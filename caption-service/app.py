"""HTTP adapter for VideoCaptioner.

This service turns the VideoCaptioner CLI into the tiny HTTP contract expected
by the Cloudflare Worker:

POST /jobs -> {"status": "processing", "job_id": "..."}
GET  /jobs/{job_id} -> {"status": "complete", "srt": "..."}

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
from typing import Literal

from fastapi import BackgroundTasks, FastAPI, HTTPException
from pydantic import BaseModel, Field, HttpUrl


APP_VERSION = "0.1.0"
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


app = FastAPI(title="Listening VideoCaptioner Adapter", version=APP_VERSION)


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
        "service": "videocaptioner-adapter",
        "version": APP_VERSION,
        "videocaptioner": bool(shutil.which("videocaptioner")),
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "groq_configured": bool(os.getenv("GROQ_API_KEY")),
        "groq_api_base": os.getenv("GROQ_API_BASE", DEFAULT_GROQ_BASE),
        "groq_whisper_model": os.getenv("GROQ_WHISPER_MODEL", DEFAULT_GROQ_WHISPER_MODEL),
    }


@app.post("/jobs", response_model=CaptionJobResponse, status_code=202)
def create_job(request: CaptionJobRequest, background_tasks: BackgroundTasks) -> CaptionJobResponse:
    job_id = f"vc_{uuid.uuid4().hex}"
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    set_job(
        job_id,
        id=job_id,
        status="processing",
        title=request.title,
        source_url=str(request.source_url),
        language=request.language or "auto",
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
        "This is a test caption from the adapter.\n\n"
        "2\n"
        "00:00:03,000 --> 00:00:06,000\n"
        "The real server will call VideoCaptioner and Groq.\n"
    )
    write_valid_srt(job_id, srt)
    set_job(job_id, status="complete", error=None)


def process_job(job_id: str) -> None:
    state = read_job(job_id) or {}
    directory = job_dir(job_id)
    source_url = str(state.get("source_url") or "")
    language = str(state.get("language") or "auto")

    try:
        assert_runtime_ready()
        run_command(
            [
                "videocaptioner",
                "download",
                source_url,
                "-o",
                str(directory),
                "--quiet",
            ],
            cwd=directory,
        )
        media_file = find_downloaded_media(directory)
        srt_path = directory / "output.srt"
        transcribe_args = [
            "videocaptioner",
            "transcribe",
            str(media_file),
            "--asr",
            "whisper-api",
            "--whisper-model",
            os.getenv("GROQ_WHISPER_MODEL", DEFAULT_GROQ_WHISPER_MODEL),
            "--language",
            language or "auto",
            "--format",
            "srt",
            "-o",
            str(srt_path),
            "--quiet",
        ]
        run_command(transcribe_args, cwd=directory, include_groq_env=True)

        if not srt_path.exists():
            raise RuntimeError("VideoCaptioner finished but output.srt was not created")
        write_valid_srt(job_id, srt_path.read_text(encoding="utf-8"))
        set_job(job_id, status="complete", error=None, output_srt=str(srt_path))
        cleanup_downloads(directory)
    except Exception as exc:  # noqa: BLE001 - return useful job error to Worker
        set_job(job_id, status="failed", error=str(exc))


def assert_runtime_ready() -> None:
    if not os.getenv("GROQ_API_KEY"):
        raise RuntimeError("GROQ_API_KEY is not configured")
    if not shutil.which("videocaptioner"):
        raise RuntimeError("videocaptioner CLI is not installed")
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg is not installed")


def run_command(
    args: list[str],
    cwd: Path,
    include_groq_env: bool = False,
) -> None:
    env = os.environ.copy()
    if include_groq_env:
        env["VIDEOCAPTIONER_WHISPER_API_KEY"] = os.environ["GROQ_API_KEY"]
        env["VIDEOCAPTIONER_WHISPER_API_BASE"] = os.getenv("GROQ_API_BASE", DEFAULT_GROQ_BASE)

    timeout = int(os.getenv("CAPTION_JOB_TIMEOUT_SECONDS", "3600"))
    result = subprocess.run(
        args,
        cwd=str(cwd),
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        output = redact(result.stdout or "")
        raise RuntimeError(f"Command failed ({args[0]} {args[1]}): {output[-2000:]}")


def redact(text: str) -> str:
    secret = os.getenv("GROQ_API_KEY")
    if secret:
        text = text.replace(secret, "[redacted]")
    return re.sub(r"gsk_[A-Za-z0-9_-]+", "[redacted-groq-key]", text)


def find_downloaded_media(directory: Path) -> Path:
    candidates = [
        path
        for path in directory.rglob("*")
        if path.is_file() and path.suffix.lower() in MEDIA_EXTENSIONS
    ]
    if not candidates:
        raise RuntimeError("No downloaded media file found")
    return max(candidates, key=lambda path: (path.stat().st_size, path.stat().st_mtime))


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


def cleanup_downloads(directory: Path) -> None:
    if os.getenv("CAPTION_KEEP_ARTIFACTS", "0") == "1":
        return
    for path in directory.rglob("*"):
        if path.is_file() and path.suffix.lower() in MEDIA_EXTENSIONS:
            path.unlink(missing_ok=True)


def test_mode_enabled() -> bool:
    return os.getenv("CAPTION_TEST_MODE", "0") == "1"
