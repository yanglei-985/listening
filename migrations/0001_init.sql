CREATE TABLE IF NOT EXISTS contents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_url TEXT,
  source_type TEXT NOT NULL DEFAULT 'unknown',
  video_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sentences (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  start_ms INTEGER NOT NULL DEFAULT 0,
  end_ms INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  normalized_text TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS listening_attempts (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  content_id TEXT NOT NULL,
  sentence_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('understood', 'unsure', 'missed')),
  previous_status TEXT NOT NULL DEFAULT 'new',
  next_status TEXT NOT NULL CHECK (next_status IN ('green', 'yellow', 'red')),
  evidence_type TEXT NOT NULL DEFAULT 'self_report',
  showed_subtitle INTEGER NOT NULL DEFAULT 0,
  replay_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE,
  FOREIGN KEY (sentence_id) REFERENCES sentences(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sentence_progress (
  learner_id TEXT NOT NULL,
  content_id TEXT NOT NULL,
  sentence_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('green', 'yellow', 'red')),
  first_result TEXT NOT NULL,
  last_result TEXT NOT NULL,
  replay_count INTEGER NOT NULL DEFAULT 0,
  subtitle_views INTEGER NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0,
  turn_green_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (learner_id, sentence_id),
  FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE,
  FOREIGN KEY (sentence_id) REFERENCES sentences(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sentences_content_position ON sentences(content_id, position);
CREATE INDEX IF NOT EXISTS idx_attempts_learner_content ON listening_attempts(learner_id, content_id, created_at);
CREATE INDEX IF NOT EXISTS idx_progress_learner_content_status ON sentence_progress(learner_id, content_id, status);

INSERT OR IGNORE INTO contents (id, title, source_url, source_type, video_id, created_at)
VALUES (
  'demo_bilingual_brain',
  'Demo: bilingual brain listening drill',
  'https://www.youtube.com/watch?v=MMmOLN5zBLY',
  'youtube',
  'MMmOLN5zBLY',
  CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO sentences (id, content_id, position, start_ms, end_ms, text, normalized_text)
VALUES
  ('demo_bilingual_brain_s1', 'demo_bilingual_brain', 1, 0, 5200, 'A useful listening session starts with input that the learner can already read.', 'a useful listening session starts with input that the learner can already read'),
  ('demo_bilingual_brain_s2', 'demo_bilingual_brain', 2, 5200, 10300, 'Then the text disappears and the ear has to rebuild the sentence from sound.', 'then the text disappears and the ear has to rebuild the sentence from sound'),
  ('demo_bilingual_brain_s3', 'demo_bilingual_brain', 3, 10300, 16000, 'A red sentence is not a failure; it is the exact place where teaching should begin.', 'a red sentence is not a failure it is the exact place where teaching should begin'),
  ('demo_bilingual_brain_s4', 'demo_bilingual_brain', 4, 16000, 21400, 'When a learner checks the transcript and hears it once, the system marks it yellow.', 'when a learner checks the transcript and hears it once the system marks it yellow'),
  ('demo_bilingual_brain_s5', 'demo_bilingual_brain', 5, 21400, 27100, 'Only after another clean pass does that sentence finally turn green.', 'only after another clean pass does that sentence finally turn green');

