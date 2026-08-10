const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type"
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/health") return json(await health(env));
      if (path === "/api/accounts/login" && request.method === "POST") return json(await login(request, env));
      if (path === "/api/teacher/dashboard" && request.method === "GET") return json(await teacherDashboard(env, url.searchParams));
      if (path === "/api/heard" && request.method === "POST") return json(await recordHeard(request, env), 201);
      if (path === "/api/caption-jobs" && request.method === "POST") return json(await createCaptionJob(request, env), 201);

      const captionJobMatch = path.match(/^\/api\/caption-jobs\/([^/]+)$/);
      if (captionJobMatch && request.method === "GET") {
        return json(await getCaptionJob(env, decodeURIComponent(captionJobMatch[1])));
      }

      if (path === "/api/contents" && request.method === "GET") return json(await listContents(env));
      if (path === "/api/contents" && request.method === "POST") return json(await createContent(request, env), 201);

      const contentMatch = path.match(/^\/api\/contents\/([^/]+)$/);
      if (contentMatch && request.method === "GET") {
        return json(await getContent(env, decodeURIComponent(contentMatch[1])));
      }

      if (path === "/api/attempts" && request.method === "POST") return json(await recordAttempt(request, env), 201);
      if (path === "/api/progress" && request.method === "GET") return json(await getProgress(env, url.searchParams));
      if (path === "/api/review" && request.method === "GET") return json(await getReview(env, url.searchParams));

      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error.message || "Unexpected error", details: error.details }, error.status || 500);
    }
  }
};

async function health(env) {
  const content = await env.DB.prepare("SELECT COUNT(*) AS content_count FROM contents").first();
  const users = await env.DB.prepare("SELECT COUNT(*) AS user_count FROM users").first().catch(() => ({ user_count: 0 }));
  return {
    ok: true,
    database: "listening",
    content_count: content?.content_count ?? 0,
    user_count: users?.user_count ?? 0,
    caption_service_configured: Boolean(getCaptionBase(env)),
    checked_at: new Date().toISOString()
  };
}

async function login(request, env) {
  const body = await readJson(request);
  const accessCode = cleanText(body.access_code || body.accessCode || "", 100);
  if (!accessCode) throw httpError(400, "access_code is required");

  const user = await env.DB.prepare(`
    SELECT id, display_name, role, created_at, last_login_at
    FROM users
    WHERE access_code = ?
  `).bind(accessCode).first();

  if (!user) throw httpError(401, "Invalid access code");

  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(now, user.id).run();

  const classes = await env.DB.prepare(`
    SELECT c.id, c.name, c.teacher_id, cm.role
    FROM class_members cm
    JOIN classes c ON c.id = cm.class_id
    WHERE cm.user_id = ?
    ORDER BY c.created_at ASC
  `).bind(user.id).all();

  return { user: { ...user, last_login_at: now }, classes: classes.results || [] };
}

async function listContents(env) {
  const result = await env.DB.prepare(`
    SELECT
      c.id,
      c.title,
      c.source_url,
      c.source_type,
      c.video_id,
      c.created_at,
      c.created_by_user_id,
      c.caption_status,
      c.caption_job_id,
      COUNT(s.id) AS sentence_count
    FROM contents c
    LEFT JOIN sentences s ON s.content_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `).all();

  return { contents: result.results || [] };
}

async function getContent(env, contentId) {
  const content = await env.DB.prepare("SELECT * FROM contents WHERE id = ?").bind(contentId).first();
  if (!content) throw httpError(404, "Content not found");

  const sentences = await env.DB.prepare(`
    SELECT id, content_id, position, start_ms, end_ms, text
    FROM sentences
    WHERE content_id = ?
    ORDER BY position ASC
  `).bind(contentId).all();

  return { content, sentences: sentences.results || [] };
}

async function createContent(request, env) {
  const body = await readJson(request);
  const title = cleanText(body.title || "Untitled listening content", 140);
  const sourceUrl = cleanText(body.source_url || body.sourceUrl || "", 500);
  const creatorUserId = cleanText(body.user_id || body.userId || body.created_by_user_id || "", 120);
  const srtSource = typeof body.srt === "string" ? body.srt : "";

  let sentences = Array.isArray(body.sentences) ? body.sentences : [];
  if (srtSource.trim()) {
    const parsed = parseStrictSrt(srtSource);
    if (!parsed.ok) {
      throw httpError(400, "SRT validation failed", parsed.errors);
    }
    sentences = parsed.sentences;
  }

  if (!sentences.length) throw httpError(400, "At least one sentence is required");

  return createContentFromSentences(env, {
    title,
    sourceUrl,
    creatorUserId,
    sentences,
    srtSource,
    captionStatus: "ready",
    captionJobId: cleanText(body.caption_job_id || body.captionJobId || "", 140)
  });
}

async function createContentFromSentences(env, options) {
  const parsed = parseSource(options.sourceUrl);
  const contentId = `content_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const statements = [
    env.DB.prepare(`
      INSERT INTO contents (
        id, title, source_url, source_type, video_id, created_at,
        created_by_user_id, srt_source, caption_status, caption_job_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      contentId,
      options.title,
      options.sourceUrl,
      parsed.source_type,
      parsed.video_id,
      createdAt,
      options.creatorUserId || null,
      options.srtSource || null,
      options.captionStatus || "ready",
      options.captionJobId || null
    )
  ];

  options.sentences.slice(0, 600).forEach((sentence, index) => {
    const text = cleanText(sentence.text || "", 1400);
    if (!text) return;

    const startMs = toMs(sentence.start_ms ?? sentence.start ?? index * 4);
    const endMs = Math.max(startMs + 250, toMs(sentence.end_ms ?? sentence.end ?? (index + 1) * 4));
    statements.push(
      env.DB.prepare(`
        INSERT INTO sentences (id, content_id, position, start_ms, end_ms, text, normalized_text)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        `sentence_${crypto.randomUUID()}`,
        contentId,
        index + 1,
        startMs,
        endMs,
        text,
        normalizeText(text)
      )
    );
  });

  await env.DB.batch(statements);
  return getContent(env, contentId);
}

async function createCaptionJob(request, env) {
  const body = await readJson(request);
  const title = cleanText(body.title || "Untitled listening content", 140);
  const sourceUrl = cleanText(body.source_url || body.sourceUrl || "", 500);
  const requestedBy = cleanText(body.user_id || body.userId || "", 120);

  if (!sourceUrl) throw httpError(400, "source_url is required");

  const jobId = `caption_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const captionBase = getCaptionBase(env);

  await env.DB.prepare(`
    INSERT INTO caption_jobs (
      id, requested_by_user_id, title, source_url, status, provider, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'videocaptioner', ?, ?)
  `).bind(jobId, requestedBy || null, title, sourceUrl, captionBase ? "queued" : "waiting_for_service", now, now).run();

  if (!captionBase) {
    return {
      job: await readCaptionJob(env, jobId),
      caption_service_configured: false,
      message: "VideoCaptioner service URL is not configured yet"
    };
  }

  try {
    const remote = await callCaptionService(captionBase, "/jobs", {
      title,
      source_url: sourceUrl,
      output: "srt",
      language: body.language || "en"
    });

    const update = {
      status: remote.srt ? "complete" : normalizeCaptionStatus(remote.status || "processing"),
      externalJobId: cleanText(remote.job_id || remote.id || "", 160),
      resultSrt: typeof remote.srt === "string" ? remote.srt : "",
      error: ""
    };

    let content = null;
    if (update.resultSrt) {
      const parsed = parseStrictSrt(update.resultSrt);
      if (!parsed.ok) throw httpError(502, "VideoCaptioner returned invalid SRT", parsed.errors);
      content = await createContentFromSentences(env, {
        title,
        sourceUrl,
        creatorUserId: requestedBy,
        sentences: parsed.sentences,
        srtSource: update.resultSrt,
        captionStatus: "ready",
        captionJobId: jobId
      });
      update.contentId = content.content.id;
    }

    await updateCaptionJob(env, jobId, update);
    return { job: await readCaptionJob(env, jobId), content, caption_service_configured: true };
  } catch (error) {
    await updateCaptionJob(env, jobId, {
      status: "failed",
      error: error.message || "VideoCaptioner request failed"
    });
    throw error;
  }
}

async function getCaptionJob(env, jobId) {
  let job = await readCaptionJob(env, jobId);
  if (!job) throw httpError(404, "Caption job not found");

  const captionBase = getCaptionBase(env);
  let content = null;
  if (job.content_id) {
    content = await getContent(env, job.content_id).catch(() => null);
  }

  if (
    captionBase &&
    job.external_job_id &&
    ["queued", "processing"].includes(job.status)
  ) {
    const refreshed = await refreshCaptionJob(env, captionBase, job);
    job = refreshed.job || job;
    content = refreshed.content || content;
  }

  return { job, content, caption_service_configured: Boolean(captionBase) };
}

async function readCaptionJob(env, jobId) {
  return env.DB.prepare("SELECT * FROM caption_jobs WHERE id = ?").bind(jobId).first();
}

async function updateCaptionJob(env, jobId, update) {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE caption_jobs
    SET status = COALESCE(?, status),
        content_id = COALESCE(?, content_id),
        external_job_id = COALESCE(?, external_job_id),
        error_message = ?,
        result_srt = COALESCE(?, result_srt),
        updated_at = ?
    WHERE id = ?
  `).bind(
    update.status || null,
    update.contentId || null,
    update.externalJobId || null,
    update.error || null,
    update.resultSrt || null,
    now,
    jobId
  ).run();
}

async function refreshCaptionJob(env, captionBase, job) {
  const remote = await callCaptionService(
    captionBase,
    `/jobs/${encodeURIComponent(job.external_job_id)}`,
    null,
    "GET"
  );

  const update = {
    status: normalizeCaptionStatus(remote.status || job.status),
    error: remote.error || ""
  };
  let content = null;

  if (typeof remote.srt === "string" && remote.srt.trim()) {
    const parsed = parseStrictSrt(remote.srt);
    if (!parsed.ok) throw httpError(502, "VideoCaptioner returned invalid SRT", parsed.errors);

    if (job.content_id) {
      content = await getContent(env, job.content_id).catch(() => null);
      update.status = "complete";
      update.resultSrt = remote.srt;
    } else {
      content = await createContentFromSentences(env, {
        title: job.title,
        sourceUrl: job.source_url,
        creatorUserId: job.requested_by_user_id,
        sentences: parsed.sentences,
        srtSource: remote.srt,
        captionStatus: "ready",
        captionJobId: job.id
      });
      update.status = "complete";
      update.contentId = content.content.id;
      update.resultSrt = remote.srt;
    }
  }

  if (update.status === "failed") {
    update.error = remote.error || remote.message || "VideoCaptioner service failed";
  }

  await updateCaptionJob(env, job.id, update);
  return { job: await readCaptionJob(env, job.id), content };
}

async function callCaptionService(base, path, body, method = "POST") {
  const init = {
    method,
    headers: { "content-type": "application/json" }
  };
  if (body) init.body = JSON.stringify(body);

  const response = await fetch(`${base}${path}`, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw httpError(502, data.error || data.message || "VideoCaptioner service failed");
  }
  return data;
}

function normalizeCaptionStatus(status) {
  if (status === "complete") return "complete";
  if (status === "failed" || status === "error") return "failed";
  if (status === "queued") return "queued";
  return "processing";
}

async function recordHeard(request, env) {
  const body = await readJson(request);
  const studentId = cleanText(body.student_id || body.studentId || body.user_id || body.userId || body.learner_id || body.learnerId || "", 120);
  const contentId = cleanText(body.content_id || body.contentId || "", 120);
  const sentenceId = cleanText(body.sentence_id || body.sentenceId || "", 120);
  const playCount = Math.max(1, Number.parseInt(body.play_count ?? body.playCount ?? 1, 10) || 1);

  if (!studentId || !contentId || !sentenceId) {
    throw httpError(400, "student_id, content_id and sentence_id are required");
  }

  const sentence = await env.DB.prepare(`
    SELECT id, position FROM sentences WHERE id = ? AND content_id = ?
  `).bind(sentenceId, contentId).first();
  if (!sentence) throw httpError(404, "Sentence not found");

  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO listening_presence (
      student_id, content_id, sentence_id, current_position, play_count, last_event_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id, content_id) DO UPDATE SET
      sentence_id = excluded.sentence_id,
      current_position = excluded.current_position,
      play_count = listening_presence.play_count + excluded.play_count,
      last_event_at = excluded.last_event_at,
      updated_at = excluded.updated_at
  `).bind(studentId, contentId, sentenceId, sentence.position, playCount, now, now).run();

  const presence = await env.DB.prepare(`
    SELECT * FROM listening_presence WHERE student_id = ? AND content_id = ?
  `).bind(studentId, contentId).first();

  return { presence };
}

async function recordAttempt(request, env) {
  const body = await readJson(request);
  const learnerId = cleanText(body.learner_id || body.learnerId || body.user_id || body.userId || "", 120);
  const contentId = cleanText(body.content_id || body.contentId || "", 120);
  const sentenceId = cleanText(body.sentence_id || body.sentenceId || "", 120);
  const result = cleanText(body.result || "", 20);
  const evidenceType = cleanText(body.evidence_type || body.evidenceType || "self_report", 80);
  const replayCount = Math.max(0, Number.parseInt(body.replay_count ?? body.replayCount ?? 0, 10) || 0);
  const showedSubtitle = body.showed_subtitle || body.showedSubtitle ? 1 : 0;

  if (!learnerId || !contentId || !sentenceId) {
    throw httpError(400, "learner_id, content_id and sentence_id are required");
  }

  if (!["understood", "unsure", "missed"].includes(result)) {
    throw httpError(400, "result must be understood, unsure or missed");
  }

  const sentence = await env.DB.prepare(`
    SELECT id FROM sentences WHERE id = ? AND content_id = ?
  `).bind(sentenceId, contentId).first();
  if (!sentence) throw httpError(404, "Sentence not found");

  const previous = await env.DB.prepare(`
    SELECT status, first_result FROM sentence_progress
    WHERE learner_id = ? AND sentence_id = ?
  `).bind(learnerId, sentenceId).first();

  const previousStatus = previous?.status || "new";
  const nextStatus = transitionStatus(previousStatus, result);
  const now = new Date().toISOString();
  const attemptId = `attempt_${crypto.randomUUID()}`;
  const turnGreenAt = nextStatus === "green" ? now : null;

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO listening_attempts (
        id, learner_id, content_id, sentence_id, result, previous_status,
        next_status, evidence_type, showed_subtitle, replay_count, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      attemptId,
      learnerId,
      contentId,
      sentenceId,
      result,
      previousStatus,
      nextStatus,
      evidenceType,
      showedSubtitle,
      replayCount,
      now
    ),
    env.DB.prepare(`
      INSERT INTO sentence_progress (
        learner_id, content_id, sentence_id, status, first_result, last_result,
        replay_count, subtitle_views, review_count, turn_green_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(learner_id, sentence_id) DO UPDATE SET
        status = excluded.status,
        last_result = excluded.last_result,
        replay_count = sentence_progress.replay_count + excluded.replay_count,
        subtitle_views = sentence_progress.subtitle_views + excluded.subtitle_views,
        review_count = sentence_progress.review_count + 1,
        turn_green_at = CASE
          WHEN excluded.status = 'green' THEN COALESCE(sentence_progress.turn_green_at, excluded.turn_green_at)
          ELSE sentence_progress.turn_green_at
        END,
        updated_at = excluded.updated_at
    `).bind(
      learnerId,
      contentId,
      sentenceId,
      nextStatus,
      previous?.first_result || result,
      result,
      replayCount,
      showedSubtitle,
      turnGreenAt,
      now
    )
  ]);

  const progress = await env.DB.prepare(`
    SELECT * FROM sentence_progress
    WHERE learner_id = ? AND sentence_id = ?
  `).bind(learnerId, sentenceId).first();

  return { attempt_id: attemptId, progress };
}

async function getProgress(env, params) {
  const learnerId = params.get("learner_id") || params.get("learnerId") || params.get("user_id") || params.get("userId");
  const contentId = params.get("content_id") || params.get("contentId");
  if (!learnerId) throw httpError(400, "learner_id is required");

  const query = contentId
    ? env.DB.prepare(`
        SELECT * FROM sentence_progress
        WHERE learner_id = ? AND content_id = ?
        ORDER BY updated_at DESC
      `).bind(learnerId, contentId)
    : env.DB.prepare(`
        SELECT * FROM sentence_progress
        WHERE learner_id = ?
        ORDER BY updated_at DESC
      `).bind(learnerId);

  const result = await query.all();
  return { progress: result.results || [] };
}

async function getReview(env, params) {
  const learnerId = params.get("learner_id") || params.get("learnerId") || params.get("user_id") || params.get("userId");
  const contentId = params.get("content_id") || params.get("contentId");
  if (!learnerId) throw httpError(400, "learner_id is required");

  const query = contentId
    ? env.DB.prepare(`
        SELECT p.*, s.position, s.start_ms, s.end_ms, s.text, c.title
        FROM sentence_progress p
        JOIN sentences s ON s.id = p.sentence_id
        JOIN contents c ON c.id = p.content_id
        WHERE p.learner_id = ? AND p.content_id = ? AND p.status IN ('red', 'yellow')
        ORDER BY p.status DESC, p.updated_at DESC
      `).bind(learnerId, contentId)
    : env.DB.prepare(`
        SELECT p.*, s.position, s.start_ms, s.end_ms, s.text, c.title
        FROM sentence_progress p
        JOIN sentences s ON s.id = p.sentence_id
        JOIN contents c ON c.id = p.content_id
        WHERE p.learner_id = ? AND p.status IN ('red', 'yellow')
        ORDER BY p.status DESC, p.updated_at DESC
      `).bind(learnerId);

  const result = await query.all();
  return { review: result.results || [] };
}

async function teacherDashboard(env, params) {
  const teacherId = params.get("teacher_id") || params.get("teacherId") || params.get("user_id") || params.get("userId");
  const contentId = params.get("content_id") || params.get("contentId");
  if (!teacherId) throw httpError(400, "teacher_id is required");

  const teacher = await env.DB.prepare(`
    SELECT id, display_name, role FROM users WHERE id = ? AND role = 'teacher'
  `).bind(teacherId).first();
  if (!teacher) throw httpError(403, "Teacher account required");

  const studentsResult = await env.DB.prepare(`
    SELECT DISTINCT u.id, u.display_name, u.role
    FROM users u
    JOIN class_members cm_student ON cm_student.user_id = u.id
    JOIN classes c ON c.id = cm_student.class_id
    WHERE c.teacher_id = ? AND u.role = 'student'
    ORDER BY u.display_name ASC
  `).bind(teacherId).all();

  const students = [];
  for (const student of studentsResult.results || []) {
    const countsQuery = contentId
      ? env.DB.prepare(`
          SELECT status, COUNT(*) AS count FROM sentence_progress
          WHERE learner_id = ? AND content_id = ?
          GROUP BY status
        `).bind(student.id, contentId)
      : env.DB.prepare(`
          SELECT status, COUNT(*) AS count FROM sentence_progress
          WHERE learner_id = ?
          GROUP BY status
        `).bind(student.id);

    const presenceQuery = contentId
      ? env.DB.prepare(`
          SELECT lp.*, s.text
          FROM listening_presence lp
          JOIN sentences s ON s.id = lp.sentence_id
          WHERE lp.student_id = ? AND lp.content_id = ?
        `).bind(student.id, contentId)
      : env.DB.prepare(`
          SELECT lp.*, s.text
          FROM listening_presence lp
          JOIN sentences s ON s.id = lp.sentence_id
          WHERE lp.student_id = ?
          ORDER BY lp.updated_at DESC
          LIMIT 1
        `).bind(student.id);

    const reviewQuery = contentId
      ? env.DB.prepare(`
          SELECT p.status, p.review_count, p.replay_count, p.subtitle_views, p.updated_at,
                 s.position, s.text, c.title
          FROM sentence_progress p
          JOIN sentences s ON s.id = p.sentence_id
          JOIN contents c ON c.id = p.content_id
          WHERE p.learner_id = ? AND p.content_id = ? AND p.status IN ('red', 'yellow')
          ORDER BY p.status DESC, p.updated_at DESC
          LIMIT 8
        `).bind(student.id, contentId)
      : env.DB.prepare(`
          SELECT p.status, p.review_count, p.replay_count, p.subtitle_views, p.updated_at,
                 s.position, s.text, c.title
          FROM sentence_progress p
          JOIN sentences s ON s.id = p.sentence_id
          JOIN contents c ON c.id = p.content_id
          WHERE p.learner_id = ? AND p.status IN ('red', 'yellow')
          ORDER BY p.status DESC, p.updated_at DESC
          LIMIT 8
        `).bind(student.id);

    const [countsResult, presence, reviewResult] = await Promise.all([
      countsQuery.all(),
      presenceQuery.first(),
      reviewQuery.all()
    ]);

    const counts = { green: 0, yellow: 0, red: 0 };
    for (const row of countsResult.results || []) counts[row.status] = row.count;

    students.push({
      user: student,
      counts,
      presence,
      review: reviewResult.results || []
    });
  }

  return { teacher, students };
}

function parseStrictSrt(raw) {
  const normalized = String(raw || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return { ok: false, errors: ["SRT is empty"], sentences: [] };

  const blocks = normalized.split(/\n{2,}/);
  const errors = [];
  const sentences = [];
  let previousEnd = -1;

  blocks.forEach((block, blockIndex) => {
    const lines = block.split("\n").map((line) => line.trimEnd());
    const expectedIndex = blockIndex + 1;
    const numberLine = (lines[0] || "").trim();
    const timeLine = (lines[1] || "").trim();
    const textLines = lines.slice(2).filter((line) => line.trim());

    if (!/^\d+$/.test(numberLine)) {
      errors.push(`Block ${expectedIndex}: missing numeric index`);
      return;
    }

    const actualIndex = Number.parseInt(numberLine, 10);
    if (actualIndex !== expectedIndex) {
      errors.push(`Block ${expectedIndex}: expected index ${expectedIndex}, got ${actualIndex}`);
    }

    const timeMatch = timeLine.match(/^(\d{2,}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2,}:\d{2}:\d{2},\d{3})(?:\s+.*)?$/);
    if (!timeMatch) {
      errors.push(`Block ${expectedIndex}: invalid time range`);
      return;
    }

    const startMs = parseSrtTime(timeMatch[1]);
    const endMs = parseSrtTime(timeMatch[2]);
    if (startMs === null || endMs === null) {
      errors.push(`Block ${expectedIndex}: invalid timestamp`);
      return;
    }

    if (startMs >= endMs) {
      errors.push(`Block ${expectedIndex}: start time must be before end time`);
    }

    if (previousEnd > startMs) {
      errors.push(`Block ${expectedIndex}: overlaps previous subtitle`);
    }
    previousEnd = Math.max(previousEnd, endMs);

    if (!textLines.length) {
      errors.push(`Block ${expectedIndex}: subtitle text is empty`);
    }

    sentences.push({
      start_ms: startMs,
      end_ms: endMs,
      text: textLines.join(" ").replace(/\s+/g, " ").trim()
    });
  });

  return { ok: errors.length === 0, errors, sentences };
}

function parseSrtTime(value) {
  const match = String(value).match(/^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/);
  if (!match) return null;
  return (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 + Number(match[4]);
}

function transitionStatus(previousStatus, result) {
  if (result !== "understood") return "red";
  if (previousStatus === "red") return "yellow";
  if (previousStatus === "yellow") return "green";
  return "green";
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw httpError(400, "Invalid JSON body");
  }
}

function parseSource(sourceUrl) {
  const youtube = sourceUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{6,})/);
  const bilibili = sourceUrl.match(/bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/);
  if (youtube) return { source_type: "youtube", video_id: youtube[1] };
  if (bilibili) return { source_type: "bilibili", video_id: bilibili[1] };
  if (sourceUrl) return { source_type: "video", video_id: "" };
  return { source_type: "unknown", video_id: "" };
}

function getCaptionBase(env) {
  return String(env.VIDEOCAPTIONER_API_BASE || "").replace(/\/+$/, "");
}

function cleanText(value, maxLength) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeText(value) {
  return cleanText(value, 2000).toLowerCase().replace(/[^a-z0-9\s']/g, "");
}

function toMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number > 1000 ? number : number * 1000);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: JSON_HEADERS
  });
}

function httpError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}
