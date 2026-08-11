CREATE TABLE IF NOT EXISTS teacher_sentence_annotations (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL,
  sentence_id TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (label IN (
    'linking',
    'intrusion',
    'weak_form',
    'reduction',
    'elision',
    'assimilation',
    'stress',
    'intonation',
    'phoneme',
    'chunking',
    'other'
  )),
  summary TEXT NOT NULL,
  detail TEXT,
  example TEXT,
  reference_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE,
  FOREIGN KEY (sentence_id) REFERENCES sentences(id) ON DELETE CASCADE,
  FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_teacher_annotations_content_sentence
  ON teacher_sentence_annotations(content_id, sentence_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_teacher_annotations_teacher_content
  ON teacher_sentence_annotations(teacher_id, content_id, updated_at);
