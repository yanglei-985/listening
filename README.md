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

Cloudflare Worker does not run VideoCaptioner directly. It calls the HTTP adapter in `caption-service/` through `VIDEOCAPTIONER_API_BASE`.

Groq settings for the caption service:

- `GROQ_API_BASE=https://api.groq.com/openai/v1`
- `GROQ_WHISPER_MODEL=whisper-large-v3-turbo`
- `GROQ_API_KEY` is a server-side secret and must not be exposed to Pages or Worker logs.

Expected service shape:

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

The response can either return `{"status":"processing","job_id":"..."}` or return `{"srt":"..."}` directly.

When the response is asynchronous, the Worker polls:

```http
GET /jobs/{job_id}
```

If the adapter returns SRT, the Worker strictly validates it before saving it to D1. The frontend also polls `/api/caption-jobs/:id` until the content is imported.

Run the adapter locally:

```powershell
cd caption-service
python -m venv .venv
.\\.venv\\Scripts\\Activate.ps1
pip install -r requirements.txt
$env:GROQ_API_KEY = "<your-groq-key>"
$env:GROQ_API_BASE = "https://api.groq.com/openai/v1"
$env:GROQ_WHISPER_MODEL = "whisper-large-v3-turbo"
uvicorn app:app --host 0.0.0.0 --port 8080
```

Deploy it on a server, then set the Worker variable:

```powershell
npx wrangler deploy --var VIDEOCAPTIONER_API_BASE:https://your-caption-service.example.com
```
