// Parche temporal: aplica wwebjs/whatsapp-web.js PR #201925 sobre la version
// 1.34.7 instalada en node_modules. Problema: WhatsApp cambio su bundle y el
// envio de medios crashea con "Data passed to getter must include an id
// property (it's how we memoize) but got undefined" (issue #201922).
// El PR oficial aun no esta liberado en npm; cuando salga una version >=1.35
// se puede eliminar este parche.
//
// Idempotente: si detecta el parche aplicado, no hace nada.
// Falla el build si no encuentra los anclajes (version cambio demasiado).

import { readFileSync, writeFileSync } from "node:fs";

const FILE = "node_modules/whatsapp-web.js/src/util/Injected/Utils.js";

let src = readFileSync(FILE, "utf8");

if (src.includes("cleanMediaOptions")) {
  console.log(`[patch] ${FILE}: parche ya aplicado, no se toca nada.`);
  process.exit(0);
}

function replaceOnce(label, oldStr, newStr) {
  const n = src.split(oldStr).length - 1;
  if (n !== 1) {
    console.error(
      `[patch] ERROR: ancla "${label}" aparece ${n} veces (se esperaba 1). ` +
        "La version de whatsapp-web.js cambio; revisa/actualiza el parche."
    );
    process.exit(1);
  }
  src = src.replace(oldStr, newStr);
}

// Reemplaza SOLO la primera ocurrencia (p.ej. el mismo patron existe en
// sendMessage y en editMessage; el de sendMessage viene primero).
function replaceFirst(label, oldStr, newStr) {
  const i = src.indexOf(oldStr);
  if (i === -1) {
    console.error(
      `[patch] ERROR: ancla "${label}" no encontrada. ` +
        "La version de whatsapp-web.js cambio; revisa/actualiza el parche."
    );
    process.exit(1);
  }
  src = src.slice(0, i) + newStr + src.slice(i + oldStr.length);
}

// Hunk 1: constructor de MsgKey con nuevo formato (fromMe/remote) y fallback
// al viejo (from/to/selfDir).
replaceOnce(
  "msgkey-ctor",
  `        const newMsgKey = new (window.require('WAWebMsgKey'))({
            from: from,
            to: chat.id,
            id: newId,
            participant: participant,
            selfDir: 'out',
        });`,
  `        let newMsgKey;
        try {
            newMsgKey = new (window.require('WAWebMsgKey'))({
                fromMe: true,
                remote: chat.id,
                id: newId,
                participant: participant,
            });
        } catch {
            newMsgKey = new (window.require('WAWebMsgKey'))({
                from: from,
                to: chat.id,
                id: newId,
                participant: participant,
                selfDir: 'out',
            });
        }`
);

// Hunk 2a: copias limpias de mediaOptions sin el id (era la causa del crash
// del getter memoize).
replaceOnce(
  "clean-media-insert",
  `        const ephemeralFields = window
            .require('WAWebGetEphemeralFieldsMsgActionsUtils')
            .getEphemeralFields(chat);

        const message = {`,
  `        const ephemeralFields = window
            .require('WAWebGetEphemeralFieldsMsgActionsUtils')
            .getEphemeralFields(chat);

        const cleanMediaOptions = { ...mediaOptions };
        const cleanMediaJson = mediaOptions.toJSON ? mediaOptions.toJSON() : {};
        delete cleanMediaOptions.id;
        delete cleanMediaJson.id;

        const message = {`
);

// Hunk 2b: el id del mensaje se define AL FINAL (antes lo pisaban las
// opciones de media).
replaceOnce(
  "id-early-remove",
  `        const message = {
            ...options,
            id: newMsgKey,
            ack: 0,`,
  `        const message = {
            ...options,
            ack: 0,`
);

replaceOnce(
  "media-spreads",
  `            ...ephemeralFields,
            ...mediaOptions,
            ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}),
            ...quotedMsgOptions,`,
  `            ...ephemeralFields,
            ...cleanMediaOptions,
            ...cleanMediaJson,
            ...quotedMsgOptions,`
);

replaceFirst(
  "id-late-add",
  `            ...extraOptions,
        };`,
  `            ...extraOptions,
            id: newMsgKey,
        };`
);

// Hunk 3: retorno resiliente si Msg.get no encuentra el mensaje recien enviado.
replaceOnce(
  "return-resilient",
  `        return window
            .require('WAWebCollections')
            .Msg.get(newMsgKey._serialized);`,
  `        const keyStr = newMsgKey._serialized || (newMsgKey.toString ? newMsgKey.toString() : String(newMsgKey));
        return (
            window.require('WAWebCollections').Msg.get(keyStr) ||
            message
        );`
);

writeFileSync(FILE, src);
console.log(`[patch] ${FILE}: parche PR#201925 aplicado correctamente.`);
