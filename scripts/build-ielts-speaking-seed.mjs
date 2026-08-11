import fs from "node:fs";
import path from "node:path";

const srtPath = process.argv[2];
const outPath = process.argv[3] || path.join("migrations", "0004_ielts_speaking_teacher_notes.sql");

if (!srtPath) {
  console.error("Usage: node scripts/build-ielts-speaking-seed.mjs <srt-path> [out-sql]");
  process.exit(1);
}

const CONTENT_ID = "content_ielts_speaking_4_scores_datiyamemek";
const VIDEO_ID = "daTiyamEmEk";
const TEACHER_ID = "teacher_demo";
const TITLE = "IELTS Speaking: The 4 Things Examiners Actually Score";
const SOURCE_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

const rawSrt = fs.readFileSync(srtPath, "utf8");
const parsed = parseSrt(rawSrt)
  .filter((item) => item.text.trim().toLowerCase() !== "you");

if (!parsed.length) throw new Error("No valid SRT blocks parsed.");

const sentences = parsed.map((item, index) => ({
  ...item,
  position: index + 1,
  id: `ielts_speaking_4_scores_s${String(index + 1).padStart(3, "0")}`
}));

const annotations = sentences.map((sentence) => {
  const hint = explainSentence(sentence.position, sentence.text);
  const section = sectionFor(sentence.position);
  const cue = listeningCue(sentence.text);
  const isLast = sentence.position === sentences.length;
  return {
    id: `ann_ielts_speaking_4_scores_s${String(sentence.position).padStart(3, "0")}`,
    sentenceId: sentence.id,
    summary: isLast ? "全课收束：这句后附本课思维导图，帮学生回顾四项评分和训练路线。" : hint,
    detail: isLast
      ? "结束语：视频收尾。重点不是记住广告信息，而是回到四项评分，找出自己的两个最弱项并集中训练。"
      : `${section.name}：${hint} 听的时候先抓关键词 “${cue}”，再回到整句理解。`,
    example: isLast ? mindMap() : "",
    referenceKey: "teacher_observation"
  };
});

const sql = [
  "-- Seed IELTS Speaking content, teacher notes, and final mind map.",
  `-- Source SRT: ${path.basename(srtPath)}`,
  "-- The trailing one-word artifact 'you' was dropped before seeding.",
  "",
  `INSERT INTO contents (
  id, title, source_url, source_type, video_id, created_at,
  created_by_user_id, srt_source, caption_status, caption_job_id
)
VALUES (
  ${q(CONTENT_ID)},
  ${q(TITLE)},
  ${q(SOURCE_URL)},
  'youtube',
  ${q(VIDEO_ID)},
  CURRENT_TIMESTAMP,
  ${q(TEACHER_ID)},
  NULL,
  'ready',
  NULL
)
ON CONFLICT(id) DO UPDATE SET
  title = excluded.title,
  source_url = excluded.source_url,
  source_type = excluded.source_type,
  video_id = excluded.video_id,
  created_by_user_id = excluded.created_by_user_id,
  caption_status = excluded.caption_status;`,
  "",
  `INSERT INTO sentences (id, content_id, position, start_ms, end_ms, text, normalized_text)
VALUES
${sentences.map((sentence) => `  (${q(sentence.id)}, ${q(CONTENT_ID)}, ${sentence.position}, ${sentence.startMs}, ${sentence.endMs}, ${q(sentence.text)}, ${q(normalizeText(sentence.text))})`).join(",\n")}
ON CONFLICT(id) DO UPDATE SET
  content_id = excluded.content_id,
  position = excluded.position,
  start_ms = excluded.start_ms,
  end_ms = excluded.end_ms,
  text = excluded.text,
  normalized_text = excluded.normalized_text;`,
  "",
  `INSERT INTO teacher_sentence_annotations (
  id, content_id, sentence_id, teacher_id, label, summary, detail,
  example, reference_key, created_at, updated_at
)
VALUES
${annotations.map((annotation) => `  (${q(annotation.id)}, ${q(CONTENT_ID)}, ${q(annotation.sentenceId)}, ${q(TEACHER_ID)}, 'other', ${q(annotation.summary)}, ${q(annotation.detail)}, ${annotation.example ? q(annotation.example) : "NULL"}, ${q(annotation.referenceKey)}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).join(",\n")}
ON CONFLICT(id) DO UPDATE SET
  content_id = excluded.content_id,
  sentence_id = excluded.sentence_id,
  teacher_id = excluded.teacher_id,
  label = excluded.label,
  summary = excluded.summary,
  detail = excluded.detail,
  example = excluded.example,
  reference_key = excluded.reference_key,
  updated_at = CURRENT_TIMESTAMP;`,
  ""
].join("\n");

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, sql, "utf8");
console.log(JSON.stringify({
  outPath,
  contentId: CONTENT_ID,
  sentenceCount: sentences.length,
  annotationCount: annotations.length,
  lastSentence: sentences[sentences.length - 1].text
}, null, 2));

function parseSrt(raw) {
  return raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n").map((line) => line.trimEnd());
      const timeLine = lines[1] || "";
      const match = timeLine.match(/^(\d\d:\d\d:\d\d,\d{3})\s+-->\s+(\d\d:\d\d:\d\d,\d{3})$/);
      if (!match) return null;
      const text = lines.slice(2).join(" ").replace(/\s+/g, " ").trim();
      if (!text) return null;
      return {
        startMs: parseSrtTime(match[1]),
        endMs: parseSrtTime(match[2]),
        text
      };
    })
    .filter(Boolean);
}

function parseSrtTime(value) {
  const match = value.match(/^(\d\d):(\d\d):(\d\d),(\d{3})$/);
  if (!match) throw new Error(`Invalid SRT timestamp: ${value}`);
  const [, h, m, s, ms] = match.map(Number);
  return h * 3600000 + m * 60000 + s * 1000 + ms;
}

function sectionFor(position) {
  if (position <= 16) return { name: "评分框架", fallback: "这句在建立整节课的评分框架：雅思口语不是凭感觉打分，而是看四个评分项。" };
  if (position <= 29) return { name: "流利与连贯", fallback: "这句在讲 Fluency & Coherence：答案要能展开、有逻辑，不能只给很短的回应。" };
  if (position <= 47) return { name: "词汇资源", fallback: "这句在讲 Lexical Resource：高分词汇不是罕见词，而是自然搭配、话题词组和准确表达。" };
  if (position <= 60) return { name: "语法范围与准确度", fallback: "这句在讲 Grammar：少量可靠结构反复练到自然，比临场硬套复杂句更有效。" };
  if (position <= 82) return { name: "发音", fallback: "这句在讲 Pronunciation：重点是清楚、重音和语调，不是改变自己的口音。" };
  if (position <= 110) return { name: "四周训练 routine", fallback: "这句在讲训练安排：把影子跟读、自由表达、录音复盘和老师反馈组合起来。" };
  return { name: "总结复盘", fallback: "这句在总结整节课：围绕四项评分找弱项，再用具体练习持续推进。" };
}

function explainSentence(position, text) {
  const lower = text.toLowerCase();
  const rules = [
    [/stuck at a 6\.5/, "开场问题：如果口语卡在 6.5，本课要帮你找到真正拖分的地方。"],
    [/averages four separate criteria/, "口语分数由四个评分项综合决定，不是只看你会不会说。"],
    [/walk through each one/, "本课会逐项拆解四个评分项，并找出最拉低分数的两个。"],
    [/specific drills/, "这里强调要用具体训练把弱项推到 Band 7，而不是只听技巧。"],
    [/four criteria for ielts speaking/, "这里正式引出 IELTS Speaking 的四个评分标准。"],
    [/25%/, "四个评分项各占 25%，所以任何一项偏弱都会拖总分。"],
    [/fluency and coherence/, "Fluency & Coherence 看的是能否持续表达，并让观点自然连接。"],
    [/lexical resource/, "Lexical Resource 看词汇范围、搭配和表达是否自然。"],
    [/grammatical range/, "Grammar 看结构是否多样、准确，而不是堆砌复杂句。"],
    [/pronunciation.*misunderstand|understand\.$/, "这里提醒学生：Pronunciation 很容易被误解，不等于必须换口音。"],
    [/isn't about your accent/, "发音分不是口音分，重点不是变成英美口音。"],
    [/word stress.*natural intonation/, "清晰发音包括词重音和自然语调，这些会影响考官理解。"],
    [/overall speaking is 6\.5/, "如果总分 6.5，通常说明四项里有两项还停在 Band 6。"],
    [/band 6/, "这句点明问题定位：要找出哪两个评分项还没到 7。"],
    [/practical band 7/, "目标不是抽象知道评分标准，而是看见每一项 Band 7 的具体做法。"],
    [/short answers/, "第一个卡点是 Part 1 回答太短，以及 Part 2/3 容易犹豫。"],
    [/do you enjoy/, "这里用 cooking 问题举例，展示短答案为什么不够。"],
    [/yes, i enjoy cooking/, "这个答案语法没错，但语言样本太少，考官很难给高分。"],
    [/not enough language|three words/, "考官需要足够语言来评估；三个词的回答信息量太低。"],
    [/reason, an example/, "Band 7 的 Part 1 回答要补原因、例子和个人经历。"],
    [/answer the question, give a reason/, "可以记住这个回答骨架：回答问题 → 给原因 → 给例子。"],
    [/don't memorize the sentences/, "不要背固定句子，要背可迁移的回答模式。"],
    [/cue card/, "Part 2 cue card 要把提示点当结构，而不是讲到没话说。"],
    [/90 seconds/, "三个 bullet 每个讲约 30 秒，基本就能撑起 90 秒。"],
    [/abstract/, "Part 3 容易卡在抽象题，解决办法是固定答题结构。"],
    [/position, reason, example/, "Part 3 可以用 Position → Reason → Example → Conclusion 的结构。"],
    [/20 seconds/, "这句给出时间分配，让 Part 3 答案听起来完整而不散。"],
    [/band 7 shape/, "Band 7 的形状是有立场、有理由、有例子、有收束。"],
    [/rare words/, "词汇高分不是背生僻词，很多学生误把难词当高分。"],
    [/criterion actually measures/, "这里转向真正的评分点：范围、搭配和习语自然度。"],
    [/different words/, "词汇范围要求能换说法，避免一直重复同一个词。"],
    [/pair naturally/, "Collocation 是自然搭配，词和词要像母语者那样组合。"],
    [/idiomatic language/, "习语不是越多越好，而是在适合语境时自然使用。"],
    [/general words/, "Band 6 常见问题是总用 good、bad、nice 这类泛词。"],
    [/how was the meal/, "这里用 meal 举例，说明泛泛说 nice/good 信息量太低。"],
    [/excellent.*flavors.*portion/, "Band 7 的词汇更具体：味道、分量、价格都说清楚。"],
    [/different vocabulary, more precise/, "同一个意思可以用更准确的词说出来，这就是提分方向。"],
    [/build vocabulary and topic clusters/, "词汇要按话题簇积累，比如家庭、工作、科技和健康。"],
    [/10 to 15 natural phrases/, "每个话题积累 10–15 个自然短语，比孤立背单词更有效。"],
    [/podcasts interviews or articles/, "自然表达要从真实内容里收集，而不是只从词表里背。"],
    [/band seven.*blocker number three/, "词汇部分收束后，视频进入第三个卡点：语法范围和准确度。"],
    [/same principle as writing/, "语法训练和写作一样：先掌握稳定结构，再自然使用。"],
    [/10 new structures/, "不需要临场硬套十种结构，少量可靠结构更重要。"],
    [/simple sentences/, "6.5 学生常见问题是句型过于单一，听起来像几句短句堆在一起。"],
    [/i work in marketing/, "这组短句内容清楚，但结构太单一，缺少 Band 7 的句法变化。"],
    [/mixes structures naturally/, "Band 7 不是复杂，而是自然混合不同结构。"],
    [/present perfect continuous/, "这里点出可学习的语法结构：现在完成进行时、定语从句、because 从句等。"],
    [/not advanced grammar/, "这些不是炫技语法，而是自然英语里常见的表达方式。"],
    [/three structures to drill/, "语法训练先抓三个高频结构：条件句、关系从句和现在完成时。"],
    [/conditional/, "条件句可以帮你谈假设和偏好，是口语里很常用的结构。"],
    [/relative clause/, "关系从句能把信息合并得更自然，避免一直说短句。"],
    [/present perfect/, "现在完成时适合讲经历和持续时间，口语 Part 1/2 都常用。"],
    [/without thinking/, "目标是考场上自然产出，不是临时想语法公式。"],
    [/blocker number four/, "第四个卡点是发音，也是最多学生误解的一项。"],
    [/trained to assess speakers/, "考官受训评估不同背景的说话者，所以口音本身不是问题。"],
    [/easy to understand/, "发音评分核心是可理解度：考官能不能轻松跟上你。"],
    [/word stress/, "词重音错了，熟词也可能听起来像另一个词。"],
    [/photograph photography photographic/, "同词根不同词性的重音会变，这是发音训练重点。"],
    [/sentence stress/, "句重音决定一句话里哪些信息被突出。"],
    [/stole the money/, "同一句话重音不同，含义会变，这就是句重音的作用。"],
    [/i didn't say she stole/, "示范句：重读不同词，会改变听者理解的重点。"],
    [/intonation/, "Intonation 是声音的升降，会影响句子的态度和功能。"],
    [/statements typically fall/, "陈述句通常降调，真实疑问句常见升调。"],
    [/flat monotone/, "语调太平会让考官更费力，即使语法没错也会影响发音分。"],
    [/shadowing/, "解决发音的核心练习是 shadowing：听一句，马上模仿节奏和语调。"],
    [/repeat it, copying the rhythm/, "跟读不是念文字，而是复制原声的节奏。"],
    [/stress the syllables/, "跟读时要模仿重音、停顿和升降调。"],
    [/five minutes a day/, "每天五分钟稳定练，比偶尔长时间练更容易坚持。"],
    [/most effective pronunciation drill/, "作者把 shadowing 定位为最有效、低成本的发音训练。"],
    [/change your accent/, "不要把目标设成改变口音，目标是更清楚自然。"],
    [/rhythm and stress/, "要模仿自然英语的节奏和重音，这才是考官听的重点。"],
    [/examiner is listening for/, "这句收束发音部分：考官主要听清晰度、节奏和重音。"],
    [/drill pack/, "这里是课程资源提示，可以理解为把四项评分做成练习包。"],
    [/one drill per criterion/, "练习包按每个评分项配一个 drill，再加 Part 2 模板。"],
    [/move on to the routine/, "接下来进入四周训练计划，开始讲日常怎么练。"],
    [/four week practice routine/, "四周 routine 的目标是从 6.5 推到 7。"],
    [/daily, 10 minutes/, "每天只需要十分钟，但要稳定执行。"],
    [/five minutes of shadowing/, "每日前五分钟做 shadowing，练节奏、重音和语调。"],
    [/free speaking/, "另外五分钟做自由表达，训练不看稿说话。"],
    [/recorded on your phone/, "用手机录下来，方便后面复盘自己的真实表现。"],
    [/talk for two minutes/, "先连续说两分钟，再听录音找问题。"],
    [/not editing yet/, "第一遍复盘先听问题，不急着改稿或润色。"],
    [/three times a week/, "每周三次做更完整的 Part 2 cue card 训练。"],
    [/one minute to plan/, "Part 2 训练按考试节奏来：一分钟准备，两分钟表达，并录音。"],
    [/where did i hesitate/, "复盘问题很具体：在哪里犹豫、重复或没话说。"],
    [/note the patterns/, "不是只看一次错误，而是记录反复出现的模式。"],
    [/expert feedback/, "每周至少一次找专业反馈，补自己看不到的问题。"],
    [/own pronunciation patterns/, "自己很难听出自己的发音习惯，需要外部耳朵。"],
    [/filler words/, "filler words 说多了自己会麻木，旁人更容易发现。"],
    [/trained teacher hears it/, "受过 IELTS 训练的老师能快速指出该练什么。"],
    [/one-on-one speaking practice/, "这里介绍一对一口语练习服务。"],
    [/weekly/, "建议每周让懂四项评分的人听一次，形成反馈闭环。"],
    [/quick recap/, "最后进入快速复盘，把前面四个模块重新串起来。"],
    [/extend your answers/, "复盘第一项：流利连贯要展开答案，并给 Part 1/2/3 结构。"],
    [/grammatical range/, "复盘第三项：用生活话题练三个可靠语法结构。"],
    [/pronunciation\. shadowing/, "复盘第四项：用 shadowing 练词重音、句重音和语调。"],
    [/80% of your study time/, "学习时间要集中到两个最弱项，而不是平均用力。"],
    [/speaking drill pack/, "这里再次提示练习包资源，不是核心知识点。"],
    [/like and subscribe/, "这句是频道互动提示，学习重点可以略过。"],
    [/weakest section/, "如果弱项不是 speaking，也可以用同样诊断法看其它科目。"],
    [/dedicated video/, "频道后续会把同样诊断法应用到写作、阅读、听力。"],
    [/same diagnostic approach/, "核心方法是诊断弱项，再针对性训练。"],
    [/one-on-one speaking practice/, "如果需要个性化评分，可以找 IELTS-trained teacher 做一对一反馈。"],
    [/four official criteria/, "老师会按四个官方评分项指出分数卡在哪里。"],
    [/thanks for watching/, "视频结尾，作者完成总结并结束。"]
  ];

  const rule = rules.find(([pattern]) => pattern.test(lower));
  return rule ? rule[1] : sectionFor(position).fallback;
}

function listeningCue(text) {
  const words = text
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !/^(the|a|an|and|or|to|of|in|on|for|with|is|are|it|this|that|you|your|we|i)$/i.test(word));
  return words.slice(0, 5).join(" ") || text.slice(0, 40);
}

function mindMap() {
  return `MINDMAP
IELTS Speaking 四项评分与训练路线
- Fluency & Coherence
  - Part 1：回答 + 原因 + 例子
  - Part 2：cue card 每个 bullet 讲约 30 秒
  - Part 3：Position → Reason → Example → 小结
- Lexical Resource
  - 不追生僻词，追自然搭配
  - 按 family / work / technology 等 topic clusters 积累
  - 从播客、采访、文章里收集真实表达
- Grammatical Range & Accuracy
  - 练少量可靠结构
  - 条件句、关系从句、现在完成时
  - 用自己的生活话题练到不用想
- Pronunciation
  - 不是换口音，而是让人容易听懂
  - word stress / sentence stress / intonation
  - 每天 5 分钟 shadowing
- 四周执行
  - 每天 10 分钟：5 分钟 shadowing + 5 分钟自由表达录音
  - 每周 3 次 Part 2 录音复盘
  - 每周 1 次老师反馈
  - 找两个最弱项，用 80% 时间集中突破`;
}

function normalizeText(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, "").replace(/\s+/g, " ").trim();
}

function q(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}
