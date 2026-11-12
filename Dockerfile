# syntax=docker/dockerfile:1.7

# LearnHarness production image.
#
# The app is a Next.js 16 standalone server. `npm run build` compiles the
# core plugin packages, emits the self-contained `.next/standalone`
# (server.js + traced node_modules), and scripts/build-server.mjs then
# copies public/.next/static plus the plugin payload into it and runs the
# repo's payload safety checks. The runtime stage ships only that folder,
# Node, CA certificates, fonts and the privilege-drop helper. Chromium is
# opt-in because the server runs without it.

ARG NODE_VERSION=26

# ─── Build ──────────────────────────────────────────────────────────────────
# Single stage on purpose: `npm ci` + `next build` need ~2 GB of scratch
# space, and copying node_modules between stages doubles that. The build
# artifacts are moved to /out and the scratch trees are deleted inside the
# same layer, so the committed layer stays small.
FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1

COPY package.json package-lock.json ./

# Runtime dependencies only, plus the dev tools the production build
# actually uses: Tailwind/PostCSS compile the CSS; TypeScript and
# @types/node drive the plugin SDK type emission (scripts/build-plugin-types.mjs
# resolves both from the repo root). Omitting the rest keeps
# electron-builder/eslint/etc. out of the traced standalone payload, which is
# the bulk of a full install.
RUN npm ci --omit=dev --no-audit --no-fund \
 && node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));delete p.devDependencies;fs.writeFileSync('package.json',JSON.stringify(p,null,'\t')+'\n')" \
 && npm install --no-save --omit=dev --no-audit --no-fund \
        tailwindcss@4.3.3 \
        @tailwindcss/postcss@4.3.3 \
        typescript@5.9.3 \
        @types/node@24.13.3 \
 && npm cache clean --force

COPY . .

# The core plugin packages are separate npm projects (esbuild et al.) and are
# compiled by `npm run build`; install their locked dependencies exactly like
# CI does. Their node_modules never ship — they are deleted after the build.
RUN npm run plugins:setup

# Same gates as CI's standalone job: build, offline provider-runtime probe,
# payload curation (data/secrets never ship; prompt assets must be traced).
RUN npm run build \
 && node scripts/smoke-provider-runtime.mjs \
 && node scripts/build-server.mjs

# Build-only trees inside the traced payload. The server reads just a few
# things from disk at request time: src/agent/prompts (+ system-prompt.md),
# src/agent/image-processing workers, core-plugins/, public/ and
# scripts/plugin-loader.cjs. Sources, docs, tests and the authoring project
# are build inputs, so drop them here — then the smoke gate validates exactly
# what ships.
RUN cd .next/standalone \
 && rm -rf app components lib electron tests docs build examples skills \
           plugin-authoring AGENTS.md CONTRIBUTING.md README.md SECURITY.md \
           Dockerfile docker-compose.yml electron-builder.yml \
           eslint.config.mjs postcss.config.mjs tsconfig.json next.config.ts \
           proxy.ts package-lock.json instrumentation.ts

# Boot the pruned payload and probe the API surface (plus the plugin and
# authoring-download routes). Only after the gate passes: move it out and drop
# the build trees.
RUN node scripts/smoke-server.mjs \
 && mv .next/standalone /out \
 && rm -rf .next node_modules core-plugins plugins/*/node_modules plugins/*/.sdk

# ─── Runtime ────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runner
WORKDIR /app

# Chromium powers the demo-builder's mandatory verification pass. It is a
# large optional dependency, so the default runtime is bare minimum: the
# server works without it and demo/visual verification reports a clear
# "no render engine" error. Build with WITH_CHROMIUM=1 to include it.
ARG WITH_CHROMIUM=0

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    LH_DATA_DIR=/data \
    LH_AUTH_FILE=/data/auth.json \
    CHROME_PATH=/usr/bin/chromium

# ca-certificates: outbound HTTPS to model providers.
# fontconfig + DejaVu: text rendering for Chromium, resvg and PDF output.
# chromium: browser used by src/agent/subagents/headless.ts.
# gosu: drop root in the entrypoint after fixing volume ownership.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        fontconfig \
        fonts-dejavu-core \
        gosu; \
    if [ "$WITH_CHROMIUM" = "1" ]; then \
        apt-get install -y --no-install-recommends chromium; \
    fi; \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /data && chown node:node /data

# Runtime needs Node only — drop npm/npx from the image.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

COPY --from=builder --chown=node:node /out ./

# Root only during the entrypoint's chown; the server itself runs as node.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

EXPOSE 3000
VOLUME ["/data"]

# The standalone server answers GET / once it is ready. Use Node's own fetch
# so the slim image needs no curl/wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
