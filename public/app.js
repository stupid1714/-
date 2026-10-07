'use strict';

const $app = document.getElementById('app');
const state = { me: null, students: [], staff: [], selectedId: null, tab: 'progress', search: '', todayOnly: false, mineOnly: false };

// 화면 아래에 표시되는 버전 (업데이트를 받았는지 확인용)
const APP_VERSION = '2026.10.08-18';
const ROLE_LABEL = { admin: '관리자', teacher: '선생님', student: '학생', parent: '학부모' };
const isStaff = (me) => Boolean(me) && (me.role === 'admin' || me.role === 'teacher');
const isAdmin = (me) => Boolean(me) && me.role === 'admin';
const ATT_LABEL = { present: '출석', late: '지각', absent: '결석', excused: '공결' };
const DAY_LABEL = ['일', '월', '화', '수', '목', '금', '토'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // 월요일부터 표시

// 학원 수업 규칙: 주 2회, 회당 1시간 30분. 토요일은 09:00~12:00에 2회분을 한 번에 진행
const CLASS_MINUTES = 90;
const WEEKLY_SESSIONS = 2;
const SATURDAY = 6;
const SATURDAY_SLOT = { start_time: '09:00', end_time: '12:00' };
const DEFAULT_WEEKDAY_START = '16:00';

// ---------- 유틸 ----------

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(s) { return String(s || '').slice(0, 16); }
function ext(name) { const m = /\.([a-z0-9]{1,5})$/i.exec(name || ''); return m ? m[1] : 'file'; }
function initial(name) { return esc(String(name || '?').trim().charAt(0)); }

let toastTimer;
function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2400);
}

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opts.form) init.body = opts.form;
  else if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('서버에 연결할 수 없습니다. PC의 서버(검은 창)가 켜져 있는지 확인해 주세요.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login' && state.me) {
    // 세션이 만료된 경우에만 로그인 화면으로 (비로그인 상태의 /api/me 확인은 제외)
    state.me = null;
    render();
    throw new Error(data.error || '로그인이 필요합니다.');
  }
  if (!res.ok) throw new Error(data.error || '요청에 실패했습니다.');
  return data;
}

// 폼 제출 공통 처리: 에러는 토스트로 표시
function onSubmit(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    if (btn) btn.disabled = true;
    try { await handler(new FormData(form)); } catch (err) { toast(err.message, true); } finally { if (btn) btn.disabled = false; }
  });
}

function progressBar(pct) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return `<div class="progress"><i style="width:${p}%"></i></div>`;
}

function topbar() {
  const me = state.me;
  return `
    <header class="topbar">
      <span class="brand">학습 관리</span>
      <span class="muted small app-version">v${APP_VERSION}</span>
      <span class="spacer"></span>
      <span class="who"><span class="role-label">${ROLE_LABEL[me.role]} · </span><b>${esc(me.name)}</b>${me.name.endsWith('님') ? '' : '님'}</span>
      <button class="btn small" data-act="password">${isStaff(me) ? '내 정보' : '비밀번호'}</button>
      <button class="btn small" data-act="logout">로그아웃</button>
    </header>
    ${me.weak_password ? `<div class="warn-bar">⚠️ 테스트용 기본 비밀번호를 사용 중입니다. 오른쪽 위 <b>${isStaff(me) ? '내 정보' : '비밀번호'}</b>에서 꼭 바꿔 주세요.</div>` : ''}`;
}

function bindTopbar() {
  $app.querySelector('[data-act=logout]').onclick = async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    state.me = null;
    location.hash = '';
    render();
  };
  $app.querySelector('[data-act=password]').onclick = openPasswordModal;
}

function modal(html, bind) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">${html}</div>`;
  const close = () => bg.remove();
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  document.body.appendChild(bg);
  bind(bg, close);
}

function openPasswordModal() {
  const staff = isStaff(state.me);
  modal(`
    ${staff ? `
    <h2>내 정보</h2>
    <form id="my-name" style="margin-bottom:18px">
      <label class="field"><span>표시 이름 (학생·학부모 화면의 코멘트 작성자로 보입니다)</span>
        <input type="text" name="name" value="${esc(state.me.name)}" required></label>
      <div class="row end"><button class="btn" type="submit">이름 저장</button></div>
    </form>
    <p class="muted small" style="margin:0 0 12px">아이디: <b class="mono">${esc(state.me.username)}</b></p>` : ''}
    <h2 style="font-size:15px">비밀번호 변경</h2>
    <form id="my-pw">
      <label class="field"><span>현재 비밀번호</span><input type="password" name="current" required autocomplete="current-password"></label>
      <label class="field"><span>새 비밀번호 (4자 이상)</span><input type="password" name="next" required minlength="4" autocomplete="new-password"></label>
      <div class="row end"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">변경</button></div>
    </form>`, (el, close) => {
    const nameForm = el.querySelector('#my-name');
    if (nameForm) {
      onSubmit(nameForm, async (fd) => {
        await api('/api/me/name', { method: 'POST', body: Object.fromEntries(fd) });
        state.me.name = fd.get('name');
        toast('이름이 저장되었습니다.');
        close();
        render();
      });
    }
    onSubmit(el.querySelector('#my-pw'), async (fd) => {
      await api('/api/me/password', { method: 'POST', body: Object.fromEntries(fd) });
      toast('비밀번호가 변경되었습니다.');
      close();
      if (state.me.weak_password) { state.me.weak_password = false; document.querySelector('.warn-bar')?.remove(); }
    });
  });
}

// ---------- 공용 섹션 (학생/학부모/관리자) ----------

function progressCard(s, title = '현재 진도') {
  return `
    <section class="card">
      <div class="card-head"><h2>${title}</h2><span class="big-pct">${Number(s.progress_percent) || 0}%</span></div>
      ${progressBar(s.progress_percent)}
      <dl class="kv">
        <dt>과정</dt><dd>${esc(s.course) || '-'}</dd>
        <dt>현재 진도</dt><dd>${esc(s.current_lesson) || '-'}</dd>
        <dt>다음 진도</dt><dd>${esc(s.next_lesson) || '-'}</dd>
      </dl>
    </section>`;
}

function toMin(t) { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; }
function toTime(min) { return `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; }
function addClass(start, count = 1) { return toTime(toMin(start) + CLASS_MINUTES * count); }

// 수업 시간 길이로 몇 회분인지 계산 (1시간 30분 = 1회, 3시간 = 2회분)
function sessionsOf(slot) { return Math.max(1, Math.round((toMin(slot.end_time) - toMin(slot.start_time)) / CLASS_MINUTES)); }
function weeklySessions(schedule) { return (schedule || []).reduce((n, x) => n + sessionsOf(x), 0); }
function sessionsLabel(slot) { const n = sessionsOf(slot); return n > 1 ? `${n}회분` : ''; }

function weeklyBadge(schedule) {
  if (!schedule || !schedule.length) return '<span class="badge">미등록</span>';
  const n = weeklySessions(schedule);
  return n === WEEKLY_SESSIONS ? `<span class="badge present">주 ${n}회</span>` : `<span class="badge late">주 ${n}회 · 확인 필요</span>`;
}

// 같은 시간대 요일끼리 묶어서 "월·수 16:00~18:00 / 토 10:00~12:00" 형태로
function scheduleText(schedule) {
  if (!schedule || !schedule.length) return '';
  const groups = new Map();
  [...schedule].sort((a, b) => DAY_ORDER.indexOf(a.weekday) - DAY_ORDER.indexOf(b.weekday)).forEach((x) => {
    const key = `${x.start_time}~${x.end_time}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(DAY_LABEL[x.weekday]);
  });
  return [...groups].map(([time, days]) => `${days.join('·')} ${time}`).join(' / ');
}

function todaySlot(schedule) {
  const wd = new Date().getDay();
  return (schedule || []).find((x) => x.weekday === wd) || null;
}

function scheduleWeek(schedule) {
  const wd = new Date().getDay();
  return `<div class="week">${DAY_ORDER.map((d) => {
    const slot = (schedule || []).find((x) => x.weekday === d);
    return `<div class="day ${slot ? 'on' : ''} ${d === wd ? 'today' : ''}">
      <b>${DAY_LABEL[d]}</b>${slot ? `<span>${esc(slot.start_time)}</span><span>~${esc(slot.end_time)}</span>${sessionsLabel(slot) ? `<em>${sessionsLabel(slot)}</em>` : ''}` : '<span>-</span>'}
    </div>`;
  }).join('')}</div>`;
}

function scheduleCard(schedule) {
  const slot = todaySlot(schedule);
  return `
    <section class="card">
      <div class="card-head"><h2>수업 시간</h2>
        ${slot ? `<span class="badge present">오늘 ${esc(slot.start_time)}~${esc(slot.end_time)} 수업</span>` : '<span class="badge">오늘 수업 없음</span>'}</div>
      ${schedule && schedule.length ? `${scheduleWeek(schedule)}
        <p class="muted small" style="margin:10px 0 0">주 ${weeklySessions(schedule)}회 · 1회 수업 1시간 30분${schedule.some((x) => sessionsOf(x) > 1) ? ' · 토요일은 2회분 수업을 한 번에 진행' : ''}</p>`
        : '<div class="empty">등록된 수업 시간이 없습니다.</div>'}
    </section>`;
}

function assignmentCard(s) {
  return `
    <section class="card">
      <div class="card-head"><h2>과제</h2>${s.assignment_due ? `<span class="badge late">마감 ${esc(s.assignment_due)}</span>` : ''}</div>
      ${s.assignment ? `<p style="margin:0;white-space:pre-wrap">${esc(s.assignment)}</p>` : '<div class="empty">등록된 과제가 없습니다.</div>'}
    </section>`;
}

// ---------- 메시지 (학부모 ↔ 선생님) ----------

function messageThread(rows, viewerIsStaff) {
  if (!rows.length) {
    return `<div class="empty">${viewerIsStaff ? '아직 주고받은 메시지가 없습니다.' : '궁금한 점이나 전달할 내용을 선생님께 남겨 주세요.'}</div>`;
  }
  return rows.map((m) => {
    const mine = viewerIsStaff ? Boolean(m.from_staff) : !m.from_staff;
    const who = m.sender_name || (m.from_staff ? '선생님' : '학부모');
    // 상대방이 읽었는지 (내가 보낸 메시지에만 표시)
    const read = m.from_staff ? m.read_by_parent : m.read_by_staff;
    return `
      <div class="msg ${mine ? 'mine' : ''}">
        <div class="msg-who">${esc(who)}</div>
        <div class="msg-bubble">${esc(m.content)}</div>
        <div class="msg-meta">${fmtDate(m.created_at)}${mine ? ` · ${read ? '읽음' : '안 읽음'}` : ''}</div>
      </div>`;
  }).join('');
}

// 대화 내용 + 입력창을 container 안에 그림. onSent는 보낸 뒤 다시 그릴 때 호출
async function renderMessageBox(container, studentId, viewerIsStaff, onSent) {
  const rows = await api(`/api/students/${studentId}/messages`);
  container.innerHTML = `
    <div class="msg-thread">${messageThread(rows, viewerIsStaff)}</div>
    <form class="msg-form">
      <textarea name="content" required maxlength="2000" rows="2"
        placeholder="${viewerIsStaff ? '학부모님께 답장 쓰기' : '예: 다음 주 수요일에 30분 늦을 것 같습니다.'}"></textarea>
      <button class="btn primary" type="submit">보내기</button>
    </form>`;
  const thread = container.querySelector('.msg-thread');
  thread.scrollTop = thread.scrollHeight;
  const form = container.querySelector('.msg-form');
  const textarea = form.querySelector('textarea');
  // PC에서는 Enter로 보내기, Shift+Enter는 줄바꿈
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  onSubmit(form, async (fd) => {
    await api(`/api/students/${studentId}/messages`, { method: 'POST', body: { content: fd.get('content') } });
    toast('메시지를 보냈습니다.');
    await renderMessageBox(container, studentId, viewerIsStaff, onSent);
    if (onSent) onSent();
  });
  return rows;
}

function commentsList(comments, deletable = false) {
  if (!comments.length) return '<div class="empty">아직 코멘트가 없습니다.</div>';
  return comments.map((c) => `
    <div class="comment">
      <p>${esc(c.content)}</p>
      <div class="meta"><span>${esc(c.author || '선생님')}</span><span>·</span><span>${fmtDate(c.created_at)}</span>
        ${deletable ? `<span class="spacer"></span><button class="btn small ghost danger" data-del-comment="${c.id}">삭제</button>` : ''}
      </div>
    </div>`).join('');
}

function attendanceSection(d, deletable = false) {
  const s = d.attendanceSummary;
  const rows = d.attendance.length
    ? `<ul class="list">${d.attendance.map((a) => `
        <li>
          <span class="grow">${esc(a.date)}${a.note ? ` <span class="muted small">· ${esc(a.note)}</span>` : ''}</span>
          <span class="badge ${a.status}">${ATT_LABEL[a.status]}</span>
          ${deletable ? `<button class="btn small ghost danger" data-del-att="${a.id}">삭제</button>` : ''}
        </li>`).join('')}</ul>`
    : '<div class="empty">출석 기록이 없습니다.</div>';
  return `
    <div class="att-summary">
      ${Object.keys(ATT_LABEL).map((k) => `<div><b>${s[k]}</b><span>${ATT_LABEL[k]}</span></div>`).join('')}
    </div>
    ${rows}`;
}

function fileList(files, { deletable = false, showCommon = false, empty = '파일이 없습니다.' } = {}) {
  if (!files.length) return `<div class="empty">${empty}</div>`;
  return `<ul class="list">${files.map((f) => `
    <li>
      <span class="file-icon">${esc(ext(f.original_name))}</span>
      <span class="grow">
        <div class="title">${esc(f.original_name)}</div>
        <div class="muted small">${[f.lesson && esc(f.lesson), fmtSize(f.size), fmtDate(f.created_at)].filter(Boolean).join(' · ')}
          ${showCommon && f.is_common ? ' <span class="badge common">공통</span>' : ''}</div>
        ${f.description ? `<div class="small">${esc(f.description)}</div>` : ''}
      </span>
      <a class="btn small" href="/api/files/${f.id}/download">다운로드</a>
      ${deletable ? `<button class="btn small ghost danger" data-del-file="${f.id}">삭제</button>` : ''}
    </li>`).join('')}</ul>`;
}

function photoGrid(photos) {
  if (!photos || !photos.length) return '';
  return `<div class="photo-grid">${photos.map((ph) =>
    `<button type="button" class="photo-thumb" data-photo="${ph.id}" title="크게 보기"><img src="/api/photos/${ph.id}" alt="" loading="lazy"></button>`).join('')}</div>`;
}

function logsList(logs, editable = false) {
  if (!logs.length) return '<div class="empty">진도 기록이 없습니다.</div>';
  return `<div class="logs">${logs.map((l) => `
    <article class="log-item">
      <div class="log-head"><span class="badge">${esc(l.date)}</span>
        ${l.photos && l.photos.length ? `<span class="muted small">📷 ${l.photos.length}</span>` : ''}
        <span class="spacer"></span>
        ${editable ? `<button class="btn small ghost" data-edit-log="${l.id}">수정</button>
          <button class="btn small ghost danger" data-del-log="${l.id}">삭제</button>` : ''}</div>
      ${l.content ? `<div class="log-content">${esc(l.content)}</div>` : ''}
      ${photoGrid(l.photos)}
    </article>`).join('')}</div>`;
}

// 사진 크게 보기 (어느 화면에서든 사진을 누르면)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-photo]');
  if (!btn) return;
  const pid = btn.dataset.photo;
  modal(`
    <div class="lightbox"><img src="/api/photos/${pid}" alt=""></div>
    <div class="row end" style="margin-top:10px">
      <a class="btn" href="/api/photos/${pid}?download=1">저장</a><button type="button" class="btn primary" data-close>닫기</button>
    </div>`, () => {});
  document.querySelector('.modal-bg:last-child .modal').classList.add('modal-wide');
});

// 휴대폰 사진은 커서(수 MB) 올리기 전에 긴 변 1600px JPEG로 줄임. 실패하면 원본 그대로
async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 400 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

// 사진 고르기 + 미리보기 (선택한 사진을 x로 뺄 수 있음). getFiles()로 현재 목록을 받음
function photoPicker(container) {
  let files = [];
  container.innerHTML = `
    <label class="btn small photo-add">📷 사진 추가<input type="file" accept="image/*" multiple hidden></label>
    <span class="muted small">여러 장 선택 가능 · 최대 10장</span>
    <div class="photo-grid preview"></div>`;
  const input = container.querySelector('input');
  const grid = container.querySelector('.preview');
  const draw = () => {
    grid.querySelectorAll('img').forEach((img) => URL.revokeObjectURL(img.src));
    grid.innerHTML = files.map((f, i) => `
      <span class="photo-thumb"><img src="${URL.createObjectURL(f)}" alt=""><button type="button" class="photo-x" data-i="${i}" title="빼기">×</button></span>`).join('');
    grid.querySelectorAll('.photo-x').forEach((b) => { b.onclick = () => { files.splice(Number(b.dataset.i), 1); draw(); }; });
  };
  input.onchange = () => {
    files = files.concat([...input.files].filter((f) => f.type.startsWith('image/'))).slice(0, 10);
    input.value = '';
    draw();
  };
  return { getFiles: () => files, clear: () => { files = []; draw(); } };
}

async function logFormData(date, content, files, extra = {}) {
  const fd = new FormData();
  fd.append('date', date);
  fd.append('content', content);
  Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
  for (const f of files) fd.append('photos', await shrinkImage(f), f.name);
  return fd;
}

function openEditLog(log, reload) {
  modal(`
    <h2>진도 기록 수정</h2>
    <form>
      <label class="field"><span>날짜</span><input type="date" name="date" value="${esc(log.date)}" required style="max-width:200px"></label>
      <label class="field"><span>내용</span><textarea name="content" rows="6">${esc(log.content)}</textarea></label>
      ${log.photos.length ? `<div class="field"><span class="muted small" style="font-weight:600">올린 사진 (누르면 삭제 표시)</span>
        <div class="photo-grid">${log.photos.map((ph) => `
          <span class="photo-thumb removable" data-pid="${ph.id}"><img src="/api/photos/${ph.id}" alt=""><span class="photo-del-mark">삭제</span></span>`).join('')}</div></div>` : ''}
      <div class="field" id="edit-picker"></div>
      <div class="row end"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">저장</button></div>
    </form>`, (el, close) => {
    const picker = photoPicker(el.querySelector('#edit-picker'));
    el.querySelectorAll('.removable').forEach((t) => { t.onclick = () => t.classList.toggle('marked'); });
    onSubmit(el.querySelector('form'), async (fd) => {
      const remove = [...el.querySelectorAll('.removable.marked')].map((t) => t.dataset.pid).join(',');
      const body = await logFormData(fd.get('date'), fd.get('content'), picker.getFiles(), { remove_photo_ids: remove });
      await api(`/api/admin/logs/${log.id}`, { method: 'PUT', form: body });
      toast('수정되었습니다.');
      close();
      reload();
    });
  });
}

// 목록 안의 삭제 버튼들 연결
function bindDeletes(root, reload) {
  const handlers = [
    ['del-comment', (id) => api(`/api/admin/comments/${id}`, { method: 'DELETE' }), '코멘트를 삭제할까요?'],
    ['del-att', (id) => api(`/api/admin/attendance/${id}`, { method: 'DELETE' }), '출석 기록을 삭제할까요?'],
    ['del-log', (id) => api(`/api/admin/logs/${id}`, { method: 'DELETE' }), '진도 기록을 삭제할까요?'],
    ['del-file', (id) => api(`/api/files/${id}`, { method: 'DELETE' }), '파일을 삭제할까요?'],
  ];
  handlers.forEach(([attr, fn, question]) => {
    root.querySelectorAll(`[data-${attr}]`).forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm(question)) return;
        try { await fn(btn.dataset[attr.replace(/-(\w)/g, (_, c) => c.toUpperCase())]); toast('삭제되었습니다.'); reload(); } catch (e) { toast(e.message, true); }
      };
    });
  });
}

// ---------- 로그인 ----------

function renderLogin() {
  let role = 'student';
  $app.innerHTML = `
    <div class="login-wrap">
      <div class="card login-card">
        <img class="logo" src="/icon.svg" alt="">
        <h1>학습 관리</h1>
        <p class="sub">진도 · 과제 · 자료를 한곳에서</p>
        <div class="role-tabs">
          <button type="button" data-role="student" class="on">학생</button>
          <button type="button" data-role="parent">학부모</button>
          <button type="button" data-role="staff">선생님</button>
        </div>
        <form>
          <label class="field"><span>아이디</span><input type="text" name="username" required autocomplete="username" autocapitalize="off"></label>
          <label class="field"><span>비밀번호</span><input type="password" name="password" required autocomplete="current-password"></label>
          <div class="error"></div>
          <button class="btn primary" type="submit" style="width:100%">로그인</button>
        </form>
        <button type="button" class="btn" id="go-signup" style="width:100%;margin-top:10px">회원가입</button>
        <p class="muted small" style="text-align:center;margin:14px 0 0">아이디나 비밀번호를 잊으셨나요? 학원에 문의해 주세요.<br>
          선생님 계정은 관리자가 만들어 드립니다.</p>
        <p class="muted small" style="text-align:center;margin:10px 0 0;opacity:.7">버전 ${APP_VERSION}</p>
      </div>
    </div>`;
  $app.querySelector('#go-signup').onclick = () => renderSignup(role === 'parent' ? 'parent' : 'student');
  $app.querySelectorAll('[data-role]').forEach((b) => {
    b.onclick = () => {
      role = b.dataset.role;
      $app.querySelectorAll('[data-role]').forEach((x) => x.classList.toggle('on', x === b));
    };
  });
  const form = $app.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = form.querySelector('.error');
    errEl.textContent = '';
    try {
      const user = await api('/api/login', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      if ((role === 'staff') !== isStaff(user) || (role !== 'staff' && user.role !== role)) {
        // 선택한 탭과 계정 종류가 달라도 로그인은 진행하고 알려줌
        toast(`${ROLE_LABEL[user.role]} 계정으로 로그인했습니다.`);
      }
      state.me = await api('/api/me');
      history.replaceState(null, '', '#/'); // hashchange 없이 주소만 정리 (중복 렌더 방지)
      render();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
}

// ---------- 회원가입 ----------

function renderSignup(initialRole = 'student') {
  let role = initialRole;
  $app.innerHTML = `
    <div class="login-wrap">
      <div class="card login-card">
        <h1>회원가입</h1>
        <p class="sub">가입 후 학원에서 승인하면 로그인할 수 있습니다.</p>
        <div class="role-tabs" style="grid-template-columns:1fr 1fr">
          <button type="button" data-role="student">학생</button>
          <button type="button" data-role="parent">학부모</button>
        </div>
        <form>
          <label class="field"><span id="name-label">이름</span><input type="text" name="name" required></label>
          <label class="field"><span>아이디 (영문·숫자 3~20자)</span>
            <input type="text" name="username" required autocomplete="username" autocapitalize="off" pattern="[A-Za-z0-9_]{3,20}"></label>
          <label class="field"><span>비밀번호 (4자 이상)</span><input type="password" name="password" required minlength="4" autocomplete="new-password"></label>
          <label class="field"><span>비밀번호 확인</span><input type="password" name="password2" required minlength="4" autocomplete="new-password"></label>
          <label class="field"><span>연락처 (선택)</span><input type="text" name="phone" inputmode="tel" placeholder="010-0000-0000"></label>
          <div id="child-fields">
            <p class="small" style="margin:4px 0 8px"><b>자녀 정보</b> — 자녀가 먼저 <b>학생으로 가입</b>해야 합니다.</p>
            <div class="grid2">
              <label class="field"><span>자녀 이름</span><input type="text" name="child_name"></label>
              <label class="field"><span>자녀 학생 아이디</span><input type="text" name="child_username" autocapitalize="off"></label>
            </div>
          </div>
          <div class="error"></div>
          <button class="btn primary" type="submit" style="width:100%">가입 신청</button>
        </form>
        <button type="button" class="btn ghost" id="go-login" style="width:100%;margin-top:8px">← 로그인으로 돌아가기</button>
      </div>
    </div>`;
  const form = $app.querySelector('form');
  const setRole = (r) => {
    role = r;
    $app.querySelectorAll('[data-role]').forEach((x) => x.classList.toggle('on', x.dataset.role === r));
    const parent = r === 'parent';
    $app.querySelector('#child-fields').style.display = parent ? '' : 'none';
    $app.querySelector('#name-label').textContent = parent ? '학부모 이름' : '학생 이름';
    form.child_name.required = form.child_username.required = parent;
  };
  $app.querySelectorAll('[data-role]').forEach((b) => { b.onclick = () => setRole(b.dataset.role); });
  setRole(role);
  $app.querySelector('#go-login').onclick = renderLogin;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = form.querySelector('.error');
    errEl.textContent = '';
    const data = Object.fromEntries(new FormData(form));
    if (data.password !== data.password2) { errEl.textContent = '비밀번호 확인이 일치하지 않습니다.'; return; }
    try {
      await api('/api/signup', { method: 'POST', body: { ...data, role } });
      $app.querySelector('.login-card').innerHTML = `
        <div style="text-align:center;font-size:44px">✅</div>
        <h1>가입 신청 완료</h1>
        <p class="sub">학원에서 승인하면 <b>${esc(data.username)}</b> 아이디로 로그인할 수 있습니다.<br>
          ${role === 'student' ? '학부모님은 이 아이디로 자녀 연결 가입을 하실 수 있습니다.' : ''}</p>
        <button class="btn primary" id="go-login2" style="width:100%">로그인 화면으로</button>`;
      $app.querySelector('#go-login2').onclick = renderLogin;
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
}

// ---------- 학생 화면 ----------

async function renderStudent() {
  const d = await api(`/api/students/${state.me.id}`);
  const s = d.student;
  $app.innerHTML = `
    ${topbar()}
    <main class="container">
      <div class="hero">
        <div class="avatar">${initial(s.name)}</div>
        <div><h1>${esc(s.name)}</h1><div class="muted">${esc(s.course) || '수강 과정 미정'}</div></div>
      </div>
      <div class="cards">${progressCard(s)}${assignmentCard(s)}</div>
      <div style="height:16px"></div>
      ${scheduleCard(d.schedule)}
      <div id="cur-view"></div>
      <div style="height:16px"></div>
      <section class="card">
        <div class="card-head"><h2>실습 파일 제출</h2></div>
        <form id="upload">
          <div class="grid2">
            <label class="field"><span>진도(강의)</span><input type="text" name="lesson" value="${esc(s.current_lesson)}"></label>
            <label class="field"><span>메모 (선택)</span><input type="text" name="description" placeholder="선생님께 남길 말"></label>
          </div>
          <label class="field"><span>파일</span><input type="file" name="file" required></label>
          <div class="row end"><button class="btn primary" type="submit">업로드</button></div>
        </form>
        <h3 style="margin:18px 0 6px">내가 제출한 파일</h3>
        ${fileList(d.submissions, { deletable: true, empty: '아직 제출한 파일이 없습니다.' })}
      </section>
      <section class="card">
        <div class="card-head"><h2>선생님 자료</h2></div>
        ${fileList(d.materials, { showCommon: true, empty: '받은 자료가 없습니다.' })}
      </section>
      <div class="cards">
        <section class="card"><div class="card-head"><h2>선생님 코멘트</h2></div>${commentsList(d.comments)}</section>
        <section class="card"><div class="card-head"><h2>출석</h2></div>${attendanceSection(d)}</section>
      </div>
      <div style="height:16px"></div>
      <section class="card"><div class="card-head"><h2>진도 기록</h2></div>${logsList(d.logs)}</section>
    </main>`;
  bindTopbar();
  loadCurriculumView(state.me.id, $app.querySelector('#cur-view'));
  bindDeletes($app, renderStudent);
  onSubmit($app.querySelector('#upload'), async (fd) => {
    await api('/api/files', { method: 'POST', form: fd });
    toast('업로드되었습니다.');
    renderStudent();
  });
}

// ---------- 학부모 화면 ----------

async function renderParent() {
  if (!state.me.child_id) {
    $app.innerHTML = `${topbar()}<main class="container"><div class="card empty">연결된 자녀 정보가 없습니다. 선생님께 문의해 주세요.</div></main>`;
    bindTopbar();
    return;
  }
  const d = await api(`/api/students/${state.me.child_id}`);
  const s = d.student;
  $app.innerHTML = `
    ${topbar()}
    <main class="container">
      <div class="hero">
        <div class="avatar">${initial(s.name)}</div>
        <div><div class="muted small">우리 아이</div><h1>${esc(s.name)}</h1><div class="muted">${esc(s.course) || ''}</div></div>
      </div>
      <section class="card" id="msg-card">
        <div class="card-head"><h2>💬 선생님께 메시지</h2>
          ${state.me.unread_messages ? `<span class="badge late">새 답장 ${state.me.unread_messages}</span>` : `<span class="muted small">${esc(s.teacher_name ? `담당 ${s.teacher_name}` : '')}</span>`}</div>
        <div id="msg-box"><div class="empty">불러오는 중...</div></div>
      </section>
      <div class="cards">${progressCard(s, '학습 진도')}${assignmentCard(s)}</div>
      <div style="height:16px"></div>
      ${scheduleCard(d.schedule)}
      <div id="cur-view"></div>
      <div style="height:16px"></div>
      <section class="card"><div class="card-head"><h2>선생님 코멘트</h2></div>${commentsList(d.comments)}</section>
      <div class="cards">
        <section class="card"><div class="card-head"><h2>출석 현황</h2></div>${attendanceSection(d)}</section>
        <section class="card"><div class="card-head"><h2>진도 기록</h2></div>${logsList(d.logs)}</section>
      </div>
      <div style="height:16px"></div>
      <section class="card"><div class="card-head"><h2>아이가 제출한 실습 파일</h2></div>
        ${fileList(d.submissions, { empty: '제출한 파일이 없습니다.' })}</section>
    </main>`;
  bindTopbar();
  loadCurriculumView(state.me.child_id, $app.querySelector('#cur-view'));
  await renderMessageBox($app.querySelector('#msg-box'), state.me.child_id, false);
  state.me.unread_messages = 0;
}

// ---------- 교재 목차 진도 ----------

const curState = { filter: 'all', search: '', open: new Set(), date: '' };

function groupChapters(items) {
  const map = new Map();
  items.forEach((it) => {
    const key = it.chapter || '목차';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  });
  return [...map].map(([chapter, list]) => ({ chapter, items: list }));
}

function pctOf(done, total) { return total ? (done === total ? 100 : Math.floor((done / total) * 100)) : 0; }

function itemCode(it) {
  if (/^(코드|예제) /.test(it.code)) return it.code.replace(/^(코드|예제) /, '');
  if (/^LAB \d/.test(it.code)) return it.code;
  if (it.code === 'Mini') return 'Mini';
  if (['Lab', 'LAB', 'REAL'].includes(it.code) || /^\d+(\.\d+)?$/.test(it.code)) return it.code;
  return '';
}

function groupBySubject(list) {
  const map = new Map();
  list.forEach((c) => { const k = c.subject || '기타'; if (!map.has(k)) map.set(k, []); map.get(k).push(c); });
  return [...map];
}

// 교재 한 권의 목차 카드 (editable이면 체크박스, 아니면 ✓ 표시만)
function courseCardHtml(c, editable, nextId) {
  const q = curState.search.trim().toLowerCase();
  const match = (it) => (curState.filter === 'all' || (curState.filter === 'done') === Boolean(it.done_date))
    && (!q || `${it.title} ${it.code} ${it.topic} ${it.file}`.toLowerCase().includes(q));
  // '다음' 표시는 서버가 계산한 다음 진도(마지막으로 한 곳 다음)와 같게
  const firstTodo = c.items.find((it) => it.id === nextId) || null;
  const chapters = groupChapters(c.items);
  const body = chapters.map((g) => {
    const shown = g.items.filter(match);
    if (!shown.length) return '';
    const d = g.items.filter((it) => it.done_date).length;
    const key = `${c.id}|${g.chapter}`;
    // 사용자가 연 장 + 검색 중 + '다음에 할 항목'이 있는 장은 항상 펼침
    const open = curState.open.has(key) || Boolean(q) || Boolean(firstTodo && g.items.includes(firstTodo));
    return `
      <details class="cur-chapter" data-key="${esc(key)}" ${open ? 'open' : ''}>
        <summary>
          <b>${esc(g.chapter)}</b>
          <span class="muted small">${d}/${g.items.length}</span>
          <span class="mini-bar">${progressBar(pctOf(d, g.items.length))}</span>
          ${editable ? `<button type="button" class="btn small ghost" data-chapter-all="${esc(key)}">${d === g.items.length ? '장 전체 해제' : '장 전체 완료'}</button>` : ''}
        </summary>
        <div class="cur-items">${shown.map((it) => `
          <label class="cur-item ${it.done_date ? 'done' : ''} ${firstTodo === it ? 'next' : ''}">
            ${editable ? `<input type="checkbox" data-item="${it.id}" ${it.done_date ? 'checked' : ''}>` : `<span class="cur-mark">${it.done_date ? '✓' : '○'}</span>`}
            ${itemCode(it) ? `<span class="cur-code">${esc(itemCode(it))}</span>` : ''}
            <span class="cur-title">${esc(it.title)}${firstTodo === it ? ' <span class="badge late">다음</span>' : ''}${editable && it.file ? ` <span class="muted small cur-file">${esc(it.file)}</span>` : ''}</span>
            <span class="cur-tags">
              ${it.stage ? `<span class="badge">${it.stage}단계</span>` : ''}
              ${it.topic ? `<span class="badge common">${esc(it.topic)}</span>` : ''}
              ${it.done_date ? `<span class="muted small">${esc(it.done_date.slice(5).replace('-', '/'))}</span>` : ''}
            </span>
          </label>`).join('')}</div>
      </details>`;
  }).join('');
  const p = pctOf(c.done, c.total);
  return `
    <section class="card cur-course" data-course="${c.id}">
      <div class="card-head"><h2>📘 ${esc(c.name)}</h2><span class="big-pct" style="font-size:22px">${p}%</span></div>
      ${progressBar(p)}
      <div class="progress-label"><span>완료 ${c.done} / 전체 ${c.total}${esc(c.unit)}</span><span>${c.total - c.done}${esc(c.unit)} 남음</span></div>
      <div style="margin-top:12px">${body || '<div class="empty">조건에 맞는 목차가 없습니다.</div>'}</div>
    </section>`;
}

// 과목별 공통 단계 진행 현황 (파이썬 1~25, C언어 1~22 …)
function stageTableHtml(cur) {
  const groups = groupBySubject(cur.courses);
  return groups.map(([subject, courses]) => {
    const stages = cur.stages.filter((st) => (st.subject || '기타') === subject);
    if (!stages.length) return '';
    const rows = stages.map((st) => {
      const per = courses.map((c) => {
        const list = c.items.filter((it) => it.stage === st.no);
        return { total: list.length, done: list.filter((it) => it.done_date).length };
      });
      const total = per.reduce((n, x) => n + x.total, 0);
      if (!total) return '';
      const done = per.reduce((n, x) => n + x.done, 0);
      return `<tr><td>${st.no}</td><td><span class="badge band-${esc(st.band)}">${esc(st.band)}</span></td><td>${esc(st.name)}</td>
        ${per.map((x) => `<td class="num">${x.total ? `${x.done}/${x.total}` : '-'}</td>`).join('')}
        <td class="stage-bar">${progressBar(pctOf(done, total))}<span class="small muted">${pctOf(done, total)}%</span></td></tr>`;
    }).join('');
    const bands = ['기초', '중급', '심화'].map((band) => {
      const nos = stages.filter((st) => st.band === band).map((st) => st.no);
      const list = courses.flatMap((c) => c.items.filter((it) => nos.includes(it.stage)));
      const done = list.filter((it) => it.done_date).length;
      return list.length ? `<div class="band-sum"><span class="badge band-${band}">${band}</span>${progressBar(pctOf(done, list.length))}<span class="small">${pctOf(done, list.length)}%</span></div>` : '';
    }).join('');
    return `
      <div class="subject-block">
        ${groups.length > 1 ? `<h3 class="subject-title">${esc(subject)}</h3>` : ''}
        <div class="band-sums">${bands}</div>
        <details class="stage-details"><summary>${esc(subject)} 단계별(1~${stages.length}) 자세히 보기</summary>
          <div class="table-wrap"><table class="stage-table">
            <thead><tr><th>단계</th><th>구간</th><th>학습 내용</th>${courses.map((c) => `<th>${esc(c.name)}</th>`).join('')}<th>통합</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
        </details>
      </div>`;
  }).join('');
}

// 학생·학부모 화면: 읽기 전용
async function loadCurriculumView(studentId, el) {
  if (!el) return;
  const cur = await api(`/api/students/${studentId}/curriculum`).catch(() => null);
  if (!cur || !cur.courses.length) { el.innerHTML = ''; return; }
  const draw = () => {
    el.innerHTML = `
      <section class="card">
        <div class="card-head"><h2>📚 교재 진도</h2>
          <span class="seg">${[['all', '전체'], ['todo', '남은 것'], ['done', '완료']].map(([k, l]) => `<button type="button" data-f="${k}" class="${curState.filter === k ? 'on' : ''}">${l}</button>`).join('')}</span></div>
        ${stageTableHtml(cur)}
      </section>
      ${cur.courses.map((c) => courseCardHtml(c, false, cur.next_item_id)).join('')}`;
    el.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { curState.filter = b.dataset.f; draw(); }; });
    el.querySelectorAll('details.cur-chapter').forEach((dt) => {
      dt.addEventListener('toggle', () => { if (dt.open) curState.open.add(dt.dataset.key); else curState.open.delete(dt.dataset.key); });
    });
  };
  draw();
}

// 선생님 화면: 교재 지정 + 체크
async function renderCurriculumTab(body, id, onProgress) {
  const [cur, all] = await Promise.all([api(`/api/students/${id}/curriculum`), api('/api/courses')]);
  const assigned = new Set(cur.courses.map((c) => c.id));
  if (!curState.date) curState.date = today();
  body.innerHTML = `
    <section class="card">
      <div class="card-head"><h2>교재 지정</h2><span class="muted small">여러 권 선택 가능 · 목차를 체크하면 진도율·현재/다음 진도가 자동으로 바뀝니다</span></div>
      ${all.length ? groupBySubject(all).map(([subject, list]) => `
        <div class="pick-group"><span class="pick-subject">${esc(subject)}</span><div class="course-picks">${list.map((c) => `
        <label class="chip-check"><input type="checkbox" value="${c.id}" ${assigned.has(c.id) ? 'checked' : ''}>
          <span>${esc(c.name)} <small class="muted">${c.item_count}${esc(c.unit)}</small></span></label>`).join('')}</div></div>`).join('')
        : '<div class="empty">등록된 교재가 없습니다. 왼쪽 아래 <b>📚 교재·목차</b>에서 추가하세요.</div>'}
    </section>
    ${cur.courses.length ? `
      <section class="card cur-toolbar">
        <label class="row small" style="gap:6px">완료 날짜 <input type="date" id="cur-date" value="${esc(curState.date)}" style="width:auto"></label>
        <span class="seg">${[['all', '전체'], ['todo', '남은 것'], ['done', '완료']].map(([k, l]) => `<button type="button" data-f="${k}" class="${curState.filter === k ? 'on' : ''}">${l}</button>`).join('')}</span>
        <input type="search" id="cur-search" placeholder="예제 제목·코드 검색" value="${esc(curState.search)}" style="flex:1;min-width:160px">
      </section>
      <div id="cur-courses"></div>
      <section class="card"><div class="card-head"><h2>단계별 진행 현황</h2></div><div id="stage-box"></div></section>`
      : '<p class="muted" style="margin-left:4px">위에서 교재를 선택하면 목차 체크리스트가 나타납니다. 교재를 선택하지 않으면 지금처럼 슬라이드바로 진도율을 정합니다.</p>'}`;

  body.querySelectorAll('.course-picks input').forEach((cb) => {
    cb.onchange = async () => {
      const ids = [...body.querySelectorAll('.course-picks input:checked')].map((x) => Number(x.value));
      if (!cb.checked && !confirm('이 교재를 학생에게서 뺄까요? (체크 기록은 남아 있어 다시 지정하면 돌아옵니다)')) { cb.checked = true; return; }
      try {
        await api(`/api/admin/students/${id}/courses`, { method: 'PUT', body: { course_ids: ids } });
        toast('교재가 저장되었습니다.');
        onProgress(true);
      } catch (e) { toast(e.message, true); }
    };
  });
  if (!cur.courses.length) return;

  const box = body.querySelector('#cur-courses');
  const draw = () => {
    box.innerHTML = cur.courses.map((c) => courseCardHtml(c, true, cur.next_item_id)).join('');
    body.querySelector('#stage-box').innerHTML = stageTableHtml(cur);
    box.querySelectorAll('details.cur-chapter').forEach((dt) => {
      dt.addEventListener('toggle', () => { if (dt.open) curState.open.add(dt.dataset.key); else curState.open.delete(dt.dataset.key); });
    });
  };
  const send = async (itemIds, done) => {
    const r = await api(`/api/admin/students/${id}/progress`, { method: 'POST', body: { item_ids: itemIds, done, date: curState.date } });
    cur.courses.forEach((c) => {
      c.items.forEach((it) => { if (itemIds.includes(it.id)) it.done_date = done ? curState.date : null; });
      c.done = c.items.filter((it) => it.done_date).length;
    });
    cur.next_item_id = r.next_item_id;
    // 열려 있던 장은 그대로 두기
    box.querySelectorAll('details.cur-chapter[open]').forEach((dt) => curState.open.add(dt.dataset.key));
    draw();
    onProgress(false, r.student);
  };
  box.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-item]');
    if (cb) send([Number(cb.dataset.item)], cb.checked).catch((err) => { cb.checked = !cb.checked; toast(err.message, true); });
  });
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-chapter-all]');
    if (!btn) return;
    e.preventDefault();
    const [cid, ...rest] = btn.dataset.chapterAll.split('|');
    const chapter = rest.join('|');
    const c = cur.courses.find((x) => x.id === Number(cid));
    const list = c.items.filter((it) => (it.chapter || '목차') === chapter);
    const allDone = list.every((it) => it.done_date);
    if (allDone && !confirm(`${chapter}의 완료 체크를 모두 해제할까요?`)) return;
    send(list.filter((it) => Boolean(it.done_date) === allDone).map((it) => it.id), !allDone).catch((err) => toast(err.message, true));
  });
  body.querySelector('#cur-date').onchange = (e) => { curState.date = e.target.value || today(); };
  body.querySelectorAll('.cur-toolbar [data-f]').forEach((b) => {
    b.onclick = () => {
      curState.filter = b.dataset.f;
      body.querySelectorAll('.cur-toolbar [data-f]').forEach((x) => x.classList.toggle('on', x === b));
      draw();
    };
  });
  body.querySelector('#cur-search').oninput = (e) => { curState.search = e.target.value; draw(); };
  draw();
}

// ---------- 계정 안내 (임시 비밀번호) ----------

function randomPassword() {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0] % 1000000).padStart(6, '0'); // 알려주기 쉬운 6자리 숫자
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http 주소(같은 와이파이 접속 등)에서는 clipboard API가 막혀 있어 예전 방식으로 복사
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function showLoginInfo(title, text) {
  modal(`
    <h2>${esc(title)}</h2>
    <p class="muted small" style="margin-top:0">비밀번호는 이 창을 닫으면 다시 볼 수 없습니다. 복사해서 문자나 카톡으로 보내 주세요.</p>
    <pre class="login-info">${esc(text)}</pre>
    <div class="row end"><button type="button" class="btn" data-close>닫기</button><button type="button" class="btn primary" data-copy>안내 문구 복사</button></div>`,
  (el) => {
    el.querySelector('[data-copy]').onclick = async () => toast((await copyText(text)) ? '복사되었습니다.' : '복사하지 못했습니다. 직접 선택해서 복사해 주세요.', false);
  });
}

function loginInfoText(who, username, password) {
  return `[학습 관리] ${who} 로그인 정보
주소: ${location.origin}
아이디: ${username}
비밀번호: ${password}
로그인 후 오른쪽 위 '비밀번호'(선생님은 '내 정보') 버튼에서 원하는 비밀번호로 바꿔 주세요.`;
}

// 선생님이 정해 준 비밀번호는 보여 주고, 본인이 바꾼 경우는 확인 불가로 표시
function pwView(u) {
  if (!u.username) return '';
  return u.initial_password
    ? `비밀번호 <b class="mono pw">${esc(u.initial_password)}</b>`
    : '<span class="muted">비밀번호: 본인이 설정함 (확인 불가)</span>';
}

async function issueTempPassword(studentId, target, username, who, parentId) {
  if (!confirm(`${who}의 비밀번호를 새 임시 비밀번호로 바꿀까요?\n기존 비밀번호로는 더 이상 로그인할 수 없습니다.`)) return;
  const password = randomPassword();
  await api(`/api/admin/students/${studentId}/password`, { method: 'POST', body: { target, password, parent_id: parentId } });
  showLoginInfo('임시 비밀번호 발급 완료', loginInfoText(who, username, password));
}

// ---------- 관리자 화면 ----------

function teacherOptions(selectedId, emptyLabel = '담당 없음') {
  return `<option value="">${emptyLabel}</option>${state.staff.map((t) =>
    `<option value="${t.id}" ${Number(selectedId) === t.id ? 'selected' : ''}>${esc(t.name)}${t.role === 'admin' ? ' (관리자)' : ''}</option>`).join('')}`;
}

async function renderAdmin() {
  [state.students, state.staff] = await Promise.all([api('/api/admin/students'), api('/api/staff')]);
  state.me = await api('/api/me'); // 가입 승인 대기 수·안 읽은 메시지 수 갱신
  const unread = state.me.unread_messages || 0;
  const pending = state.me.pending_signups || 0;

  $app.innerHTML = `
    ${topbar()}
    <div class="admin">
      <aside class="side">
        <div class="side-head">
          <div class="row" style="margin-bottom:10px"><h2>학생 목록 <span class="muted small">${state.students.length}명</span></h2>
            <span class="spacer"></span><button class="btn small primary" data-act="add">+ 학생 추가</button></div>
          <input type="search" placeholder="이름 검색" value="${esc(state.search)}" id="search">
          <label class="row small muted" style="margin-top:8px;cursor:pointer;gap:6px">
            <input type="checkbox" id="today-only" ${state.todayOnly ? 'checked' : ''}> 오늘(${DAY_LABEL[new Date().getDay()]}) 오는 학생만 보기</label>
          <label class="row small muted" style="margin-top:4px;cursor:pointer;gap:6px">
            <input type="checkbox" id="mine-only" ${state.mineOnly ? 'checked' : ''}> 내 담당 학생만 보기</label>
        </div>
        <div class="side-list" id="stu-list"></div>
        <div class="side-nav">
          <a class="btn small" href="#/inbox">💬 메시지함<span class="count" id="inbox-count" ${unread ? '' : 'hidden'}>${unread}</span></a>
          <a class="btn small" href="#/timetable">🗓 시간표</a>
          <a class="btn small" href="#/accounts">👥 계정 목록</a>
          <a class="btn small" href="#/common">📁 공통 자료</a>
          <a class="btn small" href="#/courses">📚 교재·목차</a>
        </div>
        ${isAdmin(state.me) ? `
        <div class="side-nav admin-nav">
          <span class="admin-nav-label">관리자 메뉴</span>
          <a class="btn small" href="#/signups">✅ 가입 승인${pending ? ` <span class="count">${pending}</span>` : ''}</a>
          <a class="btn small" href="#/teachers">🧑‍🏫 선생님 관리</a>
        </div>` : ''}
      </aside>
      <section class="main" id="main"></section>
    </div>`;
  bindTopbar();
  renderStudentList();
  $app.querySelector('#search').oninput = (e) => { state.search = e.target.value; renderStudentList(); };
  $app.querySelector('[data-act=add]').onclick = openAddStudentModal;
  $app.querySelector('#today-only').onchange = (e) => { state.todayOnly = e.target.checked; renderStudentList(); };
  $app.querySelector('#mine-only').onchange = (e) => { state.mineOnly = e.target.checked; renderStudentList(); };
  await showAdminMain();
}

// 주소(#/...)에 따라 오른쪽 영역을 그림
async function showAdminMain() {
  const m = /^#\/student\/(\d+)/.exec(location.hash);
  const page = m ? 'student' : (/^#\/(common|timetable|accounts|signups|teachers|inbox|courses)/.exec(location.hash) || [])[1] || '';
  state.selectedId = m ? Number(m[1]) : null;
  $app.querySelector('.admin').classList.toggle('detail-open', Boolean(page));
  renderStudentList();
  if (page === 'common') await renderCommonMaterials();
  else if (page === 'timetable') await renderTimetable();
  else if (page === 'accounts') await renderAccounts();
  else if (page === 'inbox') await renderInbox();
  else if (page === 'courses') await renderCourses();
  else if (page === 'signups' && isAdmin(state.me)) await renderSignups();
  else if (page === 'teachers' && isAdmin(state.me)) await renderTeachers();
  else if (page === 'student') await renderAdminDetail();
  else {
    const pending = state.me.pending_signups || 0;
    $app.querySelector('#main').innerHTML = `<div class="welcome"><div><div style="font-size:40px">👈</div>왼쪽 목록에서 학생을 선택하세요.
      ${isAdmin(state.me) && pending ? `<p><a class="btn primary" href="#/signups">승인 대기 중인 가입 신청 ${pending}건 보기</a></p>` : ''}</div></div>`;
  }
}

function renderStudentList() {
  const q = state.search.trim();
  const list = state.students
    .filter((s) => !q || s.name.includes(q) || (s.course || '').includes(q))
    .filter((s) => !state.todayOnly || todaySlot(s.schedule))
    .filter((s) => !state.mineOnly || s.teacher_id === state.me.id)
    .sort((a, b) => (state.todayOnly ? todaySlot(a.schedule).start_time.localeCompare(todaySlot(b.schedule).start_time) : 0));
  const el = $app.querySelector('#stu-list');
  if (!list.length) { el.innerHTML = `<div class="empty">${state.todayOnly || state.mineOnly ? '조건에 맞는 학생이 없습니다.' : '학생이 없습니다.'}</div>`; return; }
  el.innerHTML = list.map((s) => `
    <button class="stu-item ${s.id === state.selectedId ? 'on' : ''}" data-id="${s.id}">
      <span class="avatar sm">${initial(s.name)}</span>
      <span class="grow">
        <span class="row"><span class="name">${esc(s.name)}</span>
          ${s.today_status ? `<span class="badge ${s.today_status}">${ATT_LABEL[s.today_status]}</span>` : '<span class="badge">미체크</span>'}
          ${s.unread_messages ? `<span class="badge late" title="안 읽은 학부모 메시지">💬 ${s.unread_messages}</span>` : ''}
          ${s.has_account ? '' : '<span class="badge" title="로그인 계정이 아직 없습니다">계정 없음</span>'}
          <span class="spacer"></span><span class="small muted">${Number(s.progress_percent) || 0}%</span></span>
        <span class="sub" style="display:block">${esc(s.course || '-')} · ${esc(s.current_lesson || '진도 미입력')}${s.teacher_name ? ` · 담당 ${esc(s.teacher_name)}` : ''}</span>
        <span class="sub" style="display:block">🕒 ${esc(scheduleText(s.schedule) || '수업 시간 미등록')}
          ${s.schedule && s.schedule.length && weeklySessions(s.schedule) !== WEEKLY_SESSIONS ? `<span class="badge late">주 ${weeklySessions(s.schedule)}회</span>` : ''}</span>
        ${progressBar(s.progress_percent)}
      </span>
    </button>`).join('');
  el.querySelectorAll('.stu-item').forEach((b) => { b.onclick = () => { location.hash = `#/student/${b.dataset.id}`; }; });
}

function openAddStudentModal() {
  modal(`
    <h2>학생 추가</h2>
    <form>
      <div class="grid2">
        <label class="field"><span>학생 이름 *</span><input type="text" name="name" required></label>
        <label class="field"><span>수강 과정</span><input type="text" name="course"></label>
        <label class="field"><span>담당 선생님</span><select name="teacher_id">${teacherOptions(state.me.role === 'teacher' ? state.me.id : '')}</select></label>
        <label class="field"><span>연락처</span><input type="text" name="phone" inputmode="tel"></label>
      </div>
      <details class="acc-details">
        <summary>로그인 계정도 지금 만들기 <span class="muted small">(선택 · 나중에 학생 화면의 '계정' 탭에서 언제든 가능)</span></summary>
        <div class="grid2" style="margin-top:10px">
          <label class="field"><span>학생 아이디 (영문·숫자)</span><input type="text" name="username" autocapitalize="off"></label>
          <label class="field"><span>학생 비밀번호</span><input type="text" name="password" placeholder="비우면 6자리 자동 생성"></label>
          <label class="field"><span>학부모 아이디</span><input type="text" name="parent_username" autocapitalize="off"></label>
          <label class="field"><span>학부모 비밀번호</span><input type="text" name="parent_password" placeholder="비우면 6자리 자동 생성"></label>
        </div>
      </details>
      <div class="row end" style="margin-top:12px"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">추가</button></div>
    </form>`, (el, close) => {
    onSubmit(el.querySelector('form'), async (fd) => {
      const data = Object.fromEntries(fd);
      const r = await api('/api/admin/students', { method: 'POST', body: data });
      close();
      const infos = [];
      if (data.username) infos.push(loginInfoText(`${data.name} 학생`, data.username, r.password));
      if (data.parent_username) infos.push(loginInfoText(`${data.name} 학부모`, data.parent_username, r.parent_password));
      if (infos.length) showLoginInfo('학생 추가 완료', infos.join('\n\n'));
      else toast('학생이 추가되었습니다. 로그인 계정은 나중에 만들 수 있습니다.');
      await refreshList();
      location.hash = `#/student/${r.id}`; // hashchange가 상세 화면을 그림
    });
  });
}

async function renderCommonMaterials() {
  const main = $app.querySelector('#main');
  const files = await api('/api/admin/materials/common');
  main.innerHTML = `
    <div class="row" style="margin-bottom:16px"><a class="btn small back-btn" href="#/">← 목록</a><h2>전체 공통 자료</h2></div>
    <section class="card">
      <div class="card-head"><h2>모든 학생에게 자료 올리기</h2></div>
      <form id="upload">
        <div class="grid2">
          <label class="field"><span>진도(강의)</span><input type="text" name="lesson"></label>
          <label class="field"><span>설명</span><input type="text" name="description"></label>
        </div>
        <label class="field"><span>파일</span><input type="file" name="file" required></label>
        <div class="row end"><button class="btn primary" type="submit">업로드</button></div>
      </form>
    </section>
    <section class="card"><div class="card-head"><h2>올린 공통 자료</h2></div>${fileList(files, { deletable: true })}</section>`;
  bindDeletes(main, renderCommonMaterials);
  onSubmit(main.querySelector('#upload'), async (fd) => {
    await api('/api/files', { method: 'POST', form: fd });
    toast('업로드되었습니다.');
    renderCommonMaterials();
  });
}

async function renderAdminDetail() {
  const main = $app.querySelector('#main');
  const id = state.selectedId;
  let d;
  try { d = await api(`/api/students/${id}`); } catch (e) { main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const s = d.student;
  const listItem = state.students.find((x) => x.id === id) || {};
  const todayAtt = d.attendance.find((a) => a.date === today());
  const tabs = [['progress', '진도·과제'], ['curriculum', '📚 교재 진도'], ['files', `자료·제출물 (${d.submissions.length})`], ['comments', `코멘트 (${d.comments.length})`], ['messages', `메시지${listItem.unread_messages ? ` 🔴${listItem.unread_messages}` : ''}`], ['schedule', '수업 시간'], ['attendance', '출석'], ['account', '계정']];
  const reload = () => renderAdminDetail().then(refreshList);

  main.innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <a class="btn small back-btn" href="#/">← 목록</a>
      <div class="avatar">${initial(s.name)}</div>
      <div><h1 style="font-size:20px">${esc(s.name)}</h1>
        <div class="muted small">🕒 ${esc(scheduleText(d.schedule) || '수업 시간 미등록')} ${weeklyBadge(d.schedule)}</div>
        <div class="muted small">${s.username ? esc(s.username) : '로그인 계정 없음'} · 담당 ${esc(s.teacher_name || '없음')}${listItem.parent_name ? ` · 학부모: ${esc(listItem.parent_name)}` : ' · 학부모 계정 없음'}</div></div>
    </div>
    <div class="overview">
      <div class="card" id="ov-pct"><div class="label">진도율${listItem.course_count ? ' <span class="badge common">교재 자동</span>' : ''}</div><div class="value">${Number(s.progress_percent) || 0}%</div>${progressBar(s.progress_percent)}</div>
      <div class="card"><div class="label">현재 진도</div><div class="value" id="ov-cur">${esc(s.current_lesson) || '-'}</div></div>
      <div class="card"><div class="label">다음 진도</div><div class="value" id="ov-next">${esc(s.next_lesson) || '-'}</div></div>
      <div class="card"><div class="label">오늘 출석</div><div class="value">${todayAtt ? `<span class="badge ${todayAtt.status}">${ATT_LABEL[todayAtt.status]}</span>` : '<span class="badge">미체크</span>'}</div></div>
    </div>
    <nav class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${state.tab === k ? 'on' : ''}">${l}</button>`).join('')}</nav>
    <div id="tab-body"></div>`;

  main.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { state.tab = b.dataset.tab; renderAdminDetail(); }; });
  const body = main.querySelector('#tab-body');

  if (state.tab === 'progress') {
    body.innerHTML = `
      <section class="card">
        <div class="card-head"><h2>진도 · 과제 설정</h2></div>
        <form id="profile">
          <div class="grid2">
            <label class="field"><span>이름</span><input type="text" name="name" value="${esc(s.name)}" required></label>
            <label class="field"><span>수강 과정</span><input type="text" name="course" value="${esc(s.course)}"></label>
            <label class="field"><span>담당 선생님</span><select name="teacher_id">${teacherOptions(s.teacher_id)}</select></label>
            <span></span>
            <label class="field"><span>현재 진도</span><input type="text" name="current_lesson" value="${esc(s.current_lesson)}" ${listItem.course_count ? 'readonly title="교재 진도 탭의 체크로 자동 계산됩니다"' : ''}></label>
            <label class="field"><span>다음 진도</span><input type="text" name="next_lesson" value="${esc(s.next_lesson)}" ${listItem.course_count ? 'readonly title="교재 진도 탭의 체크로 자동 계산됩니다"' : ''}></label>
          </div>
          <label class="field"><span>진도율 <b id="pct-label">${Number(s.progress_percent) || 0}%</b>
            ${listItem.course_count ? ' — <b>📚 교재 진도</b> 탭에서 목차를 체크하면 자동으로 계산됩니다' : ''}</span>
            <input type="range" name="progress_percent" min="0" max="100" step="5" value="${Number(s.progress_percent) || 0}" style="width:100%" ${listItem.course_count ? 'disabled' : ''}></label>
          <label class="field"><span>과제</span><textarea name="assignment">${esc(s.assignment)}</textarea></label>
          <div class="grid2">
            <label class="field"><span>과제 마감일</span><input type="date" name="assignment_due" value="${esc(s.assignment_due)}"></label>
          </div>
          <label class="field"><span>선생님 메모 (학생·학부모에게 보이지 않음)</span><textarea name="memo">${esc(s.memo)}</textarea></label>
          <div class="row end"><button class="btn primary" type="submit">저장</button></div>
        </form>
      </section>
      <section class="card">
        <div class="card-head"><h2>진도 기록</h2></div>
        <form id="log" class="log-form">
          <input type="date" name="date" value="${today()}" required style="max-width:200px">
          <textarea name="content" rows="4" placeholder="오늘 수업 내용과 아이의 상황을 적어 주세요. (Enter로 줄 바꿈)"></textarea>
          <div id="log-picker" class="row"></div>
          <div class="row end"><button class="btn primary" type="submit">기록 추가</button></div>
        </form>
        ${logsList(d.logs, true)}
      </section>`;
    const range = body.querySelector('[name=progress_percent]');
    range.oninput = () => { body.querySelector('#pct-label').textContent = `${range.value}%`; };
    onSubmit(body.querySelector('#profile'), async (fd) => {
      await api(`/api/admin/students/${id}/profile`, { method: 'PUT', body: Object.fromEntries(fd) });
      toast('저장되었습니다.');
      reload();
    });
    const picker = photoPicker(body.querySelector('#log-picker'));
    onSubmit(body.querySelector('#log'), async (fd) => {
      const files = picker.getFiles();
      if (!String(fd.get('content')).trim() && !files.length) throw new Error('내용을 쓰거나 사진을 추가해 주세요.');
      if (files.length) toast('사진을 올리는 중...');
      await api(`/api/admin/students/${id}/logs`, { method: 'POST', form: await logFormData(fd.get('date'), fd.get('content'), files) });
      toast('진도 기록이 추가되었습니다.');
      reload();
    });
    body.querySelectorAll('[data-edit-log]').forEach((btn) => {
      btn.onclick = () => openEditLog(d.logs.find((l) => l.id === Number(btn.dataset.editLog)), reload);
    });
  }

  if (state.tab === 'files') {
    body.innerHTML = `
      <section class="card">
        <div class="card-head"><h2>${esc(s.name)} 학생에게 자료 보내기</h2></div>
        <form id="upload">
          <input type="hidden" name="student_id" value="${id}">
          <div class="grid2">
            <label class="field"><span>진도(강의)</span><input type="text" name="lesson" value="${esc(s.next_lesson || s.current_lesson)}"></label>
            <label class="field"><span>설명</span><input type="text" name="description"></label>
          </div>
          <label class="field"><span>파일</span><input type="file" name="file" required></label>
          <div class="row end"><button class="btn primary" type="submit">업로드</button></div>
        </form>
      </section>
      <section class="card"><div class="card-head"><h2>학생 제출물</h2></div>${fileList(d.submissions, { deletable: true, empty: '제출한 파일이 없습니다.' })}</section>
      <section class="card"><div class="card-head"><h2>보낸 자료</h2><a class="btn small" href="#/common">공통 자료 관리</a></div>
        ${fileList(d.materials, { deletable: true, showCommon: true, empty: '보낸 자료가 없습니다.' })}</section>`;
    onSubmit(body.querySelector('#upload'), async (fd) => {
      await api('/api/files', { method: 'POST', form: fd });
      toast('업로드되었습니다.');
      reload();
    });
  }

  if (state.tab === 'comments') {
    body.innerHTML = `
      <section class="card">
        <div class="card-head"><h2>코멘트 작성</h2><span class="muted small">학생과 학부모 모두에게 보입니다</span></div>
        <form id="comment">
          <label class="field"><textarea name="content" placeholder="오늘 수업 피드백을 남겨주세요" required></textarea></label>
          <div class="row end"><button class="btn primary" type="submit">등록</button></div>
        </form>
      </section>
      <section class="card"><div class="card-head"><h2>코멘트 내역</h2></div>${commentsList(d.comments, true)}</section>`;
    onSubmit(body.querySelector('#comment'), async (fd) => {
      await api(`/api/admin/students/${id}/comments`, { method: 'POST', body: Object.fromEntries(fd) });
      toast('코멘트가 등록되었습니다.');
      reload();
    });
  }

  if (state.tab === 'curriculum') {
    body.innerHTML = '<div class="empty">불러오는 중...</div>';
    await renderCurriculumTab(body, id, (full, student) => {
      if (full) { refreshList().then(() => renderAdminDetail()); return; }
      // 체크할 때마다 위쪽 진도율·현재/다음 진도와 왼쪽 목록을 바로 갱신
      if (student) {
        main.querySelector('#ov-pct .value').textContent = `${student.progress_percent}%`;
        main.querySelector('#ov-pct .progress > i').style.width = `${student.progress_percent}%`;
        main.querySelector('#ov-cur').textContent = student.current_lesson || '-';
        main.querySelector('#ov-next').textContent = student.next_lesson || '-';
      }
      refreshList();
    });
  }

  if (state.tab === 'messages') {
    body.innerHTML = `
      <section class="card">
        <div class="card-head"><h2>학부모 메시지</h2><span class="muted small">이 학생의 학부모님과 선생님들만 볼 수 있습니다 (학생에게는 보이지 않음)</span></div>
        ${d.parents && d.parents.length ? '' : '<p class="small" style="margin-top:0">⚠️ 이 학생은 아직 학부모 계정이 없어 학부모님이 메시지를 볼 수 없습니다.</p>'}
        <div id="msg-box"><div class="empty">불러오는 중...</div></div>
      </section>`;
    await renderMessageBox(body.querySelector('#msg-box'), id, true);
    // 읽음 처리됐으니 목록·탭의 빨간 숫자 갱신
    if (listItem.unread_messages) {
      listItem.unread_messages = 0;
      const tabBtn = main.querySelector('[data-tab=messages]');
      if (tabBtn) tabBtn.textContent = '메시지';
      refreshList();
      refreshInboxCount();
    }
  }

  if (state.tab === 'schedule') {
    body.innerHTML = `
      <section class="card">
        <div class="card-head"><h2>수업 요일 · 시간</h2><span id="weekly-count"></span></div>
        <p class="muted small" style="margin-top:0">주 ${WEEKLY_SESSIONS}회 · 1회 1시간 30분 수업입니다. 평일은 시작 시간만 고르면 끝나는 시간이 자동으로 채워지고,
          토요일은 ${SATURDAY_SLOT.start_time}~${SATURDAY_SLOT.end_time}에 2회분을 한 번에 진행합니다.</p>
        <div class="row" style="margin-bottom:12px">
          <button type="button" class="btn small" id="preset-sat">토요일반으로 설정 (토 ${SATURDAY_SLOT.start_time}~${SATURDAY_SLOT.end_time})</button>
          <button type="button" class="btn small ghost" id="preset-clear">모두 해제</button>
        </div>
        <form id="schedule">
          <div class="sched-rows">
            ${DAY_ORDER.map((wd) => {
              const slot = d.schedule.find((x) => x.weekday === wd);
              return `
              <div class="sched-row ${slot ? 'on' : ''}" data-wd="${wd}">
                <label class="sched-day"><input type="checkbox" ${slot ? 'checked' : ''}><span>${DAY_LABEL[wd]}</span></label>
                <input type="time" class="start" value="${slot ? esc(slot.start_time) : ''}" step="600" ${slot ? '' : 'disabled'}>
                <span class="muted">~</span>
                <input type="time" class="end" value="${slot ? esc(slot.end_time) : ''}" step="600" ${slot ? '' : 'disabled'}>
                <span class="sched-count"></span>
              </div>`;
            }).join('')}
          </div>
          <div class="row end"><button class="btn primary" type="submit">저장</button></div>
        </form>
      </section>
      <section class="card"><div class="card-head"><h2>미리보기</h2></div>${scheduleWeek(d.schedule)}</section>`;
    const form = body.querySelector('#schedule');
    const rows = [...form.querySelectorAll('.sched-row')];
    const firstWeekday = d.schedule.find((x) => x.weekday !== SATURDAY);
    let lastStart = firstWeekday ? firstWeekday.start_time : DEFAULT_WEEKDAY_START;

    const readSlots = () => rows
      .filter((row) => row.querySelector('[type=checkbox]').checked)
      .map((row) => {
        const [st, en] = row.querySelectorAll('[type=time]');
        return { weekday: Number(row.dataset.wd), start_time: st.value, end_time: en.value };
      });

    // 각 요일 옆 "1회 / 2회분"과 위쪽 주간 횟수 갱신
    const refresh = () => {
      rows.forEach((row) => {
        const [st, en] = row.querySelectorAll('[type=time]');
        const on = row.querySelector('[type=checkbox]').checked;
        row.querySelector('.sched-count').textContent = on && st.value && en.value && st.value < en.value
          ? `${sessionsOf({ start_time: st.value, end_time: en.value })}회${sessionsOf({ start_time: st.value, end_time: en.value }) > 1 ? '분' : ''}` : '';
      });
      const valid = readSlots().filter((x) => x.start_time && x.end_time && x.start_time < x.end_time);
      const n = weeklySessions(valid);
      body.querySelector('#weekly-count').innerHTML = !valid.length ? '<span class="badge">선택 안 됨</span>'
        : n === WEEKLY_SESSIONS ? `<span class="badge present">주 ${n}회 ✓</span>`
        : `<span class="badge late">주 ${n}회 (기준 ${WEEKLY_SESSIONS}회)</span>`;
    };

    const setRow = (row, on, start, endTime) => {
      const cb = row.querySelector('[type=checkbox]');
      const [st, en] = row.querySelectorAll('[type=time]');
      cb.checked = on;
      row.classList.toggle('on', on);
      st.disabled = en.disabled = !on;
      if (on) { st.value = start; en.value = endTime; }
    };

    rows.forEach((row) => {
      const wd = Number(row.dataset.wd);
      const cb = row.querySelector('[type=checkbox]');
      const [st, en] = row.querySelectorAll('[type=time]');
      cb.onchange = () => {
        if (!cb.checked) setRow(row, false);
        else if (st.value) setRow(row, true, st.value, en.value);
        else if (wd === SATURDAY) setRow(row, true, SATURDAY_SLOT.start_time, SATURDAY_SLOT.end_time);
        else setRow(row, true, lastStart, addClass(lastStart));
        refresh();
      };
      // 시작 시간을 바꾸면 끝나는 시간을 규칙에 맞게 자동 계산 (토요일은 2회분)
      st.onchange = () => {
        if (!st.value) return refresh();
        en.value = addClass(st.value, wd === SATURDAY ? 2 : 1);
        if (wd !== SATURDAY) lastStart = st.value;
        refresh();
      };
      en.onchange = refresh;
    });

    body.querySelector('#preset-sat').onclick = () => {
      rows.forEach((row) => {
        if (Number(row.dataset.wd) === SATURDAY) setRow(row, true, SATURDAY_SLOT.start_time, SATURDAY_SLOT.end_time);
        else setRow(row, false);
      });
      refresh();
    };
    body.querySelector('#preset-clear').onclick = () => { rows.forEach((row) => setRow(row, false)); refresh(); };
    refresh();

    onSubmit(form, async () => {
      const slots = readSlots();
      for (const x of slots) {
        const label = DAY_LABEL[x.weekday];
        if (!x.start_time || !x.end_time) throw new Error(`${label}요일 시간을 입력하세요.`);
        if (x.start_time >= x.end_time) throw new Error(`${label}요일 끝나는 시간이 시작 시간보다 늦어야 합니다.`);
      }
      const n = weeklySessions(slots);
      if (slots.length && n !== WEEKLY_SESSIONS && !confirm(`현재 주 ${n}회입니다. (기준: 주 ${WEEKLY_SESSIONS}회)\n그래도 저장할까요?`)) return;
      await api(`/api/admin/students/${id}/schedule`, { method: 'PUT', body: { slots } });
      toast('수업 시간이 저장되었습니다.');
      reload();
    });
  }

  if (state.tab === 'attendance') {
    const slot = todaySlot(d.schedule);
    body.innerHTML = `
      <section class="card">
        <div class="card-head"><h2>출석 체크</h2>
          ${slot ? `<span class="badge present">오늘 수업 ${esc(slot.start_time)}~${esc(slot.end_time)}</span>` : '<span class="badge">오늘은 수업 요일이 아님</span>'}</div>
        <form id="att">
          <label class="field"><span>날짜</span><input type="date" name="date" value="${today()}" required style="max-width:220px"></label>
          <div class="field status-pick">
            ${Object.entries(ATT_LABEL).map(([k, l], i) => `<label><input type="radio" name="status" value="${k}" ${(todayAtt ? todayAtt.status === k : i === 0) ? 'checked' : ''}><span>${l}</span></label>`).join('')}
          </div>
          <label class="field"><span>비고</span><input type="text" name="note" value="${esc(todayAtt ? todayAtt.note : '')}"></label>
          <div class="row end"><button class="btn primary" type="submit">저장</button></div>
        </form>
      </section>
      <section class="card"><div class="card-head"><h2>출석 기록</h2></div>${attendanceSection(d, true)}</section>`;
    onSubmit(body.querySelector('#att'), async (fd) => {
      await api(`/api/admin/students/${id}/attendance`, { method: 'POST', body: Object.fromEntries(fd) });
      toast('출석이 저장되었습니다.');
      reload();
    });
  }

  if (state.tab === 'account') {
    const parents = d.parents || [];
    const hasAccount = Boolean(s.username);
    body.innerHTML = `
      <section class="card">
        <div class="card-head"><h2>학생 로그인 계정</h2>${hasAccount ? '<span class="badge present">사용 중</span>' : '<span class="badge late">아직 없음</span>'}</div>
        ${hasAccount ? `
          <div class="acc-box">
            <div>아이디 <b class="mono">${esc(s.username)}</b></div>
            <div>${pwView(s)}</div>
          </div>
          <div class="row" style="margin-top:10px">
            <button class="btn small" data-temp="student">임시 비밀번호 발급</button>
            <button class="btn small" id="show-info" ${s.initial_password ? '' : 'disabled'}>안내 문구 보기</button>
            <button class="btn small ghost" id="toggle-edit">아이디·비밀번호 직접 변경</button>
          </div>` : '<p class="muted small" style="margin:0 0 8px">학생이 로그인하려면 아이디가 필요합니다. 지금 만들거나, 나중에 만들어도 됩니다.</p>'}
        <form id="stu-account" ${hasAccount ? 'hidden' : ''} style="margin-top:12px">
          <div class="grid2">
            <label class="field"><span>학생 아이디 (영문·숫자 3~20자)</span><input type="text" name="username" value="${esc(s.username || '')}" required autocapitalize="off"></label>
            <label class="field"><span>비밀번호</span><input type="text" name="password" placeholder="${hasAccount ? '비우면 그대로 유지' : '비우면 6자리 자동 생성'}"></label>
          </div>
          <div class="row end"><button class="btn primary" type="submit">${hasAccount ? '변경 저장' : '학생 계정 만들기'}</button></div>
        </form>
      </section>
      <section class="card">
        <div class="card-head"><h2>학부모 로그인 계정</h2><span class="muted small">${parents.length}명</span></div>
        ${parents.length ? `<ul class="list wrap-list">${parents.map((p) => `
          <li>
            <span class="badge excused">학부모</span>
            <span class="grow"><div class="title">${esc(p.name)}${p.phone ? ` <span class="muted small">${esc(p.phone)}</span>` : ''}</div>
              <div class="small">아이디 <b class="mono">${esc(p.username)}</b> · ${pwView(p)}</div></span>
            <span class="signup-actions">
              <button class="btn small" data-temp="parent" data-pid="${p.id}">임시 비밀번호</button>
              ${p.initial_password ? `<button class="btn small" data-pinfo="${p.id}">안내 문구</button>` : ''}
            </span>
          </li>`).join('')}</ul>` : '<p class="muted small" style="margin-top:0">아직 학부모 계정이 없습니다. 아래에서 만들거나, 학부모님이 직접 회원가입할 수도 있습니다.</p>'}
        <form id="add-parent" style="margin-top:12px">
          <p class="small" style="margin:0 0 8px"><b>학부모 계정 ${parents.length ? '추가' : '만들기'}</b> ${parents.length ? '<span class="muted">(예: 아버지·어머니 각각)</span>' : ''}</p>
          <div class="grid2">
            <label class="field"><span>학부모 이름</span><input type="text" name="name" placeholder="${esc(s.name)} 학부모"></label>
            <label class="field"><span>학부모 아이디 (영문·숫자)</span><input type="text" name="username" required autocapitalize="off"></label>
            <label class="field"><span>비밀번호</span><input type="text" name="password" placeholder="비우면 6자리 자동 생성"></label>
          </div>
          <div class="row end"><button class="btn${parents.length ? '' : ' primary'}" type="submit">학부모 계정 만들기</button></div>
        </form>
      </section>
      ${isAdmin(state.me) ? `
      <section class="card">
        <div class="card-head"><h2>학생 삭제</h2></div>
        <p class="muted small" style="margin-top:0">학생, 연결된 학부모 계정, 진도·출석·코멘트·파일이 모두 삭제되며 되돌릴 수 없습니다.</p>
        <button class="btn danger" id="del-student">학생 삭제</button>
      </section>` : ''}`;
    body.querySelectorAll('[data-temp]').forEach((btn) => {
      btn.onclick = async () => {
        const p = parents.find((x) => x.id === Number(btn.dataset.pid));
        try {
          await issueTempPassword(id, btn.dataset.temp, p ? p.username : s.username, p ? p.name : `${s.name} 학생`, btn.dataset.pid);
          reload();
        } catch (e) { toast(e.message, true); }
      };
    });
    const showInfo = body.querySelector('#show-info');
    if (showInfo) showInfo.onclick = () => showLoginInfo('학생 로그인 안내', loginInfoText(`${s.name} 학생`, s.username, s.initial_password));
    body.querySelectorAll('[data-pinfo]').forEach((btn) => {
      btn.onclick = () => {
        const p = parents.find((x) => x.id === Number(btn.dataset.pinfo));
        showLoginInfo('학부모 로그인 안내', loginInfoText(p.name, p.username, p.initial_password));
      };
    });
    const toggle = body.querySelector('#toggle-edit');
    if (toggle) toggle.onclick = () => { const f = body.querySelector('#stu-account'); f.hidden = !f.hidden; };
    onSubmit(body.querySelector('#stu-account'), async (fd) => {
      const r = await api(`/api/admin/students/${id}/account`, { method: 'PUT', body: Object.fromEntries(fd) });
      if (r.password) showLoginInfo(hasAccount ? '학생 계정 변경 완료' : '학생 계정 생성 완료', loginInfoText(`${s.name} 학생`, r.username, r.password));
      else toast('아이디가 변경되었습니다.');
      reload();
    });
    onSubmit(body.querySelector('#add-parent'), async (fd) => {
      const r = await api(`/api/admin/students/${id}/parent`, { method: 'POST', body: Object.fromEntries(fd) });
      showLoginInfo('학부모 계정 생성 완료', loginInfoText(r.name, r.username, r.password));
      reload();
    });
    const del = body.querySelector('#del-student');
    if (del) {
      del.onclick = async () => {
        if (!confirm(`${s.name} 학생을 삭제할까요? 되돌릴 수 없습니다.`)) return;
        await api(`/api/admin/students/${id}`, { method: 'DELETE' });
        toast('삭제되었습니다.');
        location.hash = '#/';
        refreshList();
      };
    }
  }

  bindDeletes(body, reload);
}

async function refreshInboxCount() {
  const me = await api('/api/me');
  state.me.unread_messages = me.unread_messages;
  const el = $app.querySelector('#inbox-count');
  if (el) { el.textContent = me.unread_messages; el.hidden = !me.unread_messages; }
}

async function renderInbox() {
  const main = $app.querySelector('#main');
  const rows = (await api('/api/admin/inbox')).filter((r) => !state.mineOnly || r.teacher_id === state.me.id);
  main.innerHTML = `
    <div class="row" style="margin-bottom:8px"><a class="btn small back-btn" href="#/">← 목록</a><h2>메시지함</h2></div>
    <p class="muted small" style="margin-top:0">학부모님이 보낸 메시지입니다. 안 읽은 대화가 위에 표시됩니다.${state.mineOnly ? ' (내 담당 학생만 보는 중)' : ''}</p>
    <section class="card" style="padding:6px 18px">
      ${rows.length ? `<ul class="list">${rows.map((r) => `
        <li class="inbox-item ${r.unread ? 'unread' : ''}" data-id="${r.student_id}">
          <span class="avatar sm">${initial(r.student_name)}</span>
          <span class="grow">
            <div class="row"><span class="title">${esc(r.student_name)} 학부모</span>
              ${r.unread ? `<span class="count">${r.unread}</span>` : ''}<span class="spacer"></span><span class="muted small">${fmtDate(r.last_at)}</span></div>
            <div class="muted small inbox-preview">${r.last_from_staff ? `↪ ${esc(r.last_sender || '선생님')}: ` : ''}${esc(r.last_content)}</div>
          </span>
        </li>`).join('')}</ul>` : '<div class="empty">아직 받은 메시지가 없습니다.</div>'}
    </section>`;
  main.querySelectorAll('.inbox-item').forEach((li) => {
    li.onclick = () => {
      state.tab = 'messages';
      lastStudent = li.dataset.id; // 학생을 바꿔도 메시지 탭이 열리도록
      location.hash = `#/student/${li.dataset.id}`;
    };
  });
}

async function renderAccounts() {
  const main = $app.querySelector('#main');
  const rows = await api('/api/admin/accounts');
  const noAccount = rows.filter((r) => !r.username).length;
  main.innerHTML = `
    <div class="row" style="margin-bottom:8px"><a class="btn small back-btn" href="#/">← 목록</a><h2>계정 목록</h2></div>
    <p class="muted small" style="margin-top:0">학생·학부모의 아이디와 <b>선생님이 정해 준 비밀번호</b>를 확인할 수 있습니다.
      본인이 직접 바꾼 비밀번호는 보이지 않으니, 잊어버렸다면 <b>임시 비밀번호</b>를 발급해 주세요.
      ${noAccount ? `<br>아직 로그인 계정이 없는 학생이 <b>${noAccount}명</b> 있습니다.` : ''}</p>
    <input type="search" id="acc-search" placeholder="이름 또는 아이디 검색" style="margin-bottom:12px">
    <section class="card" style="padding:0;overflow:hidden">
      ${rows.length ? `<div class="acc-table">
        <div class="acc-row acc-head"><span>학생</span><span>학생 계정</span><span>학부모 계정</span></div>
        ${rows.map((r) => `
          <div class="acc-row" data-search="${esc(`${r.name} ${r.username || ''} ${r.parents.map((p) => `${p.username} ${p.name}`).join(' ')}`.toLowerCase())}">
            <span><a href="#/student/${r.id}" class="title">${esc(r.name)}</a><span class="muted small acc-course">${esc(r.course || '')}</span></span>
            <span class="acc-parents"><span class="acc-label">학생</span>${r.username ? `
              <span class="acc-cred"><b class="mono">${esc(r.username)}</b><span class="small">${pwView(r)}</span></span>
              <button class="btn small" data-temp="student" data-id="${r.id}">임시 비밀번호</button>`
              : `<span class="badge late">계정 없음</span> <a class="small" href="#/student/${r.id}" data-goto-account>만들기</a>`}</span>
            <span class="acc-parents"><span class="acc-label">학부모</span>${r.parents.length ? r.parents.map((p) => `
              <span class="acc-parent"><span class="acc-cred"><b class="mono">${esc(p.username)}</b><span class="small">${pwView(p)}</span></span>
              <button class="btn small" data-temp="parent" data-id="${r.id}" data-pid="${p.id}">임시 비밀번호</button></span>`).join('')
              : `<span class="badge late">계정 없음</span> <a class="small" href="#/student/${r.id}" data-goto-account>만들기</a>`}</span>
          </div>`).join('')}
      </div>` : '<div class="empty">학생이 없습니다.</div>'}
    </section>`;
  main.querySelector('#acc-search').oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    main.querySelectorAll('.acc-row[data-search]').forEach((row) => { row.style.display = !q || row.dataset.search.includes(q) ? '' : 'none'; });
  };
  main.querySelectorAll('[data-goto-account]').forEach((a) => { a.onclick = () => { state.tab = 'account'; lastStudent = a.getAttribute('href').split('/').pop(); }; });
  main.querySelectorAll('[data-temp]').forEach((btn) => {
    btn.onclick = async () => {
      const r = rows.find((x) => x.id === Number(btn.dataset.id));
      const p = r.parents.find((x) => x.id === Number(btn.dataset.pid));
      try {
        await issueTempPassword(r.id, btn.dataset.temp, p ? p.username : r.username, p ? p.name : `${r.name} 학생`, btn.dataset.pid);
        renderAccounts();
      } catch (e) { toast(e.message, true); }
    };
  });
}

async function renderSignups() {
  const main = $app.querySelector('#main');
  const rows = await api('/api/admin/signups');
  const students = rows.filter((r) => r.role === 'student');
  const parents = rows.filter((r) => r.role === 'parent');
  const reload = async () => {
    state.me = await api('/api/me');
    renderAdmin(); // 왼쪽 목록과 승인 대기 수까지 새로 그림
  };
  main.innerHTML = `
    <div class="row" style="margin-bottom:8px"><a class="btn small back-btn" href="#/">← 목록</a><h2>가입 승인</h2></div>
    <p class="muted small" style="margin-top:0">학생·학부모가 회원가입하면 여기에 표시됩니다. 승인해야 로그인할 수 있습니다.
      학부모는 자녀(학생)를 먼저 승인한 뒤 승인할 수 있습니다.</p>
    <section class="card">
      <div class="card-head"><h2>학생 가입 신청 <span class="muted small">${students.length}건</span></h2></div>
      ${students.length ? `<ul class="list wrap-list">${students.map((r) => `
        <li class="signup-item" data-id="${r.id}">
          <span class="grow">
            <div class="title">${esc(r.name)} <span class="muted small mono">${esc(r.username)}</span></div>
            <div class="muted small">${r.phone ? `${esc(r.phone)} · ` : ''}신청 ${fmtDate(r.created_at)}</div>
            <div class="row" style="margin-top:8px">
              <input type="text" class="su-course" placeholder="수강 과정 (선택)" style="flex:1;min-width:140px;min-height:36px">
              <select class="su-teacher" style="width:auto;min-height:36px">${teacherOptions('', '담당 선생님 (선택)')}</select>
            </div>
          </span>
          <span class="signup-actions">
            <button class="btn small primary" data-approve="${r.id}">승인</button>
            <button class="btn small danger" data-reject="${r.id}">거절</button>
          </span>
        </li>`).join('')}</ul>` : '<div class="empty">대기 중인 학생 가입 신청이 없습니다.</div>'}
    </section>
    <section class="card">
      <div class="card-head"><h2>학부모 가입 신청 <span class="muted small">${parents.length}건</span></h2></div>
      ${parents.length ? `<ul class="list wrap-list">${parents.map((r) => `
        <li data-id="${r.id}">
          <span class="grow">
            <div class="title">${esc(r.name)} <span class="muted small mono">${esc(r.username)}</span></div>
            <div class="small">자녀: <b>${esc(r.child_name || '알 수 없음')}</b> <span class="mono muted">(${esc(r.child_username || '-')})</span>
              ${r.child_status === 'pending' ? '<span class="badge late">자녀 승인 대기</span>' : ''}</div>
            <div class="muted small">${r.phone ? `${esc(r.phone)} · ` : ''}신청 ${fmtDate(r.created_at)}</div>
          </span>
          <span class="signup-actions">
            <button class="btn small primary" data-approve="${r.id}" ${r.child_status === 'pending' ? 'disabled title="자녀를 먼저 승인하세요"' : ''}>승인</button>
            <button class="btn small danger" data-reject="${r.id}">거절</button>
          </span>
        </li>`).join('')}</ul>` : '<div class="empty">대기 중인 학부모 가입 신청이 없습니다.</div>'}
    </section>`;
  main.querySelectorAll('[data-approve]').forEach((btn) => {
    btn.onclick = async () => {
      const li = btn.closest('li');
      const course = li.querySelector('.su-course');
      const teacher = li.querySelector('.su-teacher');
      try {
        await api(`/api/admin/signups/${btn.dataset.approve}/approve`, {
          method: 'POST', body: { course: course ? course.value : '', teacher_id: teacher ? teacher.value : '' },
        });
        toast('승인되었습니다.');
        reload();
      } catch (e) { toast(e.message, true); }
    };
  });
  main.querySelectorAll('[data-reject]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('이 가입 신청을 거절할까요? 신청 정보가 삭제됩니다.')) return;
      try {
        await api(`/api/admin/signups/${btn.dataset.reject}`, { method: 'DELETE' });
        toast('거절되었습니다.');
        reload();
      } catch (e) { toast(e.message, true); }
    };
  });
}

async function renderTeachers() {
  const main = $app.querySelector('#main');
  const rows = await api('/api/admin/teachers');
  main.innerHTML = `
    <div class="row" style="margin-bottom:8px"><a class="btn small back-btn" href="#/">← 목록</a><h2>선생님 관리</h2></div>
    <p class="muted small" style="margin-top:0">선생님마다 아이디를 만들어 드리세요. 선생님은 학생 관리(진도·과제·자료·코멘트·출석·수업 시간)를 할 수 있고,
      <b>관리자</b>는 추가로 선생님 관리·가입 승인·학생 삭제를 할 수 있습니다.</p>
    <section class="card">
      <div class="card-head"><h2>선생님 계정 만들기</h2></div>
      <form id="add-teacher">
        <div class="grid2">
          <label class="field"><span>이름 *</span><input type="text" name="name" required placeholder="예: 홍길동 선생님"></label>
          <label class="field"><span>연락처</span><input type="text" name="phone" inputmode="tel"></label>
          <label class="field"><span>아이디 * (영문·숫자 3~20자)</span><input type="text" name="username" required autocapitalize="off"></label>
          <label class="field"><span>비밀번호 * (4자 이상)</span><input type="text" name="password" required minlength="4"></label>
          <label class="field"><span>권한</span><select name="role"><option value="teacher">선생님</option><option value="admin">관리자</option></select></label>
        </div>
        <div class="row end"><button class="btn primary" type="submit">만들기</button></div>
      </form>
    </section>
    <section class="card">
      <div class="card-head"><h2>선생님 목록 <span class="muted small">${rows.length}명</span></h2></div>
      <ul class="list wrap-list">${rows.map((t) => `
        <li>
          <span class="avatar sm">${initial(t.name)}</span>
          <span class="grow">
            <div class="title">${esc(t.name)} <span class="badge ${t.role === 'admin' ? 'common' : ''}">${ROLE_LABEL[t.role]}</span>
              ${t.id === state.me.id ? '<span class="badge present">나</span>' : ''}</div>
            <div class="small">아이디 <b class="mono">${esc(t.username)}</b> · ${pwView(t)}${t.phone ? ` · ${esc(t.phone)}` : ''} · 담당 학생 ${t.student_count}명</div>
          </span>
          <span class="signup-actions">
            <button class="btn small" data-edit="${t.id}">수정</button>
            <button class="btn small" data-tpw="${t.id}">임시 비밀번호</button>
            ${t.id === state.me.id ? '' : `<button class="btn small danger" data-tdel="${t.id}">삭제</button>`}
          </span>
        </li>`).join('')}</ul>
    </section>`;
  const reload = async () => { state.staff = await api('/api/staff'); renderTeachers(); };
  onSubmit(main.querySelector('#add-teacher'), async (fd) => {
    const data = Object.fromEntries(fd);
    await api('/api/admin/teachers', { method: 'POST', body: data });
    showLoginInfo('선생님 계정 생성 완료', loginInfoText(data.name, data.username, data.password));
    reload();
  });
  main.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.onclick = () => {
      const t = rows.find((x) => x.id === Number(btn.dataset.edit));
      modal(`
        <h2>선생님 정보 수정</h2>
        <form>
          <label class="field"><span>이름</span><input type="text" name="name" value="${esc(t.name)}" required></label>
          <label class="field"><span>연락처</span><input type="text" name="phone" value="${esc(t.phone || '')}"></label>
          <p class="muted small">아이디: <b class="mono">${esc(t.username)}</b> (아이디는 바꿀 수 없습니다)</p>
          <div class="row end"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">저장</button></div>
        </form>`, (el, close) => {
        onSubmit(el.querySelector('form'), async (fd) => {
          await api(`/api/admin/teachers/${t.id}`, { method: 'PUT', body: Object.fromEntries(fd) });
          toast('저장되었습니다.');
          close();
          if (t.id === state.me.id) { state.me = await api('/api/me'); renderAdmin(); } else reload();
        });
      });
    };
  });
  main.querySelectorAll('[data-tpw]').forEach((btn) => {
    btn.onclick = async () => {
      const t = rows.find((x) => x.id === Number(btn.dataset.tpw));
      if (!confirm(`${t.name}의 비밀번호를 새 임시 비밀번호로 바꿀까요?`)) return;
      const password = randomPassword();
      try {
        await api(`/api/admin/teachers/${t.id}/password`, { method: 'POST', body: { password } });
        showLoginInfo('임시 비밀번호 발급 완료', loginInfoText(t.name, t.username, password));
        reload();
      } catch (e) { toast(e.message, true); }
    };
  });
  main.querySelectorAll('[data-tdel]').forEach((btn) => {
    btn.onclick = async () => {
      const t = rows.find((x) => x.id === Number(btn.dataset.tdel));
      if (!confirm(`${t.name} 계정을 삭제할까요?\n담당 학생 ${t.student_count}명은 '담당 없음'으로 바뀝니다.`)) return;
      try {
        await api(`/api/admin/teachers/${t.id}`, { method: 'DELETE' });
        toast('삭제되었습니다.');
        reload();
      } catch (e) { toast(e.message, true); }
    };
  });
}

const PASTE_HELP = `<p class="muted small" style="margin:0 0 6px">
  <b>방법 1 (엑셀):</b> 엑셀에서 <b>머리글 줄(No, 단계, 교재 장, 코드 번호, 예제 제목 …)부터</b> 표를 복사해 붙여넣으면 칸이 자동으로 맞춰집니다.<br>
  <b>방법 2 (직접):</b> 한 줄에 하나씩 쓰세요. <code>#</code>으로 시작하는 줄은 장 이름이 됩니다. 예) <code># 4장 반복문</code></p>`;

async function renderCourses() {
  const main = $app.querySelector('#main');
  const admin = isAdmin(state.me);
  const m = /^#\/courses\/(\d+)/.exec(location.hash);
  if (m) return renderCourseDetail(main, Number(m[1]), admin);
  const [list, subjects] = await Promise.all([api('/api/courses'), admin ? api('/api/subjects') : Promise.resolve([])]);
  main.innerHTML = `
    <div class="row" style="margin-bottom:8px"><a class="btn small back-btn" href="#/">← 목록</a><h2>교재·목차</h2></div>
    <p class="muted small" style="margin-top:0">교재마다 목차를 한 번만 올려 두면, 학생 화면의 <b>📚 교재 진도</b> 탭에서 체크만으로 진도율이 자동 계산됩니다.
      ${admin ? '' : '(교재 추가·수정은 관리자만 할 수 있습니다)'}</p>
    ${groupBySubject(list).map(([subject, items]) => `
      <h3 class="subject-title">${esc(subject)}</h3>
      <div class="course-list">${items.map((c) => `
        <a class="card course-card" href="#/courses/${c.id}">
          <div class="title">📘 ${esc(c.name)}</div>
          <div class="muted small">목차 ${c.item_count}${esc(c.unit)} · 사용 학생 ${c.student_count}명</div>
        </a>`).join('')}</div>`).join('') || '<div class="empty">등록된 교재가 없습니다.</div>'}
    ${admin ? `
    <section class="card" style="margin-top:16px">
      <div class="card-head"><h2>새 교재 추가</h2></div>
      <form id="new-course">
        <div class="grid2">
          <label class="field"><span>교재 이름 *</span><input type="text" name="name" required placeholder="예: 엑셀 실무"></label>
          <label class="field"><span>목차 단위</span><select name="unit"><option>예제</option><option>항목</option><option>장</option><option>강</option><option>단원</option></select></label>
          <label class="field"><span>과목 (같은 과목끼리 공통 단계표를 함께 씀)</span>
            <input type="text" name="subject" list="subject-list" placeholder="예: 파이썬, C언어, 엑셀"><datalist id="subject-list">${subjects.map((x) => `<option value="${esc(x)}">`).join('')}</datalist></label>
        </div>
        <label class="field"><span>목차 붙여넣기 (나중에 추가해도 됩니다)</span>${PASTE_HELP}<textarea name="text" rows="8" placeholder="# 1장 시작하기&#10;엑셀 화면 구성&#10;셀 서식&#10;# 2장 함수&#10;SUM, AVERAGE"></textarea></label>
        <div class="row end"><button class="btn primary" type="submit">교재 추가</button></div>
      </form>
    </section>` : ''}`;
  const form = main.querySelector('#new-course');
  if (form) {
    onSubmit(form, async (fd) => {
      const r = await api('/api/admin/courses', { method: 'POST', body: Object.fromEntries(fd) });
      toast(`교재를 추가했습니다 (목차 ${r.added}개).`);
      location.hash = `#/courses/${r.id}`;
    });
  }
}

async function renderCourseDetail(main, courseId, admin) {
  let c;
  try { c = await api(`/api/courses/${courseId}`); } catch (e) { main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const stageName = (no) => (c.stages.find((x) => x.no === no) || {}).name || '';
  main.innerHTML = `
    <div class="row" style="margin-bottom:12px"><a class="btn small" href="#/courses">← 교재 목록</a><h2>📘 ${esc(c.name)}</h2>
      <span class="muted small">${esc(c.subject || '')} · 목차 ${c.items.length}${esc(c.unit)}</span></div>
    ${admin ? `
    <section class="card">
      <form id="course-edit" class="row">
        <input type="text" name="name" value="${esc(c.name)}" required style="flex:1;min-width:160px">
        <select name="unit" style="width:auto">${['예제', '항목', '장', '강', '단원'].map((u) => `<option ${u === c.unit ? 'selected' : ''}>${u}</option>`).join('')}</select>
        <input type="text" name="subject" value="${esc(c.subject || '')}" list="subject-list2" placeholder="과목" style="width:120px">
        <datalist id="subject-list2">${(c.subjects || []).map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
        <button class="btn" type="submit">이름 저장</button>
        <button class="btn danger" type="button" id="course-del">교재 삭제</button>
      </form>
    </section>` : ''}
    <section class="card">
      <div class="card-head"><h2>목차</h2><input type="search" id="item-search" placeholder="검색" style="max-width:220px"></div>
      <div id="item-box">${groupChapters(c.items).map((g) => `
        <details class="cur-chapter" open>
          <summary><b>${esc(g.chapter)}</b> <span class="muted small">${g.items.length}${esc(c.unit)}</span></summary>
          <div class="cur-items">${g.items.map((it) => `
            <div class="cur-item" data-search="${esc(`${it.title} ${it.code} ${it.topic} ${it.file}`.toLowerCase())}">
              <span class="cur-code">${esc(it.code)}</span>
              <span class="cur-title">${esc(it.title)}${it.file ? ` <span class="muted small">${esc(it.file)}</span>` : ''}</span>
              <span class="cur-tags">
                ${it.stage ? `<span class="badge" title="${esc(stageName(it.stage))}">${it.stage}단계</span>` : ''}
                ${it.topic ? `<span class="badge common">${esc(it.topic)}</span>` : ''}
                ${admin ? `<button class="btn small ghost" data-edit-item="${it.id}">수정</button><button class="btn small ghost danger" data-del-item="${it.id}">삭제</button>` : ''}
              </span>
            </div>`).join('')}</div>
        </details>`).join('') || '<div class="empty">목차가 없습니다. 아래에서 붙여넣어 추가하세요.</div>'}</div>
    </section>
    ${admin ? `
    <section class="card">
      <div class="card-head"><h2>목차 추가 (맨 뒤에 붙음)</h2></div>
      <form id="add-items">${PASTE_HELP}<textarea name="text" rows="6" required></textarea>
        <div class="row end" style="margin-top:8px"><button class="btn primary" type="submit">추가</button></div></form>
    </section>` : ''}`;
  const reload = () => renderCourseDetail(main, courseId, admin);
  main.querySelector('#item-search').oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    main.querySelectorAll('#item-box .cur-item').forEach((row) => { row.style.display = !q || row.dataset.search.includes(q) ? '' : 'none'; });
  };
  if (!admin) return;
  onSubmit(main.querySelector('#course-edit'), async (fd) => {
    await api(`/api/admin/courses/${courseId}`, { method: 'PUT', body: Object.fromEntries(fd) });
    toast('저장되었습니다.');
    reload();
  });
  main.querySelector('#course-del').onclick = async () => {
    if (!confirm(`'${c.name}' 교재를 삭제할까요?\n이 교재를 쓰는 학생들의 체크 기록도 함께 지워집니다.`)) return;
    try {
      await api(`/api/admin/courses/${courseId}`, { method: 'DELETE' });
      toast('삭제되었습니다.');
      location.hash = '#/courses';
    } catch (e) { toast(e.message, true); }
  };
  onSubmit(main.querySelector('#add-items'), async (fd) => {
    const r = await api(`/api/admin/courses/${courseId}/items`, { method: 'POST', body: Object.fromEntries(fd) });
    toast(`목차 ${r.added}개를 추가했습니다.`);
    reload();
  });
  main.querySelectorAll('[data-del-item]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('이 목차 항목을 삭제할까요? (학생들의 이 항목 체크 기록도 지워집니다)')) return;
      try { await api(`/api/admin/course-items/${b.dataset.delItem}`, { method: 'DELETE' }); toast('삭제되었습니다.'); reload(); } catch (e) { toast(e.message, true); }
    };
  });
  main.querySelectorAll('[data-edit-item]').forEach((b) => {
    b.onclick = () => {
      const it = c.items.find((x) => x.id === Number(b.dataset.editItem));
      modal(`
        <h2>목차 항목 수정</h2>
        <form>
          <label class="field"><span>제목</span><input type="text" name="title" value="${esc(it.title)}" required></label>
          <div class="grid2">
            <label class="field"><span>장</span><input type="text" name="chapter" value="${esc(it.chapter)}"></label>
            <label class="field"><span>코드 번호·구분</span><input type="text" name="code" value="${esc(it.code)}"></label>
            <label class="field"><span>단계 (1~25)</span><select name="stage"><option value="">없음</option>${c.stages.map((st) =>
              `<option value="${st.no}" ${st.no === it.stage ? 'selected' : ''}>${st.no}. ${esc(st.name)}</option>`).join('')}</select></label>
          </div>
          <div class="row end"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">저장</button></div>
        </form>`, (el, close) => {
        onSubmit(el.querySelector('form'), async (fd) => {
          await api(`/api/admin/course-items/${it.id}`, { method: 'PUT', body: Object.fromEntries(fd) });
          toast('저장되었습니다.');
          close();
          reload();
        });
      });
    };
  });
}

async function renderTimetable() {
  const main = $app.querySelector('#main');
  const rows = await api('/api/admin/timetable');
  const wd = new Date().getDay();
  main.innerHTML = `
    <div class="row" style="margin-bottom:16px"><a class="btn small back-btn" href="#/">← 목록</a><h2>주간 시간표</h2>
      <span class="muted small">학생 이름을 누르면 상세 화면으로 이동합니다</span></div>
    <div class="timetable">
      ${DAY_ORDER.map((d) => {
        const items = rows.filter((r) => r.weekday === d);
        return `
        <section class="tt-day ${d === wd ? 'today' : ''}">
          <h3>${DAY_LABEL[d]}요일 <span class="muted small">${items.length}명</span></h3>
          ${items.length ? items.map((r) => `
            <a class="tt-item" href="#/student/${r.student_id}">
              <span class="tt-time">${esc(r.start_time)}~${esc(r.end_time)}${sessionsLabel(r) ? ` · ${sessionsLabel(r)}` : ''}</span>
              <span class="tt-name">${esc(r.name)}</span>
              ${r.course ? `<span class="muted small">${esc(r.course)}</span>` : ''}
            </a>`).join('') : '<div class="empty small">수업 없음</div>'}
        </section>`;
      }).join('')}
    </div>`;
}

async function refreshList() {
  state.students = await api('/api/admin/students');
  renderStudentList();
}

// ---------- 라우팅 ----------

async function render() {
  try {
    if (!state.me) {
      state.me = await api('/api/me').catch(() => null);
      if (!state.me) return renderLogin();
    }
    if (isStaff(state.me)) return await renderAdmin();
    if (state.me.role === 'student') return await renderStudent();
    return await renderParent();
  } catch (e) {
    if (state.me) toast(e.message, true);
  }
}

let lastStudent = (/^#\/student\/(\d+)/.exec(location.hash) || [])[1] || null;
window.addEventListener('hashchange', () => {
  // 다른 학생을 선택하면 첫 탭으로
  const m = /^#\/student\/(\d+)/.exec(location.hash);
  const cur = m ? m[1] : null;
  if (cur !== lastStudent) state.tab = 'progress';
  lastStudent = cur;
  if (isStaff(state.me) && document.querySelector('.admin')) {
    // 목록은 그대로 두고 오른쪽 영역만 다시 그림
    showAdminMain().catch((e) => toast(e.message, true));
    window.scrollTo(0, 0);
    return;
  }
  render();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

render();
