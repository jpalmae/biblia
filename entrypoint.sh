#!/bin/sh
set -e

# Limpiar locks de Chromium dejados por corridas previas que no se cerraron
# bien (caída del contenedor, OOM kill, etc.). Sin esto, Puppeteer rehúsa
# arrancar diciendo "The profile appears to be in use by another Chromium".
SESSION_DIR="/app/.wwebjs_auth/session"
if [ -d "$SESSION_DIR" ]; then
  find "$SESSION_DIR" -maxdepth 1 -name 'Singleton*' -delete 2>/dev/null || true
  find "$SESSION_DIR" -maxdepth 1 -name 'DevToolsActivePort' -delete 2>/dev/null || true
fi

# Ejecutar el comando (por defecto: node src/index.js).
exec "$@"
