# Backend container: API + worker + both mock gateways (see scripts/start-prod.mjs).
# The dashboard is deployed separately (Vercel); see DEPLOY.md.
#
# Base image from the AWS ECR Public mirror of the official Docker Hub image
# (identical image; avoids Docker Hub rate limits and auth hiccups).
FROM public.ecr.aws/docker/library/node:22-bookworm-slim

# Prisma's query engine needs OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@12.11.2

WORKDIR /app

# Install dependencies first (cached between builds while only code changes).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma
COPY apps/mock-gateway/package.json apps/mock-gateway/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/shared/package.json packages/shared/
COPY packages/routing/package.json packages/routing/
RUN pnpm install --frozen-lockfile

# Then the source.
COPY . .

ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "scripts/start-prod.mjs"]
