# VideoCaptioner HTTP Adapter

This service wraps the `videocaptioner` CLI so the Listening Worker can submit
video URLs and later poll for strict SRT output.

## Contract

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

Immediate response:

```json
{ "status": "processing", "job_id": "vc_..." }
```

Poll:

```http
GET /jobs/vc_...
```

Complete response:

```json
{ "status": "complete", "job_id": "vc_...", "srt": "1\n00:00:00,000 --> ..." }
```

## Run locally

```bash
cd caption-service
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export GROQ_API_KEY="gsk_..."
export GROQ_API_BASE="https://api.groq.com/openai/v1"
export GROQ_WHISPER_MODEL="whisper-large-v3-turbo"
uvicorn app:app --host 0.0.0.0 --port 8080
```

## Docker

```bash
docker build -t listening-caption-service ./caption-service
docker run -d --name listening-caption-service \
  -p 8080:8080 \
  -e GROQ_API_KEY="gsk_..." \
  -e GROQ_API_BASE="https://api.groq.com/openai/v1" \
  -e GROQ_WHISPER_MODEL="whisper-large-v3-turbo" \
  -v listening-caption-data:/data/caption-service \
  listening-caption-service
```

Then set the Worker variable:

```bash
wrangler deploy --var VIDEOCAPTIONER_API_BASE:https://your-caption-service.example.com
```

Or set it in `wrangler.toml` / Cloudflare dashboard and redeploy.

## Notes

- `GROQ_API_KEY` stays only on this server.
- The Worker calls this service, not Groq directly.
- The service validates SRT strictly before returning it.
- `CAPTION_TEST_MODE=1` returns a fake valid SRT for local integration tests.
