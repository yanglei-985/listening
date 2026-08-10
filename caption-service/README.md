# Listening Caption Pipeline

这是放进 Cloudflare Containers 的字幕处理容器，不是浏览器脚本，也不是普通 Cloudflare Worker。

它不把 YouTube URL 直接发给 Groq。Groq 只接收音频文件：

1. `yt-dlp` 下载 YouTube / Bilibili / TED-Ed 等视频或音频。
2. `ffmpeg` 抽取单声道压缩 MP3。
3. Groq 通过 OpenAI-compatible `/audio/transcriptions` 接收音频文件。
4. 服务将 Groq 的 segment timestamps 转成严格 SRT。
5. Worker 轮询容器任务，把通过校验的 SRT 写入 D1。

## HTTP contract

```http
POST /jobs
Content-Type: application/json

{
  "title": "TED-Ed video",
  "source_url": "https://www.youtube.com/watch?v=...",
  "output": "srt",
  "language": "en"
}
```

返回处理中：

```json
{ "status": "processing", "job_id": "cap_..." }
```

轮询：

```http
GET /jobs/cap_...
```

完成：

```json
{ "status": "complete", "job_id": "cap_...", "srt": "1\n00:00:00,000 --> ..." }
```

## Environment variables

- `GROQ_API_KEY`：必填，由 Worker Secret 注入到 Container。
- `GROQ_API_BASE`：默认 `https://api.groq.com/openai/v1`。
- `GROQ_WHISPER_MODEL`：默认 `whisper-large-v3-turbo`。
- `YTDLP_FORMAT`：默认 `bestaudio/best`。
- `YTDLP_COOKIES_FILE`：可选，Netscape `cookies.txt` 路径，用于绕过 YouTube bot / 登录态校验。
- `YTDLP_COOKIES_FROM_BROWSER`：可选，本地开发可设为 `chrome` 或 `edge`，但浏览器运行时可能因 Cookie 数据库被占用而失败。
- `YTDLP_JS_RUNTIMES`：可选，本机建议设为 `node`，用于解决 YouTube JS challenge。
- `YTDLP_REMOTE_COMPONENTS`：可选，本机建议设为 `ejs:github`，让 yt-dlp 下载官方 JS challenge solver。
- `CAPTION_AUDIO_BITRATE`：默认 `64k`。
- `CAPTION_AUDIO_SAMPLE_RATE`：默认 `16000`。
- `GROQ_MAX_UPLOAD_BYTES`：默认 `25000000`；超过后切片上传。
- `CAPTION_CHUNK_SECONDS`：默认 `600`。
- `CAPTION_TEST_MODE=1`：返回假的合法 SRT，用于集成测试。

## Local smoke test

```powershell
cd caption-service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:CAPTION_TEST_MODE = "1"
uvicorn app:app --host 0.0.0.0 --port 8080
```

Cloudflare 线上运行时由 `wrangler.toml` 的 `[[containers]]` 构建 Dockerfile。
