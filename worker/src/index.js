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

      if (path === "/health") {
        return json(await health(env));
      }

      if (path === "/api/contents" && request.method === "GET") {
        return json(await listContents(env));
      }

      if (path === "/api/contents" && request.method === "POST") {
        return json(await createContent(request, env), 201);
      }

      const contentMatch = path.match(/^\/api\/contents\/([^/]+)$/);
      if (contentMatch && request.method === "GET") {
        return json(await getContent(env, decodeURIComponent(contentMatch[1])));
      }

      if (path === "/api/attempts" && request.method === "POST") {
        return json(await recordAttempt(request, env), 201);
      }

      if (path === "/api/progress" && request.method === "GET") {
        return json(await getProgress(env, url.searchParams));
      }

      if (path === "/api/review" && request.method === "GET") {
        return json(await getReview(env, url.searchParams));
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error.message || "Unexpected error" }, error.status || 500);
    }
  }
};

async function health(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS content_count FROM contents").first();
  return {
    ok: true,
    database: "listening",
    content_count: row?.content_count ?? 0,
    checked_at: new Date().toISOString()
  };
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
  const parsed = parseSource(sourceUrl);
  const sentences = Array.isArray(body.sentences) ? body.sentences : [];

  if (!sentences.length) {
    throw httpError(400, "At least one sentence is required");
  }

  const contentId = `content_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const statements = [
    env.DB.prepare(`
      INSERT INTO contents (id, title, source_url, source_type, video_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(contentId, title, sourceUrl, parsed.source_type, parsed.video_id, createdAt)
  ];

  sentences.slice(0, 400).forEach((sentence, index) => {
    const text = cleanText(sentence.text || "", 1200);
    if (!text) return;

    const startMs = toMs(sentence.start_ms ?? sentence.start ?? index * 4);
    const endMs = Math.max(startMs + 500, toMs(sentence.end_ms ?? sentence.end ?? (index + 1) * 4));
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

async function recordAttempt(request, env) {
  const body = await readJson(request);
  const learnerId = cleanText(body.learner_id || body.learnerId || "", 120);
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
  const learnerId = params.get("learner_id") || params.get("learnerId");
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
  const learnerId = params.get("learner_id") || params.get("learnerId");
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

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

