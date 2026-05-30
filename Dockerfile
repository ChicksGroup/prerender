# Prerender server image for DigitalOcean App Platform.
#
# The `prerender` package does NOT bundle a browser, so we install Chromium
# here and point the server at it with CHROME_LOCATION. The container also needs
# the headless-Chrome flags set via EXTRA_CHROME_FLAGS (see bottom).
FROM node:20-bookworm-slim

# Chromium + the system libraries headless Chrome needs to launch and render.
# (chromium pulls most of these in transitively; fonts + a few libs are listed
# explicitly so rendering is correct and stable.)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    libnss3 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libasound2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxfixes3 \
    libxext6 \
    libpango-1.0-0 \
    libcairo2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (node_modules excluded via .dockerignore so the layer above stands).
COPY . .

# Drop privileges to the unprivileged `node` user that ships with the base image.
RUN chown -R node:node /app
USER node

# --no-sandbox / --disable-setuid-sandbox: required to run Chrome as non-root in
#   a container. --disable-dev-shm-usage: App Platform can't size /dev/shm, so
#   write shared memory to /tmp to avoid "Target closed" crashes.
ENV NODE_ENV=production \
    PORT=3000 \
    CHROME_LOCATION=/usr/bin/chromium \
    EXTRA_CHROME_FLAGS="--no-sandbox --disable-dev-shm-usage --disable-setuid-sandbox"

EXPOSE 3000

CMD ["node", "server.js"]
