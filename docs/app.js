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
  accessCode: document.querySelector("#accessCode"),
  loginBtn: document.querySelector("#loginBtn"),
  accountBadge: document.querySelector("#accountBadge"),
  sentenceList: document.querySelector("#sentenceList"),
  mediaMount: document.querySelector("#mediaMount"),
  currentBlock: document.querySelector("#currentBlock"),
  currentIndex: document.querySelector("#currentIndex"),
  currentTime: document.querySelector("#currentTime"),
  currentSentence: document.querySelector("#currentSentence"),
  favoriteBtn: document.querySelector("#favoriteBtn"),
  prevBtn: document.querySelector("#prevBtn"),
  replayBtn: document.querySelector("#replayBtn"),
  nextBtn: document.querySelector("#nextBtn"),
  toggleSentenceMask: document.querySelector("#toggleSentenceMask"),
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
  srtFile: document.querySelector("#srtFile"),
  srtValidation: document.querySelector("#srtValidation"),
  loadDemoTranscript: document.querySelector("#loadDemoTranscript"),
  generateCaption: document.querySelector("#generateCaption"),
  captionJobStatus: document.querySelector("#captionJobStatus")
};

const state = {
  account: loadJson("listening.account", null),
  learnerId: "",
  contents: [],
  content: normalizeContent(DEMO_CONTENT),
  currentIndex: 0,
  progress: loadJson("listening.progress", {}),
  playbackCounts: loadJson("listening.playbackCounts", {}),
  favorites: loadJson("listening.favorites", {}),
  allSubtitlesVisible: false,
  currentSentenceVisible: false,
  teacherVisible: false,
  teacherDashboard: null,
  ytPlayer: null,
  ytReady: false,
  mediaKind: "none",
  segmentTimer: null
};

state.learnerId = state.account?.user?.id || getLocalLearnerId();

init();

function init() {
  bindEvents();
  renderAccount();
  validateSrtField();
  setSyncStatus(API_BASE ? "Connecting API..." : "Local draft");
  render();
  loadContents();
}

function bindEvents() {
  els.contentSelect.addEventListener("change", () => loadContent(els.contentSelect.value));
  els.openImport.addEventListener("click", () => els.importDialog.showModal());
  els.closeImport.addEventListener("click", () => els.importDialog.close());
  els.teacherToggle.addEventListener("click", async () => {
    state.teacherVisible = !state.teacherVisible;
    if (state.teacherVisible) await loadTeacherDashboard();
    renderInsights();
  });
  els.loginBtn.addEventListener("click", login);
  els.accessCode.addEventListener("keydown", (event) => {
    if (event.key === "Enter") login();
  });
  els.prevBtn.addEventListener("click", previousSentence);
  els.replayBtn.addEventListener("click", () => playCurrentSentence(true));
  els.nextBtn.addEventListener("click", nextSentence);
  els.toggleSentenceMask.addEventListener("click", toggleCurrentSentence);
  els.toggleSubtitles.addEventListener("click", toggleAllSubtitles);
  els.favoriteBtn.addEventListener("click", toggleFavorite);
  els.understoodBtn.addEventListener("click", () => markCurrent("understood"));
  els.unsureBtn.addEventListener("click", () => markCurrent("unsure"));
  els.missedBtn.addEventListener("click", () => markCurrent("missed"));
  els.loadDemoTranscript.addEventListener("click", loadDemoIntoForm);
  els.importTranscript.addEventListener("input", validateSrtField);
  els.srtFile.addEventListener("change", readSrtFile);
  els.generateCaption.addEventListener("click", generateCaption);
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

async function login() {
  const accessCode = els.accessCode.value.trim();
  if (!accessCode) return setSyncStatus("请输入访问码");
  if (!API_BASE) return setSyncStatus("API 未配置");

  try {
    const account = await api("/api/accounts/login", {
      method: "POST",
      body: { access_code: accessCode }
    });
    state.account = account;
    state.learnerId = account.user.id;
    saveJson("listening.account", account);
    els.accessCode.value = "";
    setSyncStatus(`${account.user.display_name} 已进入`);
    await syncProgress();
    if (account.user.role === "teacher") {
      state.teacherVisible = true;
      await loadTeacherDashboard();
    }
    render();
  } catch (error) {
    setSyncStatus(`登录失败 · ${error.message}`);
  }
}

async function loadContents() {
  if (!API_BASE) {
    state.contents = [state.content];
    renderContentSelect();
    return;
  }

  try {
    const health = await api("/health");
    const caption = health.caption_service_configured ? "VideoCaptioner ready" : "VideoCaptioner 待配置";
    setSyncStatus(`API connected · D1 ${health.database} · ${caption}`);
    els.captionJobStatus.textContent = caption;
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
    state.currentSentenceVisible = false;
    render();
    return;
  }

  try {
    const data = await api(`/api/contents/${encodeURIComponent(contentId)}`);
    state.content = normalizeContent({ ...data.content, sentences: data.sentences });
    state.currentIndex = 0;
    state.currentSentenceVisible = false;
    await syncProgress();
    if (state.teacherVisible) await loadTeacherDashboard();
    render();
  } catch (error) {
    setSyncStatus(`内容加载失败 · ${error.message}`);
  }
}

async function syncProgress() {
  if (!API_BASE || !state.content?.id || !state.learnerId) return;
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
    setSyncStatus(`进度仅本地 · ${error.message}`);
  }
}

async function loadTeacherDashboard() {
  if (!API_BASE || state.account?.user?.role !== "teacher") {
    state.teacherDashboard = null;
    return;
  }

  try {
    const query = new URLSearchParams({
      teacher_id: state.account.user.id,
      content_id: state.content.id
    });
    state.teacherDashboard = await api(`/api/teacher/dashboard?${query}`);
  } catch (error) {
    state.teacherDashboard = { error: error.message, students: [] };
  }
}

function render() {
  renderAccount();
  renderContentSelect();
  renderMedia();
  renderSentences();
  renderCurrentSentence();
  renderInsights();
  els.body.classList.toggle("show-all-subtitles", state.allSubtitlesVisible);
  els.body.classList.toggle("show-current-subtitle", state.currentSentenceVisible);
  els.toggleSentenceMask.textContent = state.currentSentenceVisible ? "遮蔽本句" : "显示本句";
  els.toggleSubtitles.textContent = state.allSubtitlesVisible ? "遮蔽全部" : "显示全部";
}

function renderAccount() {
  if (!state.account?.user) {
    els.accountBadge.textContent = "未登录";
    els.teacherToggle.disabled = true;
    return;
  }
  els.accountBadge.textContent = `${state.account.user.display_name} · ${state.account.user.role === "teacher" ? "老师" : "学生"}`;
  els.teacherToggle.disabled = state.account.user.role !== "teacher";
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
        events: { onReady: () => { state.ytReady = true; } }
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
    const isActive = index === state.currentIndex;
    const isRevealed = state.allSubtitlesVisible || (isActive && state.currentSentenceVisible);
    row.className = `sentence ${status} ${isActive ? "active" : ""} ${isRevealed ? "revealed" : ""}`;
    row.tabIndex = 0;
    row.innerHTML = `
      <span class="sentence-index">${String(index + 1).padStart(2, "0")}</span>
      <p class="sentence-text">${escapeHtml(sentence.text)}</p>
      <span class="sentence-state" aria-hidden="true"></span>
    `;
    row.addEventListener("click", () => {
      state.currentIndex = index;
      state.currentSentenceVisible = false;
      render();
      playCurrentSentence(false);
    });
    fragment.append(row);
  });
  els.sentenceList.replaceChildren(fragment);
}

function renderCurrentSentence() {
  const sentence = currentSentence();
  els.currentBlock.classList.toggle("revealed", state.allSubtitlesVisible || state.currentSentenceVisible);
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

  const attempted = state.content.sentences.filter((sentence) => state.progress[sentence.id]?.firstResult).length;
  const firstPass = state.content.sentences.filter((sentence) => state.progress[sentence.id]?.firstResult === "understood").length;
  els.accuracyRate.textContent = attempted ? `${Math.round((firstPass / attempted) * 100)}%` : "0%";

  const reviewItems = getReviewItems();
  els.reviewSize.textContent = reviewItems.length;
  els.reviewList.replaceChildren(...reviewItems.map(renderReviewItem));
  if (!reviewItems.length) els.reviewList.innerHTML = '<div class="empty">暂无红黄句</div>';

  els.teacherSection.hidden = !state.teacherVisible;
  els.teacherToggle.classList.toggle("primary", state.teacherVisible);
  if (state.teacherVisible) renderTeacherView();
}

function renderReviewItem(item) {
  const node = document.createElement("div");
  node.className = `review-item ${item.progress.status}`;
  node.innerHTML = `<button type="button">${escapeHtml(item.sentence.text)}</button><p>${item.progress.status.toUpperCase()} · ${formatTime(item.sentence.start)}</p>`;
  node.querySelector("button").addEventListener("click", () => {
    state.currentIndex = item.index;
    state.currentSentenceVisible = false;
    render();
    playCurrentSentence(false);
  });
  return node;
}

function renderTeacherView() {
  if (state.account?.user?.role !== "teacher") {
    els.teacherList.innerHTML = '<div class="empty">老师访问码进入后可查看学生卡点</div>';
    return;
  }

  if (!state.teacherDashboard) {
    els.teacherList.innerHTML = '<div class="empty">老师后台加载中</div>';
    return;
  }

  if (state.teacherDashboard.error) {
    els.teacherList.innerHTML = `<div class="empty">老师后台加载失败：${escapeHtml(state.teacherDashboard.error)}</div>`;
    return;
  }

  const students = state.teacherDashboard.students || [];
  if (!students.length) {
    els.teacherList.innerHTML = '<div class="empty">暂无学生数据</div>';
    return;
  }

  els.teacherList.replaceChildren(...students.map((student) => {
    const node = document.createElement("div");
    node.className = "teacher-item";
    const presence = student.presence
      ? `听到第 ${student.presence.current_position} 句 · ${escapeHtml(student.presence.text || "")}`
      : "还没有播放位置";
    const review = (student.review || []).map((item) =>
      `<li class="${item.status}">#${item.position} ${escapeHtml(item.text)}</li>`
    ).join("");
    node.innerHTML = `
      <strong>${escapeHtml(student.user.display_name)}</strong>
      <p>${presence}</p>
      <div class="mini-counts">
        <span class="chip-green">${student.counts.green || 0}</span>
        <span class="chip-yellow">${student.counts.yellow || 0}</span>
        <span class="chip-red">${student.counts.red || 0}</span>
      </div>
      <ul class="teacher-review">${review || "<li>暂无红黄句</li>"}</ul>
    `;
    return node;
  }));
}

function getReviewItems() {
  return state.content.sentences
    .map((sentence, index) => ({ sentence, index, progress: state.progress[sentence.id] }))
    .filter((item) => ["red", "yellow"].includes(item.progress?.status));
}

function previousSentence() {
  state.currentIndex = Math.max(0, state.currentIndex - 1);
  state.currentSentenceVisible = false;
  render();
  playCurrentSentence(false);
}

function nextSentence() {
  state.currentIndex = Math.min(state.content.sentences.length - 1, state.currentIndex + 1);
  state.currentSentenceVisible = false;
  render();
  playCurrentSentence(false);
}

function playCurrentSentence(isReplay) {
  const sentence = currentSentence();
  state.playbackCounts[sentence.id] = (state.playbackCounts[sentence.id] || 0) + 1;
  saveJson("listening.playbackCounts", state.playbackCounts);
  recordHeard(sentence);
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

async function recordHeard(sentence) {
  if (!API_BASE || !state.account?.user || state.content.id.startsWith("local_")) return;
  try {
    await api("/api/heard", {
      method: "POST",
      body: {
        student_id: state.account.user.id,
        content_id: state.content.id,
        sentence_id: sentence.id,
        play_count: 1
      }
    });
  } catch {
    // Playback must not be blocked by presence sync.
  }
}

async function markCurrent(result) {
  const sentence = currentSentence();
  const current = state.progress[sentence.id] || {};
  const previousStatus = current.status || "new";
  const nextStatus = transitionStatus(previousStatus, result);
  const now = new Date().toISOString();
  const replayCount = state.playbackCounts[sentence.id] || 0;
  const subtitleVisible = state.allSubtitlesVisible || state.currentSentenceVisible;

  state.progress[sentence.id] = {
    ...current,
    status: nextStatus,
    attempts: (current.attempts || 0) + 1,
    firstResult: current.firstResult || result,
    lastResult: result,
    replayCount: (current.replayCount || 0) + replayCount,
    subtitleViews: (current.subtitleViews || 0) + (subtitleVisible ? 1 : 0),
    updatedAt: now
  };
  state.playbackCounts[sentence.id] = 0;
  persistProgress();
  saveJson("listening.playbackCounts", state.playbackCounts);
  render();

  if (API_BASE && !state.content.id.startsWith("local_")) {
    try {
      await api("/api/attempts", {
        method: "POST",
        body: {
          learner_id: state.learnerId,
          content_id: state.content.id,
          sentence_id: sentence.id,
          result,
          evidence_type: "self_report",
          showed_subtitle: subtitleVisible,
          replay_count: replayCount
        }
      });
      setSyncStatus("Progress synced");
      if (state.teacherVisible) await loadTeacherDashboard();
    } catch (error) {
      setSyncStatus(`进度仅本地 · ${error.message}`);
    }
  }

  if (nextStatus === "green") moveToNextReviewCandidate();
}

function moveToNextReviewCandidate() {
  const next = state.content.sentences.findIndex((sentence, index) =>
    index > state.currentIndex && state.progress[sentence.id]?.status !== "green"
  );
  if (next >= 0) {
    state.currentIndex = next;
    state.currentSentenceVisible = false;
    render();
    playCurrentSentence(false);
  }
}

function toggleCurrentSentence() {
  state.currentSentenceVisible = !state.currentSentenceVisible;
  if (state.currentSentenceVisible) noteSubtitleView(currentSentence());
  render();
}

function toggleAllSubtitles() {
  state.allSubtitlesVisible = !state.allSubtitlesVisible;
  if (state.allSubtitlesVisible) noteSubtitleView(currentSentence());
  render();
}

function noteSubtitleView(sentence) {
  const current = state.progress[sentence.id] || {};
  state.progress[sentence.id] = {
    ...current,
    subtitleViews: (current.subtitleViews || 0) + 1
  };
  persistProgress();
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
  const srt = els.importTranscript.value;
  const parsed = parseStrictSrt(srt);
  if (!parsed.ok) {
    renderSrtValidation(parsed);
    setSyncStatus("SRT 未通过校验");
    return;
  }

  const localContent = normalizeContent({
    id: `local_${Date.now()}`,
    title,
    source_url: sourceUrl,
    ...parseSource(sourceUrl),
    sentences: parsed.sentences
  });

  if (API_BASE) {
    try {
      const data = await api("/api/contents", {
        method: "POST",
        body: {
          title,
          source_url: sourceUrl,
          user_id: state.account?.user?.id,
          srt
        }
      });
      const remote = normalizeContent({ ...data.content, sentences: data.sentences });
      state.contents.unshift(remote);
      state.content = remote;
      state.currentIndex = 0;
      state.currentSentenceVisible = false;
      setSyncStatus("SRT 已保存到 D1");
    } catch (error) {
      state.contents.unshift(localContent);
      state.content = localContent;
      setSyncStatus(`已本地保存 · ${error.message}`);
    }
  } else {
    state.contents.unshift(localContent);
    state.content = localContent;
    setSyncStatus("已本地保存");
  }

  els.importDialog.close();
  els.importForm.reset();
  validateSrtField();
  render();
}

async function generateCaption() {
  const title = els.importTitle.value.trim() || "Untitled listening content";
  const sourceUrl = els.importUrl.value.trim();
  if (!sourceUrl) return setCaptionStatus("先填视频 URL");
  if (!API_BASE) return setCaptionStatus("API 未配置");

  setCaptionStatus("提交中...");
  try {
    const data = await api("/api/caption-jobs", {
      method: "POST",
      body: {
        title,
        source_url: sourceUrl,
        user_id: state.account?.user?.id,
        language: "en"
      }
    });

    if (data.content) {
      const remote = normalizeContent({ ...data.content.content, sentences: data.content.sentences });
      state.contents.unshift(remote);
      state.content = remote;
      state.currentIndex = 0;
      setCaptionStatus("字幕已生成并导入");
      render();
      return;
    }

    setCaptionStatus(data.message || `任务状态：${data.job.status}`);
  } catch (error) {
    setCaptionStatus(`字幕任务失败：${error.message}`);
  }
}

async function readSrtFile() {
  const file = els.srtFile.files?.[0];
  if (!file) return;
  const text = await file.text();
  els.importTranscript.value = text;
  validateSrtField();
}

function validateSrtField() {
  const raw = els.importTranscript.value.trim();
  if (!raw) {
    els.srtValidation.textContent = "等待 SRT";
    els.srtValidation.className = "validation-box";
    return;
  }
  renderSrtValidation(parseStrictSrt(raw));
}

function renderSrtValidation(result) {
  if (result.ok) {
    els.srtValidation.textContent = `SRT 通过 · ${result.sentences.length} 句`;
    els.srtValidation.className = "validation-box ok";
    return;
  }
  els.srtValidation.innerHTML = `SRT 错误：<br>${result.errors.slice(0, 5).map(escapeHtml).join("<br>")}`;
  els.srtValidation.className = "validation-box error";
}

function loadDemoIntoForm() {
  els.importTitle.value = "Demo: bilingual brain listening drill";
  els.importUrl.value = "https://www.youtube.com/watch?v=MMmOLN5zBLY";
  els.importTranscript.value = DEMO_CONTENT.sentences
    .map((sentence, index) => [
      String(index + 1),
      `${formatSrtTime(sentence.start)} --> ${formatSrtTime(sentence.end)}`,
      sentence.text
    ].join("\n"))
    .join("\n\n");
  validateSrtField();
}

function parseStrictSrt(raw) {
  const normalized = String(raw || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return { ok: false, errors: ["SRT 为空"], sentences: [] };

  const blocks = normalized.split(/\n{2,}/);
  const errors = [];
  const sentences = [];
  let previousEnd = -1;

  blocks.forEach((block, blockIndex) => {
    const expectedIndex = blockIndex + 1;
    const lines = block.split("\n").map((line) => line.trimEnd());
    const numberLine = (lines[0] || "").trim();
    const timeLine = (lines[1] || "").trim();
    const textLines = lines.slice(2).filter((line) => line.trim());

    if (!/^\d+$/.test(numberLine)) {
      errors.push(`第 ${expectedIndex} 段缺少数字序号`);
      return;
    }

    const actualIndex = Number.parseInt(numberLine, 10);
    if (actualIndex !== expectedIndex) {
      errors.push(`第 ${expectedIndex} 段序号应为 ${expectedIndex}，实际为 ${actualIndex}`);
    }

    const timeMatch = timeLine.match(/^(\d{2,}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2,}:\d{2}:\d{2},\d{3})(?:\s+.*)?$/);
    if (!timeMatch) {
      errors.push(`第 ${expectedIndex} 段时间轴格式错误`);
      return;
    }

    const startMs = parseSrtTime(timeMatch[1]);
    const endMs = parseSrtTime(timeMatch[2]);
    if (startMs === null || endMs === null) {
      errors.push(`第 ${expectedIndex} 段时间戳无效`);
      return;
    }
    if (startMs >= endMs) errors.push(`第 ${expectedIndex} 段开始时间不能晚于结束时间`);
    if (previousEnd > startMs) errors.push(`第 ${expectedIndex} 段与上一段重叠`);
    if (!textLines.length) errors.push(`第 ${expectedIndex} 段字幕为空`);

    previousEnd = Math.max(previousEnd, endMs);
    sentences.push({
      id: `local_sentence_${blockIndex + 1}`,
      position: expectedIndex,
      start_ms: startMs,
      end_ms: endMs,
      start: startMs / 1000,
      end: endMs / 1000,
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

function formatSrtTime(seconds) {
  const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
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
  return state.content.sentences[state.currentIndex] || state.content.sentences[0] || { id: "empty", start: 0, end: 0, text: "" };
}

function normalizeContent(content) {
  const sentences = (content.sentences || []).map((sentence, index) => ({
    id: sentence.id || `sentence_${content.id}_${index + 1}`,
    position: sentence.position || index + 1,
    start: Number.isFinite(sentence.start) ? sentence.start : (sentence.start_ms || 0) / 1000,
    end: Number.isFinite(sentence.end) ? sentence.end : (sentence.end_ms || 0) / 1000,
    start_ms: Number.isFinite(sentence.start_ms) ? sentence.start_ms : Math.round((sentence.start || 0) * 1000),
    end_ms: Number.isFinite(sentence.end_ms) ? sentence.end_ms : Math.round((sentence.end || 0) * 1000),
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

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method || "GET",
    headers: { "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.details ? `${data.error}: ${data.details.join("; ")}` : (data.error || response.statusText));
  return data;
}

function setSyncStatus(text) {
  els.syncStatus.textContent = text;
}

function setCaptionStatus(text) {
  els.captionJobStatus.textContent = text;
}

function persistProgress() {
  saveJson("listening.progress", state.progress);
}

function getLocalLearnerId() {
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
    window.onYouTubeIframeAPIReady = () => resolve();
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
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
