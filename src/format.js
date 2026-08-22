// Formatea el JSON diario (data/YYYY-MM-DD.json) como mensaje de WhatsApp.
// Mensaje: evangelio + comentario (homilía) + 1 pensamiento.
// WhatsApp soporta *negrita*, _cursiva_, ~tachado~, `codigo`, y saltos de línea.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SEP = "\n\n";
const B = (s) => `*${s}*`;
const I = (s) => `_${s}_`;

// Abreviaturas bíblicas -> nombre hablado, para que el TTS lo lea bien.
// Aplicado solo al texto que va a síntesis de voz, no al mensaje WhatsApp.
const ABBR = {
  // Pentateuco
  Gn: "Génesis", Ex: "Éxodo", Lv: "Levítico", Nm: "Números", Dt: "Deuteronomio",
  // Históricos
  Jos: "Josué", Jue: "Jueces", Rt: "Rut",
  "1Sam": "Primero de Samuel", "2Sam": "Segundo de Samuel",
  "1Rey": "Primero de Reyes", "2Rey": "Segundo de Reyes",
  "1Cro": "Primero de las Crónicas", "2Cro": "Segundo de las Crónicas",
  Esd: "Esdras", Neh: "Nehemías", Tb: "Tobías", Jdt: "Judit",
  Est: "Ester", "1Mac": "Primero de los Macabeos", "2Mac": "Segundo de los Macabeos",
  // Sapienciales
  Job: "Job", Sal: "Salmo", Pr: "Proverbios", Qo: "Qohelet",
  Cant: "Cantar de los Cantares", Sab: "Sabiduría", Si: "Eclesiástico",
  // Proféticos
  Is: "Isaías", Jer: "Jeremías", Lam: "Lamentaciones", Bar: "Baruc",
  Ez: "Ezequiel", Dn: "Daniel",
  Os: "Oseas", Jl: "Joel", Am: "Amós", Abd: "Abdías", Jon: "Jonás",
  Mi: "Miqueas", Na: "Nahúm", Hab: "Habacuc", Sof: "Sofonías",
  Ag: "Ageo", Zac: "Zacarías", Mal: "Malaquías",
  // Evangelios
  Mt: "Mateo", Mc: "Marcos", Lc: "Lucas", Jn: "Juan",
  // Hechos y cartas
  Hch: "Hechos de los Apóstoles",
  Rom: "Romanos",
  "1Cor": "Primera de Corintios", "2Cor": "Segunda de Corintios",
  Gál: "Gálatas", Ef: "Efesios", Flp: "Filipenses", Col: "Colosenses",
  "1Tes": "Primera de Tesalonicenses", "2Tes": "Segunda de Tesalonicenses",
  "1Tim": "Primera de Timoteo", "2Tim": "Segunda de Timoteo",
  Tit: "Tito", Flm: "Filemón", Heb: "Hebreos", Stg: "Santiago",
  "1Pe": "Primera de Pedro", "2Pe": "Segunda de Pedro",
  "1Jn": "Primera de Juan", "2Jn": "Segunda de Juan", "3Jn": "Tercera de Juan",
  Jud: "Judas", Ap: "Apocalipsis",
};

// "Texto del Evangelio ( Mt 18,15-20):" -> "Mt 18,15-20"
function extraerCita(ref) {
  if (!ref) return "";
  const m = ref.match(/\(([^)]+)\)/);
  return m ? m[1].trim() : ref.trim();
}

const EVANGELISTAS = {
  Mt: "Mateo",
  Mc: "Marcos",
  Lc: "Lucas",
  Jn: "Juan",
};

// Parsea "Mt 18,15-20" / "1Cor 13, 1-3" -> { num, abbr, capitulo, versiculos }
function parsearCita(cita) {
  const m = cita.match(
    /^(\d{1,3})?\s*([A-Za-zÁÉÍÓÚáéíóúÑñ]{1,5})\s+(\d+)(?:\s*[,;.]\s*(.+))?$/
  );
  if (!m) return null;
  return { num: m[1] || "", abbr: m[2], capitulo: m[3], versiculos: (m[4] || "").trim() };
}

// Versión para el encabezado del mensaje WhatsApp:
//   "Mt 18,15-20"   -> "Evangelio según san Mateo 18, 15-20"
//   "Hch 3, 1-5"    -> "Hechos de los Apóstoles 3, 1-5"
function tituloCitaWhatsApp(cita) {
  const p = parsearCita(cita);
  if (!p) return cita;
  if (!p.num && EVANGELISTAS[p.abbr]) {
    const ref = p.versiculos ? `${p.capitulo}, ${p.versiculos}` : `${p.capitulo}`;
    return `Evangelio según san ${EVANGELISTAS[p.abbr]} ${ref}`.replace(/\s+/g, " ").trim();
  }
  return expandirCita(cita);
}

// Versión hablada para el TTS:
//   "Mt 18,15-20" -> "Evangelio según san Mateo, capítulo 18, versículos 15 al 20"
//   "Mc 1, 1-5"   -> "Evangelio según san Marcos, capítulo 1, versículos 1 al 5"
function citaHablada(cita) {
  const p = parsearCita(cita);
  if (!p) return expandirAbreviaturasLiturgicas(expandirCita(cita));
  let nombre;
  if (!p.num && EVANGELISTAS[p.abbr]) {
    nombre = `Evangelio según san ${EVANGELISTAS[p.abbr]}`;
  } else {
    nombre = expandirCita(`${p.num}${p.abbr}`.trim());
  }
  let out = `${nombre}, capítulo ${p.capitulo}`;
  if (p.versiculos) {
    const vers = p.versiculos
      .replace(/(\d+)\s*[-–—]\s*(\d+)/g, "$1 al $2") // 15-20 / 15—20 -> 15 al 20
      .replace(/\s*[;.]\s*/g, ", ")              // 1-5. 10 -> 1 al 5, 10
      .replace(/,\s([^,]+)$/, " y $1");          // último separador -> "y"
    out += `, versículos ${vers}`;
  }
  return out;
}

// "Liturgia del Miércoles 12 de Agosto de 2026" -> "Miércoles 12 de Agosto de 2026"
function extraerFechaHumana(titulo) {
  if (!titulo) return "";
  const m = titulo.match(/Liturgia del\s+(.*)/i);
  return m ? m[1].trim() : titulo;
}

// Construye las líneas (sin marcado) del mensaje. Sirve tanto para la versión
// WhatsApp (se le aplica * _ después) como para TTS (se expanden abreviaturas).
function construirPartes(data) {
  const en = data.evangeli_net || {};
  const partes = [];

  partes.push({ t: "h2", s: "Evangelio del día" });
  const fechaHumana = extraerFechaHumana(
    data.eucaristia_diaria?.titulo || data.fecha
  );
  if (fechaHumana) partes.push({ t: "i", s: fechaHumana });

  const cita = extraerCita(en.evangelio_ref);
  if (cita) partes.push({ t: "cita", s: cita });

  if (en.evangelio_texto) partes.push({ t: "p", s: en.evangelio_texto.trim() });

  if (en.comentario) {
    partes.push({ t: "h2", s: "Comentario" });
    if (en.autor) partes.push({ t: "i", s: en.autor });
    partes.push({ t: "p", s: en.comentario.trim() });
  }

  const pensamiento = en.pensamientos?.[0];
  if (pensamiento) {
    partes.push({ t: "h2", s: "Para reflexionar" });
    partes.push({ t: "p", s: pensamiento.trim() });
  }

  partes.push({ t: "i", s: "Fuente: evangeli.net" });
  return { partes, error: en.error };
}

function formatear(data) {
  const { partes, error } = construirPartes(data);
  if (error) {
    return [
      B("Liturgia de hoy"),
      I(extraerFechaHumana(data.eucaristia_diaria?.titulo || data.fecha)),
      "No se pudo obtener el evangelio/homilía hoy:",
      I(error),
    ].join(SEP);
  }
  return partes
    .map((p) =>
      p.t === "cita" ? B(tituloCitaWhatsApp(p.s))
      : p.t === "h2" ? B(p.s)
      : p.t === "i" ? I(p.s)
      : p.s
    )
    .join(SEP);
}

// Versión sin marcado WhatsApp + con la cita bíblica expandida, para TTS.
// OJO: la expansión de abreviaturas se aplica SOLO a la línea de la cita,
// no a todo el texto (si no, "Mi" -> Miqueas rompería "Miércoles", etc.).
function formatearTextoPlano(data) {
  const { partes, error } = construirPartes(data);
  if (error) {
    return `Liturgia de hoy. No se pudo obtener el evangelio: ${error}`;
  }
  const render = partes.map((p) => {
    let s = p.s;
    if (p.t === "i" && /Fuente:/.test(s)) return null; // omitir crédito en audio
    if (p.t === "i") s = `${s}.`;
    // La cita bíblica se dice completa: "Evangelio según san Mateo, capítulo…"
    if (p.t === "cita") return citaHablada(s);
    return expandirAbreviaturasLiturgicas(s);
  }).filter(Boolean);
  return render.join(SEP);
}

// Expande abreviaturas litúrgicas y de puntuación para que el TTS lo lea bien.
// Se aplica a TODO el texto plano, no solo a la cita.
function expandirAbreviaturasLiturgicas(texto) {
  return texto
    // "Cf." / "cfr." en referencias bíblicas.
    .replace(/\bCf\.\s*/g, "Comparar con ")
    .replace(/\bcfr\.\s*/gi, "Comparar con ")
    // Abreviaturas litúrgicas entre paréntesis (tipos de celebración).
    .replace(/\(ML\)/g, "(Memoria Libre)")
    .replace(/\(M\)/g, "(Memoria)")
    .replace(/\(F\)/g, "(Fiesta)")
    .replace(/\(S\)/g, "(Solemnidad)")
    // Santos y títulos religiosos.
    .replace(/\bSta\.\s*/g, "Santa ")
    .replace(/\bSto\.\s*/g, "Santo ")
    .replace(/\bHno\.\s*/g, "Hermano ")
    .replace(/\bPbro\.\s*/g, "Presbítero ")
    .replace(/\bRev\.\s*D\.\s*/g, "Reverendo Don ")
    .replace(/\bRev\.\s*/g, "Reverendo ")
    .replace(/\bDr\.\s*/g, "Doctor ")
    .replace(/\bD\.\s+/g, "Don ")            // "D. Pedro" -> "Don Pedro"
    // Abreviaturas generales.
    .replace(/\bp\.\s*ej\.\s*/gi, "por ejemplo ")
    .replace(/\betc\.\s*/g, "etcétera ")
    .replace(/\ba\.\s*C\.\s*/g, "antes de Cristo ")
    .replace(/\bd\.\s*C\.\s*/g, "después de Cristo ")
    // "Sal 73" -> "Salmo 73" (referencias a Salmos dentro del texto).
    .replace(/\bSal\s+(\d)/g, "Salmo $1")
    // "+" al inicio de línea antes del Evangelio (señal de la cruz).
    .replace(/^\s*\+\s+/gm, "")
    // "R." aislado al inicio de línea (respuesta del salmo) -> omitir.
    .replace(/^\s*R\.\s*/gm, "")
    // "v." / "vv." antes de número -> "versículo(s)".
    .replace(/\bv\.\s*(\d)/g, "versículo $1")
    .replace(/\bvv\.\s*(\d)/g, "versículos $1");
}

// Detecta líneas tipo "Mt 18,15-20" o "1Cor 13, 1-3".
function esCitaBiblica(s) {
  return /^\d{0,3}\s*[A-Za-zÁÉÍÓÚáéíóúÑñ]{1,5}\s+\d/.test(s);
}

// "Mt 18,15-20" -> "Mateo 18, 15 al 20"
// "1Cor 13, 1-3" -> "Primera de Corintios 13, 1 al 3"
function expandirCita(cita) {
  return cita.replace(
    /^(\d{1,3})?\s*([A-Za-zÁÉÍÓÚáéíóúÑñ]{1,5})\b/,
    (m, num, abbr) => {
      // Caso "1Cor" -> key directa en ABBR.
      if (num && ABBR[`${num}${abbr}`]) return ABBR[`${num}${abbr}`];
      // Caso "Mt" solo.
      if (!num && ABBR[abbr]) return ABBR[abbr];
      // Caso "1 Pe" -> "Primera de Pedro".
      if (num && ABBR[abbr]) {
        const pref =
          num === "1" ? "Primera de " :
          num === "2" ? "Segunda de " :
          num === "3" ? "Tercera de " :
          `${num} `;
        return pref + ABBR[abbr];
      }
      return m;
    }
  );
}

// Si se ejecuta directamente: `node src/format.js [ruta-json] [plain]`
// Imprime el mensaje formateado a stdout (modo WhatsApp por defecto, 'plain' para TTS).
if (import.meta.url === `file://${process.argv[1]}`) {
  const archivo = process.argv[2] || findLatest("data");
  const modo = process.argv[3] || "whatsapp";
  if (!archivo) {
    console.error("Uso: node src/format.js <ruta-a-json> [whatsapp|plain]");
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(archivo, "utf8"));
  const out =
    modo === "plain" ? formatearTextoPlano(data) : formatear(data);
  process.stdout.write(out + "\n");
}

function findLatest(dir) {
  try {
    const files = readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse();
    return files.length ? join(dir, files[0]) : null;
  } catch {
    return null;
  }
}

export {
  formatear,
  formatearTextoPlano,
  extraerCita,
  extraerFechaHumana,
  expandirCita,
  esCitaBiblica,
  expandirAbreviaturasLiturgicas,
  tituloCitaWhatsApp,
  citaHablada,
};
