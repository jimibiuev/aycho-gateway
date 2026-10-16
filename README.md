# AYCHO terminal-server（B 模块 · 终端后端）

右侧工作台「终端」面板的真实后端：**node-pty 伪终端 + WebSocket**，并顺带静态托管前端目录（这样终端面板的
`same-origin` 直连候选也能命中，无需跨端口）。

> 未启动本服务时，前端会自动降级为**内置模拟 shell**（支持 `help / pwd / ls / cd / cat / echo / mkdir / touch / rm / mv / cp / tree / clear / date / whoami / open`，读写 `state.projectFiles`），
> 所以「双击 index.html」的离线场景依旧可用、无控制台报错。

## 安装

```bash
cd server
npm install          # 安装 node-pty 与 ws
npm start            # 默认 http://127.0.0.1:8787
```

`node-pty` 是原生模块，Linux/macOS 需要编译工具链（`build-essential` / `python3`）；
Windows 需 `windows-build-tools` 或 VS Build Tools。若安装失败，服务仍能启动，
`/health` 会返回 `pty:false` 与失败原因，前端此时会退回模拟 shell。

## 参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--port` | `8787` | 监听端口 |
| `--host` | `127.0.0.1` | 监听地址（需要局域网访问用 `0.0.0.0`） |
| `--cwd` | `server/..` | 终端初始工作目录 |
| `--static` | `server/..` | 静态托管目录（前端根目录） |
| `--shell` | `$SHELL` 或 `/bin/bash` | 使用的 shell |
| `--ring` | `262144` | 环形缓冲字节数（断线重连回放上限） |
| `--idle` | `0` | >0 时无活动会话则自动退出（毫秒，便于自测） |

示例：`node terminal-server.js --host 0.0.0.0 --port 8787 --cwd /home/me/project`

## 协议

客户端（`js/rb-terminal.js`）：

| 方向 | 消息 |
| --- | --- |
| C→S | `{type:'init', cols, rows, cwd}` |
| C→S | `{type:'input', data}`（含 Ctrl-C 的 `\u0003`、方向键等原始字节） |
| C→S | `{type:'resize', cols, rows}` |
| C→S | `{type:'clear'}` / `{type:'ping'}` |

服务端：

| 方向 | 消息 |
| --- | --- |
| S→C | `{type:'ready', cwd, shell, backend, buffered?}` |
| S→C | `{type:'data', data}` |
| S→C | `{type:'exit', code}` |
| S→C | `{type:'error', message}` / `{type:'pong'}` |

端点：

- `ws://<host>:<port>/pty` — 终端 WebSocket
- `GET /health` — 健康检查：`{ok, pty, ptyError, shell, cwd, clients}`
- `GET /*` — 静态文件（`/` → `index.html`）

## 行为说明

- **多会话**：每个 WebSocket 连接一个独立 PTY；`?cwd=/path` 可指定初始目录。
- **断线重连**：会话在最后一个连接断开后保留 30 秒（含环形缓冲输出），期间重连可续看历史。
- **缓冲回放**：新连接先收到缓冲内容（`data`），随后收到 `ready`。
- **尺寸同步**：`resize` 由前端按 xterm 实际尺寸计算后下发，避免 `vim` / `top` 错位。
- **安全**：默认只监听 `127.0.0.1`；本服务等价于本机 shell 暴露入口，请勿在公网无鉴权暴露。

## 前端侧联调

前端按 `same-origin → ws://localhost:8787/pty → ws://127.0.0.1:8787/pty` 顺序尝试，
可用 `localStorage['aycho.term.ws'] = 'ws://主机:端口/pty'` 覆盖。

```bash
# 一条命令起后端 + 前端
cd server && npm start
# 浏览器打开 http://127.0.0.1:8787/_dev/dev-b.html（或 /index.html）
```
