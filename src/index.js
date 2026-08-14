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
// Para leer comprobantes conviene un modelo con mejor visión/precisión que Haiku.
const MODEL_VISION = process.env.ANTHROPIC_MODEL_VISION || "claude-sonnet-5";
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

// Confirmación al reservar (ladrillo 3a)
const CONFIRM_ENABLED = (process.env.CONFIRM_ENABLED || "true") !== "false";
const CONFIRM_WINDOW_MIN = parseInt(process.env.CONFIRM_WINDOW_MIN || "20", 10);
const CONFIRM_POLL_MS = parseInt(process.env.CONFIRM_POLL_SECONDS || "60", 10) * 1000; // cada 1 min

// Seña opcional (ladrillo 3b): si está activa, para confirmar hay que transferir
// y mandar el comprobante (que valida la IA con visión).
const SENA_ENABLED = (process.env.SENA_ENABLED || "false") === "true";
const SENA_PORCENTAJE = parseInt(process.env.SENA_PORCENTAJE || "50", 10);
const SENA_ALIAS = process.env.SENA_ALIAS || "";
const SENA_TITULAR = process.env.SENA_TITULAR || "";
const SENA_RECIENTE_MIN = parseInt(process.env.SENA_RECIENTE_MIN || "60", 10); // antigüedad máx del comprobante

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
      const link = t.token ? `${WEB_RESERVAS}/turno/${t.token}` : WEB_RESERVAS;
      const texto =
        `Hola ${nombre}! 👋 Te recordamos tu turno en ${NEGOCIO_NOMBRE} hoy a las ${t.hora} (${t.servicio}) con ${t.barbero}. ` +
        `Si necesitás cancelar o reprogramar, entrá acá: ${link}\n¡Te esperamos!`;
      console.log(`[rec2h] enviando a ${numero} (turno ${t.id}, ${t.hora})`);
      await enviarWhatsapp(numero, texto);
    }
  } catch (e) {
    console.error("[rec2h] error:", e?.message || e);
  }
}

// ── Confirmación al reservar (ladrillo 3a) ───────────────────────────────────
function esAfirmativo(t) {
  return /^\s*(si|sí|s|dale|ok|oka|okey|listo|confirmo|confirmar|va|vale|perfecto|sip|obvio)\b/i.test(t);
}
function esNegativo(t) {
  return /^\s*(no|nop|cancelar|cancela|cancelalo|cancelá|negativo)\b/i.test(t);
}

const pendKey = (numero) => `wabot:pendconf:${EVOLUTION_INSTANCE}:${numero}`;
async function getPendConf(numero) {
  if (!redis?.isReady) return null;
  try { return await redis.get(pendKey(numero)); } catch { return null; }
}
async function setPendConf(numero, id) {
  if (!redis?.isReady) return;
  try { await redis.set(pendKey(numero), String(id), { EX: CONFIRM_WINDOW_MIN * 60 + 120 }); } catch {}
}
async function clearPendConf(numero) {
  if (!redis?.isReady) return;
  try { await redis.del(pendKey(numero)); } catch {}
}
async function notifiedConf(id) {
  if (!redis?.isReady) return true; // sin Redis no mandamos (evita spam)
  try {
    const s = await redis.set(`wabot:confnotif:${EVOLUTION_INSTANCE}:${id}`, "1", { NX: true, EX: 3600 });
    return s === null; // null = ya avisado
  } catch { return true; }
}

async function accionTurno(id, accion, senaMonto = 0) {
  try {
    const res = await fetch(`${TURNOS_API_URL}/api/bot/accion`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bot-secret": BOT_API_SECRET },
      body: JSON.stringify({ id: Number(id), accion, senaMonto }),
    });
    if (!res.ok) return { ok: false };
    return await res.json();
  } catch (e) {
    console.error("[conf] accion:", e?.message || e);
    return { ok: false };
  }
}

// ── Seña: helpers (Redis, monto, media, visión) ──────────────────────────────
const senaKey = (numero) => `wabot:senareq:${EVOLUTION_INSTANCE}:${numero}`;
async function getSenaReq(numero) {
  if (!redis?.isReady) return null;
  try {
    const v = await redis.get(senaKey(numero));
    return v ? parseInt(v, 10) : null;
  } catch {
    return null;
  }
}
async function setSenaReq(numero, monto) {
  if (!redis?.isReady) return;
  try {
    await redis.set(senaKey(numero), String(monto), { EX: CONFIRM_WINDOW_MIN * 60 + 120 });
  } catch {}
}
async function clearSenaReq(numero) {
  if (!redis?.isReady) return;
  try {
    await redis.del(senaKey(numero));
  } catch {}
}

function montoSena(precioArs) {
  return Math.round((precioArs * SENA_PORCENTAJE) / 100);
}

function destinatarioCoincide(dest) {
  if (!dest) return false;
  const d = dest.toLowerCase();
  const alias = SENA_ALIAS.toLowerCase();
  if (alias && d.includes(alias)) return true;
  // por nombre: que aparezca algún apellido/nombre del titular (palabras > 3 letras)
  const palabras = SENA_TITULAR.toLowerCase().split(/\s+/).filter((p) => p.length > 3);
  return palabras.some((p) => d.includes(p));
}

// Baja el base64 de una imagen desde Evolution API.
async function bajarComprobante(msg) {
  try {
    const res = await fetch(`${EVOLUTION_URL}/chat/getBase64FromMediaMessage/${EVOLUTION_INSTANCE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: EVOLUTION_APIKEY },
      body: JSON.stringify({ message: { key: msg.key }, convertToMp4: false }),
    });
    if (!res.ok) {
      console.error(`[sena] getBase64 ${res.status}`);
      return null;
    }
    const j = await res.json();
    const base64 = j.base64 || j.media || null;
    const mimetype = j.mimetype || "image/jpeg";
    return base64 ? { base64, mimetype } : null;
  } catch (e) {
    console.error("[sena] bajarComprobante:", e?.message || e);
    return null;
  }
}

// Convierte la fecha/hora leída del comprobante (hora local AR) a epoch ms.
function epochDeComprobante(iso) {
  if (!iso) return null;
  let s = String(iso).trim().replace(" ", "T");
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) {
    if (/T\d\d:\d\d$/.test(s)) s += ":00";
    s += "-03:00"; // Argentina, sin DST
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// La IA lee el comprobante y devuelve datos estructurados (solo EXTRAE; el
// cálculo de "reciente" lo hace el código para no depender de aritmética del modelo).
async function analizarComprobante(base64, mimetype, montoEsperado) {
  const prompt =
    `Sos un validador de comprobantes de transferencia (MercadoPago o bancos argentinos). ` +
    `Mirá la imagen y respondé ÚNICAMENTE con un JSON válido, sin texto extra ni markdown, con estas claves: ` +
    `{"es_comprobante": boolean, ` +
    `"monto": number|null (en pesos, solo el número entero, sin $ ni puntos de miles; ej: 10000), ` +
    `"destinatario": string|null (nombre o alias de QUIEN RECIBE el dinero, el campo "Para"), ` +
    `"fecha_hora_iso": string|null (la fecha y hora EXACTA que figura en el comprobante, en formato ISO 8601 "YYYY-MM-DDTHH:MM", interpretando la hora como hora local de Argentina)}. ` +
    `Si la imagen no es un comprobante de transferencia, poné es_comprobante=false.`;
  const resp = await anthropic.messages.create({
    model: MODEL_VISION,
    max_tokens: 300,
    thinking: { type: "disabled" }, // extracción directa: sin pensamiento (evita gastar el presupuesto)
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimetype, data: base64 } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  const txt = resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  // extraer el primer bloque {...}
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return { es_comprobante: false };
  try {
    return JSON.parse(m[0]);
  } catch {
    return { es_comprobante: false };
  }
}

// Procesa un comprobante recibido para un turno pendiente con seña.
async function procesarComprobante(numero, turnoId, montoEsperado, msg) {
  const media = await bajarComprobante(msg);
  if (!media) {
    await enviarWhatsapp(numero, "No pude descargar tu comprobante 😕. Probá reenviarlo, por favor.");
    return;
  }
  let datos;
  try {
    datos = await analizarComprobante(media.base64, media.mimetype, montoEsperado);
  } catch (e) {
    console.error("[sena] visión:", e?.message || e);
    await enviarWhatsapp(numero, "No pude leer bien el comprobante. Mandá una captura más clara, por favor.");
    return;
  }
  console.log(`[sena] turno ${turnoId} analisis:`, JSON.stringify(datos).slice(0, 200));

  if (!datos.es_comprobante) {
    await enviarWhatsapp(numero, "Eso no parece un comprobante de transferencia. Mandá la captura de la transferencia, por favor.");
    return;
  }
  // Recencia: la calculamos en código con la fecha/hora extraída del comprobante.
  const epoch = epochDeComprobante(datos.fecha_hora_iso);
  if (epoch != null) {
    const minAgo = (Date.now() - epoch) / 60000;
    console.log(`[sena] turno ${turnoId} minAgo=${minAgo.toFixed(1)} (max ${SENA_RECIENTE_MIN})`);
    // Solo rechazamos si es claramente VIEJO. Una fecha "futura" suele ser un
    // error de lectura del modelo, así que no bloqueamos por eso (el barbero
    // valida en MercadoPago igual).
    if (minAgo > SENA_RECIENTE_MIN) {
      await enviarWhatsapp(
        numero,
        "Ese comprobante no parece de la transferencia que acabás de hacer para este turno. Tiene que ser reciente.",
      );
      return;
    }
  } else {
    console.log(`[sena] turno ${turnoId}: no pude leer la fecha del comprobante, no bloqueo por recencia`);
  }
  if (!destinatarioCoincide(datos.destinatario)) {
    await enviarWhatsapp(numero, `El comprobante no figura a nombre del destinatario correcto. La transferencia tiene que ir al alias ${SENA_ALIAS}.`);
    return;
  }
  const monto = Number(datos.monto) || 0;
  if (monto < montoEsperado) {
    await enviarWhatsapp(numero, `El monto no alcanza: la seña es de $${montoEsperado} y el comprobante muestra $${monto}. Revisá, por favor.`);
    return;
  }
  // Todo OK → confirmar con seña
  const r = await accionTurno(turnoId, "confirmar", montoEsperado);
  await clearPendConf(numero);
  await clearSenaReq(numero);
  await enviarWhatsapp(
    numero,
    r?.ok
      ? `¡Listo! Recibimos tu seña de $${montoEsperado} y tu turno quedó confirmado ✅. ¡Te esperamos!`
      : "Recibí tu comprobante, pero el turno ya no estaba disponible. Escribinos y lo vemos.",
  );
}

async function chequearConfirmaciones() {
  if (!CONFIRM_ENABLED || !BOT_API_SECRET || !redis?.isReady) return;
  try {
    const res = await fetch(`${TURNOS_API_URL}/api/bot/pendientes`, {
      headers: { "x-bot-secret": BOT_API_SECRET },
    });
    if (!res.ok) {
      console.error(`[conf] API pendientes ${res.status}`);
      return;
    }
    const data = await res.json();
    const now = Date.now();
    for (const t of data.pendientes || []) {
      const numero = normalizarTelefono(t.telefono);
      if (!numero) continue;
      const ageMin = (now - t.creadoEnEpochMs) / 60000;

      if (ageMin > CONFIRM_WINDOW_MIN) {
        const r = await accionTurno(t.id, "expirar");
        if (r?.ok) {
          console.log(`[conf] expirado turno ${t.id}`);
          await clearPendConf(numero);
          await clearSenaReq(numero);
          await enviarWhatsapp(
            numero,
            `No confirmaste tu turno en ${NEGOCIO_NOMBRE}, así que quedó liberado. Si querés, sacá otro desde ${WEB_RESERVAS}.`,
          );
        }
        continue;
      }

      if (await notifiedConf(t.id)) continue; // ya le mandamos la confirmación
      const nombre = (t.nombre || "").split(" ")[0] || "";
      const partes = t.fecha.split("-");
      const fechaLinda = `${partes[2]}/${partes[1]}`;
      const link = t.token ? `${WEB_RESERVAS}/turno/${t.token}` : WEB_RESERVAS;

      const conSena = SENA_ENABLED && SENA_ALIAS && t.precioArs > 0;
      let texto;
      if (conSena) {
        const monto = montoSena(t.precioArs);
        texto =
          `Hola ${nombre}! 👋 Registraste un turno en ${NEGOCIO_NOMBRE} para el ${fechaLinda} a las ${t.hora} (${t.servicio}). ` +
          `Para confirmarlo, transferí la seña de $${monto} (${SENA_PORCENTAJE}% del servicio) al alias ${SENA_ALIAS} y mandá la captura del comprobante acá, dentro de los ${CONFIRM_WINDOW_MIN} minutos. ` +
          `Si no lo hacés, el turno se libera.\nPara ver o cancelar tu turno: ${link}`;
        await setSenaReq(numero, monto);
      } else {
        texto =
          `Hola ${nombre}! 👋 Registraste un turno en ${NEGOCIO_NOMBRE} para el ${fechaLinda} a las ${t.hora} (${t.servicio}). ` +
          `Para confirmarlo respondé SÍ dentro de los ${CONFIRM_WINDOW_MIN} minutos. Si no confirmás, el turno se libera.\n` +
          `Para ver o cancelar tu turno cuando quieras: ${link}`;
      }
      console.log(`[conf] enviando confirmacion a ${numero} (turno ${t.id})${conSena ? " [seña]" : ""}`);
      await enviarWhatsapp(numero, texto);
      await setPendConf(numero, t.id);
    }
  } catch (e) {
    console.error("[conf] error:", e?.message || e);
  }
}

// ── Servidor ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) =>
  res.json({ ok: true, instance: EVOLUTION_INSTANCE, model: MODEL, memoria: !!redis?.isReady }),
);

// Empujón interno desde la web de turnos: al reservar, dispara el chequeo de
// confirmaciones al instante (sin esperar el polling). Protegido por secreto.
app.post("/interno/check", (req, res) => {
  if (!BOT_API_SECRET || (req.headers["x-bot-secret"] || "") !== BOT_API_SECRET) {
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  chequearConfirmaciones();
});

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

      const numero = jid.split("@")[0];
      const texto = extraerTexto(msg);
      const esImagen = !!msg.message?.imageMessage;
      const pregunta = (texto || "").trim();

      // ¿Este número tiene un turno esperando confirmación? (ladrillo 3a/3b)
      const pendId = await getPendConf(numero);
      if (pendId) {
        const senaMonto = await getSenaReq(numero);
        if (senaMonto) {
          // Flujo con seña (3b): se confirma mandando el comprobante (imagen).
          if (esImagen) {
            console.log(`[sena] comprobante de ${numero} (turno ${pendId})`);
            await procesarComprobante(numero, pendId, senaMonto, msg);
          } else if (pregunta && esNegativo(pregunta)) {
            await accionTurno(pendId, "expirar");
            await clearPendConf(numero);
            await clearSenaReq(numero);
            await enviarWhatsapp(numero, "Listo, cancelamos el turno. Cuando quieras sacás otro desde la web. 🙌");
          } else {
            await enviarWhatsapp(
              numero,
              `Para confirmar el turno, transferí la seña de $${senaMonto} al alias ${SENA_ALIAS} y mandá la captura del comprobante acá. (O respondé NO para cancelar.)`,
            );
          }
          continue;
        }
        // Flujo sin seña (3a): SÍ/NO por texto.
        if (!pregunta) continue; // imagen sin seña → ignorar
        console.log(`[msg] ${numero}: ${pregunta.slice(0, 120)}`);
        if (esAfirmativo(pregunta)) {
          const r = await accionTurno(pendId, "confirmar");
          await clearPendConf(numero);
          await enviarWhatsapp(
            numero,
            r?.ok
              ? "¡Listo! Tu turno quedó confirmado ✅. ¡Te esperamos!"
              : "Ese turno ya no estaba disponible para confirmar. Si querés, sacá uno nuevo desde la web.",
          );
        } else if (esNegativo(pregunta)) {
          await accionTurno(pendId, "expirar");
          await clearPendConf(numero);
          await enviarWhatsapp(numero, "Listo, cancelamos el turno. Cuando quieras sacás otro desde la web. 🙌");
        } else {
          await enviarWhatsapp(numero, "Para confirmar tu turno respondé SÍ dentro del tiempo. (O NO si querés cancelarlo.)");
        }
        continue;
      }

      // Sin confirmación pendiente → FAQ (solo texto).
      if (!pregunta) continue;
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
  if (CONFIRM_ENABLED && BOT_API_SECRET) {
    console.log(`[conf] confirmación al reservar activa (cada ${CONFIRM_POLL_MS / 1000}s, ventana ${CONFIRM_WINDOW_MIN} min)`);
    setInterval(chequearConfirmaciones, CONFIRM_POLL_MS);
    setTimeout(chequearConfirmaciones, 8000);
  } else {
    console.log("[conf] confirmación al reservar desactivada");
  }
});
