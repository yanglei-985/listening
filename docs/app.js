const API_BASE = (window.LISTENING_API_BASE || "").replace(/\/+$/, "");
const DEMO_CONTENT = {
  id: "demo_bilingual_brain",
  title: "Demo: bilingual brain listening drill",
  source_url: "https://www.youtube.com/watch?v=MMmOLN5zBLY",
  source_type: "youtube",
  video_id: "MMmOLN5zBLY",
  sentences: [
    { id: "demo_bilingual_brain_s1", position: 1, start: 0, end: 5.2, text: "A useful listening session starts with input that the learner can already read." },
    { id: "demo_bilingual_brain_s2", position: 2, start: 5.2, end: 10.3, text: "Then the text disappears and the ear has to rebuild the sentence from sound." },
    { id: "demo_bilingual_brain_s3", position: 3, start: 10.3, end: 16, text: "A red sentence is not a failure; it is the exact place where teaching should begin." },
    { id: "demo_bilingual_brain_s4", position: 4, start: 16, end: 21.4, text: "When a learner checks the transcript and hears it once, the system marks it yellow." },
    { id: "demo_bilingual_brain_s5", position: 5, start: 21.4, end: 27.1, text: "Only after another clean pass does that sentence finally turn green." }
  ]
};

const els = {
  body: document.body,
  syncStatus: document.querySelector("#syncStatus"),
  contentSelect: document.querySelector("#contentSelect"),
  openImport: document.querySelector("#openImport"),
  teacherToggle: document.querySelector("#teacherToggle"),
  sentenceList: document.querySelector("#sentenceList"),
  mediaMount: document.querySelector("#mediaMount"),
  currentIndex: document.querySelector("#currentIndex"),
  currentTime: document.querySelector("#currentTime"),
  currentSentence: document.querySelector("#currentSentence"),
  favoriteBtn: document.querySelector("#favoriteBtn"),
  prevBtn: document.querySelector("#prevBtn"),
  replayBtn: document.querySelector("#replayBtn"),
  nextBtn: document.querySelector("#nextBtn"),
  toggleSubtitles: document.querySelector("#toggleSubtitles"),
  understoodBtn: document.querySelector("#understoodBtn"),
  unsureBtn: document.querySelector("#unsureBtn"),
  missedBtn: document.querySelector("#missedBtn"),
  greenCount: document.querySelector("#greenCount"),
  yellowCount: document.querySelector("#yellowCount"),
  redCount: document.querySelector("#redCount"),
  accuracyRate: document.querySelector("#accuracyRate"),
  reviewSize: document.querySelector("#reviewSize"),
  reviewList: document.querySelector("#reviewList"),
  teacherSection: document.querySelector("#teacherSection"),
  teacherList: document.querySelector("#teacherList"),
  importDialog: document.querySelector("#importDialog"),
  importForm: document.querySelector("#importForm"),
  closeImport: document.querySelector("#closeImport"),
  importTitle: document.querySelector("#importTitle"),
  importUrl: document.querySelector("#importUrl"),
  importTranscript: document.querySelector("#importTranscript"),
  loadDemoTranscript: document.querySelector("#loadDemoTranscript")
};

const state = {
  learnerId: getLearnerId(),
  contents: [],
  content: normalizeContent(DEMO_CONTENT),
  currentIndex: 0,
  progress: loadJson("listening.progress", {}),
  playbackCounts: loadJson("listening.playbackCounts", {}),
  favorites: loadJson("listening.favorites", {}),
  subtitlesVisible: false,
  teacherVisible: false,
  ytPlayer: null,
  ytReady: false,
  mediaKind: "none",
  segmentTimer: null
};

init();

function init() {
  bindEvents();
  setSyncStatus(API_BASE ? "Connecting API..." : "Local draft");
  render();
  loadContents();
}

function bindEvents() {
  els.contentSelect.addEventListener("change", () => loadContent(els.contentSelect.value));
  els.openImport.addEventListener("click", () => els.importDialog.showModal());
  els.closeImport.addEventListener("click", () => els.importDialog.close());
  els.teacherToggle.addEventListener("click", () => {
    state.teacherVisible = !state.teacherVisible;
    renderInsights();
  });
  els.prevBtn.addEventListener("click", previousSentence);
  els.replayBtn.addEventListener("click", () => playCurrentSentence(true));
  els.nextBtn.addEventListener("click", nextSentence);
  els.toggleSubtitles.addEventListener("click", toggleSubtitles);
  els.favoriteBtn.addEventListener("click", toggleFavorite);
  els.understoodBtn.addEventListener("click", () => markCurrent("understood"));
  els.unsureBtn.addEventListener("click", () => markCurrent("unsure"));
  els.missedBtn.addEventListener("click", () => markCurrent("missed"));
  els.loadDemoTranscript.addEventListener("click", loadDemoIntoForm);
  els.importForm.addEventListener("submit", handleImport);

  window.addEventListener("keydown", (event) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
    if (event.key === "ArrowLeft") previousSentence();
    if (event.key === "ArrowDown") playCurrentSentence(true);
    if (event.key === "ArrowRight") nextSentence();
    if (event.key === " ") {
      event.preventDefault();
      playCurrentSentence(true);
    }
  });
}

async function loadContents() {
  if (!API_BASE) {
    state.contents = [state.content];
    renderContentSelect();
    return;
  }

  try {
    const health = await api("/health");
    setSyncStatus(`API connected · D1 ${health.database}`);
    const data = await api("/api/contents");
    state.contents = data.contents.length ? data.contents.map(normalizeContent) : [state.content];
    renderContentSelect();
    await loadContent(state.contents[0].id);
  } catch (error) {
    setSyncStatus(`Offline fallback · ${error.message}`);
    state.contents = [state.content];
    renderContentSelect();
  }
}

async function loadContent(contentId) {
  if (!contentId) return;

  const local = state.contents.find((item) => item.id === contentId);
  if (!API_BASE || contentId.startsWith("local_")) {
    state.content = normalizeContent(local || DEMO_CONTENT);
    state.currentIndex = 0;
    render();
    return;
  }

  try {
    const data = await api(`/api/contents/${encodeURIComponent(contentId)}`);
    state.content = normalizeContent({ ...data.content, sentences: data.sentences });
    state.currentIndex = 0;
    await syncProgress();
    render();
  } catch (error) {
    setSyncStatus(`Could not load content · ${error.message}`);
  }
}

async function syncProgress() {
  if (!API_BASE || !state.content?.id) return;
  try {
    const data = await api(`/api/progress?learner_id=${encodeURIComponent(state.learnerId)}&content_id=${encodeURIComponent(state.content.id)}`);
    data.progress.forEach((row) => {
      state.progress[row.sentence_id] = {
        status: row.status,
        attempts: row.review_count,
        firstResult: row.first_result,
        lastResult: row.last_result,
        replayCount: row.replay_count,
        subtitleViews: row.subtitle_views,
        updatedAt: row.updated_at
      };
    });
    persistProgress();
  } catch (error) {
    setSyncStatus(`Progress local only · ${error.message}`);
  }
}

function render() {
  renderContentSelect();
  renderMedia();
  renderSentences();
  renderCurrentSentence();
  renderInsights();
  els.body.classList.toggle("hide-subtitles", !state.subtitlesVisible);
  els.toggleSubtitles.textContent = state.subtitlesVisible ? "隐藏字幕" : "显示字幕";
}

function renderContentSelect() {
  els.contentSelect.innerHTML = "";
  state.contents.forEach((content) => {
    const option = document.createElement("option");
    option.value = content.id;
    option.textContent = `${content.title} (${content.sentence_count || content.sentences?.length || 0})`;
    option.selected = state.content?.id === content.id;
    els.contentSelect.append(option);
  });
}

function renderMedia() {
  const source = parseSource(state.content?.source_url || "");
  if (els.mediaMount.dataset.contentId === state.content?.id) return;

  stopSegmentTimer();
  state.ytPlayer = null;
  state.ytReady = false;
  state.mediaKind = source.type;
  els.mediaMount.dataset.contentId = state.content?.id || "";

  if (source.type === "youtube") {
    els.mediaMount.innerHTML = '<div id="youtubePlayer"></div>';
    loadYouTubeApi().then(() => {
      state.ytPlayer = new YT.Player("youtubePlayer", {
        videoId: source.id,
        playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
        events: {
          onReady: () => {
            state.ytReady = true;
          }
        }
      });
    }).catch(() => renderFallback("Video preview unavailable"));
    return;
  }

  if (source.type === "bilibili") {
    els.mediaMount.innerHTML = `<iframe src="https://player.bilibili.com/player.html?bvid=${encodeURIComponent(source.id)}&autoplay=0" allowfullscreen title="Bilibili player"></iframe>`;
    return;
  }

  if (source.type === "video") {
    els.mediaMount.innerHTML = `<video id="nativeVideo" src="${escapeHtml(state.content.source_url)}" controls playsinline></video>`;
    return;
  }

  renderFallback("Import a video URL to attach media");
}

function renderFallback(text) {
  els.mediaMount.innerHTML = `<div class="media-fallback">${escapeHtml(text)}</div>`;
}

function renderSentences() {
  const fragment = document.createDocumentFragment();
  state.content.sentences.forEach((sentence, index) => {
    const row = document.createElement("li");
    const progress = state.progress[sentence.id];
    const status = progress?.status || "new";
    row.className = `sentence ${status} ${index === state.currentIndex ? "active" : ""}`;
    row.tabIndex = 0;
    row.innerHTML = `
      <span class="sentence-index">${String(index + 1).padStart(2, "0")}</span>
      <p class="sentence-text">${escapeHtml(sentence.text)}</p>
      <span class="sentence-state" aria-hidden="true"></span>
    `;
    row.addEventListener("click", () => {
      state.currentIndex = index;
      render();
      playCurrentSentence(false);
    });
    fragment.append(row);
  });
  els.sentenceList.replaceChildren(fragment);
}

function renderCurrentSentence() {
  const sentence = currentSentence();
  els.currentIndex.textContent = String(state.currentIndex + 1).padStart(2, "0");
  els.currentTime.textContent = `${formatTime(sentence.start)} - ${formatTime(sentence.end)}`;
  els.currentSentence.textContent = sentence.text;
  els.favoriteBtn.textContent = state.favorites[sentence.id] ? "★" : "☆";
}

function renderInsights() {
  const counts = countStatuses();
  els.greenCount.textContent = counts.green;
  els.yellowCount.textContent = counts.yellow;
  els.redCount.textContent = counts.red;

  const attempted = Object.values(state.progress).filter((item) => item.firstResult).length;
  const firstPass = Object.values(state.progress).filter((item) => item.firstResult === "understood").length;
  els.accuracyRate.textContent = attempted ? `${Math.round((firstPass / attempted) * 100)}%` : "0%";

  const reviewItems = state.content.sentences
    .map((sentence, index) => ({ sentence, index, progress: state.progress[sentence.id] }))
    .filter((item) => ["red", "yellow"].includes(item.progress?.status));
  els.reviewSize.textContent = reviewItems.length;

  els.reviewList.replaceChildren(
    ...reviewItems.map((item) => {
      const node = document.createElement("div");
      node.className = `review-item ${item.progress.status}`;
      node.innerHTML = `<button type="button">${escapeHtml(item.sentence.text)}</button><p>${item.progress.status.toUpperCase()} · ${formatTime(item.sentence.start)}</p>`;
      node.querySelector("button").addEventListener("click", () => {
        state.currentIndex = item.index;
        render();
        playCurrentSentence(false);
      });
      return node;
    })
  );

  if (!reviewItems.length) {
    els.reviewList.innerHTML = '<div class="empty">暂无红黄句</div>';
  }

  els.teacherSection.hidden = !state.teacherVisible;
  els.teacherToggle.classList.toggle("primary", state.teacherVisible);
  if (state.teacherVisible) renderTeacherView(reviewItems);
}

function renderTeacherView(reviewItems) {
  const repeatedWords = extractRepeatedWords(reviewItems.map((item) => item.sentence.text));
  const nodes = reviewItems.slice(0, 8).map((item) => {
    const node = document.createElement("div");
    node.className = `teacher-item ${item.progress.status}`;
    node.innerHTML = `<strong>${escapeHtml(item.sentence.text)}</strong><p>${item.progress.status} · replay ${item.progress.replayCount || 0} · subtitle ${item.progress.subtitleViews || 0}</p>`;
    return node;
  });

  if (repeatedWords.length) {
    const node = document.createElement("div");
    node.className = "teacher-item yellow";
    node.innerHTML = `<strong>${repeatedWords.join(", ")}</strong><p>高频卡词</p>`;
    nodes.unshift(node);
  }

  els.teacherList.replaceChildren(...nodes);
  if (!nodes.length) {
    els.teacherList.innerHTML = '<div class="empty">还没有可诊断的卡点</div>';
  }
}

function previousSentence() {
  state.currentIndex = Math.max(0, state.currentIndex - 1);
  render();
  playCurrentSentence(false);
}

function nextSentence() {
  state.currentIndex = Math.min(state.content.sentences.length - 1, state.currentIndex + 1);
  render();
  playCurrentSentence(false);
}

function playCurrentSentence(isReplay) {
  const sentence = currentSentence();
  const count = (state.playbackCounts[sentence.id] || 0) + 1;
  state.playbackCounts[sentence.id] = count;
  saveJson("listening.playbackCounts", state.playbackCounts);
  stopSegmentTimer();

  if (state.mediaKind === "youtube" && state.ytPlayer && state.ytReady) {
    state.ytPlayer.seekTo(sentence.start, true);
    state.ytPlayer.playVideo();
    state.segmentTimer = window.setInterval(() => {
      if (state.ytPlayer.getCurrentTime && state.ytPlayer.getCurrentTime() >= sentence.end) {
        state.ytPlayer.pauseVideo();
        stopSegmentTimer();
      }
    }, 180);
    return;
  }

  const nativeVideo = document.querySelector("#nativeVideo");
  if (nativeVideo) {
    nativeVideo.currentTime = sentence.start;
    nativeVideo.play();
    state.segmentTimer = window.setInterval(() => {
      if (nativeVideo.currentTime >= sentence.end) {
        nativeVideo.pause();
        stopSegmentTimer();
      }
    }, 180);
  }

  if (isReplay) renderInsights();
}

async function markCurrent(result) {
  const sentence = currentSentence();
  const current = state.progress[sentence.id] || {};
  const previousStatus = current.status || "new";
  const nextStatus = transitionStatus(previousStatus, result);
  const now = new Date().toISOString();
  const replayCount = state.playbackCounts[sentence.id] || 0;
  const subtitleViews = state.subtitlesVisible ? 1 : 0;

  state.progress[sentence.id] = {
    ...current,
    status: nextStatus,
    attempts: (current.attempts || 0) + 1,
    firstResult: current.firstResult || result,
    lastResult: result,
    replayCount: (current.replayCount || 0) + replayCount,
    subtitleViews: (current.subtitleViews || 0) + subtitleViews,
    updatedAt: now
  };
  state.playbackCounts[sentence.id] = 0;
  persistProgress();
  saveJson("listening.playbackCounts", state.playbackCounts);
  render();

  if (API_BASE) {
    try {
      await api("/api/attempts", {
        method: "POST",
        body: {
          learner_id: state.learnerId,
          content_id: state.content.id,
          sentence_id: sentence.id,
          result,
          evidence_type: "self_report",
          showed_subtitle: state.subtitlesVisible,
          replay_count: replayCount
        }
      });
      setSyncStatus("Progress synced");
    } catch (error) {
      setSyncStatus(`Progress local only · ${error.message}`);
    }
  }

  if (nextStatus === "green") {
    moveToNextReviewCandidate();
  }
}

function moveToNextReviewCandidate() {
  const sentences = state.content.sentences;
  const next = sentences.findIndex((sentence, index) => index > state.currentIndex && state.progress[sentence.id]?.status !== "green");
  if (next >= 0) {
    state.currentIndex = next;
    render();
    playCurrentSentence(false);
  }
}

function toggleSubtitles() {
  state.subtitlesVisible = !state.subtitlesVisible;
  if (state.subtitlesVisible) {
    const sentence = currentSentence();
    const current = state.progress[sentence.id] || {};
    state.progress[sentence.id] = {
      ...current,
      subtitleViews: (current.subtitleViews || 0) + 1
    };
    persistProgress();
  }
  render();
}

function toggleFavorite() {
  const sentence = currentSentence();
  state.favorites[sentence.id] = !state.favorites[sentence.id];
  saveJson("listening.favorites", state.favorites);
  renderCurrentSentence();
}

async function handleImport(event) {
  event.preventDefault();
  const title = els.importTitle.value.trim() || "Untitled listening content";
  const sourceUrl = els.importUrl.value.trim();
  const sentences = parseTranscript(els.importTranscript.value);
  if (!sentences.length) {
    setSyncStatus("Import failed · no sentences");
    return;
  }

  const localContent = normalizeContent({
    id: `local_${Date.now()}`,
    title,
    source_url: sourceUrl,
    ...parseSource(sourceUrl),
    sentences
  });

  if (API_BASE) {
    try {
      const data = await api("/api/contents", {
        method: "POST",
        body: {
          title,
          source_url: sourceUrl,
          sentences
        }
      });
      const remote = normalizeContent({ ...data.content, sentences: data.sentences });
      state.contents.unshift(remote);
      state.content = remote;
      state.currentIndex = 0;
      setSyncStatus("Content saved to D1");
    } catch (error) {
      state.contents.unshift(localContent);
      state.content = localContent;
      setSyncStatus(`Saved locally · ${error.message}`);
    }
  } else {
    state.contents.unshift(localContent);
    state.content = localContent;
    setSyncStatus("Saved locally");
  }

  els.importDialog.close();
  els.importForm.reset();
  render();
}

function loadDemoIntoForm() {
  els.importTitle.value = "Demo: bilingual brain listening drill";
  els.importUrl.value = "https://www.youtube.com/watch?v=MMmOLN5zBLY";
  els.importTranscript.value = DEMO_CONTENT.sentences
    .map((sentence) => `${formatTime(sentence.start)} - ${formatTime(sentence.end)} ${sentence.text}`)
    .join("\n");
}

function parseTranscript(raw) {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsed = lines.map((line, index) => {
    const match = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[\.,]\d{1,3})?)\]?\s*(?:[-–]|-->|to)?\s*\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[\.,]\d{1,3})?)?\]?\s*(.*)$/i);
    if (match && match[3]) {
      return {
        start: toSeconds(match[1]),
        end: match[2] ? toSeconds(match[2]) : null,
        text: match[3].trim()
      };
    }
    return {
      start: index * 4,
      end: index * 4 + 4,
      text: line
    };
  });

  parsed.forEach((item, index) => {
    if (item.end === null) {
      item.end = parsed[index + 1]?.start || item.start + 4;
    }
  });

  return regroupFragments(parsed).map((item, index) => ({
    id: `local_sentence_${Date.now()}_${index}`,
    position: index + 1,
    start: item.start,
    end: Math.max(item.end, item.start + 0.5),
    text: item.text
  }));
}

function regroupFragments(items) {
  const result = [];
  for (const item of items) {
    const previous = result[result.length - 1];
    const shouldMerge = previous && !/[.!?。？！]$/.test(previous.text) && item.start - previous.end <= 1.2;
    if (shouldMerge) {
      previous.text = `${previous.text} ${item.text}`.replace(/\s+/g, " ").trim();
      previous.end = item.end;
    } else {
      result.push({ ...item });
    }
  }
  return result;
}

function transitionStatus(previousStatus, result) {
  if (result !== "understood") return "red";
  if (previousStatus === "red") return "yellow";
  if (previousStatus === "yellow") return "green";
  return "green";
}

function countStatuses() {
  return state.content.sentences.reduce((counts, sentence) => {
    const status = state.progress[sentence.id]?.status;
    if (status) counts[status] += 1;
    return counts;
  }, { green: 0, yellow: 0, red: 0 });
}

function currentSentence() {
  return state.content.sentences[state.currentIndex] || state.content.sentences[0];
}

function normalizeContent(content) {
  const sentences = (content.sentences || []).map((sentence, index) => ({
    id: sentence.id || `sentence_${content.id}_${index + 1}`,
    position: sentence.position || index + 1,
    start: Number.isFinite(sentence.start) ? sentence.start : (sentence.start_ms || 0) / 1000,
    end: Number.isFinite(sentence.end) ? sentence.end : (sentence.end_ms || 0) / 1000,
    text: sentence.text || ""
  }));
  return {
    ...content,
    source_url: content.source_url || content.sourceUrl || "",
    source_type: content.source_type || content.sourceType || "unknown",
    video_id: content.video_id || content.videoId || "",
    sentence_count: content.sentence_count || sentences.length,
    sentences
  };
}

function parseSource(sourceUrl) {
  const youtube = sourceUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{6,})/);
  const bilibili = sourceUrl.match(/bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/);
  if (youtube) return { type: "youtube", source_type: "youtube", id: youtube[1], video_id: youtube[1] };
  if (bilibili) return { type: "bilibili", source_type: "bilibili", id: bilibili[1], video_id: bilibili[1] };
  if (/\.(mp4|webm|ogg)(\?.*)?$/i.test(sourceUrl)) return { type: "video", source_type: "video", id: "", video_id: "" };
  return { type: "unknown", source_type: "unknown", id: "", video_id: "" };
}

function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function toSeconds(stamp) {
  const normalized = String(stamp).replace(",", ".");
  const parts = normalized.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(normalized) || 0;
}

function extractRepeatedWords(lines) {
  const stop = new Set(["that", "with", "this", "from", "only", "after", "where", "when", "then", "does", "have", "into", "will", "your", "they"]);
  const counts = new Map();
  lines.join(" ").toLowerCase().match(/[a-z']{4,}/g)?.forEach((word) => {
    if (!stop.has(word)) counts.set(word, (counts.get(word) || 0) + 1);
  });
  return [...counts.entries()].filter(([, count]) => count >= 1).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([word]) => word);
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method || "GET",
    headers: { "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function setSyncStatus(text) {
  els.syncStatus.textContent = text;
}

function persistProgress() {
  saveJson("listening.progress", state.progress);
}

function getLearnerId() {
  const existing = localStorage.getItem("listening.learnerId");
  if (existing) return existing;
  const created = `learner_${crypto.randomUUID()}`;
  localStorage.setItem("listening.learnerId", created);
  return created;
}

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function stopSegmentTimer() {
  if (state.segmentTimer) {
    window.clearInterval(state.segmentTimer);
    state.segmentTimer = null;
  }
}

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (window.__listeningYouTubeApiPromise) return window.__listeningYouTubeApiPromise;

  window.__listeningYouTubeApiPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onload = () => {
      window.onYouTubeIframeAPIReady = () => resolve();
      if (window.YT?.Player) resolve();
    };
    script.onerror = reject;
    document.head.append(script);
  });
  return window.__listeningYouTubeApiPromise;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

