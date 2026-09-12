# OMEW 项目索引
> 最后更新：2026-09-11

## 项目目标
OMEW 是运行在 Cloudflare Workers 上的社区/聊天应用，提供 Web 静态资源、API、D1 数据库、R2 媒体存储和 Durable Objects。

## 技术栈
TypeScript、Hono/Workers、Vue 3/Vite、Wrangler、Vitest。

## 模块结构
- `server/`：Worker API、D1 migrations、Durable Objects 与 Wrangler 配置。
- `web/`：Vue 前端及 Vite 构建产物。
- `test/`：契约与 Worker 测试。
- `agents/`：任务审计记录。

## 相关指令
- [任务 110 审计](110_[Feature]_Overture部署支持/)
- [任务 112 发布](112_[Release]_OMEW1.0.0发布/)
- [任务 113 首页 Overture 部署入口](113_[Fix]_首页Overture部署入口/)
- [任务 114 Overture 正式使用条款](114_[Feature]_Overture正式使用条款/)
- [任务 115 Overture 权限声明](115_[Fix]_Overture权限声明/)
- [任务 116 Workers.dev 实例域](116_[Fix]_WorkersDev实例域/)
- [任务 117 可选自定义域](117_[Fix]_可选自定义域/)
- [任务 118 星尘站身份桥接与据点策略](118_[Feature]_星尘站身份桥接与据点策略/)
- [任务 119 默认据点创建策略](119_[Fix]_默认据点创建策略/)
