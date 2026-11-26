# syntax=docker/dockerfile:1.7
# Builds the three web apps (marketing site, Super Admin portal, company app) and serves them with Nginx,
# which also terminates TLS and reverse-proxies /api to the API containers.
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY shared-ui/package.json shared-ui/
COPY marketing/package.json marketing/
COPY admin/package.json admin/
COPY company-app/package.json company-app/
RUN npm ci --no-audit --no-fund
COPY . .
ARG ROOT_DOMAIN=yourhrms.com
ARG BRAND_NAME="Lishnu HRMS"
ARG CONTACT_EMAIL=""
ARG CONTACT_PHONE=""
ENV VITE_ROOT_DOMAIN=${ROOT_DOMAIN} VITE_SITE_URL=https://www.${ROOT_DOMAIN} VITE_BRAND_NAME=${BRAND_NAME} \
    VITE_CONTACT_EMAIL=${CONTACT_EMAIL} VITE_CONTACT_PHONE=${CONTACT_PHONE}
RUN if [ -z "$VITE_CONTACT_EMAIL" ]; then export VITE_CONTACT_EMAIL=hello@${ROOT_DOMAIN}; fi && npm run build

FROM nginx:1.27-alpine AS runtime
RUN rm /etc/nginx/conf.d/default.conf
COPY --from=build /src/marketing/dist   /srv/marketing
COPY --from=build /src/admin/dist       /srv/admin
COPY --from=build /src/company-app/dist /srv/app
COPY nginx/templates/ /etc/nginx/templates/
COPY nginx/snippets/  /etc/nginx/snippets/
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
