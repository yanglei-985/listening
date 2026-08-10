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
- `POST /api/accounts/login`
- `GET /api/teacher/dashboard?teacher_id=...&content_id=...`
- `POST /api/heard`
- `POST /api/caption-jobs`
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

## Demo accounts

- Teacher access code: `teacher-demo`
- Student access code: `student-demo`

Student playback position is stored in `listening_presence`. Teacher dashboard reads each student's current sentence and red/yellow checkpoints.

## VideoCaptioner

Cloudflare Worker does not run VideoCaptioner directly. It calls an HTTP service through `VIDEOCAPTIONER_API_BASE`.

Expected service shape for the first adapter:

```http
POST /jobs
Content-Type: application/json

{
  "title": "...",
  "source_url": "https://...",
  "output": "srt",
  "language": "en"
}
```

The response can either return `{"status":"processing","job_id":"..."}` or return `{"srt":"..."}` directly. Returned SRT is strictly validated before it is saved.
