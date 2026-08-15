FROM node:24.18.1-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /source
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter pactmark-node-quickstart build
RUN pnpm --filter pactmark-node-quickstart deploy --prod --offline --trust-lockfile --config.inject-workspace-packages=true --config.dedupe-injected-deps=false /product

FROM node:24.18.1-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV PACTMARK_BIND_HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /product ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
