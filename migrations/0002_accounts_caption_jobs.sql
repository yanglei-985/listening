ALTER TABLE contents ADD COLUMN created_by_user_id TEXT;
ALTER TABLE contents ADD COLUMN srt_source TEXT;
ALTER TABLE contents ADD COLUMN caption_status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE contents ADD COLUMN caption_job_id TEXT;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  access_code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS class_members (
  class_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (class_id, user_id),
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS listening_presence (
  student_id TEXT NOT NULL,
  content_id TEXT NOT NULL,
  sentence_id TEXT NOT NULL,
  current_position INTEGER NOT NULL DEFAULT 1,
  play_count INTEGER NOT NULL DEFAULT 0,
  last_event_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (student_id, content_id),
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE,
  FOREIGN KEY (sentence_id) REFERENCES sentences(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS caption_jobs (
  id TEXT PRIMARY KEY,
  content_id TEXT,
  requested_by_user_id TEXT,
  title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting_for_service', 'queued', 'processing', 'complete', 'failed')),
  provider TEXT NOT NULL DEFAULT 'videocaptioner',
  external_job_id TEXT,
  error_message TEXT,
  result_srt TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE SET NULL,
  FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_class_members_user ON class_members(user_id);
CREATE INDEX IF NOT EXISTS idx_presence_content_student ON listening_presence(content_id, student_id);
CREATE INDEX IF NOT EXISTS idx_caption_jobs_status ON caption_jobs(status, updated_at);

INSERT OR IGNORE INTO users (id, display_name, role, access_code, created_at)
VALUES
  ('teacher_demo', 'Demo Teacher', 'teacher', 'teacher-demo', CURRENT_TIMESTAMP),
  ('student_demo', 'Demo Student', 'student', 'student-demo', CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO classes (id, name, teacher_id, created_at)
VALUES ('class_demo', 'Listening Demo Class', 'teacher_demo', CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO class_members (class_id, user_id, role, created_at)
VALUES
  ('class_demo', 'teacher_demo', 'teacher', CURRENT_TIMESTAMP),
  ('class_demo', 'student_demo', 'student', CURRENT_TIMESTAMP);

