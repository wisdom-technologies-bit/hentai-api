# Bun runtime + Chromium, nothing else.
#
# The old image installed mongodb and redis-server from apt inside node:20; the
# mongodb package no longer exists in Debian's repos, so that build could not
# succeed, and both services belong outside the app container anyway.

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

FROM oven/bun:1
WORKDIR /app

# Chromium needs these shared libraries; bun's base image does not ship them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
      libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 \
      libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 \
      libxext6 libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 wget \
 && find /var/lib/apt/lists -type f -delete

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY tests ./tests

# The browser resolver is the only way to read the sources, so ship it.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN bunx playwright install --with-deps chromium && chmod -R 755 /ms-playwright

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Runtime check: the app must answer /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

CMD ["bun", "run", "start"]
