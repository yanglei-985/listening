# Listening 卡点系统

这是一个听力 MVP：前端部署在 GitHub Pages，API 部署在 Cloudflare Worker，学习数据写入 D1 数据库 `listening`。

## 当前链路

- `docs/`：GitHub Pages 静态前端
- `worker/src/index.js`：Cloudflare Worker API
- `migrations/0001_init.sql`：D1 schema 和 demo 内容
- `wrangler.toml`：Worker 与 D1 绑定配置

## 本地命令

```powershell
npm install
npx wrangler d1 migrations apply listening --local
npx wrangler dev --local
npx http-server docs -p 4173
```

## API

- `GET /health`
- `GET /api/contents`
- `POST /api/contents`
- `GET /api/contents/:id`
- `POST /api/attempts`
- `GET /api/progress?learner_id=...&content_id=...`
- `GET /api/review?learner_id=...&content_id=...`

## 红黄绿规则

- 第一遍懂：绿
- 不确定或没听懂：红
- 红句复听懂：黄
- 黄句再次听懂：绿

