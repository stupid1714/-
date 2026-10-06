process.env.TZ = process.env.TZ || 'Asia/Seoul';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { db, UPLOAD_DIR, hashPassword, verifyPassword } = require('./db');

const PORT = process.env.PORT || 3000;
const SESSION_DAYS = 14;
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 50);
const ATTENDANCE_STATUSES = ['present', 'late', 'absent', 'excused'];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- 인증 ----------

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function loadUser(req, res, next) {
  const token = parseCookies(req).sid;
  if (token) {
    const row = db.prepare(
      `SELECT u.id, u.username, u.name, u.role, u.child_id FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ? AND u.status = 'active'`
    ).get(token, Date.now());
    if (row) req.user = row;
  }
  next();
}
app.use(loadUser);

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다.' });
  next();
}

const isStaff = (user) => Boolean(user) && (user.role === 'admin' || user.role === 'teacher');

// 관리자(원장) 전용: 선생님 계정, 회원가입 승인, 학생 삭제
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '관리자만 사용할 수 있습니다.' });
  next();
}

// 관리자 + 선생님: 학생 관리(진도, 과제, 자료, 코멘트, 출석 등)
function requireStaff(req, res, next) {
  if (!isStaff(req.user)) return res.status(403).json({ error: '권한이 없습니다.' });
  next();
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const USERNAME_MSG = '아이디는 영문·숫자·밑줄(_)로 3~20자여야 합니다.';
const usernameTaken = (username) => Boolean(db.prepare('SELECT 1 FROM users WHERE username = ?').get(username));

// 요청한 사용자가 해당 학생의 정보를 볼 수 있는지 확인
function canViewStudent(user, studentId) {
  if (!user) return false;
  if (isStaff(user)) return true;
  if (user.role === 'student') return user.id === studentId;
  if (user.role === 'parent') return user.child_id === studentId;
  return false;
}

function getStudent(id) {
  return db.prepare(
    `SELECT u.id, u.username, u.name, u.phone, p.course, p.current_lesson, p.progress_percent,
            p.next_lesson, p.assignment, p.assignment_due, p.memo, p.teacher_id,
            (SELECT name FROM users t WHERE t.id = p.teacher_id) AS teacher_name
     FROM users u LEFT JOIN student_profiles p ON p.user_id = u.id
     WHERE u.id = ? AND u.role = 'student'`
  ).get(id);
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }
  if (user.status === 'pending') {
    return res.status(403).json({ error: '가입 승인 대기 중입니다. 학원에서 승인하면 로그인할 수 있습니다.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, user.id, Date.now() + maxAge * 1000);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`);
  res.json({ id: user.id, name: user.name, role: user.role, child_id: user.child_id });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

// 회원가입 (학생 / 학부모). 관리자가 승인해야 로그인 가능
app.post('/api/signup', (req, res) => {
  const b = req.body || {};
  const role = b.role;
  const name = String(b.name || '').trim();
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const phone = String(b.phone || '').trim();
  if (!['student', 'parent'].includes(role)) return res.status(400).json({ error: '가입 유형을 선택하세요.' });
  if (!name) return res.status(400).json({ error: '이름을 입력하세요.' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: USERNAME_MSG });
  if (password.length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다.' });
  if (usernameTaken(username)) return res.status(400).json({ error: '이미 사용 중인 아이디입니다.' });

  let childId = null;
  if (role === 'parent') {
    // 자녀의 학생 아이디와 이름이 모두 맞아야 연결
    const child = db.prepare("SELECT id FROM users WHERE role = 'student' AND username = ? AND name = ?")
      .get(String(b.child_username || '').trim(), String(b.child_name || '').trim());
    if (!child) return res.status(400).json({ error: '자녀 정보를 찾을 수 없습니다. 자녀가 먼저 학생으로 가입했는지, 아이디와 이름이 맞는지 확인하세요.' });
    childId = child.id;
  }
  db.exec('BEGIN');
  try {
    const id = db.prepare(
      "INSERT INTO users (username, password_hash, name, role, status, child_id, phone) VALUES (?, ?, ?, ?, 'pending', ?, ?)"
    ).run(username, hashPassword(password), name, role, childId, phone).lastInsertRowid;
    if (role === 'student') db.prepare('INSERT INTO student_profiles (user_id) VALUES (?)').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  const me = { ...req.user };
  if (me.role === 'admin') me.pending_signups = db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'pending'").get().c;
  if (me.role === 'parent' && me.child_id) {
    const child = getStudent(me.child_id);
    me.child_name = child ? child.name : null;
    me.unread_messages = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE student_id = ? AND from_staff = 1 AND read_by_parent = 0').get(me.child_id).c;
  }
  if (isStaff(me)) me.unread_messages = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE from_staff = 0 AND read_by_staff = 0').get().c;
  res.json(me);
});

app.post('/api/me/password', requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(current || ''), user.password_hash)) {
    return res.status(400).json({ error: '현재 비밀번호가 올바르지 않습니다.' });
  }
  if (!next || String(next).length < 4) return res.status(400).json({ error: '새 비밀번호는 4자 이상이어야 합니다.' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(next)), req.user.id);
  res.json({ ok: true });
});

app.post('/api/me/name', requireStaff, (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: '이름을 입력하세요.' });
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  res.json({ ok: true });
});

// ---------- 학생 상세 (모든 역할 공용, 권한 검사) ----------

function getSchedule(studentId) {
  return db.prepare(
    'SELECT weekday, start_time, end_time FROM schedules WHERE student_id = ? ORDER BY weekday, start_time'
  ).all(studentId);
}

function studentDetail(studentId) {
  const student = getStudent(studentId);
  if (!student) return null;
  const comments = db.prepare(
    `SELECT c.id, c.content, c.created_at, u.name AS author FROM comments c
     LEFT JOIN users u ON u.id = c.author_id WHERE c.student_id = ? ORDER BY c.created_at DESC, c.id DESC`
  ).all(studentId);
  const attendance = db.prepare(
    'SELECT id, date, status, note FROM attendance WHERE student_id = ? ORDER BY date DESC LIMIT 60'
  ).all(studentId);
  const logs = db.prepare(
    'SELECT id, date, content FROM progress_logs WHERE student_id = ? ORDER BY date DESC, id DESC'
  ).all(studentId);
  const materials = db.prepare(
    `SELECT id, original_name, size, lesson, description, created_at, student_id IS NULL AS is_common
     FROM files WHERE kind = 'material' AND (student_id = ? OR student_id IS NULL) ORDER BY created_at DESC, id DESC`
  ).all(studentId);
  const submissions = db.prepare(
    `SELECT id, original_name, size, lesson, description, created_at
     FROM files WHERE kind = 'submission' AND student_id = ? ORDER BY created_at DESC, id DESC`
  ).all(studentId);
  const schedule = getSchedule(studentId);
  const summary = { present: 0, late: 0, absent: 0, excused: 0 };
  attendance.forEach((a) => { summary[a.status] += 1; });
  return { student, schedule, comments, attendance, attendanceSummary: summary, logs, materials, submissions };
}

app.get('/api/students/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!canViewStudent(req.user, id)) return res.status(403).json({ error: '권한이 없습니다.' });
  const detail = studentDetail(id);
  if (!detail) return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
  if (!isStaff(req.user)) delete detail.student.memo; // 선생님 전용 메모
  else detail.parents = db.prepare("SELECT id, username, name, phone FROM users WHERE role = 'parent' AND child_id = ? AND status = 'active' ORDER BY id").all(id);
  res.json(detail);
});

// ---------- 학부모 ↔ 선생님 메시지 ----------

// 학부모(그 학생의 부모)와 선생님·관리자만. 학생 본인은 볼 수 없음
function canMessage(user, studentId) {
  return isStaff(user) || (user.role === 'parent' && user.child_id === studentId);
}

app.get('/api/students/:id/messages', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!canMessage(req.user, id) || !getStudent(id)) return res.status(403).json({ error: '권한이 없습니다.' });
  const rows = db.prepare(
    `SELECT m.id, m.content, m.from_staff, m.created_at, m.read_by_staff, m.read_by_parent, m.sender_id,
            u.name AS sender_name, u.role AS sender_role
     FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.student_id = ? ORDER BY m.id`
  ).all(id);
  // 열어 본 쪽의 '읽음' 처리
  if (isStaff(req.user)) db.prepare('UPDATE messages SET read_by_staff = 1 WHERE student_id = ? AND from_staff = 0 AND read_by_staff = 0').run(id);
  else db.prepare('UPDATE messages SET read_by_parent = 1 WHERE student_id = ? AND from_staff = 1 AND read_by_parent = 0').run(id);
  res.json(rows);
});

app.post('/api/students/:id/messages', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!canMessage(req.user, id) || !getStudent(id)) return res.status(403).json({ error: '권한이 없습니다.' });
  const content = String((req.body || {}).content || '').trim();
  if (!content) return res.status(400).json({ error: '메시지 내용을 입력하세요.' });
  if (content.length > 2000) return res.status(400).json({ error: '메시지는 2000자 이하로 써 주세요.' });
  const staff = isStaff(req.user) ? 1 : 0;
  // 보낸 쪽은 자기 메시지를 이미 읽은 것으로 처리
  db.prepare('INSERT INTO messages (student_id, sender_id, from_staff, content, read_by_staff, read_by_parent) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.user.id, staff, content, staff, staff ? 0 : 1);
  res.json({ ok: true });
});

// 메시지함: 학생별 마지막 메시지와 안 읽은 수
app.get('/api/admin/inbox', requireStaff, (req, res) => {
  res.json(db.prepare(
    `SELECT u.id AS student_id, u.name AS student_name, p.teacher_id,
            m.content AS last_content, m.from_staff AS last_from_staff, m.created_at AS last_at,
            (SELECT name FROM users s WHERE s.id = m.sender_id) AS last_sender,
            (SELECT COUNT(*) FROM messages x WHERE x.student_id = u.id AND x.from_staff = 0 AND x.read_by_staff = 0) AS unread
     FROM users u
     LEFT JOIN student_profiles p ON p.user_id = u.id
     JOIN messages m ON m.id = (SELECT MAX(id) FROM messages WHERE student_id = u.id)
     WHERE u.role = 'student' AND u.status = 'active'
     ORDER BY unread > 0 DESC, m.id DESC`
  ).all());
});

// ---------- 관리자: 학생 목록 / 계정 관리 ----------

app.get('/api/admin/students', requireStaff, (req, res) => {
  const today = todayStr();
  const rows = db.prepare(
    `SELECT u.id, u.username, u.name, p.course, p.current_lesson, p.progress_percent,
            (SELECT status FROM attendance a WHERE a.student_id = u.id AND a.date = ?) AS today_status,
            (SELECT COUNT(*) FROM files f WHERE f.kind = 'submission' AND f.student_id = u.id) AS submission_count,
            (SELECT COUNT(*) FROM messages m WHERE m.student_id = u.id AND m.from_staff = 0 AND m.read_by_staff = 0) AS unread_messages,
            (SELECT name FROM users pr WHERE pr.role = 'parent' AND pr.child_id = u.id AND pr.status = 'active' LIMIT 1) AS parent_name,
            p.teacher_id, (SELECT name FROM users t WHERE t.id = p.teacher_id) AS teacher_name
     FROM users u LEFT JOIN student_profiles p ON p.user_id = u.id
     WHERE u.role = 'student' AND u.status = 'active' ORDER BY u.name`
  ).all(today);
  const slots = db.prepare('SELECT student_id, weekday, start_time, end_time FROM schedules ORDER BY weekday, start_time').all();
  rows.forEach((r) => { r.schedule = slots.filter((x) => x.student_id === r.id).map(({ student_id, ...rest }) => rest); });
  res.json(rows);
});

app.post('/api/admin/students', requireStaff, (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  const name = String(b.name || '').trim();
  if (!username || !name || !b.password) return res.status(400).json({ error: '이름, 아이디, 비밀번호는 필수입니다.' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: USERNAME_MSG });
  if (usernameTaken(username)) {
    return res.status(400).json({ error: '이미 사용 중인 학생 아이디입니다.' });
  }
  const parentUsername = String(b.parent_username || '').trim();
  if (parentUsername) {
    if (!b.parent_password) return res.status(400).json({ error: '학부모 비밀번호를 입력하세요.' });
    if (!USERNAME_RE.test(parentUsername)) return res.status(400).json({ error: `학부모 ${USERNAME_MSG}` });
    if (parentUsername === username || usernameTaken(parentUsername)) {
      return res.status(400).json({ error: '이미 사용 중인 학부모 아이디입니다.' });
    }
  }
  db.exec('BEGIN');
  try {
    const id = db.prepare(
      "INSERT INTO users (username, password_hash, name, role, phone) VALUES (?, ?, ?, 'student', ?)"
    ).run(username, hashPassword(String(b.password)), name, String(b.phone || '')).lastInsertRowid;
    db.prepare('INSERT INTO student_profiles (user_id, course, teacher_id) VALUES (?, ?, ?)')
      .run(id, String(b.course || ''), validTeacherId(b.teacher_id) ?? (req.user.role === 'teacher' ? req.user.id : null));
    if (parentUsername) {
      db.prepare("INSERT INTO users (username, password_hash, name, role, child_id) VALUES (?, ?, ?, 'parent', ?)")
        .run(parentUsername, hashPassword(String(b.parent_password)), `${name} 학부모`, id);
    }
    db.exec('COMMIT');
    res.json({ id: Number(id) });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

app.delete('/api/admin/students/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const files = db.prepare('SELECT stored_name FROM files WHERE student_id = ?').all(id);
  db.prepare("DELETE FROM users WHERE role = 'parent' AND child_id = ?").run(id);
  db.prepare("DELETE FROM users WHERE id = ? AND role = 'student'").run(id);
  files.forEach((f) => fs.rm(path.join(UPLOAD_DIR, f.stored_name), { force: true }, () => {}));
  res.json({ ok: true });
});

app.put('/api/admin/students/:id/profile', requireStaff, (req, res) => {
  const id = Number(req.params.id);
  if (!getStudent(id)) return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
  const b = req.body || {};
  const pct = Math.max(0, Math.min(100, Number(b.progress_percent) || 0));
  db.prepare(
    `INSERT INTO student_profiles (user_id, course, current_lesson, progress_percent, next_lesson, assignment, assignment_due, memo, teacher_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET course = excluded.course, current_lesson = excluded.current_lesson,
       progress_percent = excluded.progress_percent, next_lesson = excluded.next_lesson,
       assignment = excluded.assignment, assignment_due = excluded.assignment_due, memo = excluded.memo,
       teacher_id = excluded.teacher_id`
  ).run(id, String(b.course || ''), String(b.current_lesson || ''), pct, String(b.next_lesson || ''),
    String(b.assignment || ''), String(b.assignment_due || ''), String(b.memo || ''), validTeacherId(b.teacher_id));
  if (b.name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(b.name).trim(), id);
  res.json({ ok: true });
});

// 계정 목록: 학생·학부모 아이디 한눈에 보기 (비밀번호는 암호화되어 있어 볼 수 없음)
app.get('/api/admin/accounts', requireStaff, (req, res) => {
  const students = db.prepare(
    `SELECT u.id, u.name, u.username, u.phone, p.course FROM users u LEFT JOIN student_profiles p ON p.user_id = u.id
     WHERE u.role = 'student' AND u.status = 'active' ORDER BY u.name`
  ).all();
  const parents = db.prepare("SELECT id, child_id, username, name, phone FROM users WHERE role = 'parent' AND status = 'active' ORDER BY id").all();
  students.forEach((st) => { st.parents = parents.filter((x) => x.child_id === st.id).map(({ child_id, ...rest }) => rest); });
  res.json(students);
});

// 학부모 계정이 없는 학생에게 나중에 학부모 계정 추가
app.post('/api/admin/students/:id/parent', requireStaff, (req, res) => {
  const id = Number(req.params.id);
  const student = getStudent(id);
  if (!student) return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  if (!username || password.length < 4) return res.status(400).json({ error: '학부모 아이디와 4자 이상 비밀번호를 입력하세요.' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: USERNAME_MSG });
  if (usernameTaken(username)) return res.status(400).json({ error: '이미 사용 중인 아이디입니다.' });
  db.prepare("INSERT INTO users (username, password_hash, name, role, child_id) VALUES (?, ?, ?, 'parent', ?)")
    .run(username, hashPassword(password), `${student.name} 학부모`, id);
  res.json({ ok: true });
});

app.post('/api/admin/students/:id/password', requireStaff, (req, res) => {
  const id = Number(req.params.id);
  const { target, password, parent_id: parentId } = req.body || {};
  if (!password || String(password).length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다.' });
  const hash = hashPassword(String(password));
  // 학부모가 여러 명(엄마·아빠)일 수 있으므로 parent_id로 한 명만 바꿈
  const r = target === 'parent'
    ? db.prepare("UPDATE users SET password_hash = ? WHERE role = 'parent' AND child_id = ? AND id = ? AND status = 'active'").run(hash, id, Number(parentId))
    : db.prepare("UPDATE users SET password_hash = ? WHERE role = 'student' AND id = ?").run(hash, id);
  if (!r.changes) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  res.json({ ok: true });
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// 수업 요일·시간 전체 교체: { slots: [{ weekday, start_time, end_time }] }
app.put('/api/admin/students/:id/schedule', requireStaff, (req, res) => {
  const id = Number(req.params.id);
  if (!getStudent(id)) return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
  const slots = Array.isArray((req.body || {}).slots) ? req.body.slots : [];
  const seen = new Set();
  for (const s of slots) {
    const wd = Number(s.weekday);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6 || seen.has(wd)) return res.status(400).json({ error: '요일 정보가 올바르지 않습니다.' });
    if (!TIME_RE.test(s.start_time) || !TIME_RE.test(s.end_time)) return res.status(400).json({ error: '시간을 HH:MM 형식으로 입력하세요.' });
    if (s.start_time >= s.end_time) return res.status(400).json({ error: '끝나는 시간은 시작 시간보다 늦어야 합니다.' });
    seen.add(wd);
  }
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM schedules WHERE student_id = ?').run(id);
    const ins = db.prepare('INSERT INTO schedules (student_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)');
    slots.forEach((s) => ins.run(id, Number(s.weekday), s.start_time, s.end_time));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

// 주간 시간표 (전체 학생)
app.get('/api/admin/timetable', requireStaff, (req, res) => {
  res.json(db.prepare(
    `SELECT s.weekday, s.start_time, s.end_time, u.id AS student_id, u.name, p.course
     FROM schedules s JOIN users u ON u.id = s.student_id LEFT JOIN student_profiles p ON p.user_id = u.id
     WHERE u.status = 'active'
     ORDER BY s.weekday, s.start_time, u.name`
  ).all());
});

app.post('/api/admin/students/:id/comments', requireStaff, (req, res) => {
  const content = String((req.body || {}).content || '').trim();
  if (!content) return res.status(400).json({ error: '코멘트 내용을 입력하세요.' });
  db.prepare('INSERT INTO comments (student_id, author_id, content) VALUES (?, ?, ?)')
    .run(Number(req.params.id), req.user.id, content);
  res.json({ ok: true });
});

app.delete('/api/admin/comments/:id', requireStaff, (req, res) => {
  db.prepare('DELETE FROM comments WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/students/:id/logs', requireStaff, (req, res) => {
  const { date, content } = req.body || {};
  if (!date || !String(content || '').trim()) return res.status(400).json({ error: '날짜와 내용을 입력하세요.' });
  db.prepare('INSERT INTO progress_logs (student_id, date, content) VALUES (?, ?, ?)')
    .run(Number(req.params.id), String(date), String(content).trim());
  res.json({ ok: true });
});

app.delete('/api/admin/logs/:id', requireStaff, (req, res) => {
  db.prepare('DELETE FROM progress_logs WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/students/:id/attendance', requireStaff, (req, res) => {
  const { date, status, note } = req.body || {};
  if (!date || !ATTENDANCE_STATUSES.includes(status)) return res.status(400).json({ error: '날짜와 출석 상태를 확인하세요.' });
  db.prepare(
    `INSERT INTO attendance (student_id, date, status, note) VALUES (?, ?, ?, ?)
     ON CONFLICT(student_id, date) DO UPDATE SET status = excluded.status, note = excluded.note`
  ).run(Number(req.params.id), String(date), status, String(note || ''));
  res.json({ ok: true });
});

app.delete('/api/admin/attendance/:id', requireStaff, (req, res) => {
  db.prepare('DELETE FROM attendance WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- 파일 업로드 / 다운로드 ----------

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`),
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});

// 브라우저가 보내는 파일명(latin1)을 UTF-8 한글로 복원
function decodeName(name) {
  try { return Buffer.from(name, 'latin1').toString('utf8'); } catch { return name; }
}

app.post('/api/files', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일을 선택하세요.' });
  const b = req.body || {};
  let kind;
  let studentId;
  if (isStaff(req.user)) {
    kind = 'material';
    studentId = b.student_id ? Number(b.student_id) : null; // null = 전체 학생 공통 자료
    if (studentId && !getStudent(studentId)) {
      fs.rm(req.file.path, { force: true }, () => {});
      return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
    }
  } else if (req.user.role === 'student') {
    kind = 'submission';
    studentId = req.user.id;
  } else {
    fs.rm(req.file.path, { force: true }, () => {});
    return res.status(403).json({ error: '학부모 계정은 파일을 업로드할 수 없습니다.' });
  }
  db.prepare(
    `INSERT INTO files (kind, student_id, uploader_id, original_name, stored_name, size, lesson, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(kind, studentId, req.user.id, decodeName(req.file.originalname), req.file.filename, req.file.size,
    String(b.lesson || ''), String(b.description || ''));
  res.json({ ok: true });
});

function getFileForUser(user, id) {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  if (!file) return null;
  if (isStaff(user)) return file;
  if (file.kind === 'material' && file.student_id === null) return file;
  return canViewStudent(user, file.student_id) ? file : null;
}

app.get('/api/files/:id/download', requireAuth, (req, res) => {
  const file = getFileForUser(req.user, Number(req.params.id));
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  res.download(path.join(UPLOAD_DIR, file.stored_name), file.original_name);
});

app.get('/api/admin/materials/common', requireStaff, (req, res) => {
  res.json(db.prepare(
    `SELECT id, original_name, size, lesson, description, created_at FROM files
     WHERE kind = 'material' AND student_id IS NULL ORDER BY created_at DESC, id DESC`
  ).all());
});

app.delete('/api/files/:id', requireAuth, (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(req.params.id));
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  const own = req.user.role === 'student' && file.kind === 'submission' && file.student_id === req.user.id;
  if (!isStaff(req.user) && !own) return res.status(403).json({ error: '권한이 없습니다.' });
  db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
  fs.rm(path.join(UPLOAD_DIR, file.stored_name), { force: true }, () => {});
  res.json({ ok: true });
});

// ---------- 선생님 / 회원가입 승인 (관리자 모드) ----------

function validTeacherId(value) {
  const id = Number(value);
  if (!id) return null;
  return db.prepare("SELECT 1 FROM users WHERE id = ? AND role IN ('admin','teacher') AND status = 'active'").get(id) ? id : null;
}

// 담당 선생님 선택 목록 (관리자 + 선생님)
app.get('/api/staff', requireStaff, (req, res) => {
  res.json(db.prepare("SELECT id, name, role FROM users WHERE role IN ('admin','teacher') AND status = 'active' ORDER BY role DESC, name").all());
});

app.get('/api/admin/teachers', requireAdmin, (req, res) => {
  res.json(db.prepare(
    `SELECT u.id, u.username, u.name, u.role, u.phone, u.created_at,
            (SELECT COUNT(*) FROM student_profiles p JOIN users s ON s.id = p.user_id
             WHERE p.teacher_id = u.id AND s.status = 'active') AS student_count
     FROM users u WHERE u.role IN ('admin','teacher') ORDER BY u.role, u.name`
  ).all());
});

app.post('/api/admin/teachers', requireAdmin, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const role = b.role === 'admin' ? 'admin' : 'teacher';
  if (!name) return res.status(400).json({ error: '이름을 입력하세요.' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: USERNAME_MSG });
  if (password.length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다.' });
  if (usernameTaken(username)) return res.status(400).json({ error: '이미 사용 중인 아이디입니다.' });
  const id = db.prepare('INSERT INTO users (username, password_hash, name, role, phone) VALUES (?, ?, ?, ?, ?)')
    .run(username, hashPassword(password), name, role, String(b.phone || '').trim()).lastInsertRowid;
  res.json({ id: Number(id) });
});

function getStaffUser(id) {
  return db.prepare("SELECT id, role FROM users WHERE id = ? AND role IN ('admin','teacher')").get(id);
}

app.put('/api/admin/teachers/:id', requireAdmin, (req, res) => {
  const target = getStaffUser(Number(req.params.id));
  if (!target) return res.status(404).json({ error: '선생님 계정을 찾을 수 없습니다.' });
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: '이름을 입력하세요.' });
  db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(name, String((req.body || {}).phone || '').trim(), target.id);
  res.json({ ok: true });
});

app.post('/api/admin/teachers/:id/password', requireAdmin, (req, res) => {
  const target = getStaffUser(Number(req.params.id));
  if (!target) return res.status(404).json({ error: '선생님 계정을 찾을 수 없습니다.' });
  const password = String((req.body || {}).password || '');
  if (password.length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다.' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), target.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND user_id != ?').run(target.id, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/admin/teachers/:id', requireAdmin, (req, res) => {
  const target = getStaffUser(Number(req.params.id));
  if (!target) return res.status(404).json({ error: '선생님 계정을 찾을 수 없습니다.' });
  if (target.id === req.user.id) return res.status(400).json({ error: '내 계정은 삭제할 수 없습니다.' });
  if (target.role === 'admin' && db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c <= 1) {
    return res.status(400).json({ error: '관리자는 최소 1명 있어야 합니다.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id); // 담당 학생은 '담당 없음'으로 바뀜
  res.json({ ok: true });
});

app.get('/api/admin/signups', requireAdmin, (req, res) => {
  res.json(db.prepare(
    `SELECT u.id, u.username, u.name, u.role, u.phone, u.created_at,
            c.name AS child_name, c.username AS child_username, c.status AS child_status
     FROM users u LEFT JOIN users c ON c.id = u.child_id
     WHERE u.status = 'pending' ORDER BY u.created_at, u.id`
  ).all());
});

app.post('/api/admin/signups/:id/approve', requireAdmin, (req, res) => {
  const u = db.prepare("SELECT id, role, child_id FROM users WHERE id = ? AND status = 'pending'").get(Number(req.params.id));
  if (!u) return res.status(404).json({ error: '가입 신청을 찾을 수 없습니다.' });
  const b = req.body || {};
  if (u.role === 'parent') {
    const child = db.prepare('SELECT status FROM users WHERE id = ?').get(u.child_id);
    if (!child) return res.status(400).json({ error: '연결된 자녀 계정이 없습니다. 이 신청은 거절해 주세요.' });
    if (child.status !== 'active') return res.status(400).json({ error: '자녀(학생) 가입을 먼저 승인해 주세요.' });
  }
  db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(u.id);
  if (u.role === 'student') {
    db.prepare(
      `INSERT INTO student_profiles (user_id, course, teacher_id) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET course = excluded.course, teacher_id = excluded.teacher_id`
    ).run(u.id, String(b.course || ''), validTeacherId(b.teacher_id));
  }
  res.json({ ok: true });
});

app.delete('/api/admin/signups/:id', requireAdmin, (req, res) => {
  const u = db.prepare("SELECT id, role FROM users WHERE id = ? AND status = 'pending'").get(Number(req.params.id));
  if (!u) return res.status(404).json({ error: '가입 신청을 찾을 수 없습니다.' });
  // 거절한 학생에 연결된 승인 대기 학부모 신청도 함께 정리
  if (u.role === 'student') db.prepare("DELETE FROM users WHERE role = 'parent' AND status = 'pending' AND child_id = ?").run(u.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  res.json({ ok: true });
});

// ---------- 에러 처리 / SPA ----------

app.use('/api', (req, res) => res.status(404).json({ error: '요청한 API가 없습니다.' }));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: `파일은 ${MAX_FILE_MB}MB 이하만 업로드할 수 있습니다.` });
  }
  console.error(err);
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

// 같은 와이파이의 휴대폰에서 접속할 주소(PC의 내부 IP)를 함께 보여 줌
function lanAddresses() {
  return Object.values(require('node:os').networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  const ips = lanAddresses();
  if (ips.length) {
    console.log('');
    console.log('[휴대폰에서 보기] PC와 같은 와이파이에 연결한 뒤 휴대폰 브라우저 주소창에 입력하세요:');
    ips.forEach((ip) => console.log(`  http://${ip}:${PORT}`));
  }
});
