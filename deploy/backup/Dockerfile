FROM restic/restic:0.19.0@sha256:7f44e0057b82348597568ea209360762d0b38f8e1dbc8ad859661ac1055e45f2 AS restic

FROM alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40

ARG SOURCE_REVISION
ARG VERSION=unknown
RUN test -n "${SOURCE_REVISION}" \
  && apk add --no-cache \
      sqlite=3.51.2-r0 \
      util-linux=2.41.4-r0 \
      ca-certificates=20260611-r0 \
  && addgroup -S -g 10001 nusend \
  && adduser -S -D -H -h /nonexistent -s /sbin/nologin -u 10001 -G nusend nusend \
  && mkdir -p /work \
  && chown 10001:10001 /work

LABEL org.opencontainers.image.source="https://github.com/maxedapps/nusend" \
  org.opencontainers.image.revision="${SOURCE_REVISION}" \
  org.opencontainers.image.version="${VERSION}"

COPY --from=restic /usr/bin/restic /usr/local/bin/restic
COPY --chmod=0555 backup.sh /usr/local/bin/backup.sh

USER 10001:10001
ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["schedule"]
