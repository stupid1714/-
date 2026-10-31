'use strict';

// ---------- 수업 진도 PDF (월간 기록지 · 상세 학습 리포트) ----------
// 리포트를 A4 크기 페이지로 나눠 그린 뒤, 페이지마다 이미지로 바꿔 PDF로 저장합니다.
// (한글 글꼴이 깨지지 않도록 화면에 보이는 그대로 저장하는 방식)

const RP_W = 794;   // A4 너비 (96dpi 기준 px)
const RP_H = 1122;  // A4 높이
const RP_PAD = 44;  // 페이지 여백
const RP_FOOT = 28; // 쪽 번호 영역

let pdfLibPromise = null;
function loadPdfLib() {
  if (window.html2pdf) return Promise.resolve();
  if (!pdfLibPromise) {
    pdfLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/html2pdf.bundle.min.js';
      s.onload = resolve;
      s.onerror = () => { pdfLibPromise = null; reject(new Error('PDF 만들기 도구를 불러오지 못했습니다. 서버가 켜져 있는지 확인해 주세요.')); };
      document.head.appendChild(s);
    });
  }
  return pdfLibPromise;
}

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const REPORT_PARTS = [
  ['curriculum', '과목 진도 (단계별 완료)'],
  ['logs', '진도 기록'],
  ['photos', '진도 기록 사진'],
  ['comments', '선생님 코멘트'],
  ['attendance', '출석'],
  ['assignment', '과제'],
];

function thisMonth() { return today().slice(0, 7); }

function openReportModal(studentId) {
  const staff = isStaff(state.me);
  const parts = staff ? [...REPORT_PARTS, ['memo', '선생님 메모 (학생·학부모에게 보이지 않는 메모)']] : REPORT_PARTS;
  const canShareFiles = (() => {
    try { return Boolean(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] })); } catch { return false; }
  })();
  modal(`
    <form id="rp-form">
      <h2>📄 수업 진도 PDF</h2>
      <div class="seg rp-kind">
        <button type="button" data-kind="sheet" class="on">월간 수업 진도 기록지</button>
        <button type="button" data-kind="report">상세 학습 리포트</button>
      </div>
      <div id="rp-sheet">
        <label class="field"><span>달</span><input type="month" name="month" value="${thisMonth()}" required style="max-width:220px"></label>
        <label class="field"><span>특이사항 · 종합 코멘트 <small class="muted">(그 달의 선생님 코멘트가 자동으로 들어갑니다. 고쳐 써도 됩니다)</small></span>
          <textarea name="note" rows="4" placeholder="이번 달 학습 태도, 성취한 점, 보완할 점, 학부모 안내사항"></textarea></label>
        <p class="muted small" style="margin:0 0 12px">A4 한 장에 그 달의 수업(날짜·과목·수업 내용·이해도)이 들어갑니다. 수업 내용은 <b>진도 기록</b>에서, 완료한 단계는 <b>과목 진도</b>에서 가져옵니다.</p>
      </div>
      <div id="rp-report" hidden>
        <label class="field"><span>기간</span>
          <select name="period">
            <option value="1">최근 1개월</option><option value="3">최근 3개월</option><option value="6">최근 6개월</option>
            <option value="all">전체</option><option value="custom">직접 지정</option>
          </select></label>
        <div class="grid2" id="rp-custom" hidden>
          <label class="field"><span>시작일</span><input type="date" name="from" value="${monthsAgo(1)}"></label>
          <label class="field"><span>종료일</span><input type="date" name="to" value="${today()}"></label>
        </div>
        <div class="field"><span>넣을 내용</span>
          <div class="rp-checks">${parts.map(([k, l]) => `<label class="rp-check"><input type="checkbox" name="${k}" checked> ${l}</label>`).join('')}</div>
        </div>
        ${staff ? '<p class="muted small" style="margin:0 0 12px">학부모님께 보낼 PDF라면 <b>선생님 메모</b> 체크를 빼 주세요.</p>' : ''}
      </div>
      <div class="row end">
        <button type="button" class="btn" data-close>닫기</button>
        ${canShareFiles ? '<button type="button" class="btn" id="rp-share">📤 공유하기</button>' : ''}
        <button type="submit" class="btn primary">PDF 다운로드</button>
      </div>
      ${canShareFiles ? '' : '<p class="muted small" style="margin:10px 0 0">💡 휴대폰에서 https 주소(인터넷주소만들기)로 접속하면 <b>공유하기</b> 버튼으로 카카오톡 등에 바로 보낼 수 있습니다. 지금은 PDF를 내려받은 뒤 보내 주세요.</p>'}
    </form>`, (bg, close) => {
    const form = bg.querySelector('#rp-form');
    let kind = 'sheet';
    let prepared = null; // 공유 버튼: 만들어 둔 PDF (처음 공유가 막히면 한 번 더 눌러 공유)
    const noteBox = form.querySelector('[name=note]');
    let noteTouched = false;
    noteBox.addEventListener('input', () => { noteTouched = true; });
    const fillNote = async () => {
      if (noteTouched) return;
      const m = form.querySelector('[name=month]').value;
      const d = await api(`/api/students/${studentId}`).catch(() => null);
      if (!d || noteTouched) return;
      noteBox.value = d.comments.filter((c) => String(c.created_at).slice(0, 7) === m).reverse().map((c) => c.content).join('\n');
    };
    fillNote();
    form.querySelector('[name=month]').onchange = () => { prepared = null; noteTouched = false; fillNote(); };
    form.querySelectorAll('[data-kind]').forEach((b) => {
      b.onclick = () => {
        kind = b.dataset.kind;
        prepared = null;
        form.querySelectorAll('[data-kind]').forEach((x) => x.classList.toggle('on', x === b));
        form.querySelector('#rp-sheet').hidden = kind !== 'sheet';
        form.querySelector('#rp-report').hidden = kind !== 'report';
      };
    });
    form.addEventListener('input', (e) => { if (e.target !== noteBox) prepared = null; });
    noteBox.addEventListener('input', () => { prepared = null; });
    const period = form.querySelector('[name=period]');
    period.onchange = () => { form.querySelector('#rp-custom').hidden = period.value !== 'custom'; prepared = null; };

    const build = async (onStatus) => {
      if (kind === 'sheet') {
        const month = form.querySelector('[name=month]').value;
        if (!month) throw new Error('달을 고르세요.');
        return buildMonthlySheet(studentId, month, noteBox.value, onStatus);
      }
      const opts = {};
      parts.forEach(([k]) => { opts[k] = form.querySelector(`[name=${k}]`).checked; });
      if (period.value === 'custom') {
        opts.from = form.querySelector('[name=from]').value;
        opts.to = form.querySelector('[name=to]').value;
        if (opts.from && opts.to && opts.from > opts.to) throw new Error('시작일이 종료일보다 늦습니다.');
      } else if (period.value !== 'all') {
        opts.from = monthsAgo(Number(period.value));
        opts.to = today();
      }
      return buildReport(studentId, opts, onStatus);
    };
    const run = async (btn, label, finish) => {
      btn.disabled = true;
      try {
        await finish(btn);
      } catch (err) {
        if (err && err.name === 'AbortError') { /* 공유 창을 닫음 */ } else toast(err.message || String(err), true);
      } finally {
        btn.disabled = false;
        if (btn.dataset.keep !== '1') btn.textContent = label;
      }
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      run(btn, 'PDF 다운로드', async () => {
        const r = await build((msg) => { btn.textContent = msg; });
        savePdf(r.blob, r.name);
        toast('PDF를 저장했습니다.');
      });
    });
    const shareBtn = form.querySelector('#rp-share');
    if (shareBtn) {
      shareBtn.onclick = () => run(shareBtn, '📤 공유하기', async () => {
        shareBtn.dataset.keep = '';
        if (!prepared) prepared = await build((msg) => { shareBtn.textContent = msg; });
        const file = new File([prepared.blob], prepared.name, { type: 'application/pdf' });
        try {
          await navigator.share({ files: [file], title: prepared.name.replace(/\.pdf$/, '') });
        } catch (err) {
          // PDF를 만드는 동안 시간이 지나 공유가 막힌 경우: 한 번 더 누르면 바로 공유
          if (err && err.name === 'NotAllowedError') {
            shareBtn.dataset.keep = '1';
            shareBtn.textContent = '📤 준비 완료 · 눌러서 공유';
            return;
          }
          throw err;
        }
      });
    }
  });
}

function savePdf(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function safeFileName(name) { return name.replace(/[\\/:*?"<>|]/g, '_'); }

// 페이지 요소들을 PDF로 (페이지마다 이미지로 바꿔 A4에 붙임)
async function pagesToPdf(pageEls, onStatus, fitOnePage = false) {
  const opt = { margin: 0, image: { type: 'jpeg', quality: 0.9 }, html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' } };
  let pdf = null;
  for (let i = 0; i < pageEls.length; i += 1) {
    onStatus(`PDF 만드는 중... (${i + 1}/${pageEls.length}쪽)`);
    const canvas = await window.html2pdf().set(opt).from(pageEls[i]).toCanvas().get('canvas');
    if (!pdf) pdf = await window.html2pdf().set(opt).from(document.createElement('div')).toPdf().get('pdf').then((p) => { p.deletePage(1); return p; });
    addCanvasPages(pdf, canvas, fitOnePage);
  }
  return pdf.output('blob');
}

// ----- 월간 수업 진도 기록지 (A4 한 장) -----

const SHEET_ROWS = 8; // 주 2회 × 4주

async function buildMonthlySheet(studentId, month, note, onStatus) {
  onStatus('불러오는 중...');
  await loadPdfLib();
  const [d, sp, settings] = await Promise.all([
    api(`/api/students/${studentId}?full=1`),
    api(`/api/students/${studentId}/subjects`).catch(() => null),
    api('/api/settings').catch(() => ({})),
  ]);
  const s = d.student;
  const inMonth = (date) => String(date || '').slice(0, 7) === month;
  // 수업한 날: 진도 기록 + 출석 + 단계 완료한 날
  const days = new Map();
  const day = (date) => {
    if (!days.has(date)) days.set(date, { date, subjects: new Set(), contents: [], stages: [], understanding: '', att: '' });
    return days.get(date);
  };
  [...d.logs].reverse().filter((l) => inMonth(l.date)).forEach((l) => {
    const x = day(l.date);
    (l.subjects || []).forEach((sj) => x.subjects.add(sj));
    if (l.content) x.contents.push(l.content);
    if (l.understanding) x.understanding = l.understanding;
  });
  (sp ? sp.subjects : []).forEach((sub) => sub.stages.forEach((st) => {
    if (st.done_date && inMonth(st.done_date)) {
      const x = day(st.done_date);
      x.subjects.add(sub.subject);
      x.stages.push(`${sub.subject} ${st.no}단계 · ${st.name}`);
    }
  }));
  d.attendance.filter((a) => inMonth(a.date)).forEach((a) => {
    const x = day(a.date);
    if (a.status !== 'present') x.att = ATT_LABEL[a.status] + (a.note ? ` (${a.note})` : '');
  });
  const sessions = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const subjectCols = sp && sp.subjects.length ? sp.subjects.map((x) => x.subject) : [...DEFAULT_LOG_SUBJECTS];
  sessions.forEach((x) => x.subjects.forEach((sj) => { if (!subjectCols.includes(sj)) subjectCols.push(sj); }));
  const rows = [...sessions];
  while (rows.length < SHEET_ROWS) rows.push(null);

  const [y, m] = month.split('-').map(Number);
  const academy = settings.academy_name || '';
  const phone = settings.academy_phone || '';
  const box = (on) => `<span class="sh-box ${on ? 'on' : ''}">${on ? '✓' : ''}</span>`;
  const html = `
    <div class="sh-head">
      <div><div class="sh-title">수업 진도 기록지</div>
        <div class="sh-sub">${esc(subjectCols.length ? `${s.course || subjectCols.join(' · ')}` : '')} 월간 학습 기록 &nbsp;|&nbsp; 주 ${WEEKLY_SESSIONS}회</div></div>
      <div class="sh-academy">${academy ? `<span class="sh-badge">${esc(academy)}</span>` : ''}${phone ? `<div class="sh-phone">${esc(phone)}</div>` : ''}</div>
    </div>
    <div class="sh-info">
      <div><b>학생명</b><span>${esc(s.name)}</span></div>
      <div><b>과정·반</b><span>${esc(s.course || '-')}</span></div>
      <div><b>기간</b><span>${y}년 ${m}월</span></div>
      <div><b>담당 강사</b><span>${esc(s.teacher_name || '')}</span></div>
    </div>
    <table class="sh-table">
      <thead><tr><th style="width:44px">주차</th><th style="width:66px">회차·날짜</th><th style="width:${subjectCols.length > 4 ? 150 : 130}px">과목</th><th>수업 내용 및 진도</th><th style="width:76px">이해도</th></tr></thead>
      <tbody>${rows.map((x, i) => {
        const dt = x ? new Date(`${x.date}T00:00:00`) : null;
        return `<tr>
          <td class="sh-week">${Math.floor(i / WEEKLY_SESSIONS) + 1}주</td>
          <td class="sh-date"><b>${i + 1}회</b><span>${dt ? `${dt.getMonth() + 1}/${dt.getDate()} (${DAY_LABEL[dt.getDay()]})` : '월/일'}</span></td>
          <td class="sh-subj">${subjectCols.map((sj) => `<span class="sh-opt">${box(x && x.subjects.has(sj))}${esc(sj)}</span>`).join('')}</td>
          <td class="sh-content">${x ? `${x.att ? `<span class="sh-att">${esc(x.att)}</span> ` : ''}${esc(x.contents.join('\n'))}${x.stages.length ? `<div class="sh-stages">✔ ${x.stages.map(esc).join('<br>✔ ')}</div>` : ''}` : ''}</td>
          <td class="sh-und">${x ? esc(x.understanding) : ''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>
    <div class="sh-note"><div class="sh-note-h">특이사항 · 종합 코멘트</div><div class="sh-note-b">${esc(note || '')}</div></div>
    <div class="sh-sign"><span>담당 강사 <i>${esc(s.teacher_name || '')}</i> (인)</span><span>학부모 확인 <i></i> (인)</span></div>
    <div class="sh-foot">${esc(academy)}${academy && phone ? ' · ' : ''}${esc(phone)}</div>`;

  const host = document.createElement('div');
  host.className = 'rp-host';
  document.body.appendChild(host);
  try {
    const page = document.createElement('div');
    page.className = 'rp-page sh-page';
    page.innerHTML = html;
    host.appendChild(page);
    const blob = await pagesToPdf([page], onStatus, true);
    return { blob, name: safeFileName(`${s.name}_수업진도기록지_${y}년${m}월.pdf`) };
  } finally {
    host.remove();
  }
}

// ----- 리포트 내용 (블록 단위: 블록은 페이지 사이에서 잘리지 않음) -----

function rpHeading(title, sub = '') {
  return { html: `<h2 class="rp-h2">${title}${sub ? ` <span>${sub}</span>` : ''}</h2>`, keepNext: true };
}

function reportBlocks(d, cur, opts) {
  const s = d.student;
  const inRange = (date) => {
    const x = String(date || '').slice(0, 10);
    return (!opts.from || x >= opts.from) && (!opts.to || x <= opts.to);
  };
  const periodText = opts.from ? `${opts.from} ~ ${opts.to || today()}` : `전체 (~ ${opts.to || today()})`;
  const blocks = [];

  blocks.push({ html: `
    <div class="rp-head">
      <div class="rp-kicker">학습 리포트</div>
      <div class="rp-name">${esc(s.name)}</div>
      <div class="rp-meta">
        <span>과정 <b>${esc(s.course) || '-'}</b></span>
        <span>담당 <b>${esc(s.teacher_name || '-')}</b></span>
        <span>기간 <b>${esc(periodText)}</b></span>
        <span>작성일 <b>${today()}</b></span>
      </div>
    </div>` });

  const att = d.attendance.filter((a) => inRange(a.date));
  const attSum = { present: 0, late: 0, absent: 0, excused: 0 };
  att.forEach((a) => { attSum[a.status] += 1; });
  const pct = Number(s.progress_percent) || 0;
  blocks.push({ html: `
    <div class="rp-summary">
      <div class="rp-box rp-pct"><div class="rp-label">진도율 (오늘 기준)</div><div class="rp-big">${pct}%</div>
        <div class="rp-bar"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div></div>
      <div class="rp-box"><div class="rp-label">현재 진도</div><div class="rp-val">${esc(s.current_lesson) || '-'}</div>
        <div class="rp-label" style="margin-top:8px">다음 진도</div><div class="rp-val">${esc(s.next_lesson) || '-'}</div></div>
      <div class="rp-box"><div class="rp-label">수업 시간</div><div class="rp-val">${esc(scheduleText(d.schedule)) || '-'}</div>
        <div class="rp-label" style="margin-top:8px">기간 출석</div>
        <div class="rp-val">${Object.keys(ATT_LABEL).map((k) => `${ATT_LABEL[k]} ${attSum[k]}`).join(' · ')}</div></div>
    </div>` });

  if (opts.assignment && s.assignment) {
    blocks.push(rpHeading('과제', s.assignment_due ? `마감 ${esc(s.assignment_due)}` : ''));
    blocks.push({ html: `<div class="rp-text">${esc(s.assignment)}</div>` });
  }

  if (opts.memo && s.memo) {
    blocks.push(rpHeading('선생님 메모', '내부용 · 학생·학부모 화면에는 보이지 않음'));
    blocks.push({ html: `<div class="rp-text rp-memo">${esc(s.memo)}</div>` });
  }

  if (opts.curriculum && cur && cur.subjects.length) {
    blocks.push(rpHeading('과목 진도', '굵은 글씨 = 이 기간에 완료한 단계'));
    cur.subjects.forEach((sub) => {
      const p = pctOf(sub.done, sub.total);
      const inPeriod = sub.stages.filter((st) => st.done_date && inRange(st.done_date)).length;
      blocks.push({ keepNext: true, html: `
        <div class="rp-course">
          <div class="rp-course-head"><b>${esc(sub.subject)}</b><span>${sub.done} / ${sub.total}단계 완료 · ${p}%</span></div>
          <div class="rp-bar"><i style="width:${p}%"></i></div>
          <div class="rp-chapters">${bandsOf(sub.stages).map((band) => {
            const list = sub.stages.filter((st) => st.band === band);
            const done = list.filter((st) => st.done_date).length;
            return `<div class="${done === list.length ? 'full' : done ? 'part' : ''}"><span>${band}</span><em>${done}/${list.length}단계</em></div>`;
          }).join('')}<div class="part"><span>이 기간에 완료</span><em>${inPeriod}단계</em></div></div>
        </div>` });
      sub.stages.forEach((st) => {
        const isNext = Boolean(cur.next_stage && cur.next_stage.subject === sub.subject && cur.next_stage.no === st.no);
        blocks.push({ tight: true, html: `
          <div class="rp-row rp-stage ${st.done_date ? 'done' : ''} ${st.done_date && inRange(st.done_date) ? 'in' : ''}">
            <span class="rp-mark">${st.done_date ? '✓' : '○'}</span><span class="rp-no">${st.no}단계</span>
            <span class="rp-item">${esc(st.name)}${isNext ? ' <b class="rp-next">다음</b>' : ''}</span>
            <span class="rp-band">${esc(st.band)}</span><span class="rp-date">${esc(st.done_date || '')}</span></div>` });
      });
    });
  }

  if (opts.logs) {
    const logs = d.logs.filter((l) => inRange(l.date)).reverse();
    blocks.push(rpHeading('진도 기록', `${logs.length}건`));
    if (!logs.length) blocks.push({ html: '<div class="rp-empty">이 기간의 진도 기록이 없습니다.</div>' });
    logs.forEach((l) => {
      const photos = opts.photos ? l.photos || [] : [];
      blocks.push({ html: `
        <div class="rp-log">
          <div class="rp-log-date">${esc(l.date)}</div>
          ${l.content ? `<div class="rp-text">${esc(l.content)}</div>` : ''}
          ${photos.length ? `<div class="rp-photos">${photos.map((ph) => `<div class="rp-ph" style="background-image:url('/api/photos/${ph.id}')"></div>`).join('')}</div>` : ''}
        </div>` });
    });
  }

  if (opts.comments) {
    const comments = d.comments.filter((c) => inRange(c.created_at)).reverse();
    blocks.push(rpHeading('선생님 코멘트', `${comments.length}건`));
    if (!comments.length) blocks.push({ html: '<div class="rp-empty">이 기간의 코멘트가 없습니다.</div>' });
    comments.forEach((c) => {
      blocks.push({ html: `
        <div class="rp-comment"><div class="rp-comment-meta">${esc(fmtDate(c.created_at))} · ${esc(c.author || '선생님')}</div>
          <div class="rp-text">${esc(c.content)}</div></div>` });
    });
  }

  if (opts.attendance) {
    blocks.push(rpHeading('출석', `${att.length}회 기록`));
    if (!att.length) blocks.push({ html: '<div class="rp-empty">이 기간의 출석 기록이 없습니다.</div>' });
    [...att].reverse().forEach((a) => {
      blocks.push({ tight: true, html: `
        <div class="rp-row"><span class="rp-date">${esc(a.date)}</span>
          <span class="rp-att ${a.status}">${ATT_LABEL[a.status]}</span><span class="rp-item">${esc(a.note || '')}</span></div>` });
    });
  }
  return blocks;
}

// ----- 페이지 나누기 + PDF 저장 -----

// 사진을 미리 받아 둠 (PDF 이미지로 바꿀 때 빈 칸이 되지 않도록)
function waitImages(root) {
  const urls = [...root.querySelectorAll('.rp-ph')].map((el) => (/url\(["']?([^"')]+)/.exec(el.style.backgroundImage) || [])[1]).filter(Boolean);
  return Promise.all(urls.map((src) => new Promise((r) => {
    const img = new Image();
    img.onload = r;
    img.onerror = r;
    img.src = src;
  })));
}

function layoutPages(blocks, host) {
  const inner = RP_H - RP_PAD * 2 - RP_FOOT;
  const measure = document.createElement('div');
  measure.className = 'rp-page';
  measure.style.minHeight = '0';
  host.appendChild(measure);
  const els = blocks.map((b) => {
    const el = document.createElement('div');
    el.className = b.tight ? 'rp-block tight' : 'rp-block';
    el.innerHTML = b.html;
    measure.appendChild(el);
    return el;
  });
  const heights = els.map((el) => el.getBoundingClientRect().height);
  measure.remove();

  const pages = [[]];
  let used = 0;
  blocks.forEach((b, i) => {
    let need = heights[i];
    if (b.keepNext && i + 1 < blocks.length) need += heights[i + 1];
    if (need > inner) need = heights[i];
    if (used > 0 && used + need > inner) { pages.push([]); used = 0; }
    pages[pages.length - 1].push(els[i]);
    used += heights[i];
  });
  return pages.filter((p) => p.length);
}

async function buildReport(studentId, opts, onStatus) {
  onStatus('불러오는 중...');
  await loadPdfLib();
  const [d, cur] = await Promise.all([
    api(`/api/students/${studentId}?full=1`),
    opts.curriculum ? api(`/api/students/${studentId}/subjects`).catch(() => null) : null,
  ]);
  const host = document.createElement('div');
  host.className = 'rp-host';
  document.body.appendChild(host);
  try {
    const pageGroups = layoutPages(reportBlocks(d, cur, opts), host);
    const pageEls = pageGroups.map((group, i) => {
      const page = document.createElement('div');
      page.className = 'rp-page';
      group.forEach((el) => page.appendChild(el));
      const foot = document.createElement('div');
      foot.className = 'rp-foot';
      foot.textContent = `${d.student.name} · 학습 리포트 · ${i + 1} / ${pageGroups.length}`;
      page.appendChild(foot);
      host.appendChild(page);
      return page;
    });
    await waitImages(host);

    const blob = await pagesToPdf(pageEls, onStatus);
    const name = `${d.student.name}_학습리포트_${opts.from ? `${opts.from}~${opts.to}` : `전체_${today()}`}.pdf`;
    return { blob, name: safeFileName(name) };
  } finally {
    host.remove();
  }
}

// 캔버스를 A4 페이지에 붙임 (한 페이지보다 길면 여러 장으로 나눔)
//  fitOnePage: 한 장보다 조금(30% 이내) 길면 잘라 넘기지 않고 줄여서 한 장에 넣음
function addCanvasPages(pdf, canvas, fitOnePage = false) {
  const pageH = Math.round(canvas.width * (297 / 210));
  if (fitOnePage && canvas.height > pageH && canvas.height <= pageH * 1.3) {
    const k = pageH / canvas.height;
    pdf.addPage('a4', 'portrait');
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', (210 - 210 * k) / 2, 0, 210 * k, 297);
    return;
  }
  for (let y = 0; y < canvas.height; y += pageH) {
    const h = Math.min(pageH, canvas.height - y);
    if (y > 0 && h < canvas.width * 0.02) break; // 반올림으로 생긴 아주 얇은 나머지는 버림
    const part = document.createElement('canvas');
    part.width = canvas.width;
    part.height = h;
    const ctx = part.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, part.width, part.height);
    ctx.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
    pdf.addPage('a4', 'portrait');
    pdf.addImage(part.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, 210, (h / canvas.width) * 210);
  }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-report]');
  if (btn) openReportModal(Number(btn.dataset.report));
});
