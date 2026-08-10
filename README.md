# Listening 卡点系统

这是一个听力 MVP：前端部署在 GitHub Pages，API 部署在 Cloudflare Worker，学习数据写入 Cloudflare D1 数据库 `listening`。

当前目标不是再做播放器，而是记录“学生具体哪一句没听懂”，让老师后台直接看到红句、黄句、当前位置和反复卡住的内容。

## 架构

- `docs/`：GitHub Pages 静态前端
- `worker/src/index.js`：Cloudflare Worker API
- `caption-service/`：Cloudflare Containers 里的字幕处理容器
- `migrations/0001_init.sql`：D1 schema 和 demo 数据
- `wrangler.toml`：Worker、D1、Durable Object、Container 绑定配置

字幕生成链路：

1. 前端提交 YouTube / B 站 / TED-Ed 等视频 URL。
2. Worker 创建字幕任务，调用 Cloudflare Container。
3. Container 运行 `yt-dlp` 下载媒体文件。
4. Container 运行 `ffmpeg` 抽取压缩音频文件。
5. Container 把音频文件上传到 Groq OpenAI-compatible `/audio/transcriptions`。
6. Container 将 Groq segment timestamps 转成严格 SRT。
7. Worker 再次严格校验 SRT，通过后写入 D1 的 `contents` 和 `sentences`。
8. 前端按句播放，并支持单句遮蔽、红黄绿标记、老师后台查看。

注意：普通 Cloudflare Worker 不能运行 `yt-dlp` / `ffmpeg` / Python 长任务，所以字幕服务必须放在 Cloudflare Containers 这类容器环境里。

## Demo 账号

- Teacher access code: `teacher-demo`
- Student access code: `student-demo`

学生播放位置写入 `listening_presence`。老师后台读取每个学生当前听到的句子，以及红/黄卡点。

## API

- `GET /health`
- `POST /api/accounts/login`
- `GET /api/teacher/dashboard?teacher_id=...&content_id=...`
- `POST /api/heard`
- `POST /api/caption-jobs`
- `GET /api/caption-jobs/:id`
- `GET /api/contents`
- `POST /api/contents`
- `GET /api/contents/:id`
- `POST /api/attempts`
- `GET /api/progress?learner_id=...&content_id=...`
- `GET /api/review?learner_id=...&content_id=...`

## 红黄绿规则

- 第一遍听懂：绿
- 不确定 / 没听懂：红
- 红句复听后听懂：黄
- 黄句再次听懂：绿

## 本地检查

```powershell
npm install
node --check worker/src/index.js
node --check docs/app.js
python -m compileall caption-service
npx wrangler deploy --dry-run --containers-rollout=none
```

## Cloudflare 部署前提

Cloudflare Containers 需要：

1. Cloudflare Workers Paid plan / Containers 访问权限。
2. 本机构建镜像时需要 Docker 或 Podman。
3. Worker Secret 中配置 `GROQ_API_KEY`，不要写入仓库、前端或日志。

Container 运行时变量：

- `GROQ_API_KEY`：必须作为 Worker Secret 设置。
- `GROQ_API_BASE=https://api.groq.com/openai/v1`
- `GROQ_WHISPER_MODEL=whisper-large-v3-turbo`
- `GROQ_MAX_UPLOAD_BYTES=25000000`
- `CAPTION_CHUNK_SECONDS=600`
- `CAPTION_AUDIO_BITRATE=64k`
- `CAPTION_AUDIO_SAMPLE_RATE=16000`

部署：

```powershell
npx wrangler secret put GROQ_API_KEY
npx wrangler deploy --containers-rollout=immediate
```

前端仍然走当前 GitHub Pages：

```text
https://yanglei-985.github.io/listening/
```
