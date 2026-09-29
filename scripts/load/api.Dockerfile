# Load-harness image for the API (spec §11 "Load harness"). Linux deps are installed
# INSIDE the image (bcrypt, esbuild and the Prisma engine are native), so the host's
# macOS node_modules never enter it (api.Dockerfile.dockerignore).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates procps && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/hr/package.json apps/hr/
COPY apps/internal/package.json apps/internal/
COPY apps/client/package.json apps/client/
COPY apps/jobs/package.json apps/jobs/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx prisma generate --schema packages/db/prisma/schema.prisma
ENV NODE_ENV=production
CMD ["bash", "scripts/load/api-supervisor.sh"]
