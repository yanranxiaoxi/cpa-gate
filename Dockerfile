FROM docker.io/library/node:24-alpine
LABEL maintainer="XiaoXi <admin@soraharu.com>"
ENV ENV_PRODUCT=true
ENV SERVER_HOST=0.0.0.0
ENV SERVER_PORT=3001
ENV LOG_LEVEL=info
ENV PROJECT_NAME=cpa-gate
# CLIProxyAPI 默认端口；跨容器部署时用 -e CPA_MANAGEMENT_URL=... 覆盖
ENV CPA_MANAGEMENT_URL=http://127.0.0.1:8317
WORKDIR /home/node/app
# 安装生产依赖（后端以 ESM 方式 external 这些运行时依赖，由 Node 直接加载）
# 显式指定 pnpm 版本，避免 corepack 解析偏差
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate && pnpm install --prod --frozen-lockfile
# dist/ 内含 index.js（后端）与 public/（前端静态资源）
COPY ./dist/ ./
# 日志目录（winston daily-rotate 需可写）
RUN mkdir -p ./logs
EXPOSE 3001/tcp
ENTRYPOINT [ "node", "/home/node/app/index.js" ]
