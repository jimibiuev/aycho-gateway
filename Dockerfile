# AYCHO Gateway Dockerfile（Railway / Render 通用）
# node-pty 是 C++ 原生模块，必须编译成功 + 运行时能加载。
# 崩溃根因通常是：.node 二进制缺失 / glibc 不匹配 / 编译工具缺失。
# 本镜像在构建期编译 node-pty，并加启动自检（加载失败立刻报错可读）。
FROM node:20

WORKDIR /app

# 编译工具（node-pty 1.1+ 需要 node-gyp + python + make + g++）
# node:20 镜像已内置 gcc/g++/make，确认存在
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 先装依赖（利用镜像层缓存）
COPY package.json package-lock.json* ./
RUN npm install --omit=dev \
    && node -e "require('node-pty'); console.log('node-pty 加载 OK')" \
    && echo "build-time pty check passed"

# JDK（IDE 语言运行时）
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk-headless \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY . .

ENV PTY_HOST=0.0.0.0
ENV NODE_ENV=production
EXPOSE 8787

# 启动自检：先确认 node-pty 能加载，再启服务；加载失败立刻可读报错
CMD ["sh", "-c", "node -e \"try{require('node-pty');console.log('[boot] node-pty OK')}catch(e){console.error('[boot][FATAL] node-pty 加载失败:',e.message);process.exit(1)}\" \
    && node terminal-server.js --host 0.0.0.0 --port ${PORT:-8787}"]
