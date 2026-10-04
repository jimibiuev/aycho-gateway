# 语法：Node 20 完整镜像（含编译工具，node-pty 需要现场编译）
FROM node:20

WORKDIR /app

# 先装依赖，利用镜像层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV PTY_HOST=0.0.0.0
ENV NODE_ENV=production
EXPOSE 7860

# 平台会注入 PORT，未注入时回退 8787
CMD ["sh", "-c", "node terminal-server.js --host 0.0.0.0 --port ${PORT:-7860}"]
