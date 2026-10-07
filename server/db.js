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
// username/password_hash가 비어 있으면 아직 로그인 계정이 없는 학생(이름만 등록)
// initial_password: 선생님이 정해 준 비밀번호(선생님이 다시 확인 가능). 본인이 바꾸면 지워짐
const USERS_SQL = (table) => `
CREATE TABLE IF NOT EXISTS ${table} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  password_hash TEXT,
  initial_password TEXT,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','teacher','student','parent')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending')),
  child_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  phone TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);`;

// 예전 버전 DB를 새 구조로 옮김. 기존 데이터는 그대로 유지
function migrateUsers() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!row) return;
  const cols = db.prepare('PRAGMA table_info(users)').all();
  const has = (name) => cols.some((c) => c.name === name);
  const upToDate = row.sql.includes("'teacher'") && has('initial_password') && cols.find((c) => c.name === 'username').notnull === 0;
  if (upToDate) return;
  const copy = ['id', 'username', 'password_hash', 'name', 'role', 'status', 'child_id', 'phone', 'created_at'].filter(has).join(', ');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(USERS_SQL('users_new'));
    db.exec(`INSERT INTO users_new (${copy}) SELECT ${copy} FROM users`);
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

-- 진도 기록에 붙이는 그날의 사진
CREATE TABLE IF NOT EXISTS log_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_id INTEGER NOT NULL REFERENCES progress_logs(id) ON DELETE CASCADE,
  stored_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 교재(과정)와 목차: 목차를 체크하면 진도율이 자동 계산됨
CREATE TABLE IF NOT EXISTS seed_log (
  name TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  unit TEXT NOT NULL DEFAULT '예제',
  subject TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS course_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  stage INTEGER,
  chapter TEXT DEFAULT '',
  code TEXT DEFAULT '',
  file TEXT DEFAULT '',
  title TEXT NOT NULL,
  topic TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_course_items ON course_items(course_id, seq);
CREATE TABLE IF NOT EXISTS student_courses (
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (student_id, course_id)
);
CREATE TABLE IF NOT EXISTS item_progress (
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES course_items(id) ON DELETE CASCADE,
  done_date TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (student_id, item_id)
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

-- 학부모 ↔ 선생님 메시지 (학생별 대화방)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  from_staff INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  read_by_staff INTEGER NOT NULL DEFAULT 0,
  read_by_parent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_messages_student ON messages(student_id, id);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
`);

// 과목별 공통 학습 단계 (파이썬 1~25, C언어 1~22 …). 예전 DB의 과목 없는 단계표는 '파이썬'으로 옮김
const STAGES_SQL = `CREATE TABLE IF NOT EXISTS stages (
  subject TEXT NOT NULL DEFAULT '',
  no INTEGER NOT NULL,
  band TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (subject, no)
)`;
const oldStages = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'stages'").get();
if (oldStages && !oldStages.sql.includes('subject')) {
  db.exec('ALTER TABLE stages RENAME TO stages_old');
  db.exec(STAGES_SQL);
  db.exec("INSERT INTO stages (subject, no, band, name) SELECT '파이썬', no, band, name FROM stages_old");
  db.exec('DROP TABLE stages_old');
}
db.exec(STAGES_SQL);
if (!db.prepare('PRAGMA table_info(seed_log)').all().some((c) => c.name === 'version')) {
  db.exec('ALTER TABLE seed_log ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
}
if (!db.prepare('PRAGMA table_info(courses)').all().some((c) => c.name === 'subject')) {
  db.exec("ALTER TABLE courses ADD COLUMN subject TEXT NOT NULL DEFAULT ''");
}

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

const SEED_PW = { admin: 'admin1234', teacher1: '1234', student1: '1234', student2: '1234', parent1: '1234', parent2: '1234' };

function seed() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;

  const insert = db.prepare(
    'INSERT INTO users (username, password_hash, initial_password, name, role, child_id) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertUser = { run: (u, hash, name, role, child) => insert.run(u, hash, hash ? SEED_PW[u] : null, name, role, child) };
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
  const p1 = db.prepare("SELECT id FROM users WHERE username = 'parent1'").get().id;
  db.prepare('INSERT INTO messages (student_id, sender_id, from_staff, content, read_by_parent) VALUES (?, ?, 0, ?, 1)')
    .run(s1, p1, '선생님, 민준이가 다음 주 수요일에 병원 때문에 30분 늦을 것 같습니다.');
  db.prepare('INSERT INTO progress_logs (student_id, date, content) VALUES (?, ?, ?)')
    .run(s1, today, '5강 반복문 실습 완료');

  console.log('[seed] 기본 계정이 생성되었습니다. 운영 전에 반드시 비밀번호를 변경하세요.');
}

seed();

// 교재 목차 기본값 (server/seed/curriculum.json: 파이썬 3권, C언어 3권 + 과목별 공통 단계)
// 새로 추가된 기본 교재만 넣고, 한 번 넣은 교재는 기록해 두어 관리자가 지워도 다시 생기지 않음
// 교재에 version이 올라가면(예: C언어 마스터 절 단위 → 예제 단위) 체크 기록이 없을 때만 목차를 바꾸고,
// 이미 체크한 학생이 있으면 기존 교재는 그대로 두고 '(예제)' 교재를 따로 추가함
function seedCurriculum() {
  const file = path.join(__dirname, 'seed', 'curriculum.json');
  if (!fs.existsSync(file)) return;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const subjects = data.subjects || [{ name: '파이썬', stages: data.stages || [] }];
  const added = [];
  db.exec('BEGIN');
  try {
    const st = db.prepare('INSERT OR IGNORE INTO stages (subject, no, band, name) VALUES (?, ?, ?, ?)');
    subjects.forEach((sub) => sub.stages.forEach((x) => st.run(sub.name, x.no, x.band, x.name)));
    const ins = db.prepare(
      'INSERT INTO course_items (course_id, seq, stage, chapter, code, file, title, topic) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const addCourse = (name, c, subject) => {
      const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM courses').get().s;
      const id = db.prepare('INSERT INTO courses (name, unit, subject, sort) VALUES (?, ?, ?, ?)').run(name, c.unit, subject, sort).lastInsertRowid;
      c.items.forEach((it, i) => ins.run(id, i + 1, it.stage, it.chapter, it.code, it.file, it.title, it.topic));
      added.push(`${name} ${c.items.length}개`);
    };
    data.courses.forEach((c) => {
      const subject = c.subject || '파이썬';
      const ver = c.version || 1;
      const log = db.prepare('SELECT version FROM seed_log WHERE name = ?').get(c.name);
      if (log && log.version >= ver) return;
      const existing = db.prepare('SELECT id, subject FROM courses WHERE name = ?').get(c.name);
      if (!log) {
        db.prepare('INSERT INTO seed_log (name, version) VALUES (?, ?)').run(c.name, ver);
        if (!existing) { addCourse(c.name, c, subject); return; }
        // 예전 버전(기록 없음)에서 이미 넣은 교재: 과목만 채움
        if (!existing.subject) db.prepare('UPDATE courses SET subject = ? WHERE id = ?').run(subject, existing.id);
        return;
      }
      // 교재 목차가 새 버전으로 바뀐 경우
      db.prepare('UPDATE seed_log SET version = ? WHERE name = ?').run(ver, c.name);
      if (!existing) return; // 관리자가 지운 교재는 다시 만들지 않음
      const used = db.prepare(
        'SELECT COUNT(*) AS c FROM item_progress ip JOIN course_items ci ON ci.id = ip.item_id WHERE ci.course_id = ?'
      ).get(existing.id).c;
      if (!used) {
        db.prepare('DELETE FROM course_items WHERE course_id = ?').run(existing.id);
        c.items.forEach((it, i) => ins.run(existing.id, i + 1, it.stage, it.chapter, it.code, it.file, it.title, it.topic));
        db.prepare('UPDATE courses SET unit = ?, subject = ? WHERE id = ?').run(c.unit, subject, existing.id);
        added.push(`${c.name} 목차 갱신 ${c.items.length}개`);
      } else if (!db.prepare('SELECT 1 FROM courses WHERE name = ?').get(`${c.name} (예제)`)) {
        addCourse(`${c.name} (예제)`, c, subject);
      }
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (added.length) console.log('[seed] 교재 목차를 넣었습니다:', added.join(', '));
}
seedCurriculum();

module.exports = { db, UPLOAD_DIR, hashPassword, verifyPassword };
