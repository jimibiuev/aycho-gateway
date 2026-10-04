# AYCHO 后端网关 · 部署说明

这是 AYCHO 网页（aycho.de5.net 静态站）需要的**唯一后端**，一次部署即可同时打通：
邮箱验证码、真实对话、分享链接、多端同步、文件树、浏览器代理、终端。

- 运行入口：`terminal-server.js`（原生 http + ws，除终端外零第三方依赖）
- 健康检查：`GET /api/health`（返回各能力开关，`smtp:true` 表示发信通道已就绪）
- 监听端口：优先取平台注入的 `PORT`，否则 `8787`

> 部署前请先确认 `.env` / 环境变量里的 `AYCHO_SMTP_*` 完整。
> 缺任一 SMTP 项时，`/api/auth/send-code` 会直接返回 502 报错（**不会**把验证码回传给前端）。

---

## 方式 A：Render 免费实例（推荐，无需服务器）

1. 把本目录（`aycho-backend` 解压后的内容）推到一个 GitHub 仓库（**不要**把 `.env` 提交上去）。
2. 打开 https://dashboard.render.com → New → **Web Service** → 连接该仓库。
3. Render 会自动读到仓库根目录的 `render.yaml` 与 `Dockerfile`，直接确认创建。
4. 在 Environment 里逐个填入（值取自你本地 `.env`）：
   `AYCHO_MODEL_BASE_URL`、`AYCHO_MODEL_API_KEY`、`AYCHO_MODEL_NAME`、
   `AYCHO_SMTP_HOST`、`AYCHO_SMTP_PORT`、`AYCHO_SMTP_USER`、`AYCHO_SMTP_PASS`、`AYCHO_MAIL_FROM`。
5. 等构建完成，访问 `https://<你的服务名>.onrender.com/api/health`，
   看到 `"smtp": true` 即代表邮件通道就绪。
6. 打开 https://aycho.de5.net → 设置中心 → 「后端网关」，填入 `https://<你的服务名>.onrender.com`。

免费实例闲置一段时间会休眠，首次唤醒需十几秒，属正常。

## 方式 B：任意 VPS / 已有 Docker 环境

```bash
cd aycho-backend
docker build -t aycho-gateway .
docker run -d --name aycho-gateway -p 8787:8787 \
  -e AYCHO_MODEL_BASE_URL=... -e AYCHO_MODEL_API_KEY=... -e AYCHO_MODEL_NAME=... \
  -e AYCHO_SMTP_HOST=smtp.qq.com -e AYCHO_SMTP_PORT=465 \
  -e AYCHO_SMTP_USER=你的邮箱 -e AYCHO_SMTP_PASS=授权码 \
  -e AYCHO_MAIL_FROM=你的邮箱 -e AYCHO_CORS='*' \
  -v $PWD/data:/app/data \
  aycho-gateway
```

`-v $PWD/data:/app/data` 用于持久化账号与验证码数据；云免费实例没有持久盘，实例重建后账号会重置。

## 方式 C：手机 Termux 自建

```bash
pkg install nodejs-lts git -y
cd aycho-backend && npm install
node terminal-server.js --host 0.0.0.0 --port 8787
```

手机自建要让公网页面访问到，需要一个 https 隧道：

```bash
# Cloudflare 临时隧道（免费，给出 https://xxx.trycloudflare.com）
npx cloudflared tunnel --url http://127.0.0.1:8787
```

把隧道给出的 https 地址填进站点设置中心的「后端网关」即可。
注意：临时隧道重启后地址会变，需要重新填一次。

---

## 部署后自检清单

| 检查项 | 方法 | 期望 |
|--------|------|------|
| 网关在线 | 浏览器打开 `/api/health` | `ok:true` |
| 邮件通道 | 同上，看 `features.smtp` | `true` |
| 模型通道 | 同上，看 `features.chat` | `true` |
| 验证码真发 | 站点注册页输入邮箱点发送 | 邮箱收到 6 位验证码 |
| 跨域放行 | 静态站调用不被浏览器拦截 | 控制台无 CORS 报错 |

## 常见问题

- **接口返回 502「验证码邮件发送失败」**：SMTP 未配置或授权码错误。QQ 邮箱需用「授权码」而非登录密码。
- **静态站提示跨域失败**：环境变量 `AYCHO_CORS` 设为 `*`，或填站点域名白名单。
- **终端面板连不上**：部分免费平台不支持 WebSocket 升级；其余功能不受影响。
