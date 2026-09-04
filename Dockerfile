FROM node:20-bookworm-slim

WORKDIR /app

ENV HOST=0.0.0.0
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CI=true

# Vite inlines only VITE_* into the SPA. These must exist at `pnpm build` time.
# Railway/Render pass service variables as Docker build-args matching ARG names.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile \
  && pnpm exec turbo run build --filter=@charter/core-api --filter=@charter/concierge-web

EXPOSE 3000

CMD ["pnpm", "start"]
