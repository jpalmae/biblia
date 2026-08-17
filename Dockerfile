# Daemon: Node.js (whatsapp-web.js + cron) + Python 3 (scraper).
# Imagen base: Node 20 sobre Debian Bookworm slim. Le añadimos Python 3
# y las dependencias de sistema que Puppeteer/Chromium necesita.
FROM node:20-bookworm-slim

# Timezone por defecto (puede sobreescribirse en docker-compose / .env).
ENV TZ=America/Santiago \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# Deps de sistema: Python, pip, Chromium nativo para ARM/x86 (Puppeteer),
# y librerías nativas que Chromium necesita.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv \
        ca-certificates \
        chromium \
        fonts-liberation \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libgtk-3-0 \
        libnss3 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxrandr2 \
        libxkbcommon0 \
        libpangocairo-1.0-0 \
        libxshmfence1 \
        wget \
        tini \
    && rm -rf /var/lib/apt/lists/*

# Evitar que Puppeteer descargue su propio Chrome (ya tenemos chromium del sistema).
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Instalar dependencias Python primero (mejor cache).
COPY requirements.txt ./
RUN pip3 install --break-system-packages -r requirements.txt

# Instalar dependencias Node.
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copiar el resto del código.
COPY scraper ./scraper
COPY src ./src
COPY entrypoint.sh ./entrypoint.sh

# Directorios de datos (se montan como volúmenes en compose).
RUN mkdir -p /app/data /app/.wwebjs_auth /app/.wwebjs_cache

EXPOSE 8080

# tini como PID 1 (manejo correcto de señales) + entrypoint que limpia locks
# de Chromium viejos + node por defecto.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD ["node", "src/index.js"]
