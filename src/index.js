// Daemon WhatsApp:
// 1. Inicializa cliente whatsapp-web.js (sesión persistente vía LocalAuth).
// 2. Schedule con node-cron a las 10:00 (hora Santiago) cada día.
// 3. Cada corrida: ejecuta el scraper Python, genera el MP3 con edge-tts
//    (voz Lorenzo es-CL) y envía texto + audio como voice note a cada
//    destinatario de recipients.json.
//
// Modos:
//   node src/index.js              -> daemon (cliente + cron)
//   node src/index.js --once       -> corre una vez (texto + audio) y sale
//   node src/index.js --send-only  -> reenvía el último JSON sin scrapear
//   node src/index.js --voice-only -> solo audio (sin mensaje de texto)

import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import cron from "node-cron";
import qrTerminal from "qrcode-terminal";
import whatsapp from "whatsapp-web.js";

import { formatear, formatearTextoPlano } from "./format.js";

const { Client, LocalAuth, MessageMedia } = whatsapp;

const TZ = process.env.TZ || "America/Santiago";
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 10 * * *";
const RECIPIENTS_FILE =
  process.env.RECIPIENTS_FILE || "recipients.json";
const DATA_DIR = process.env.DATA_DIR || "data";
// Voz de edge-tts (default: Lorenzo, masculino chileno).
const TTS_VOICE = process.env.TTS_VOICE || "es-CL-LorenzoNeural";

const log = (...a) => console.log(new Date().toISOString(), ...a);

function loadRecipients() {
  if (!existsSync(RECIPIENTS_FILE)) {
    throw new Error(
      `No existe ${RECIPIENTS_FILE}. Copia recipients.example.json y edita.`
    );
  }
  const list = JSON.parse(readFileSync(RECIPIENTS_FILE, "utf8"));
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`${RECIPIENTS_FILE} debe ser un array no vacío de IDs.`);
  }
  return list;
}

function runScraper() {
  return new Promise((resolve, reject) => {
    log("Ejecutando scraper Python…");
    const p = spawn("python3", ["-m", "scraper.main"], { stdio: "inherit" });
    p.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`scraper terminó con código ${code}`))
    );
    p.on("error", reject);
  });
}

// Sintetiza `text` a audio llamando a scraper.tts (edge-tts + ffmpeg a OGG).
// El script imprime la ruta final (puede ser .ogg o .mp3) por stdout.
function generateTTS(text, outPath) {
  return new Promise((resolve, reject) => {
    log(`Generando audio (${text.length} chars) -> ${outPath}`);
    const p = spawn(
      "python3",
      ["-m", "scraper.tts", "--out", outPath, "--voice", TTS_VOICE],
      { stdio: ["pipe", "pipe", "inherit"] }
    );
    let stdout = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stdin.write(text);
    p.stdin.end();
    p.on("close", (code) =>
      code === 0
        ? resolve(stdout.trim().split("\n").pop() || outPath)
        : reject(new Error(`tts terminó con código ${code}`))
    );
    p.on("error", reject);
  });
}

// Fecha de hoy en la zona horaria del daemon (p.ej. America/Santiago) en ISO.
// IMPORTANTE: new Date().toISOString() devuelve UTC; el scraper Python usa
// date.today() que respeta la TZ del contenedor. Tenemos que coincidir.
function hoyISO() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
}

function latestJsonPath(fecha = null) {
  const f = fecha || hoyISO();
  return `${DATA_DIR}/${f}.json`;
}

// Envía un mensaje de texto y (opcionalmente) un audio como voice note.
async function sendToAll(client, { text, mediaPath }) {
  const recipients = loadRecipients();
  log(`Enviando a ${recipients.length} destinatario(s).`);
  let ok = 0;
  let fail = 0;
  let media = null;
  if (mediaPath && existsSync(mediaPath)) {
    // WhatsApp exige Opus/OGG para voice notes confiables; mimetype segun ext.
    const mime = mediaPath.endsWith(".ogg")
      ? "audio/ogg; codecs=opus"
      : "audio/mpeg";
    media = MessageMedia.fromFilePath(mediaPath, mime);
  }
  for (const id of recipients) {
    try {
      if (text) await client.sendMessage(id, text);
      if (media) {
        await client.sendMessage(id, media, { sendMediaAsVoiceNote: true });
      }
      log("  OK", id, media ? "(texto + audio)" : "(texto)");
      ok++;
    } catch (e) {
      log("  FAIL", id, e.message);
      fail++;
    }
  }
  log(`Envío completo: ${ok} OK, ${fail} fallidos.`);
  // Si TODO falló (p.ej. WhatsApp Web actualizo su bundle y rompio los
  // patches de la libreria: "getter must include an id property"),
  // reiniciamos el contenedor: sesion fresca + reintentos via --run-on-start.
  if (ok === 0 && fail > 0) {
    log("Envio totalmente fallido - reiniciando contenedor para reintentar…");
    process.exit(1);
  }
}

async function runOnce(client, { sendOnly = false, voiceOnly = false } = {}) {
  if (!sendOnly) await runScraper();
  const file = latestJsonPath();
  if (!existsSync(file)) throw new Error(`No se encontró ${file}`);
  const data = JSON.parse(readFileSync(file, "utf8"));

  const text = voiceOnly ? null : formatear(data);
  if (text) log(`Texto formateado (${text.length} chars) desde ${file}`);

  // Audio: siempre se intenta generar (a menos que el JSON no tenga evangelio).
  const textoPlano = formatearTextoPlano(data);
  let mp3Path = null;
  if (textoPlano && textoPlano.length > 50) {
    const outPath = `${DATA_DIR}/${data.fecha}.mp3`;
    try {
      mp3Path = await generateTTS(textoPlano, outPath);
    } catch (e) {
      log("TTS falló (continúo solo con texto):", e.message);
      mp3Path = null;
    }
  }

  if (!text && !mp3Path) throw new Error("Nada que enviar (ni texto ni audio).");
  await sendToAll(client, { text, mediaPath: mp3Path });
}

function buildClient() {
  // En Docker usamos Chromium del sistema (PUPPETEER_EXECUTABLE_PATH).
  // En desarrollo local, si no está seteado, Puppeteer usa el descargado.
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      executablePath,
      // Timeout del protocolo CDP: por defecto es bajo y falla si la pagina
      // de WhatsApp Web se queda lenta (provoca ProtocolError no capturado).
      protocolTimeout: 120_000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
  });

  client.on("qr", (qr) => {
    log("Escanea este QR con tu WhatsApp (Configuración > WhatsApp Web):");
    qrTerminal.generate(qr, { small: true });
  });

  client.on("authenticated", () => log("Sesión autenticada."));
  client.on("auth_failure", (m) => log("ERROR de autenticación:", m));
  client.on("ready", () => log("Cliente WhatsApp listo."));
  client.on("disconnected", (reason) => {
    // whatsapp-web.js no re-conecta solo de forma confiable: salimos limpio
    // para que Docker reinicie el contenedor (entrypoint limpia locks y la
    // sesion persistida re-autentica sin escanear QR de nuevo).
    log("Cliente desconectado:", reason, "- reiniciando contenedor…");
    process.exit(1);
  });

  return client;
}

async function main() {
  const argv = new Set(process.argv.slice(2));
  const once = argv.has("--once");
  const sendOnly = argv.has("--send-only");
  const voiceOnly = argv.has("--voice-only");

  const client = buildClient();

  // Cualquier rechazo no manejado (p.ej. ProtocolError de Puppeteer cuando
  // WhatsApp Web se cuelga) debe tumbar el proceso de forma controlada:
  // Docker lo reinicia, el entrypoint limpia locks y la sesion re-autentica.
  process.on("unhandledRejection", (reason) => {
    log("unhandledRejection:", reason, "- saliendo para que Docker reinicie…");
    process.exit(1);
  });

  // Watchdogs anti-zombie (falla real del 11-sep: 'authenticated' y nunca
  // 'ready' -> cron nunca agendado -> daemon vivo pero muerto por dias).
  // Etapa 1: Chromium colgado al boot (sin eventos en 10 min) -> reiniciar.
  // QR escaneandose = esperando humano -> no aplicar timeout.
  // Etapa 2: autenticado pero no 'ready' en 4 min -> sesion colgada -> reiniciar.
  // Salir con exit(1) es seguro: Docker reinicia, el entrypoint limpia locks
  // y la sesion persistida re-autentica sin escanear QR otra vez.
  const READY_TIMEOUT_MIN = Number(process.env.READY_TIMEOUT_MIN || 4);
  const bootWatchdog = setTimeout(() => {
    if (!clientReady) {
      log("Sin progreso en 10 min (Chromium colgado?) - reiniciando contenedor…");
      process.exit(1);
    }
  }, 10 * 60_000);
  bootWatchdog.unref?.();

  client.on("qr", () => clearTimeout(bootWatchdog));
  client.on("authenticated", () => {
    clearTimeout(bootWatchdog);
    const t = setTimeout(() => {
      if (!clientReady) {
        log(
          `Autenticado pero no 'ready' en ${READY_TIMEOUT_MIN} min ` +
          "(sesion colgada) - reiniciando contenedor…"
        );
        process.exit(1);
      }
    }, READY_TIMEOUT_MIN * 60_000);
    t.unref?.();
  });

  // Registrar el handler de SIGUSR2 INMEDIATAMENTE, antes de initialize().
  // Si la señal llega mientras el cliente aún conecta y no hay handler,
  // Node muere (exit 140). Si llega antes de 'ready', encolamos la corrida.
  let clientReady = false;
  let pendingRun = false;
  let running = false;

  async function doRun() {
    if (running) {
      log("Corrida ignorada: ya hay una en progreso.");
      return;
    }
    running = true;
    try {
      await runOnce(client);
    } catch (e) {
      log("ERROR en corrida manual:", e.message);
    } finally {
      running = false;
    }
  }

  process.on("SIGUSR2", () => {
    log("SIGUSR2 recibido.");
    if (!clientReady) {
      log("Cliente aún no listo: corrida encolada.");
      pendingRun = true;
      return;
    }
    doRun();
  });

  client.initialize();

  await new Promise((resolve) => {
    client.once("ready", resolve);
  });
  clientReady = true;

  if (once || sendOnly || voiceOnly) {
    try {
      await runOnce(client, { sendOnly, voiceOnly });
    } catch (e) {
      log("ERROR:", e.message);
      process.exitCode = 1;
    } finally {
      await client.destroy();
    }
    return;
  }

  // Corrida que llegó por señal mientras el cliente conectaba.
  if (pendingRun) {
    pendingRun = false;
    await doRun();
  }

  // Modo daemon: una corrida inmediata opcional + cron diario.
  if (argv.has("--run-on-start")) {
    try {
      await runOnce(client);
    } catch (e) {
      log("Corrida inicial fallida:", e.message);
    }
  }

  log(`Scheduleando cron: '${CRON_SCHEDULE}' (${TZ})`);
  cron.schedule(
    CRON_SCHEDULE,
    async () => {
      try {
        await runOnce(client);
      } catch (e) {
        log("ERROR en cron:", e.message);
      }
    },
    { timezone: TZ }
  );

  // Forzar corrida manual: docker compose kill -s USR2
  log("Daemon esperando. Ctrl+C para salir.");
}

main().catch((e) => {
  log("Fatal:", e);
  process.exit(1);
});
