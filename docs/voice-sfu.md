# 语音 SFU

OMEW 的语音频道使用 LiveKit WebRTC SFU。只有据点成员能取连接 token；私密据点、受限频道与封禁继续沿用现有权限检查。拥有 `deny channel speak` 的成员只能收听。创建/编辑频道时由据点管理员启用“语音”；频道仍保留文字能力，话题分区不支持语音。

## 本地开发

安装 [LiveKit Server](https://docs.livekit.io/transport/self-hosting/local/) 后运行 `livekit-server --dev`。它使用开发密钥 `devkey` / `secret`。将 `server/.dev.vars.example` 复制为 `server/.dev.vars`，配置 `LIVEKIT_URL=http://localhost:7880` 及这组开发密钥，然后启动 OMEW。`.dev.vars` 不要提交。

## 自部署

此仓库的 [Compose 配置](../infra/livekit/compose.yaml)面向单台 Linux 主机。运行 `livekit-server generate-keys` 生成独立的 LiveKit API key/secret，复制 `infra/livekit/.env.example` 为同目录 `.env` 并填入，再运行：

```sh
cd infra/livekit
docker compose up -d
```

使用 TLS 反向代理把 `wss://<LiveKit 域名>` 与 HTTPS API 转发到 LiveKit `7880`。LiveKit 自身需能通过 UDP `50000–60000` 与 TCP `7881` 收发 WebRTC 媒体；生产部署需在主机与云防火墙开放这些端口。浏览器连接地址必须有可信 TLS 证书。

在所用的 `server/wrangler.jsonc` 或 `server/wrangler.stardust.jsonc` 中将 `LIVEKIT_URL` 设为 `https://<LiveKit 域名>`，并通过 `cd server && pnpm exec wrangler secret put LIVEKIT_API_KEY` 与 `LIVEKIT_API_SECRET` 写入 Worker Secrets。`LIVEKIT_URL` 是 Worker 访问 LiveKit API 的 HTTPS 基址；客户端会自动使用对应的 WSS 地址。未设置这些值时，语音 token 接口返回 503，聊天和文字频道仍可用。

如需核对端到端音轨交换，请在两个真实浏览器客户端加入同一启用语音的频道，分别允许麦克风并确认互相收到音轨。Vitest 只验证服务端签发的 token、权限和 API 行为，不模拟 SFU 媒体交换。
