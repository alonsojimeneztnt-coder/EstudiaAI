/*
  estudiaAI · servidor de IA gratuito en Cloudflare Workers
  ---------------------------------------------------------
  Recibe las peticiones de la app y las responde con un modelo abierto de
  Workers AI. No guarda los apuntes ni las respuestas.

  Necesita, en Settings → Bindings del Worker:
    · Workers AI  →  nombre: AI                       (obligatorio)
    · KV namespace → nombre: LIMITES                   (opcional: límite por persona y día)
  Variables opcionales (Settings → Variables):
    · ORIGEN_PERMITIDO  → la dirección de tu app, p. ej. https://usuario.github.io
    · LIMITE_DIARIO     → peticiones por persona y día (por defecto 40, unos 6 exámenes)
    · MODELO            → por defecto @cf/qwen/qwen3-30b-a3b-fp8
*/
const MODELO_POR_DEFECTO = "@cf/qwen/qwen3-30b-a3b-fp8";
const MAX_TEXTO = 120000; // caracteres por petición

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

function textoDeRespuesta(r) {
  let t = r && (r.response ?? r.choices?.[0]?.message?.content ?? r.result?.response);
  if (t && typeof t === "object") t = JSON.stringify(t);
  t = String(t || "");
  return t.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "").trim();
}

export default {
  async fetch(req, env) {
    const h = cabeceras(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    const url = new URL(req.url);

    if (req.method === "GET") return json({ ok: true, servicio: "estudiaAI", modelo: env.MODELO || MODELO_POR_DEFECTO }, 200, h);
    if (req.method !== "POST" || url.pathname !== "/ia") return json({ code: "not_found" }, 404, h);
    if (!env.AI) return json({ code: "no_ai_binding", message: "Falta el enlace de Workers AI con el nombre AI." }, 500, h);

    const permitido = (env.ORIGEN_PERMITIDO || "").trim();
    if (permitido && req.headers.get("Origin") !== permitido) return json({ code: "forbidden" }, 403, h);

    let datos;
    try { datos = await req.json(); } catch { return json({ code: "invalid_request" }, 400, h); }
    const prompt = String(datos.prompt || "").trim();
    if (!prompt) return json({ code: "invalid_request" }, 400, h);
    if (prompt.length > MAX_TEXTO) return json({ code: "prompt_too_large" }, 413, h);

    // Límite por persona (dirección IP) y día, si hay un espacio KV llamado LIMITES
    if (env.LIMITES) {
      const ip = req.headers.get("CF-Connecting-IP") || "desconocida";
      const dia = new Date().toISOString().slice(0, 10);
      const clave = `${dia}:${ip}`;
      const usadas = parseInt(await env.LIMITES.get(clave) || "0", 10);
      const limite = parseInt(env.LIMITE_DIARIO || "40", 10);
      if (usadas >= limite) return json({ code: "user_daily_limit" }, 429, h);
      await env.LIMITES.put(clave, String(usadas + 1), { expirationTtl: 60 * 60 * 26 });
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
