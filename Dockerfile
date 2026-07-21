# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

FROM oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f AS pnpm

# @pnpm/exe carries its own Node runtime. libatomic is needed by that executable
# on Debian/arm64; this tooling remains outside the production image.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends libatomic1 \
  && rm -rf /var/lib/apt/lists/* \
  && bun install --global @pnpm/exe@11.9.0 \
  && chmod +x /root/.bun/install/global/node_modules/@pnpm/exe/pn \
    /root/.bun/install/global/node_modules/@pnpm/exe/pnpm \
    /root/.bun/install/global/node_modules/@pnpm/exe/pnpx \
    /root/.bun/install/global/node_modules/@pnpm/exe/pnx \
  && test "$(pnpm --version)" = "11.9.0"

WORKDIR /app

FROM pnpm AS manifests

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/service/package.json apps/service/package.json
COPY packages/api-contract/package.json packages/api-contract/package.json

FROM manifests AS build

RUN pnpm install --frozen-lockfile --filter @nusend/service...
COPY packages/api-contract packages/api-contract
RUN pnpm --filter @nusend/api-contract build

FROM manifests AS production-dependencies

RUN pnpm install --prod --frozen-lockfile --filter @nusend/service...

FROM oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f AS runtime

ARG SOURCE_REVISION
ARG VERSION=unknown
RUN test -n "${SOURCE_REVISION}" \
  && groupadd --gid 10001 nusend \
  && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin nusend \
  && mkdir -p /var/lib/nusend \
  && chown 10001:10001 /var/lib/nusend \
  && chmod 0700 /var/lib/nusend

LABEL org.opencontainers.image.source="https://github.com/maxedapps/nusend" \
  org.opencontainers.image.revision="${SOURCE_REVISION}" \
  org.opencontainers.image.version="${VERSION}"

ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/apps/service/node_modules ./apps/service/node_modules
COPY --from=production-dependencies /app/packages/api-contract/node_modules ./packages/api-contract/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY apps/service/package.json apps/service/package.json
COPY apps/service/src apps/service/src
COPY packages/api-contract/package.json packages/api-contract/package.json
COPY --from=build /app/packages/api-contract/dist ./packages/api-contract/dist

USER 10001:10001
EXPOSE 3000

# Clear the base image wrapper so the direct Bun command is the application
# process (or the direct child of Compose's requested init process).
ENTRYPOINT []
CMD ["bun", "apps/service/src/main.ts"]
