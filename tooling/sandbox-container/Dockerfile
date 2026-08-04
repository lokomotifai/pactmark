FROM node:24.18.1-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3

WORKDIR /sandbox
COPY --chown=65532:65532 probe.mjs /sandbox/probe.mjs

USER 65532:65532
ENTRYPOINT ["node", "/sandbox/probe.mjs"]
