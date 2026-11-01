# syntax=docker/dockerfile:1
# wagon-payroll-verify — serves the pre-generated static pay-verify dashboard
# (index.html + report/) via an unprivileged nginx. The dashboard is produced by
# the pay-verify-site workflow's generator (packages/verify-site) from the
# verify-summary history; this image only serves that static output — no app
# code, no data, PII-free/synthetic, same posture as ta-verify.
#
# There is NO build stage here: the workflow generates packages/verify-site/dist
# (validated + PII-guarded) and hands it to this image via the build context;
# the image just copies it. Build context is the repo root.
#
# SECURITY: nginx-unprivileged runs as non-root (uid 101) on port 8080. Public
# exposure, TLS and the LAN/VPN access gate are the BCN NPM's job (chunk D); this
# server is reached by the proxy over the shared docker network.
# 1.30 is the maintained stable line; 1.27 stopped receiving rebuilds in
# 2025-06 (Alpine 3.21.3) and its OpenSSL failed the Trivy gate (CVE-2026-31789).
FROM nginxinc/nginx-unprivileged:1.30-alpine AS runtime
# Upstream rebuilds the tag only every few weeks, so a fixed Alpine CVE can sit
# in the base for days (brotli-libs CVE-2026-111497, fixed in 1.2.1-r0, failed
# the Trivy gate on 2026-10-31). Take Alpine's security fixes at build time;
# Trivy still scans the exact image before it is pushed. Back to the base
# image's non-root user (uid 101) afterwards.
USER root
RUN apk upgrade --no-cache
USER 101
COPY packages/verify-site/nginx.conf /etc/nginx/conf.d/default.conf
# dist/site is the generated document set only (index.html + report/); the
# compiled generator JS lives at dist/ root and is deliberately not served.
COPY packages/verify-site/dist/site /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1
