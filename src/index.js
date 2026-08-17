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

// Sintetiza `text` a MP3 llamando a scraper.tts (edge-tts).
function generateTTS(text, outPath) {
  return new Promise((resolve, reject) => {
    log(`Generando audio (${text.length} chars) -> ${outPath}`);
    const p = spawn(
      "python3",
      ["-m", "scraper.tts", "--out", outPath, "--voice", TTS_VOICE],
      { stdio: ["pipe", "inherit", "inherit"] }
    );
    p.stdin.write(text);
    p.stdin.end();
    p.on("close", (code) =>
      code === 0
        ? resolve(outPath)
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

function latestMp3Path(fecha = null) {
  const f = fecha || hoyISO();
  return `${DATA_DIR}/${f}.mp3`;
}

// Envía un mensaje de texto y (opcionalmente) un audio como voice note.
async function sendToAll(client, { text, mediaPath }) {
  const recipients = loadRecipients();
  log(`Enviando a ${recipients.length} destinatario(s).`);
  let ok = 0;
  let fail = 0;
  const media =
    mediaPath && existsSync(mediaPath)
      ? MessageMedia.fromFilePath(mediaPath, "audio/mpeg")
      : null;
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
    mp3Path = latestMp3Path();
    try {
      await generateTTS(textoPlano, mp3Path);
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
  client.on("disconnected", (reason) =>
    log("Cliente desconectado:", reason, "(se re-conectará solo)")
  );

  return client;
}

async function main() {
  const argv = new Set(process.argv.slice(2));
  const once = argv.has("--once");
  const sendOnly = argv.has("--send-only");
  const voiceOnly = argv.has("--voice-only");

  const client = buildClient();

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
