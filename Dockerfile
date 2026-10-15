# Lightsail runs linux/amd64:
#   docker build --platform linux/amd64 \
#     --build-arg VITE_SUPABASE_URL=... --build-arg VITE_SUPABASE_PUBLISHABLE_KEY=... -t charter .
FROM node:22-bookworm-slim AS build

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CI=true

# Vite inlines only VITE_* into the SPA. These must exist at `pnpm build` time.
# Pass them with `docker build --build-arg VITE_SUPABASE_URL=... --build-arg ...`.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY
# Without these the SPA builds fine but sign-in is silently disabled.
RUN test -n "$VITE_SUPABASE_URL" && test -n "$VITE_SUPABASE_PUBLISHABLE_KEY" \
  || (echo 'VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY build args are required' >&2; exit 1)

RUN npm install -g pnpm@9.15.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile \
  && pnpm exec turbo run build --filter=@charter/core-api --filter=@charter/concierge-web \
  && pnpm --filter @charter/core-api deploy --prod /out \
  && rm -rf /out/dist && cp -r apps/core-api/dist /out/dist

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV NODE_OPTIONS=--max-old-space-size=512

COPY --from=build --chown=node:node /out ./

USER node
EXPOSE 3000

CMD ["node", "dist/server.js"]
