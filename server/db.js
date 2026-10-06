const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'academy.db'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

// role: admin(관리자) / teacher(선생님) / student(학생) / parent(학부모)
// status: active(사용 중) / pending(회원가입 후 승인 대기)
const USERS_SQL = (table) => `
CREATE TABLE IF NOT EXISTS ${table} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','teacher','student','parent')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending')),
  child_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  phone TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);`;

// 예전 버전 DB(선생님·승인 기능 없음)를 새 구조로 옮김. 기존 데이터는 그대로 유지
function migrateUsers() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!row || row.sql.includes("'teacher'")) return;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(USERS_SQL('users_new'));
    db.exec(`INSERT INTO users_new (id, username, password_hash, name, role, status, child_id, phone, created_at)
             SELECT id, username, password_hash, name, role, 'active', child_id, phone, created_at FROM users`);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  console.log('[migrate] 사용자 테이블을 새 구조로 변환했습니다.');
}
migrateUsers();

db.exec(USERS_SQL('users'));
db.exec(`

CREATE TABLE IF NOT EXISTS student_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  course TEXT DEFAULT '',
  current_lesson TEXT DEFAULT '',
  progress_percent INTEGER DEFAULT 0,
  next_lesson TEXT DEFAULT '',
  assignment TEXT DEFAULT '',
  assignment_due TEXT DEFAULT '',
  memo TEXT DEFAULT '',
  teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS progress_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present','late','absent','excused')),
  note TEXT DEFAULT '',
  UNIQUE (student_id, date)
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('material','submission')),
  student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  lesson TEXT DEFAULT '',
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 학생별 수업 요일·시간 (weekday: 0=일, 1=월 ... 6=토)
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  UNIQUE (student_id, weekday)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
`);

// 예전 DB에 담당 선생님 칸 추가
if (!db.prepare('PRAGMA table_info(student_profiles)').all().some((c) => c.name === 'teacher_id')) {
  db.exec('ALTER TABLE student_profiles ADD COLUMN teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === test.length && crypto.timingSafeEqual(expected, test);
}

function seed() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;

  const insertUser = db.prepare(
    'INSERT INTO users (username, password_hash, name, role, child_id) VALUES (?, ?, ?, ?, ?)'
  );
  insertUser.run('admin', hashPassword('admin1234'), '관리자', 'admin', null);
  const t1 = insertUser.run('teacher1', hashPassword('1234'), '김선생', 'teacher', null).lastInsertRowid;

  const s1 = insertUser.run('student1', hashPassword('1234'), '김민준', 'student', null).lastInsertRowid;
  const s2 = insertUser.run('student2', hashPassword('1234'), '이서연', 'student', null).lastInsertRowid;
  insertUser.run('parent1', hashPassword('1234'), '김민준 학부모', 'parent', s1);
  insertUser.run('parent2', hashPassword('1234'), '이서연 학부모', 'parent', s2);

  const insertProfile = db.prepare(
    `INSERT INTO student_profiles (user_id, course, current_lesson, progress_percent, next_lesson, assignment, assignment_due, teacher_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertProfile.run(s1, '파이썬 기초', '5강. 반복문 (for / while)', 40, '6강. 리스트와 튜플',
    '구구단 출력 프로그램 만들기', '', t1);
  insertProfile.run(s2, '엑셀 실무', '3강. 함수 기초 (SUM, AVERAGE)', 25, '4강. IF 함수',
    '성적표 시트에 평균 구하기', '', t1);

  const insertSchedule = db.prepare('INSERT INTO schedules (student_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)');
  insertSchedule.run(s1, 1, '16:00', '17:30'); // 평일반: 주 2회, 1시간 30분씩
  insertSchedule.run(s1, 3, '16:00', '17:30');
  insertSchedule.run(s2, 6, '09:00', '12:00'); // 토요일반: 2회분을 한 번에

  const today = new Date().toISOString().slice(0, 10);
  db.prepare('INSERT INTO comments (student_id, author_id, content) VALUES (?, ?, ?)')
    .run(s1, t1, '반복문 개념을 빠르게 이해했어요. 다음 시간에는 리스트를 함께 다뤄볼게요!');
  db.prepare('INSERT INTO attendance (student_id, date, status) VALUES (?, ?, ?)').run(s1, today, 'present');
  db.prepare('INSERT INTO progress_logs (student_id, date, content) VALUES (?, ?, ?)')
    .run(s1, today, '5강 반복문 실습 완료');

  console.log('[seed] 기본 계정이 생성되었습니다. 운영 전에 반드시 비밀번호를 변경하세요.');
}

seed();

module.exports = { db, UPLOAD_DIR, hashPassword, verifyPassword };
