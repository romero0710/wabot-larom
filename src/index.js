// Bot de WhatsApp con IA para responder consultas (FAQs) de un negocio de turnos.
// Recibe los mensajes vía webhook de Evolution API, los responde con Claude y
// contesta por Evolution API. Guarda contexto por conversación en Redis, así el
// bot "recuerda" los últimos mensajes de cada cliente.
// Un solo código base; cada cliente = un deploy con sus variables.

import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "redis";

// ── Config por variables de entorno ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const EVOLUTION_URL = process.env.EVOLUTION_URL || "http://larom_evoapi:8080";
const EVOLUTION_APIKEY = process.env.EVOLUTION_APIKEY || "";
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || "turnos-demo";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
const NEGOCIO_NOMBRE = process.env.NEGOCIO_NOMBRE || "el negocio";
const WEB_RESERVAS = process.env.WEB_RESERVAS || "https://turnos.larom.cloud";
const NEGOCIO_INFO =
  process.env.NEGOCIO_INFO ||
  "Barbería Don Gambino. Horarios: miércoles a sábado de 10 a 20 hs. Servicios: Corte, Corte y barba, Barba, Tintura. Para reservar un turno se usa la web.";
// Memoria de conversación
const REDIS_URL = process.env.REDIS_URL || ""; // vacío = sin memoria (fallback)
const HISTORY_MAX = parseInt(process.env.HISTORY_MAX || "12", 10); // mensajes guardados por chat
const HISTORY_TTL = parseInt(process.env.HISTORY_TTL_SECONDS || "28800", 10); // 8 hs

// Recordatorios (ladrillo 2): el bot consulta la web de turnos y avisa 2h antes
const TURNOS_API_URL = process.env.TURNOS_API_URL || "http://larom_turnos:3000";
const BOT_API_SECRET = process.env.BOT_API_SECRET || "";
const REC2H_ENABLED = (process.env.REC2H_ENABLED || "true") !== "false";
const REC2H_MIN = parseInt(process.env.REC2H_MIN || "110", 10); // ventana desde (min)
const REC2H_MAX = parseInt(process.env.REC2H_MAX || "130", 10); // ventana hasta (min)
const REC2H_POLL_MS = parseInt(process.env.REC2H_POLL_SECONDS || "300", 10) * 1000; // cada 5 min

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── Redis (memoria por conversación) ─────────────────────────────────────────
let redis = null;
if (REDIS_URL) {
  redis = createClient({ url: REDIS_URL });
  redis.on("error", (e) => console.error("[redis] error:", e?.message || e));
  redis
    .connect()
    .then(() => console.log("[redis] conectado"))
    .catch((e) => console.error("[redis] no conecta:", e?.message || e));
}

const histKey = (numero) => `wabot:hist:${EVOLUTION_INSTANCE}:${numero}`;

async function cargarHistorial(numero) {
  if (!redis?.isReady) return [];
  try {
    const raw = await redis.get(histKey(numero));
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error("[redis] cargar:", e?.message || e);
    return [];
  }
}

async function guardarHistorial(numero, historial) {
  if (!redis?.isReady) return;
  try {
    const recorte = historial.slice(-HISTORY_MAX);
    await redis.set(histKey(numero), JSON.stringify(recorte), { EX: HISTORY_TTL });
  } catch (e) {
    console.error("[redis] guardar:", e?.message || e);
  }
}

function systemPrompt() {
  return [
    `Sos el asistente virtual de "${NEGOCIO_NOMBRE}", un negocio que atiende por turnos.`,
    `Respondés por WhatsApp a clientes, en español rioplatense, con un tono cordial, cercano y breve (1 a 3 frases).`,
    ``,
    `INFORMACIÓN DEL NEGOCIO (usá SOLO esto para responder):`,
    NEGOCIO_INFO,
    ``,
    `REGLAS:`,
    `- Tenés memoria de esta conversación: mantené el hilo y no vuelvas a saludar en cada mensaje si ya venías hablando.`,
    `- Respondé únicamente consultas sobre el negocio (horarios, servicios, precios, ubicación, cómo reservar).`,
    `- Para reservar, sacar, reagendar o cancelar un turno, indicá amablemente la web: ${WEB_RESERVAS}`,
    `- Si te preguntan algo que no está en la información de arriba, no lo inventes: decí que no tenés ese dato y que lo va a responder una persona del local a la brevedad.`,
    `- No inventes precios ni horarios que no figuren.`,
    `- Nada de markdown ni asteriscos; WhatsApp es texto plano.`,
  ].join("\n");
}

// ── Extraer el texto de un mensaje entrante de Evolution ─────────────────────
function extraerTexto(msg) {
  const m = msg?.message;
  if (!m) return null;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    null
  );
}

// ── Responder por Evolution API ──────────────────────────────────────────────
async function enviarWhatsapp(numero, texto) {
  const url = `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: EVOLUTION_APIKEY },
    body: JSON.stringify({ number: numero, text: texto }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[evolution] sendText ${res.status}: ${body.slice(0, 300)}`);
  }
}

// ── Preguntar a Claude con el historial de la conversación ───────────────────
async function responderIA(historial, pregunta) {
  const messages = [...historial, { role: "user", content: pregunta }];
  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: systemPrompt(),
    messages,
  });
  return resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// ── Normalizar teléfono argentino a formato WhatsApp (549XXXXXXXXXX) ──────────
// Best-effort: el número lo carga el cliente al reservar. El ladrillo de
// confirmación al reservar validará que sea real.
function normalizarTelefono(raw) {
  let d = String(raw || "").replace(/[^0-9]/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("54")) {
    // ya tiene código país; asegurar el 9 de celular
    let resto = d.slice(2);
    if (!resto.startsWith("9")) resto = "9" + resto;
    return "54" + resto;
  }
  // sin código país: asumo Argentina, agrego 549
  if (d.startsWith("9")) return "54" + d;
  return "549" + d;
}

// ── Dedup de recordatorios ya enviados (Redis; fallback en memoria) ──────────
const recordadosMem = new Set();
async function yaRecordado(turnoId) {
  const key = `wabot:rec2h:${EVOLUTION_INSTANCE}:${turnoId}`;
  if (redis?.isReady) {
    try {
      const set = await redis.set(key, "1", { NX: true, EX: 86400 });
      return set === null; // null = ya existía => ya recordado
    } catch (e) {
      console.error("[redis] dedup:", e?.message || e);
    }
  }
  if (recordadosMem.has(turnoId)) return true;
  recordadosMem.add(turnoId);
  return false;
}

// ── Chequear turnos próximos y mandar recordatorio 2h ────────────────────────
async function chequearRecordatorios() {
  if (!REC2H_ENABLED || !BOT_API_SECRET) return;
  try {
    const res = await fetch(`${TURNOS_API_URL}/api/bot/turnos?horas=3`, {
      headers: { "x-bot-secret": BOT_API_SECRET },
    });
    if (!res.ok) {
      console.error(`[rec2h] API turnos ${res.status}`);
      return;
    }
    const data = await res.json();
    const ahora = Date.now();
    for (const t of data.turnos || []) {
      const mins = (t.inicioEpochMs - ahora) / 60000;
      if (mins < REC2H_MIN || mins > REC2H_MAX) continue;
      if (await yaRecordado(t.id)) continue;
      const numero = normalizarTelefono(t.telefono);
      if (!numero) continue;
      const nombre = (t.nombre || "").split(" ")[0] || "";
      const texto =
        `Hola ${nombre}! 👋 Te recordamos tu turno en ${NEGOCIO_NOMBRE} hoy a las ${t.hora} (${t.servicio}) con ${t.barbero}. ` +
        `Si no podés venir, podés cancelarlo gratis hasta 30 minutos antes. ¡Te esperamos!`;
      console.log(`[rec2h] enviando a ${numero} (turno ${t.id}, ${t.hora})`);
      await enviarWhatsapp(numero, texto);
    }
  } catch (e) {
    console.error("[rec2h] error:", e?.message || e);
  }
}

// ── Servidor ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) =>
  res.json({ ok: true, instance: EVOLUTION_INSTANCE, model: MODEL, memoria: !!redis?.isReady }),
);

app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // 200 al toque; procesamos aparte
  try {
    const body = req.body || {};
    const evento = body.event || body.Event;
    if (evento !== "messages.upsert") return;

    const datos = Array.isArray(body.data) ? body.data : [body.data];
    for (const msg of datos) {
      if (!msg?.key) continue;
      if (msg.key.fromMe) continue; // ignorar lo que mandamos nosotros
      const jid = msg.key.remoteJid || "";
      if (jid.endsWith("@g.us")) continue; // ignorar grupos

      const texto = extraerTexto(msg);
      if (!texto || !texto.trim()) continue;

      const numero = jid.split("@")[0];
      const pregunta = texto.trim();
      console.log(`[msg] ${numero}: ${pregunta.slice(0, 120)}`);

      try {
        const historial = await cargarHistorial(numero);
        const respuesta = await responderIA(historial, pregunta);
        if (respuesta) {
          await enviarWhatsapp(numero, respuesta);
          await guardarHistorial(numero, [
            ...historial,
            { role: "user", content: pregunta },
            { role: "assistant", content: respuesta },
          ]);
        }
      } catch (e) {
        console.error("[ia] error:", e?.message || e);
        await enviarWhatsapp(
          numero,
          "Perdón, tuve un problema para responderte. En un momento te contesta una persona del local. 🙏",
        );
      }
    }
  } catch (e) {
    console.error("[webhook] error:", e?.message || e);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`wabot escuchando en :${PORT} | instancia=${EVOLUTION_INSTANCE} | modelo=${MODEL}`);
  if (REC2H_ENABLED && BOT_API_SECRET) {
    console.log(`[rec2h] recordatorios 2h activos (cada ${REC2H_POLL_MS / 1000}s)`);
    setInterval(chequearRecordatorios, REC2H_POLL_MS);
    setTimeout(chequearRecordatorios, 15000); // una corrida al arranque
  } else {
    console.log("[rec2h] recordatorios 2h desactivados (falta BOT_API_SECRET o REC2H_ENABLED=false)");
  }
});
