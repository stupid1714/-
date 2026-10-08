'use strict';

// ---------- 학습 리포트 PDF ----------
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
  ['curriculum', '교재 진도 (체크한 항목)'],
  ['logs', '진도 기록'],
  ['photos', '진도 기록 사진'],
  ['comments', '선생님 코멘트'],
  ['attendance', '출석'],
  ['assignment', '과제'],
];

function openReportModal(studentId) {
  const staff = isStaff(state.me);
  const parts = staff ? [...REPORT_PARTS, ['memo', '선생님 메모 (학생·학부모에게 보이지 않는 메모)']] : REPORT_PARTS;
  modal(`
    <form id="rp-form">
      <h2>📄 학습 리포트 PDF</h2>
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
      <div class="row end"><button type="button" class="btn" data-close>취소</button><button type="submit" class="btn primary">PDF 다운로드</button></div>
    </form>`, (bg, close) => {
    const form = bg.querySelector('#rp-form');
    const period = form.querySelector('[name=period]');
    period.onchange = () => { form.querySelector('#rp-custom').hidden = period.value !== 'custom'; };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      const opts = {};
      parts.forEach(([k]) => { opts[k] = form.querySelector(`[name=${k}]`).checked; });
      if (period.value === 'custom') {
        opts.from = form.querySelector('[name=from]').value;
        opts.to = form.querySelector('[name=to]').value;
        if (opts.from && opts.to && opts.from > opts.to) { toast('시작일이 종료일보다 늦습니다.', true); return; }
      } else if (period.value !== 'all') {
        opts.from = monthsAgo(Number(period.value));
        opts.to = today();
      }
      btn.disabled = true;
      try {
        await downloadReport(studentId, opts, (msg) => { btn.textContent = msg; });
        toast('PDF를 저장했습니다.');
        close();
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
        btn.textContent = 'PDF 다운로드';
      }
    });
  });
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

  if (opts.curriculum && cur && cur.courses.length) {
    blocks.push(rpHeading('교재 진도'));
    cur.courses.forEach((c) => {
      const chapters = groupChapters(c.items);
      blocks.push({ keepNext: true, html: `
        <div class="rp-course">
          <div class="rp-course-head"><b>${esc(c.name)}</b><span>${c.done} / ${c.total} 완료 · ${pctOf(c.done, c.total)}%</span></div>
          <div class="rp-bar"><i style="width:${pctOf(c.done, c.total)}%"></i></div>
          <div class="rp-chapters">${chapters.map((ch) => {
            const done = ch.items.filter((it) => it.done_date).length;
            return `<div class="${done === ch.items.length ? 'full' : done ? 'part' : ''}"><span>${esc(ch.chapter)}</span><em>${done}/${ch.items.length}</em></div>`;
          }).join('')}</div>
        </div>` });
      const doneItems = c.items.filter((it) => it.done_date && inRange(it.done_date))
        .sort((a, b) => (a.done_date < b.done_date ? -1 : a.done_date > b.done_date ? 1 : a.seq - b.seq));
      if (!doneItems.length) {
        blocks.push({ html: '<div class="rp-empty">이 기간에 체크한 항목이 없습니다.</div>' });
        return;
      }
      blocks.push({ keepNext: true, html: `<div class="rp-sub">이 기간에 완료한 항목 (${doneItems.length}개)</div>` });
      doneItems.forEach((it) => {
        const code = itemCode(it);
        blocks.push({ tight: true, html: `
          <div class="rp-row"><span class="rp-date">${esc(it.done_date)}</span><span class="rp-ch">${esc(it.chapter)}</span>
            <span class="rp-item">${code ? `<b>${esc(code)}</b> ` : ''}${esc(it.title)}</span></div>` });
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

async function downloadReport(studentId, opts, onStatus) {
  onStatus('불러오는 중...');
  await loadPdfLib();
  const [d, cur] = await Promise.all([
    api(`/api/students/${studentId}?full=1`),
    opts.curriculum ? api(`/api/students/${studentId}/curriculum`).catch(() => null) : null,
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

    const opt = { margin: 0, image: { type: 'jpeg', quality: 0.9 }, html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' } };
    let pdf = null;
    for (let i = 0; i < pageEls.length; i += 1) {
      onStatus(`PDF 만드는 중... (${i + 1}/${pageEls.length}쪽)`);
      const canvas = await window.html2pdf().set(opt).from(pageEls[i]).toCanvas().get('canvas');
      if (!pdf) pdf = await window.html2pdf().set(opt).from(document.createElement('div')).toPdf().get('pdf').then((p) => { p.deletePage(1); return p; });
      addCanvasPages(pdf, canvas);
    }
    const name = `${d.student.name}_학습리포트_${opts.from ? `${opts.from}~${opts.to}` : `전체_${today()}`}.pdf`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(pdf.output('blob'));
    a.download = name.replace(/[\\/:*?"<>|]/g, '_');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  } finally {
    host.remove();
  }
}

// 캔버스를 A4 페이지에 붙임 (한 페이지보다 길면 여러 장으로 나눔)
function addCanvasPages(pdf, canvas) {
  const pageH = Math.round(canvas.width * (297 / 210));
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
