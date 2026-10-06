'use strict';

const $app = document.getElementById('app');
const state = { me: null, students: [], selectedId: null, tab: 'progress', search: '', todayOnly: false };

const ROLE_LABEL = { admin: '선생님', student: '학생', parent: '학부모' };
const ATT_LABEL = { present: '출석', late: '지각', absent: '결석', excused: '공결' };
const DAY_LABEL = ['일', '월', '화', '수', '목', '금', '토'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // 월요일부터 표시

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
  const res = await fetch(path, init);
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
      <span class="spacer"></span>
      <span class="who"><span class="role-label">${ROLE_LABEL[me.role]} · </span><b>${esc(me.name)}</b>${me.name.endsWith('님') ? '' : '님'}</span>
      <button class="btn small" data-act="password">비밀번호</button>
      <button class="btn small" data-act="logout">로그아웃</button>
    </header>`;
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
  modal(`
    <h2>비밀번호 변경</h2>
    <form>
      <label class="field"><span>현재 비밀번호</span><input type="password" name="current" required autocomplete="current-password"></label>
      <label class="field"><span>새 비밀번호 (4자 이상)</span><input type="password" name="next" required minlength="4" autocomplete="new-password"></label>
      <div class="row end"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">변경</button></div>
    </form>`, (el, close) => {
    onSubmit(el.querySelector('form'), async (fd) => {
      await api('/api/me/password', { method: 'POST', body: Object.fromEntries(fd) });
      toast('비밀번호가 변경되었습니다.');
      close();
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
      <b>${DAY_LABEL[d]}</b>${slot ? `<span>${esc(slot.start_time)}</span><span>~${esc(slot.end_time)}</span>` : '<span>-</span>'}
    </div>`;
  }).join('')}</div>`;
}

function scheduleCard(schedule) {
  const slot = todaySlot(schedule);
  return `
    <section class="card">
      <div class="card-head"><h2>수업 시간</h2>
        ${slot ? `<span class="badge present">오늘 ${esc(slot.start_time)} 수업</span>` : '<span class="badge">오늘 수업 없음</span>'}</div>
      ${schedule && schedule.length ? scheduleWeek(schedule) : '<div class="empty">등록된 수업 시간이 없습니다.</div>'}
    </section>`;
}

function assignmentCard(s) {
  return `
    <section class="card">
      <div class="card-head"><h2>과제</h2>${s.assignment_due ? `<span class="badge late">마감 ${esc(s.assignment_due)}</span>` : ''}</div>
      ${s.assignment ? `<p style="margin:0;white-space:pre-wrap">${esc(s.assignment)}</p>` : '<div class="empty">등록된 과제가 없습니다.</div>'}
    </section>`;
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

function logsList(logs, deletable = false) {
  if (!logs.length) return '<div class="empty">진도 기록이 없습니다.</div>';
  return `<ul class="list">${logs.map((l) => `
    <li><span class="badge">${esc(l.date)}</span><span class="grow">${esc(l.content)}</span>
    ${deletable ? `<button class="btn small ghost danger" data-del-log="${l.id}">삭제</button>` : ''}</li>`).join('')}</ul>`;
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
          <button type="button" data-role="admin">선생님</button>
        </div>
        <form>
          <label class="field"><span>아이디</span><input type="text" name="username" required autocomplete="username" autocapitalize="off"></label>
          <label class="field"><span>비밀번호</span><input type="password" name="password" required autocomplete="current-password"></label>
          <div class="error"></div>
          <button class="btn primary" type="submit" style="width:100%">로그인</button>
        </form>
      </div>
    </div>`;
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
      if (user.role !== role) {
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
      <div class="cards">${progressCard(s, '학습 진도')}${assignmentCard(s)}</div>
      <div style="height:16px"></div>
      ${scheduleCard(d.schedule)}
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
}

// ---------- 관리자 화면 ----------

async function renderAdmin() {
  state.students = await api('/api/admin/students');

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
        </div>
        <div class="side-list" id="stu-list"></div>
        <div class="side-nav"><a class="btn small" href="#/timetable">🗓 주간 시간표</a><a class="btn small" href="#/common">📁 전체 공통 자료</a></div>
      </aside>
      <section class="main" id="main"></section>
    </div>`;
  bindTopbar();
  renderStudentList();
  $app.querySelector('#search').oninput = (e) => { state.search = e.target.value; renderStudentList(); };
  $app.querySelector('[data-act=add]').onclick = openAddStudentModal;
  $app.querySelector('#today-only').onchange = (e) => { state.todayOnly = e.target.checked; renderStudentList(); };
  await showAdminMain();
}

// 주소(#/...)에 따라 오른쪽 영역을 그림
async function showAdminMain() {
  const m = /^#\/student\/(\d+)/.exec(location.hash);
  const page = m ? 'student' : location.hash.startsWith('#/common') ? 'common' : location.hash.startsWith('#/timetable') ? 'timetable' : '';
  state.selectedId = m ? Number(m[1]) : null;
  $app.querySelector('.admin').classList.toggle('detail-open', Boolean(page));
  renderStudentList();
  if (page === 'common') await renderCommonMaterials();
  else if (page === 'timetable') await renderTimetable();
  else if (page === 'student') await renderAdminDetail();
  else $app.querySelector('#main').innerHTML = '<div class="welcome"><div><div style="font-size:40px">👈</div>왼쪽 목록에서 학생을 선택하세요.</div></div>';
}

function renderStudentList() {
  const q = state.search.trim();
  const list = state.students
    .filter((s) => !q || s.name.includes(q) || (s.course || '').includes(q))
    .filter((s) => !state.todayOnly || todaySlot(s.schedule))
    .sort((a, b) => (state.todayOnly ? todaySlot(a.schedule).start_time.localeCompare(todaySlot(b.schedule).start_time) : 0));
  const el = $app.querySelector('#stu-list');
  if (!list.length) { el.innerHTML = `<div class="empty">${state.todayOnly ? '오늘 수업이 있는 학생이 없습니다.' : '학생이 없습니다.'}</div>`; return; }
  el.innerHTML = list.map((s) => `
    <button class="stu-item ${s.id === state.selectedId ? 'on' : ''}" data-id="${s.id}">
      <span class="avatar sm">${initial(s.name)}</span>
      <span class="grow">
        <span class="row"><span class="name">${esc(s.name)}</span>
          ${s.today_status ? `<span class="badge ${s.today_status}">${ATT_LABEL[s.today_status]}</span>` : '<span class="badge">미체크</span>'}
          <span class="spacer"></span><span class="small muted">${Number(s.progress_percent) || 0}%</span></span>
        <span class="sub" style="display:block">${esc(s.course || '-')} · ${esc(s.current_lesson || '진도 미입력')}</span>
        <span class="sub" style="display:block">🕒 ${esc(scheduleText(s.schedule) || '수업 시간 미등록')}</span>
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
        <label class="field"><span>학생 아이디 *</span><input type="text" name="username" required autocapitalize="off"></label>
        <label class="field"><span>학생 비밀번호 *</span><input type="text" name="password" required minlength="4"></label>
      </div>
      <p class="muted small" style="margin:4px 0 10px">학부모 계정 (선택) — 입력하면 함께 생성되어 이 학생과 연결됩니다.</p>
      <div class="grid2">
        <label class="field"><span>학부모 아이디</span><input type="text" name="parent_username" autocapitalize="off"></label>
        <label class="field"><span>학부모 비밀번호</span><input type="text" name="parent_password"></label>
      </div>
      <div class="row end"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">추가</button></div>
    </form>`, (el, close) => {
    onSubmit(el.querySelector('form'), async (fd) => {
      const r = await api('/api/admin/students', { method: 'POST', body: Object.fromEntries(fd) });
      toast('학생이 추가되었습니다.');
      close();
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
  const tabs = [['progress', '진도·과제'], ['files', `자료·제출물 (${d.submissions.length})`], ['comments', `코멘트 (${d.comments.length})`], ['schedule', '수업 시간'], ['attendance', '출석'], ['account', '계정']];
  const reload = () => renderAdminDetail().then(refreshList);

  main.innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <a class="btn small back-btn" href="#/">← 목록</a>
      <div class="avatar">${initial(s.name)}</div>
      <div><h1 style="font-size:20px">${esc(s.name)}</h1>
        <div class="muted small">🕒 ${esc(scheduleText(d.schedule) || '수업 시간 미등록')}</div>
        <div class="muted small">${esc(s.username)}${listItem.parent_name ? ` · 학부모: ${esc(listItem.parent_name)}` : ' · 학부모 계정 없음'}</div></div>
    </div>
    <div class="overview">
      <div class="card"><div class="label">진도율</div><div class="value">${Number(s.progress_percent) || 0}%</div>${progressBar(s.progress_percent)}</div>
      <div class="card"><div class="label">현재 진도</div><div class="value">${esc(s.current_lesson) || '-'}</div></div>
      <div class="card"><div class="label">다음 진도</div><div class="value">${esc(s.next_lesson) || '-'}</div></div>
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
            <label class="field"><span>현재 진도</span><input type="text" name="current_lesson" value="${esc(s.current_lesson)}"></label>
            <label class="field"><span>다음 진도</span><input type="text" name="next_lesson" value="${esc(s.next_lesson)}"></label>
          </div>
          <label class="field"><span>진도율 <b id="pct-label">${Number(s.progress_percent) || 0}%</b></span>
            <input type="range" name="progress_percent" min="0" max="100" step="5" value="${Number(s.progress_percent) || 0}" style="width:100%"></label>
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
        <form id="log" class="row" style="margin-bottom:10px">
          <input type="date" name="date" value="${today()}" style="width:auto;flex:none" required>
          <input type="text" name="content" placeholder="오늘 수업 내용" style="flex:1;min-width:160px" required>
          <button class="btn primary" type="submit">추가</button>
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
    onSubmit(body.querySelector('#log'), async (fd) => {
      await api(`/api/admin/students/${id}/logs`, { method: 'POST', body: Object.fromEntries(fd) });
      toast('진도 기록이 추가되었습니다.');
      reload();
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

  if (state.tab === 'schedule') {
    body.innerHTML = `
      <section class="card">
        <div class="card-head"><h2>수업 요일 · 시간</h2><span class="muted small">학원에 오는 요일을 체크하고 시간을 입력하세요</span></div>
        <form id="schedule">
          <div class="sched-rows">
            ${DAY_ORDER.map((wd) => {
              const slot = d.schedule.find((x) => x.weekday === wd);
              return `
              <div class="sched-row ${slot ? 'on' : ''}" data-wd="${wd}">
                <label class="sched-day"><input type="checkbox" ${slot ? 'checked' : ''}><span>${DAY_LABEL[wd]}</span></label>
                <input type="time" class="start" value="${slot ? esc(slot.start_time) : ''}" step="300" ${slot ? '' : 'disabled'}>
                <span class="muted">~</span>
                <input type="time" class="end" value="${slot ? esc(slot.end_time) : ''}" step="300" ${slot ? '' : 'disabled'}>
              </div>`;
            }).join('')}
          </div>
          <p class="muted small">요일을 체크하면 바로 위에 입력한 시간이 자동으로 채워집니다.</p>
          <div class="row end"><button class="btn primary" type="submit">저장</button></div>
        </form>
      </section>
      <section class="card"><div class="card-head"><h2>미리보기</h2></div>${scheduleWeek(d.schedule)}</section>`;
    const form = body.querySelector('#schedule');
    let lastTimes = d.schedule[0] ? [d.schedule[0].start_time, d.schedule[0].end_time] : ['16:00', '18:00'];
    form.querySelectorAll('.sched-row').forEach((row) => {
      const cb = row.querySelector('[type=checkbox]');
      const [st, en] = row.querySelectorAll('[type=time]');
      const remember = () => { if (st.value && en.value) lastTimes = [st.value, en.value]; };
      st.onchange = remember; en.onchange = remember;
      cb.onchange = () => {
        row.classList.toggle('on', cb.checked);
        st.disabled = en.disabled = !cb.checked;
        if (cb.checked && !st.value) { [st.value, en.value] = lastTimes; }
      };
    });
    onSubmit(form, async () => {
      const slots = [];
      for (const row of form.querySelectorAll('.sched-row')) {
        if (!row.querySelector('[type=checkbox]').checked) continue;
        const [st, en] = row.querySelectorAll('[type=time]');
        const label = DAY_LABEL[row.dataset.wd];
        if (!st.value || !en.value) throw new Error(`${label}요일 시간을 입력하세요.`);
        if (st.value >= en.value) throw new Error(`${label}요일 끝나는 시간이 시작 시간보다 늦어야 합니다.`);
        slots.push({ weekday: Number(row.dataset.wd), start_time: st.value, end_time: en.value });
      }
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
    body.innerHTML = `
      <section class="card">
        <div class="card-head"><h2>비밀번호 재설정</h2></div>
        <form id="pw">
          <div class="grid2">
            <label class="field"><span>대상</span><select name="target"><option value="student">학생 (${esc(s.username)})</option>
              <option value="parent">학부모</option></select></label>
            <label class="field"><span>새 비밀번호</span><input type="text" name="password" required minlength="4"></label>
          </div>
          <div class="row end"><button class="btn primary" type="submit">변경</button></div>
        </form>
      </section>
      <section class="card">
        <div class="card-head"><h2>학생 삭제</h2></div>
        <p class="muted small" style="margin-top:0">학생, 연결된 학부모 계정, 진도·출석·코멘트·파일이 모두 삭제되며 되돌릴 수 없습니다.</p>
        <button class="btn danger" id="del-student">학생 삭제</button>
      </section>`;
    onSubmit(body.querySelector('#pw'), async (fd) => {
      await api(`/api/admin/students/${id}/password`, { method: 'POST', body: Object.fromEntries(fd) });
      toast('비밀번호가 변경되었습니다.');
      body.querySelector('#pw').reset();
    });
    body.querySelector('#del-student').onclick = async () => {
      if (!confirm(`${s.name} 학생을 삭제할까요? 되돌릴 수 없습니다.`)) return;
      await api(`/api/admin/students/${id}`, { method: 'DELETE' });
      toast('삭제되었습니다.');
      location.hash = '#/';
      refreshList();
    };
  }

  bindDeletes(body, reload);
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
              <span class="tt-time">${esc(r.start_time)}~${esc(r.end_time)}</span>
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
    if (state.me.role === 'admin') return await renderAdmin();
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
  if (state.me && state.me.role === 'admin' && document.querySelector('.admin')) {
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
