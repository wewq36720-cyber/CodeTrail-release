# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build

ARG NPM_REGISTRY=https://registry.npmmirror.com

WORKDIR /build

# 容器内没有宿主 ~/.npmrc：显式指定镜像源 + 重试参数，容忍国内网络抖动（ECONNRESET/ECONNREFUSED）
# cache mount 让已下载的 tarball 跨构建尝试保留，大包装载中断后只需重试失败部分
RUN npm config set registry ${NPM_REGISTRY} \
    && npm config set fetch-retries 8 \
    && npm config set fetch-retry-mintimeout 10000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm config set fetch-timeout 600000 \
    && npm config set maxsockets 3 \
    && npm config set fund false audit false

COPY server/package.json server/package-lock.json ./server/
RUN --mount=type=cache,target=/root/.npm npm ci --prefix server
COPY server/ ./server/
RUN npm run build --prefix server && npm prune --prefix server --omit=dev

COPY client/package.json client/package-lock.json ./client/
RUN --mount=type=cache,target=/root/.npm npm ci --prefix client
COPY client/ ./client/
RUN npm run build --prefix client

FROM node:24-bookworm-slim AS runtime

ARG DEBIAN_MIRROR=mirrors.tuna.tsinghua.edu.cn

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    LEARNDESK_DIR=/data/.learndesk \
    UV_CACHE_DIR=/tmp/uv-cache

RUN sed -i "s@deb.debian.org@${DEBIAN_MIRROR}@g; s@security.debian.org@${DEBIAN_MIRROR}/debian-security@g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install --fix-missing -y --no-install-recommends \
       ca-certificates \
       git \
       libarchive-tools \
       python3 \
       python3-venv \
    && python3 -m venv /opt/uv \
    && /opt/uv/bin/pip install --no-cache-dir uv==0.12.5 \
    && ln -s /opt/uv/bin/uv /usr/local/bin/uv \
    && ln -s /usr/bin/python3 /usr/local/bin/python \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /build/server/package.json ./server/package.json
COPY --from=build /build/server/dist ./server/dist
COPY --from=build /build/server/node_modules ./server/node_modules
COPY --from=build /build/client/dist ./client/dist

RUN mkdir -p /data/.learndesk /tmp/uv-cache \
    && chown -R node:node /app /data /tmp/uv-cache

USER node
WORKDIR /app/server

EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
