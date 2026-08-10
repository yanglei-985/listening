"""Server-side transcription pipeline for the Listening app.

The browser and Cloudflare Worker only submit a video URL. This server does the
heavy work:

1. yt-dlp downloads the YouTube/Bilibili/etc. media.
2. ffmpeg extracts and compresses audio.
3. Groq receives the audio file through the OpenAI-compatible transcription API.
4. The response segments are converted to strict SRT.

Secrets stay on this server. The Worker and the browser never receive the Groq
API key.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Literal

from fastapi import BackgroundTasks, FastAPI, HTTPException
from pydantic import BaseModel, Field, HttpUrl


APP_VERSION = "0.2.0"
DEFAULT_GROQ_BASE = "https://api.groq.com/openai/v1"
DEFAULT_GROQ_WHISPER_MODEL = "whisper-large-v3-turbo"
MEDIA_EXTENSIONS = {
    ".mp4",
    ".mkv",
    ".webm",
    ".mov",
    ".m4v",
    ".mp3",
    ".m4a",
    ".wav",
    ".aac",
    ".flac",
    ".ogg",
    ".opus",
}


class CaptionJobRequest(BaseModel):
    title: str = Field(default="Untitled listening content", max_length=200)
    source_url: HttpUrl
    output: Literal["srt"] = "srt"
    language: str = Field(default="en", max_length=16)


class CaptionJobResponse(BaseModel):
    status: Literal["processing", "complete", "failed"]
    job_id: str
    srt: str | None = None
    error: str | None = None


app = FastAPI(title="Listening Caption Pipeline", version=APP_VERSION)


def work_root() -> Path:
    root = Path(os.getenv("CAPTION_WORKDIR", "/data/caption-service")).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    return root


def job_dir(job_id: str) -> Path:
    path = work_root() / "jobs" / job_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def job_json_path(job_id: str) -> Path:
    return job_dir(job_id) / "job.json"


def set_job(job_id: str, **fields: object) -> dict:
    path = job_json_path(job_id)
    current = read_job(job_id, allow_missing=True) or {}
    current.update(fields)
    current["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    path.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    return current


def read_job(job_id: str, allow_missing: bool = False) -> dict | None:
    path = job_json_path(job_id)
    if not path.exists():
        if allow_missing:
            return None
        raise HTTPException(status_code=404, detail="Caption job not found")
    return json.loads(path.read_text(encoding="utf-8"))


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "service": "listening-caption-pipeline",
        "version": APP_VERSION,
        "yt_dlp": bool(shutil.which("yt-dlp")),
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "groq_configured": bool(os.getenv("GROQ_API_KEY")),
        "groq_api_base": os.getenv("GROQ_API_BASE", DEFAULT_GROQ_BASE),
        "groq_whisper_model": os.getenv("GROQ_WHISPER_MODEL", DEFAULT_GROQ_WHISPER_MODEL),
    }


@app.post("/jobs", response_model=CaptionJobResponse, status_code=202)
def create_job(request: CaptionJobRequest, background_tasks: BackgroundTasks) -> CaptionJobResponse:
    job_id = f"cap_{uuid.uuid4().hex}"
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    set_job(
        job_id,
        id=job_id,
        status="processing",
        title=request.title,
        source_url=str(request.source_url),
        language=normalize_language(request.language),
        created_at=now,
    )

    if test_mode_enabled():
        process_test_job(job_id)
    else:
        background_tasks.add_task(process_job, job_id)

    state = read_job(job_id) or {}
    return CaptionJobResponse(
        status=state.get("status", "processing"),
        job_id=job_id,
        srt=read_srt_if_complete(job_id),
        error=state.get("error"),
    )


@app.get("/jobs/{job_id}", response_model=CaptionJobResponse)
def get_job(job_id: str) -> CaptionJobResponse:
    state = read_job(job_id) or {}
    return CaptionJobResponse(
        status=state.get("status", "processing"),
        job_id=job_id,
        srt=read_srt_if_complete(job_id),
        error=state.get("error"),
    )


def process_test_job(job_id: str) -> None:
    srt = (
        "1\n"
        "00:00:00,000 --> 00:00:03,000\n"
        "This is a test caption from the server pipeline.\n\n"
        "2\n"
        "00:00:03,000 --> 00:00:06,000\n"
        "The real server downloads audio with yt-dlp and sends the file to Groq.\n"
    )
    write_valid_srt(job_id, srt)
    set_job(job_id, status="complete", error=None)


def process_job(job_id: str) -> None:
    state = read_job(job_id) or {}
    directory = job_dir(job_id)
    source_url = str(state.get("source_url") or "")
    language = normalize_language(str(state.get("language") or "auto"))

    try:
        assert_runtime_ready()
        downloaded = download_media(source_url, directory)
        audio_path = extract_audio(downloaded, directory / "audio.mp3")
        srt = transcribe_to_srt(audio_path, language)
        write_valid_srt(job_id, srt)
        set_job(job_id, status="complete", error=None, output_srt=str(directory / "output.srt"))
        cleanup_artifacts(directory)
    except Exception as exc:  # noqa: BLE001 - return useful job error to Worker
        set_job(job_id, status="failed", error=redact(str(exc)))


def assert_runtime_ready() -> None:
    if not os.getenv("GROQ_API_KEY"):
        raise RuntimeError("GROQ_API_KEY is not configured")
    if not shutil.which("yt-dlp"):
        raise RuntimeError("yt-dlp is not installed")
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg is not installed")


def download_media(source_url: str, directory: Path) -> Path:
    before = {path.resolve() for path in directory.rglob("*") if path.is_file()}
    command = [
        "yt-dlp",
        "--no-playlist",
        "--no-warnings",
        "--restrict-filenames",
        "-f",
        os.getenv("YTDLP_FORMAT", "bestaudio/best"),
        "-o",
        str(directory / "source.%(ext)s"),
    ]
    command.extend(yt_dlp_js_args())
    command.extend(yt_dlp_cookie_args())
    command.append(source_url)
    run_command(command, cwd=directory)
    after = [path for path in directory.rglob("*") if path.is_file() and path.resolve() not in before]
    candidates = [path for path in after if path.suffix.lower() in MEDIA_EXTENSIONS]
    if not candidates:
        candidates = [path for path in directory.rglob("*") if path.is_file() and path.suffix.lower() in MEDIA_EXTENSIONS]
    if not candidates:
        raise RuntimeError("yt-dlp finished but no media file was found")
    return max(candidates, key=lambda path: (path.stat().st_size, path.stat().st_mtime))


def yt_dlp_cookie_args() -> list[str]:
    cookies_file = os.getenv("YTDLP_COOKIES_FILE", "").strip()
    if cookies_file:
        path = Path(cookies_file).expanduser()
        if not path.exists():
            raise RuntimeError(f"YTDLP_COOKIES_FILE does not exist: {path}")
        return ["--cookies", str(path)]

    cookies_from_browser = os.getenv("YTDLP_COOKIES_FROM_BROWSER", "").strip()
    if cookies_from_browser:
        return ["--cookies-from-browser", cookies_from_browser]

    return []


def yt_dlp_js_args() -> list[str]:
    args: list[str] = []
    js_runtimes = os.getenv("YTDLP_JS_RUNTIMES", "").strip()
    if js_runtimes:
        args.extend(["--js-runtimes", js_runtimes])

    remote_components = os.getenv("YTDLP_REMOTE_COMPONENTS", "").strip()
    if remote_components:
        args.extend(["--remote-components", remote_components])

    return args


def extract_audio(input_path: Path, output_path: Path) -> Path:
    bitrate = os.getenv("CAPTION_AUDIO_BITRATE", "64k")
    sample_rate = os.getenv("CAPTION_AUDIO_SAMPLE_RATE", "16000")
    run_command(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(input_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            sample_rate,
            "-b:a",
            bitrate,
            str(output_path),
        ],
        cwd=output_path.parent,
    )
    if not output_path.exists() or output_path.stat().st_size == 0:
        raise RuntimeError("ffmpeg finished but audio.mp3 was not created")
    return output_path


def transcribe_to_srt(audio_path: Path, language: str) -> str:
    max_bytes = int(os.getenv("GROQ_MAX_UPLOAD_BYTES", "25000000"))
    if audio_path.stat().st_size <= max_bytes:
        response = transcribe_audio_file(audio_path, language)
        return segments_to_srt(extract_segments(response))

    chunk_seconds = int(os.getenv("CAPTION_CHUNK_SECONDS", "600"))
    chunks = split_audio(audio_path, chunk_seconds)
    all_segments: list[dict[str, Any]] = []
    for index, chunk in enumerate(chunks):
        offset = index * chunk_seconds
        response = transcribe_audio_file(chunk, language)
        for segment in extract_segments(response):
            all_segments.append(
                {
                    **segment,
                    "start": float(segment.get("start", 0)) + offset,
                    "end": float(segment.get("end", 0)) + offset,
                }
            )
    return segments_to_srt(all_segments)


def split_audio(audio_path: Path, chunk_seconds: int) -> list[Path]:
    chunk_dir = audio_path.parent / "chunks"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    run_command(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(audio_path),
            "-f",
            "segment",
            "-segment_time",
            str(chunk_seconds),
            "-reset_timestamps",
            "1",
            "-c:a",
            "libmp3lame",
            "-b:a",
            os.getenv("CAPTION_AUDIO_BITRATE", "64k"),
            str(chunk_dir / "chunk_%03d.mp3"),
        ],
        cwd=audio_path.parent,
    )
    chunks = sorted(chunk_dir.glob("chunk_*.mp3"))
    if not chunks:
        raise RuntimeError("ffmpeg did not create audio chunks")
    return chunks


def transcribe_audio_file(audio_path: Path, language: str) -> dict:
    from openai import OpenAI

    client = OpenAI(
        api_key=os.environ["GROQ_API_KEY"],
        base_url=os.getenv("GROQ_API_BASE", DEFAULT_GROQ_BASE).rstrip("/"),
        timeout=float(os.getenv("GROQ_TIMEOUT_SECONDS", "600")),
    )

    kwargs: dict[str, Any] = {
        "model": os.getenv("GROQ_WHISPER_MODEL", DEFAULT_GROQ_WHISPER_MODEL),
        "response_format": "verbose_json",
        "timestamp_granularities": ["segment"],
    }
    if language and language != "auto":
        kwargs["language"] = language

    with audio_path.open("rb") as audio_file:
        response = client.audio.transcriptions.create(file=audio_file, **kwargs)
    return response_to_dict(response)


def response_to_dict(response: Any) -> dict:
    if isinstance(response, dict):
        return response
    if hasattr(response, "model_dump"):
        return response.model_dump()
    if hasattr(response, "to_dict"):
        return response.to_dict()
    data = json.loads(json.dumps(response, default=lambda value: getattr(value, "__dict__", str(value))))
    if not isinstance(data, dict):
        raise RuntimeError("Groq transcription response is not a JSON object")
    return data


def extract_segments(response: dict) -> list[dict[str, Any]]:
    segments = response.get("segments")
    if not isinstance(segments, list) or not segments:
        text = str(response.get("text") or "").strip()
        if text:
            raise RuntimeError("Groq response has text but no segment timestamps")
        raise RuntimeError("Groq response does not contain transcription segments")
    return [segment for segment in segments if str(segment.get("text") or "").strip()]


def segments_to_srt(segments: list[dict[str, Any]]) -> str:
    if not segments:
        raise RuntimeError("No transcription segments to convert")

    lines: list[str] = []
    previous_end_ms = 0
    for index, segment in enumerate(segments, start=1):
        text = " ".join(str(segment.get("text") or "").split())
        if not text:
            continue

        start_ms = max(previous_end_ms, seconds_to_ms(segment.get("start", 0)))
        end_ms = max(start_ms + 250, seconds_to_ms(segment.get("end", 0)))
        previous_end_ms = end_ms
        lines.extend(
            [
                str(index),
                f"{format_srt_time(start_ms)} --> {format_srt_time(end_ms)}",
                text,
                "",
            ]
        )

    srt = "\n".join(lines).strip() + "\n"
    ok, errors = validate_strict_srt(srt)
    if not ok:
        raise RuntimeError("Internal SRT conversion failed: " + "; ".join(errors[:5]))
    return srt


def run_command(args: list[str], cwd: Path) -> None:
    timeout = int(os.getenv("CAPTION_JOB_TIMEOUT_SECONDS", "3600"))
    result = subprocess.run(
        args,
        cwd=str(cwd),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        output = redact(result.stdout or "")
        raise RuntimeError(f"Command failed ({args[0]}): {output[-2000:]}")


def redact(text: str) -> str:
    secret = os.getenv("GROQ_API_KEY")
    if secret:
        text = text.replace(secret, "[redacted]")
    return re.sub(r"gsk_[A-Za-z0-9_-]+", "[redacted-groq-key]", text)


def write_valid_srt(job_id: str, srt: str) -> None:
    ok, errors = validate_strict_srt(srt)
    if not ok:
        raise RuntimeError("Generated SRT failed strict validation: " + "; ".join(errors[:5]))
    (job_dir(job_id) / "output.srt").write_text(srt.strip() + "\n", encoding="utf-8")


def read_srt_if_complete(job_id: str) -> str | None:
    state = read_job(job_id, allow_missing=True) or {}
    if state.get("status") != "complete":
        return None
    path = job_dir(job_id) / "output.srt"
    return path.read_text(encoding="utf-8") if path.exists() else None


def validate_strict_srt(raw: str) -> tuple[bool, list[str]]:
    normalized = str(raw or "").replace("\ufeff", "", 1).replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return False, ["SRT is empty"]

    errors: list[str] = []
    previous_end = -1
    blocks = re.split(r"\n{2,}", normalized)
    for block_index, block in enumerate(blocks, start=1):
        lines = [line.rstrip() for line in block.split("\n")]
        number_line = lines[0].strip() if len(lines) > 0 else ""
        time_line = lines[1].strip() if len(lines) > 1 else ""
        text_lines = [line for line in lines[2:] if line.strip()]

        if not number_line.isdigit():
            errors.append(f"Block {block_index}: missing numeric index")
            continue
        if int(number_line) != block_index:
            errors.append(f"Block {block_index}: expected index {block_index}, got {number_line}")

        match = re.match(
            r"^(\d{2,}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2,}:\d{2}:\d{2},\d{3})(?:\s+.*)?$",
            time_line,
        )
        if not match:
            errors.append(f"Block {block_index}: invalid time range")
            continue

        start = parse_srt_time(match.group(1))
        end = parse_srt_time(match.group(2))
        if start is None or end is None:
            errors.append(f"Block {block_index}: invalid timestamp")
            continue
        if start >= end:
            errors.append(f"Block {block_index}: start time must be before end time")
        if previous_end > start:
            errors.append(f"Block {block_index}: overlaps previous subtitle")
        previous_end = max(previous_end, end)

        if not text_lines:
            errors.append(f"Block {block_index}: subtitle text is empty")

    return not errors, errors


def parse_srt_time(value: str) -> int | None:
    match = re.match(r"^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$", value)
    if not match:
        return None
    return (
        int(match.group(1)) * 3_600_000
        + int(match.group(2)) * 60_000
        + int(match.group(3)) * 1000
        + int(match.group(4))
    )


def seconds_to_ms(value: object) -> int:
    try:
        return max(0, int(round(float(value) * 1000)))
    except (TypeError, ValueError):
        return 0


def format_srt_time(ms: int) -> str:
    safe = max(0, int(ms))
    hours = safe // 3_600_000
    minutes = (safe % 3_600_000) // 60_000
    seconds = (safe % 60_000) // 1000
    millis = safe % 1000
    return f"{hours:02}:{minutes:02}:{seconds:02},{millis:03}"


def normalize_language(language: str) -> str:
    value = (language or "auto").strip().lower()
    return value if value and value != "undefined" else "auto"


def cleanup_artifacts(directory: Path) -> None:
    if os.getenv("CAPTION_KEEP_ARTIFACTS", "0") == "1":
        return
    for path in directory.rglob("*"):
        if path.is_file() and path.name != "job.json" and path.name != "output.srt":
            path.unlink(missing_ok=True)


def test_mode_enabled() -> bool:
    return os.getenv("CAPTION_TEST_MODE", "0") == "1"
