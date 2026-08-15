FROM node:24.18.1-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /source
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter pactmark-node-quickstart build
RUN pnpm --filter pactmark-node-quickstart deploy --prod --offline --trust-lockfile --config.inject-workspace-packages=true --config.dedupe-injected-deps=false /product

FROM node:24.18.1-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV PACTMARK_BIND_HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /product ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
