# Native package maintainers; installation never runs this image.
FROM node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
RUN apt-get update && apt-get install -y --no-install-recommends clang make perl bison flex binutils libc6-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /package
COPY --chown=node:node . /package
USER node
CMD ["sh", "-c", "node native/build.mjs && node native/ci-server.mjs"]
