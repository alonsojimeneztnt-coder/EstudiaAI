/*
  estudiaAI · servidor de IA gratuito en Cloudflare Workers
  ---------------------------------------------------------
  Recibe las peticiones de la app y las responde con un modelo abierto de
  Workers AI. No guarda los apuntes ni las respuestas.

  Necesita, en Settings → Bindings del Worker:
    · Workers AI   → nombre: AI   (obligatorio)
    · D1 database  → nombre: DB   (recomendado: límite de exámenes por persona y semana)
  Las tablas de la base de datos se crean solas la primera vez.

  Variables opcionales (Settings → Variables and Secrets):
    · ORIGEN_PERMITIDO       → la dirección de tu app, p. ej. https://usuario.github.io
    · LIMITE_SEMANAL         → exámenes por dispositivo y semana (por defecto 5)
    · LIMITE_IP_SEMANAL      → exámenes por conexión (IP) y semana (por defecto 100; un instituto comparte IP)
    · LIMITE_GLOBAL_DIARIO   → exámenes al día entre todo el mundo (por defecto 0 = sin tope;
                               en el plan gratuito de Cloudflare no hace falta: al agotarse lo gratuito, se para solo)
    · PETICIONES_POR_EXAMEN  → peticiones a la IA que permite cada examen (por defecto 60)
    · MODELO                 → por defecto @cf/qwen/qwen3-30b-a3b-fp8

  Cómo se cuenta: al empezar a crear un examen, la app pide un «pase» (POST /examen/empezar).
  Ese pase sirve durante 7 días para analizar, crear y corregir ese examen, así que corregir
  no gasta otro examen. La semana empieza el lunes a las 00:00 (hora de España).
*/
const MODELO_POR_DEFECTO = "@cf/qwen/qwen3-30b-a3b-fp8";
const MAX_TEXTO = 120000;          // caracteres por petición
const DURACION_PASE = 7 * 24 * 3600 * 1000;
const GUARDAR_DIAS = 15;           // los registros más antiguos se borran

const SISTEMA = "Eres el motor de inteligencia artificial de estudiaAI, una plataforma educativa para estudiantes de 14 años o más. Trabaja solo con contenido educativo y responde siempre de forma adecuada para menores.";
const SISTEMA_JSON = " Responde únicamente con JSON válido: sin texto antes ni después y sin bloques de código.";

function cabeceras(env, req) {
  const origen = req.headers.get("Origin") || "";
  const permitido = (env.ORIGEN_PERMITIDO || "").trim();
  return {
    "Access-Control-Allow-Origin": permitido ? (origen === permitido ? origen : permitido) : "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
const json = (obj, status, h) => new Response(JSON.stringify(obj), { status, headers: { ...h, "Content-Type": "application/json; charset=utf-8" } });
const entero = (v, def) => { const n = parseInt(v ?? "", 10); return Number.isFinite(n) && n >= 0 ? n : def; };

function textoDeRespuesta(r) {
  let t = r && (r.response ?? r.choices?.[0]?.message?.content ?? r.result?.response);
  if (t && typeof t === "object") t = JSON.stringify(t);
  t = String(t || "");
  return t.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "").trim();
}

/* ---------- Fechas en hora de España ---------- */
const fmtMadrid = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" });
const diaDe = ms => fmtMadrid.format(new Date(ms));                       // "2026-10-17"
function semanaDe(ms) {                                                   // lunes de esa semana
  const d = new Date(diaDe(ms) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/* ---------- Base de datos (D1) ---------- */
let esquemaListo = false;
async function prepararBD(db) {
  if (esquemaListo) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS examenes (pase TEXT PRIMARY KEY, dispositivo TEXT NOT NULL, ip TEXT NOT NULL, semana TEXT NOT NULL, dia TEXT NOT NULL, creado INTEGER NOT NULL, expira INTEGER NOT NULL, quedan INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS ix_dispositivo ON examenes (dispositivo, semana)"),
    db.prepare("CREATE INDEX IF NOT EXISTS ix_ip ON examenes (ip, semana)"),
    db.prepare("CREATE INDEX IF NOT EXISTS ix_dia ON examenes (dia)"),
    db.prepare("CREATE INDEX IF NOT EXISTS ix_creado ON examenes (creado)"),
  ]);
  esquemaListo = true;
}
// No se guarda la IP: solo una huella cifrada que no se puede revertir
async function huellaIP(req, env) {
  const ip = req.headers.get("CF-Connecting-IP") || "desconocida";
  const datos = new TextEncoder().encode("estudiaai:" + (env.SAL_IP || "sal") + ":" + ip);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", datos));
  return Array.from(h.slice(0, 16), b => b.toString(16).padStart(2, "0")).join("");
}
const dispositivoValido = d => typeof d === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(d);
const contar = async (db, sql, ...args) => ((await db.prepare(sql).bind(...args).first()) || {}).n || 0;

async function cupo(env, dispositivo, ahora) {
  const limite = entero(env.LIMITE_SEMANAL, 5);
  const usados = await contar(env.DB, "SELECT COUNT(*) AS n FROM examenes WHERE dispositivo = ? AND semana = ?", dispositivo, semanaDe(ahora));
  return { limite, usados, quedan: Math.max(0, limite - usados), renueva: "lunes" };
}

async function empezarExamen(req, env, datos) {
  const ahora = Date.now();
  if (!dispositivoValido(datos.dispositivo)) return [{ code: "invalid_request" }, 400];
  await prepararBD(env.DB);
  const semana = semanaDe(ahora), dia = diaDe(ahora), ip = await huellaIP(req, env);

  const c = await cupo(env, datos.dispositivo, ahora);
  if (c.quedan <= 0) return [{ code: "user_weekly_limit", ...c }, 429];
  const limiteIP = entero(env.LIMITE_IP_SEMANAL, 100);
  if (limiteIP && await contar(env.DB, "SELECT COUNT(*) AS n FROM examenes WHERE ip = ? AND semana = ?", ip, semana) >= limiteIP) return [{ code: "ip_weekly_limit", ...c }, 429];
  const global = entero(env.LIMITE_GLOBAL_DIARIO, 0);
  if (global && await contar(env.DB, "SELECT COUNT(*) AS n FROM examenes WHERE dia = ?", dia) >= global) return [{ code: "daily_limit", ...c }, 429];

  const pase = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO examenes (pase, dispositivo, ip, semana, dia, creado, expira, quedan) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(pase, datos.dispositivo, ip, semana, dia, ahora, ahora + DURACION_PASE, entero(env.PETICIONES_POR_EXAMEN, 60)).run();
  // De vez en cuando, borrar registros viejos
  if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM examenes WHERE creado < ?").bind(ahora - GUARDAR_DIAS * 86400000).run();
  return [{ pase, limite: c.limite, usados: c.usados + 1, quedan: c.quedan - 1, renueva: "lunes" }, 200];
}

// Gasta una petición del pase. Devuelve null si vale, o el código de error
async function usarPase(env, pase) {
  if (typeof pase !== "string" || !pase) return "ticket_required";
  await prepararBD(env.DB);
  const r = await env.DB.prepare("UPDATE examenes SET quedan = quedan - 1 WHERE pase = ? AND quedan > 0 AND expira > ?").bind(pase, Date.now()).run();
  return r.meta && r.meta.changes > 0 ? null : "ticket_expired";
}

export default {
  async fetch(req, env) {
    const h = cabeceras(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/cupo") {
      if (!env.DB) return json({ sin_limite: true }, 200, h);
      const d = url.searchParams.get("dispositivo");
      if (!dispositivoValido(d)) return json({ code: "invalid_request" }, 400, h);
      await prepararBD(env.DB);
      return json(await cupo(env, d, Date.now()), 200, h);
    }
    if (req.method === "GET") return json({ ok: true, servicio: "estudiaAI", modelo: env.MODELO || MODELO_POR_DEFECTO, limites: !!env.DB }, 200, h);
    if (req.method !== "POST" || !["/ia", "/examen/empezar"].includes(url.pathname)) return json({ code: "not_found" }, 404, h);

    const permitido = (env.ORIGEN_PERMITIDO || "").trim();
    if (permitido && req.headers.get("Origin") !== permitido) return json({ code: "forbidden" }, 403, h);

    let datos;
    try { datos = await req.json(); } catch { return json({ code: "invalid_request" }, 400, h); }

    if (url.pathname === "/examen/empezar") {
      if (!env.DB) return json({ sin_limite: true }, 200, h);
      try { const [r, status] = await empezarExamen(req, env, datos); return json(r, status, h); }
      catch (e) { return json({ code: "upstream_error", message: "Base de datos: " + String((e && e.message) || e).slice(0, 200) }, 502, h); }
    }

    if (!env.AI) return json({ code: "no_ai_binding", message: "Falta el enlace de Workers AI con el nombre AI." }, 500, h);
    const prompt = String(datos.prompt || "").trim();
    if (!prompt) return json({ code: "invalid_request" }, 400, h);
    if (prompt.length > MAX_TEXTO) return json({ code: "prompt_too_large" }, 413, h);

    if (env.DB) {
      let fallo;
      try { fallo = await usarPase(env, datos.pase); }
      catch (e) { return json({ code: "upstream_error", message: "Base de datos: " + String((e && e.message) || e).slice(0, 200) }, 502, h); }
      if (fallo) return json({ code: fallo }, 401, h);
    }

    try {
      const r = await env.AI.run(env.MODELO || MODELO_POR_DEFECTO, {
        messages: [
          { role: "system", content: SISTEMA + (datos.quiere_json ? SISTEMA_JSON : "") + " /no_think" },
          { role: "user", content: prompt },
        ],
        max_tokens: Math.min(parseInt(datos.max_tokens || "6000", 10) || 6000, 8000),
        temperature: 0.4,
      });
      const texto = textoDeRespuesta(r);
      if (!texto) return json({ code: "empty_completion" }, 502, h);
      const fin = r?.choices?.[0]?.finish_reason;
      return json({ text: texto, truncated: fin === "length" }, 200, h);
    } catch (e) {
      const msg = String((e && e.message) || e).toLowerCase();
      if (/neuron|daily|quota|limit|4006|capacity|rate/.test(msg)) return json({ code: "daily_limit" }, 429, h);
      if (/too long|context|token/.test(msg)) return json({ code: "prompt_too_large" }, 413, h);
      return json({ code: "upstream_error", message: String((e && e.message) || e).slice(0, 300) }, 502, h);
    }
  },
};
