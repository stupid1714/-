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
       JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`
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

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '권한이 없습니다.' });
  next();
}

// 요청한 사용자가 해당 학생의 정보를 볼 수 있는지 확인
function canViewStudent(user, studentId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'student') return user.id === studentId;
  if (user.role === 'parent') return user.child_id === studentId;
  return false;
}

function getStudent(id) {
  return db.prepare(
    `SELECT u.id, u.username, u.name, u.phone, p.course, p.current_lesson, p.progress_percent,
            p.next_lesson, p.assignment, p.assignment_due, p.memo
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

app.get('/api/me', requireAuth, (req, res) => {
  const me = { ...req.user };
  if (me.role === 'parent' && me.child_id) {
    const child = getStudent(me.child_id);
    me.child_name = child ? child.name : null;
  }
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

// ---------- 학생 상세 (모든 역할 공용, 권한 검사) ----------

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
  const summary = { present: 0, late: 0, absent: 0, excused: 0 };
  attendance.forEach((a) => { summary[a.status] += 1; });
  return { student, comments, attendance, attendanceSummary: summary, logs, materials, submissions };
}

app.get('/api/students/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!canViewStudent(req.user, id)) return res.status(403).json({ error: '권한이 없습니다.' });
  const detail = studentDetail(id);
  if (!detail) return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
  if (req.user.role !== 'admin') delete detail.student.memo; // 선생님 전용 메모
  res.json(detail);
});

// ---------- 관리자: 학생 목록 / 계정 관리 ----------

app.get('/api/admin/students', requireAdmin, (req, res) => {
  const today = todayStr();
  const rows = db.prepare(
    `SELECT u.id, u.username, u.name, p.course, p.current_lesson, p.progress_percent,
            (SELECT status FROM attendance a WHERE a.student_id = u.id AND a.date = ?) AS today_status,
            (SELECT COUNT(*) FROM files f WHERE f.kind = 'submission' AND f.student_id = u.id) AS submission_count,
            (SELECT name FROM users pr WHERE pr.role = 'parent' AND pr.child_id = u.id LIMIT 1) AS parent_name
     FROM users u LEFT JOIN student_profiles p ON p.user_id = u.id
     WHERE u.role = 'student' ORDER BY u.name`
  ).all(today);
  res.json(rows);
});

app.post('/api/admin/students', requireAdmin, (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  const name = String(b.name || '').trim();
  if (!username || !name || !b.password) return res.status(400).json({ error: '이름, 아이디, 비밀번호는 필수입니다.' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(400).json({ error: '이미 사용 중인 학생 아이디입니다.' });
  }
  const parentUsername = String(b.parent_username || '').trim();
  if (parentUsername) {
    if (!b.parent_password) return res.status(400).json({ error: '학부모 비밀번호를 입력하세요.' });
    if (parentUsername === username || db.prepare('SELECT 1 FROM users WHERE username = ?').get(parentUsername)) {
      return res.status(400).json({ error: '이미 사용 중인 학부모 아이디입니다.' });
    }
  }
  db.exec('BEGIN');
  try {
    const id = db.prepare(
      "INSERT INTO users (username, password_hash, name, role, phone) VALUES (?, ?, ?, 'student', ?)"
    ).run(username, hashPassword(String(b.password)), name, String(b.phone || '')).lastInsertRowid;
    db.prepare('INSERT INTO student_profiles (user_id, course) VALUES (?, ?)').run(id, String(b.course || ''));
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

app.put('/api/admin/students/:id/profile', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!getStudent(id)) return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
  const b = req.body || {};
  const pct = Math.max(0, Math.min(100, Number(b.progress_percent) || 0));
  db.prepare(
    `INSERT INTO student_profiles (user_id, course, current_lesson, progress_percent, next_lesson, assignment, assignment_due, memo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET course = excluded.course, current_lesson = excluded.current_lesson,
       progress_percent = excluded.progress_percent, next_lesson = excluded.next_lesson,
       assignment = excluded.assignment, assignment_due = excluded.assignment_due, memo = excluded.memo`
  ).run(id, String(b.course || ''), String(b.current_lesson || ''), pct, String(b.next_lesson || ''),
    String(b.assignment || ''), String(b.assignment_due || ''), String(b.memo || ''));
  if (b.name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(b.name).trim(), id);
  res.json({ ok: true });
});

app.post('/api/admin/students/:id/password', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { target, password } = req.body || {};
  if (!password || String(password).length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다.' });
  const sql = target === 'parent'
    ? "UPDATE users SET password_hash = ? WHERE role = 'parent' AND child_id = ?"
    : "UPDATE users SET password_hash = ? WHERE role = 'student' AND id = ?";
  const r = db.prepare(sql).run(hashPassword(String(password)), id);
  if (!r.changes) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  res.json({ ok: true });
});

app.post('/api/admin/students/:id/comments', requireAdmin, (req, res) => {
  const content = String((req.body || {}).content || '').trim();
  if (!content) return res.status(400).json({ error: '코멘트 내용을 입력하세요.' });
  db.prepare('INSERT INTO comments (student_id, author_id, content) VALUES (?, ?, ?)')
    .run(Number(req.params.id), req.user.id, content);
  res.json({ ok: true });
});

app.delete('/api/admin/comments/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM comments WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/students/:id/logs', requireAdmin, (req, res) => {
  const { date, content } = req.body || {};
  if (!date || !String(content || '').trim()) return res.status(400).json({ error: '날짜와 내용을 입력하세요.' });
  db.prepare('INSERT INTO progress_logs (student_id, date, content) VALUES (?, ?, ?)')
    .run(Number(req.params.id), String(date), String(content).trim());
  res.json({ ok: true });
});

app.delete('/api/admin/logs/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM progress_logs WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/students/:id/attendance', requireAdmin, (req, res) => {
  const { date, status, note } = req.body || {};
  if (!date || !ATTENDANCE_STATUSES.includes(status)) return res.status(400).json({ error: '날짜와 출석 상태를 확인하세요.' });
  db.prepare(
    `INSERT INTO attendance (student_id, date, status, note) VALUES (?, ?, ?, ?)
     ON CONFLICT(student_id, date) DO UPDATE SET status = excluded.status, note = excluded.note`
  ).run(Number(req.params.id), String(date), status, String(note || ''));
  res.json({ ok: true });
});

app.delete('/api/admin/attendance/:id', requireAdmin, (req, res) => {
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
  if (req.user.role === 'admin') {
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
  if (user.role === 'admin') return file;
  if (file.kind === 'material' && file.student_id === null) return file;
  return canViewStudent(user, file.student_id) ? file : null;
}

app.get('/api/files/:id/download', requireAuth, (req, res) => {
  const file = getFileForUser(req.user, Number(req.params.id));
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  res.download(path.join(UPLOAD_DIR, file.stored_name), file.original_name);
});

app.get('/api/admin/materials/common', requireAdmin, (req, res) => {
  res.json(db.prepare(
    `SELECT id, original_name, size, lesson, description, created_at FROM files
     WHERE kind = 'material' AND student_id IS NULL ORDER BY created_at DESC, id DESC`
  ).all());
});

app.delete('/api/files/:id', requireAuth, (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(req.params.id));
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  const own = req.user.role === 'student' && file.kind === 'submission' && file.student_id === req.user.id;
  if (req.user.role !== 'admin' && !own) return res.status(403).json({ error: '권한이 없습니다.' });
  db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
  fs.rm(path.join(UPLOAD_DIR, file.stored_name), { force: true }, () => {});
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

app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
