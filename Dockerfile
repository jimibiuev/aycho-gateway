# 语法：Node 20 完整镜像（含编译工具，node-pty 需要现场编译）
FROM node:20

WORKDIR /app

# 先装依赖，利用镜像层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# IDE 「运行」所需的语言运行时：JDK（Node / Python3 / gcc / g++ 基础镜像已自带）
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends openjdk-17-jdk-headless; \
    rm -rf /var/lib/apt/lists/*

COPY . .

ENV PTY_HOST=0.0.0.0
ENV NODE_ENV=production
EXPOSE 8787

# 平台会注入 PORT，未注入时回退 8787
CMD ["sh", "-c", "node terminal-server.js --host 0.0.0.0 --port ${PORT:-8787}"]
