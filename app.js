/* app.js — UI ของแอปติดตามการผ่อนบ้าน */
(() => {
  'use strict';

  const E = window.LoanEngine;
  const BANK = window.BANK_SCHEDULE || {};
  const LS = { api: 'hl.api', cache: 'hl.cache', local: 'hl.local', tab: 'hl.tab' };
  const TABS = { dash: 'ภาพรวม', log: 'บันทึกการจ่าย', table: 'ตารางงวด', sim: 'จำลองการโปะ', settings: 'ตั้งค่า', slip: 'ทดลองอ่านสลิป' };
  const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const COLORS = { house: 'var(--brand)', mrta: '#7c3aed', decor: 'var(--accent)' };

  // ---------------- utils ----------------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage ปิดอยู่ */ } };
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const money = (x, dec = 2) => Number(x || 0).toLocaleString('th-TH', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const compact = (x) => (x >= 1e6 ? (x / 1e6).toFixed(x % 1e6 ? 1 : 0) + 'M' : x >= 1e3 ? Math.round(x / 1e3) + 'k' : String(Math.round(x)));
  const thaiDate = (iso) => { if (!iso) return '-'; const [y, m, d] = iso.split('-'); return `${d}/${m}/${Number(y) + 543}`; };
  const thaiDateLong = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${THAI_MONTHS[m - 1]} ${y + 543}`; };
  const thaiMonth = (iso) => { const [y, m] = iso.split('-').map(Number); return `${THAI_MONTHS[m - 1]} ${y + 543}`; };
  const weekday = (iso) => ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสฯ', 'ศุกร์', 'เสาร์'][new Date(E.parse(iso)).getUTCDay()];
  const ym = (months) => { const y = Math.floor(months / 12), m = months % 12; return [y ? `${y} ปี` : '', m ? `${m} เดือน` : ''].filter(Boolean).join(' ') || '0 เดือน'; };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, bad ? 5000 : 2500);
  }

  // ---------------- state ----------------
  const withDefaults = (s) => Object.assign(clone(window.DEFAULT_SETTINGS), s || {});
  const cache = lsGet(LS.cache, null);
  const local = lsGet(LS.local, { payments: [], settings: null });
  const state = {
    api: lsGet(LS.api, { url: '', pin: '' }),
    settings: null,
    payments: [],
    tab: lsGet(LS.tab, 'dash'),
    syncing: false,
    error: '',
    lastSync: null,
    ui: {
      chart: 'all', chartRange: 'plan',
      table: 'house', tableFilter: 'all',
      log: 'all',
      sim: { contract: 'house', amount: 5000, mode: 'monthly', start: null },
      draft: null,
    },
  };
  const remote = () => !!state.api.url;

  function applyData(settings, payments) {
    state.settings = withDefaults(settings);
    state.payments = (payments || []).map((p) => ({ ...p, amount: Number(p.amount), installment: p.installment === '' ? '' : Number(p.installment) }));
    state.ui.draft = null;
  }
  if (remote() && cache) applyData(cache.settings, cache.payments);
  else applyData(local.settings, local.payments);

  // ---------------- backend ----------------
  async function apiGet() {
    const u = new URL(state.api.url);
    u.searchParams.set('pin', state.api.pin);
    u.searchParams.set('_', Date.now());
    const r = await fetch(u);
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);
    return j;
  }
  async function apiPost(body) {
    // text/plain = ไม่มี CORS preflight (Apps Script ไม่รองรับ OPTIONS)
    const r = await fetch(state.api.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...body, pin: state.api.pin }) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);
    return j;
  }
  const saveLocal = () => { if (!remote()) lsSet(LS.local, { payments: state.payments, settings: state.settings }); else lsSet(LS.cache, { payments: state.payments, settings: state.settings, at: Date.now() }); };

  async function sync(silent) {
    if (!remote()) { setSync(); return; }
    state.syncing = true; setSync();
    try {
      const j = await apiGet();
      if (!j.settings) await apiPost({ action: 'saveSettings', settings: state.settings }); // ชีตใหม่ → ใส่ค่าเริ่มต้น
      applyData(j.settings || state.settings, j.payments);
      state.error = ''; state.lastSync = new Date();
      saveLocal();
      render();
    } catch (e) {
      state.error = navigator.onLine ? e.message : 'ออฟไลน์';
      if (!silent) toast('โหลดข้อมูลไม่สำเร็จ: ' + state.error, true);
    } finally {
      state.syncing = false; setSync();
    }
  }

  async function withBusy(fn, okMsg) {
    try { state.syncing = true; setSync(); await fn(); saveLocal(); render(); if (okMsg) toast(okMsg); return true; }
    catch (e) { toast('ไม่สำเร็จ: ' + e.message, true); return false; }
    finally { state.syncing = false; setSync(); }
  }

  const savePayments = (list) => withBusy(async () => {
    for (const p of list) {
      const rec = remote() ? (await apiPost({ action: 'savePayment', payment: p })).payment : { ...p, id: p.id || uuid(), updatedAt: new Date().toISOString() };
      rec.amount = Number(rec.amount);
      // สร้าง array ใหม่เสมอ — model() memo เทียบด้วย reference
      const i = state.payments.findIndex((x) => x.id === rec.id);
      state.payments = i >= 0 ? state.payments.map((x, j) => (j === i ? rec : x)) : [...state.payments, rec];
    }
  }, list.length > 1 ? `บันทึก ${list.length} รายการแล้ว` : 'บันทึกแล้ว');

  const deletePayments = (ids) => withBusy(async () => {
    for (const id of ids) {
      if (remote()) await apiPost({ action: 'deletePayment', id });
      state.payments = state.payments.filter((p) => p.id !== id);
    }
  }, 'ลบแล้ว');

  const saveSettings = (s) => withBusy(async () => {
    if (remote()) s = (await apiPost({ action: 'saveSettings', settings: s })).settings;
    state.settings = withDefaults(s);
    state.ui.draft = null;
  }, 'บันทึกการตั้งค่าแล้ว — คำนวณแผนใหม่แล้ว');

  function setSync() {
    const el = $('#syncStatus');
    const btn = $('#refreshBtn');
    btn.classList.toggle('spin', state.syncing);
    if (!remote()) { el.textContent = 'โหมดเครื่องนี้'; el.className = 'pill gray'; return; }
    if (state.syncing) { el.textContent = 'กำลังซิงก์…'; el.className = 'pill'; return; }
    if (state.error) { el.textContent = state.error === 'ออฟไลน์' ? 'ออฟไลน์' : 'ซิงก์ไม่ได้'; el.className = 'pill bad'; return; }
    el.textContent = state.lastSync ? 'ซิงก์แล้ว' : 'ข้อมูลในเครื่อง'; el.className = state.lastSync ? 'pill ok' : 'pill warn';
  }

  // ---------------- model ----------------
  /** ตารางธนาคาร (จาก xlsx) — แถวที่ไฟล์ไม่มีตัวเลขจะคำนวณเติมด้วยสูตรเดียวกับธนาคาร */
  function bankTable(S, c) {
    const src = BANK[c.id];
    if (!src || Number(c.principal) !== Number(src.rows.length && principalOf(src))) return null;
    let bal = Number(c.principal), last = S.startDate;
    return src.rows.map(([n, pay, prin, intr, balance]) => {
      const due = E.dueDate(S, n);
      let computed = false;
      if (balance == null) {
        intr = E.interestBetween(S, bal, last, due);
        pay = Math.min(pay, E.r2(bal + intr)); prin = E.r2(pay - intr); balance = Math.max(0, E.r2(bal - prin)); computed = true;
      }
      bal = balance; last = due;
      return { n, due, pay, principal: prin, interest: intr, balance, computed };
    });
  }
  const principalOf = (src) => { const r = src.rows[0]; return E.r2(r[4] + r[2]); };

  let memo = null;
  function model() {
    if (memo && memo.s === state.settings && memo.p === state.payments && memo.d === todayStr()) return memo.m;
    const S = state.settings, P = state.payments, today = todayStr();
    const contracts = S.contracts.map((c) => {
      const plan = E.project(S, c, E.initialState(S, c));
      const rp = E.replay(S, c, P);
      const proj = rp.balance > 0.005
        ? E.project(S, c, { n: rp.nextN, balance: rp.balance, lastDate: rp.lastDate })
        : { rows: [], totalInterest: 0, endN: rp.nextN - 1, endDate: rp.lastDate, stuck: false };
      const bank = bankTable(S, c);
      const lastN = Math.max(plan.endN, proj.endN, rp.nextN - 1);
      const rows = [];
      for (let n = 1; n <= lastN; n++) {
        const src = n < rp.nextN ? plan.rows[n - 1] : proj.rows[n - rp.nextN];
        const due = E.dueDate(S, n);
        const pay = src ? src.pay : E.amountFor(c, n);
        const st = E.installmentStatus(c, P, n, due, pay, today);
        rows.push({ n, due, pay, interest: src ? src.interest : 0, principal: src ? src.principal : 0, balance: src ? src.balance : 0, bankMin: bank && bank[n - 1] ? bank[n - 1].pay : null, projected: n >= rp.nextN, ...st });
      }
      const firstOpen = rows.find((r) => r.status !== 'paid');
      const paidCount = rows.filter((r) => r.status === 'paid').length;
      const planBalNow = rp.nextN > 1 && plan.rows[rp.nextN - 2] ? plan.rows[rp.nextN - 2].balance : Number(c.principal);
      return { c, plan, rp, proj, bank, rows, firstOpen: rp.balance > 0.005 ? firstOpen : null, paidCount, planBalNow };
    });
    const m = { S, contracts, today };
    memo = { s: state.settings, p: state.payments, d: today, m };
    return m;
  }
  const byId = (m, id) => m.contracts.find((x) => x.c.id === id);

  /** งวดที่ต้องจ่ายถัดไป (รวมทุกสัญญา) */
  function nextDue(m) {
    const open = m.contracts.filter((x) => x.firstOpen);
    if (!open.length) return null;
    const overdue = open.filter((x) => x.firstOpen.due < m.today);
    const date = open.reduce((a, x) => (x.firstOpen.due < a ? x.firstOpen.due : a), '9999');
    const items = open.filter((x) => x.firstOpen.due === date || x.firstOpen.due < m.today);
    const people = {};
    for (const x of items) {
      const r = x.firstOpen, seg = E.segmentFor(x.c, r.n), full = E.segAmount(seg), k = full ? (r.pay - r.paid) / full : 0;
      for (const [who, v] of Object.entries(seg.shares)) people[who] = (people[who] || 0) + Number(v) * k;
    }
    return { date, items, overdue: overdue.length > 0, people };
  }

  // ---------------- chart ----------------
  function lineChart({ series, xMax, yMax, marker, height = 210 }) {
    const W = 340, H = height, L = 38, R = 8, T = 10, B = 22;
    const x = (n) => L + (n / xMax) * (W - L - R);
    const y = (v) => T + (1 - v / yMax) * (H - T - B);
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const v = (yMax / 4) * i;
      g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 5}" y="${y(v) + 3}" text-anchor="end">${compact(v)}</text>`;
    }
    const years = xMax / 12, step = [1, 2, 5, 10, 20].find((s) => years / s <= 6) || 40;
    for (let yr = 0; yr * 12 <= xMax; yr += step) g += `<text x="${x(yr * 12)}" y="${H - 6}" text-anchor="middle">${yr ? 'ปี ' + yr : 'เริ่ม'}</text>`;
    if (marker != null) g += `<line x1="${x(marker)}" x2="${x(marker)}" y1="${T}" y2="${H - B}" stroke="var(--warn)" stroke-dasharray="3 3" stroke-width="1"/><text x="${x(marker)}" y="${T + 8}" text-anchor="middle" style="fill:var(--warn)">วันนี้</text>`;
    for (const s of series) {
      const pts = s.points.filter((p) => p[0] <= xMax);
      if (!pts.length) continue;
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
      g += `<path d="${d}" stroke="${s.color}" stroke-width="${s.width || 2}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} opacity="${s.opacity || 1}"/>`;
      if (s.dots) g += pts.map((p) => `<circle cx="${x(p[0])}" cy="${y(p[1])}" r="2.6" fill="${s.color}" stroke="none"/>`).join('');
    }
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="กราฟยอดคงเหลือ">${g}</svg>`;
  }

  /** ยอดคงเหลือจริงรายงวด (ค่าสุดท้ายในงวดนั้น) */
  function actualByN(x) {
    const out = new Map([[0, Number(x.c.principal)]]);
    for (const p of x.rp.points) out.set(p.n, p.balance);
    return out;
  }

  function balanceChart(m) {
    const sel = state.ui.chart;
    const list = sel === 'all' ? m.contracts : m.contracts.filter((x) => x.c.id === sel);
    const planEnd = Math.max(...list.map((x) => Math.max(x.plan.endN, x.proj.endN, x.rp.nextN)));
    const bankEnd = Math.max(...list.map((x) => (x.bank ? x.bank.length : 0)));
    const xMax = state.ui.chartRange === 'bank' ? Math.max(planEnd, bankEnd) : planEnd;
    const sumAt = (fn) => { const out = []; for (let n = 0; n <= xMax; n++) out.push([n, list.reduce((a, x) => a + fn(x, n), 0)]); return out; };
    const planBal = (x, n) => (n === 0 ? Number(x.c.principal) : x.plan.rows[n - 1] ? x.plan.rows[n - 1].balance : 0);
    const bankBal = (x, n) => (n === 0 ? Number(x.c.principal) : x.bank && x.bank[n - 1] ? x.bank[n - 1].balance : 0);
    const series = [];
    if (list.some((x) => x.bank)) series.push({ name: 'สัญญาเดิม (ตารางธนาคาร)', color: 'var(--plan)', dash: '5 4', points: sumAt(bankBal), width: 1.6 });
    series.push({ name: 'แผน', color: 'var(--brand)', points: sumAt(planBal), opacity: 0.35, width: 5 });
    // จริง: รวมทุกสัญญา ณ งวดที่มีบันทึก
    const maxActualN = Math.max(0, ...list.map((x) => (x.rp.points.length ? x.rp.points[x.rp.points.length - 1].n : 0)));
    if (maxActualN > 0) {
      const maps = list.map(actualByN);
      const pts = [];
      const last = maps.map(() => null);
      for (let n = 0; n <= maxActualN; n++) {
        let has = false;
        maps.forEach((mp, i) => { if (mp.has(n)) { last[i] = mp.get(n); has = true; } });
        if (has) pts.push([n, last.reduce((a, v, i) => a + (v == null ? Number(list[i].c.principal) : v), 0)]);
      }
      series.push({ name: 'จ่ายจริง', color: 'var(--accent)', points: pts, dots: true });
      const projPts = [[maxActualN, pts[pts.length - 1][1]]];
      for (let n = maxActualN + 1; n <= xMax; n++) {
        projPts.push([n, list.reduce((a, x) => { const r = x.proj.rows.find((r) => r.n === n); return a + (r ? r.balance : n < x.rp.nextN ? x.rp.balance : 0); }, 0)]);
      }
      series.push({ name: 'คาดการณ์จากยอดจริง', color: 'var(--accent)', dash: '2 3', points: projPts, width: 1.5 });
    }
    const yMax = Math.max(...series.flatMap((s) => s.points.map((p) => p[1]))) * 1.05 || 1;
    const curN = E.installmentAt(m.S, m.today) - 1;
    const svg = lineChart({ series, xMax, yMax, marker: curN > 0 ? curN : null });
    const legend = series.map((s) => `<span><i style="background:${s.color};opacity:${s.opacity || 1}"></i>${s.name}</span>`).join('');
    return { svg, legend };
  }

  // ---------------- views ----------------
  function viewDash() {
    const m = model();
    const nd = nextDue(m);
    let html = '';
    if (!remote()) html += `<div class="banner">ยังไม่ได้เชื่อม Google Sheets — ข้อมูลเก็บในเครื่องนี้เท่านั้น <a href="#" data-go="settings">ตั้งค่า</a></div>`;

    if (nd) {
      const days = E.daysBetween(m.today, nd.date);
      const countTxt = days > 0 ? `<div class="count num">${days}</div><div>วันก่อนถึงกำหนด</div>` : days === 0 ? `<div class="count">วันนี้</div><div>ครบกำหนดชำระ</div>` : `<div class="count num">${-days}</div><div>วันที่เลยกำหนด</div>`;
      html += `<section class="card next ${nd.overdue ? 'overdue' : ''}">
        <div class="row"><h2>งวดถัดไป</h2><span class="pill">${weekday(nd.date)} ${thaiDateLong(nd.date)}</span></div>
        <div class="row" style="align-items:flex-end;margin:6px 0 12px"><div>${countTxt}</div>
          <div class="right"><div class="small" style="opacity:.8">ยอดรวม</div><div class="mid num">${money(nd.items.reduce((a, x) => a + x.firstOpen.pay - x.firstOpen.paid, 0))}</div></div></div>
        ${nd.items.map((x) => `<div class="line"><span>${esc(x.c.name)} · งวด ${x.firstOpen.n}${x.firstOpen.due < m.today ? ' (เลยกำหนด)' : ''}</span><span class="num">${money(x.firstOpen.pay - x.firstOpen.paid)}</span></div>`).join('')}
        <div class="line"><span>แบ่งจ่าย</span><span>${Object.entries(nd.people).map(([k, v]) => `${esc(k)} <b class="num">${money(v)}</b>`).join(' · ')}</span></div>
        <button class="btn block" style="margin-top:10px;background:rgba(255,255,255,.95);color:#0f3b37" data-action="pay-next">บันทึกการจ่ายงวดนี้</button>
      </section>`;
    } else {
      html += `<section class="card next"><h2>ยินดีด้วย 🎉</h2><div class="mid">ปิดหนี้ครบทุกสัญญาแล้ว</div></section>`;
    }

    const totalP = m.contracts.reduce((a, x) => a + Number(x.c.principal), 0);
    const totalB = m.contracts.reduce((a, x) => a + x.rp.balance, 0);
    const interestPaid = m.contracts.reduce((a, x) => a + x.rp.interestPaid, 0);
    const interestLeft = m.contracts.reduce((a, x) => a + x.proj.totalInterest, 0);
    const endAll = m.contracts.reduce((a, x) => (x.proj.endDate > a ? x.proj.endDate : a), '');
    const endN = Math.max(...m.contracts.map((x) => x.proj.endN));
    html += `<section class="card">
      <h2>ยอดคงเหลือรวม ${m.contracts.length} สัญญา</h2>
      <div class="big num">${money(totalB)}</div>
      <div class="progress"><div style="width:${((1 - totalB / totalP) * 100).toFixed(2)}%"></div></div>
      <div class="row small muted"><span>ผ่อนไปแล้ว ${((1 - totalB / totalP) * 100).toFixed(2)}%</span><span>จาก ${money(totalP, 0)}</span></div>
      <div class="grid3" style="margin-top:12px">
        <div class="kpi"><div class="v num">${money(interestPaid, 0)}</div><div class="l">ดอกเบี้ยจ่ายแล้ว (ประมาณ)</div></div>
        <div class="kpi"><div class="v num">${money(interestLeft, 0)}</div><div class="l">ดอกเบี้ยคงเหลือตามแผน</div></div>
        <div class="kpi"><div class="v">งวด ${endN}</div><div class="l">จบประมาณ ${thaiMonth(endAll || m.today)}</div></div>
      </div>
    </section>`;

    html += `<section class="card"><h2>แต่ละสัญญา</h2>${m.contracts.map((x) => {
      const pct = (1 - x.rp.balance / x.c.principal) * 100;
      const ahead = x.planBalNow - x.rp.balance;
      const lastBank = [...x.rp.points].reverse().find((p) => p.bank);
      return `<div class="contract">
        <div class="row"><b>${esc(x.c.name)}</b><span class="pill gray">${esc(x.c.owner)}</span></div>
        <div class="row" style="margin-top:4px"><span class="mid num">${money(x.rp.balance)}</span><span class="muted small">จาก ${money(x.c.principal, 0)}</span></div>
        <div class="progress"><div style="width:${pct.toFixed(2)}%;background:${COLORS[x.c.id] || 'var(--brand)'}"></div></div>
        <div class="row small muted wrap">
          <span>${pct.toFixed(2)}% · จ่ายแล้ว ${x.paidCount}/${x.rows.length} งวด</span>
          <span>${x.rp.balance > 0.005 ? `จบงวด ${x.proj.endN} (${thaiMonth(x.proj.endDate)})` : 'ปิดแล้ว ✓'}</span>
        </div>
        ${x.rp.count ? `<div class="small" style="margin-top:4px">${Math.abs(ahead) < 1 ? '<span class="pill">ตรงแผน</span>' : ahead > 0 ? `<span class="pill ok">เร็วกว่าแผน ${money(ahead, 0)}</span>` : `<span class="pill warn">ช้ากว่าแผน ${money(-ahead, 0)}</span>`}
          ${lastBank ? `<span class="muted"> · ยอดธนาคารล่าสุด ${thaiDate(lastBank.date)}</span>` : '<span class="muted"> · ยังไม่มียอดจากธนาคาร (คำนวณเอง)</span>'}</div>` : ''}
      </div>`;
    }).join('')}</section>`;

    const ch = balanceChart(m);
    html += `<section class="card">
      <div class="row"><h2>แผน vs จริง</h2></div>
      <div class="seg" style="margin-bottom:8px">${[['all', 'รวม'], ...m.contracts.map((x) => [x.c.id, x.c.name])].map(([k, v]) => `<button data-chart="${k}" class="${state.ui.chart === k ? 'on' : ''}">${esc(v)}</button>`).join('')}</div>
      ${ch.svg}
      <div class="legend">${ch.legend}</div>
      <div class="row" style="margin-top:8px"><span class="small muted">ช่วงแกน</span>
        <div class="seg" style="flex:0 0 auto">${[['plan', 'ตามแผน'], ['bank', 'ถึงสิ้นสัญญาเดิม']].map(([k, v]) => `<button data-range="${k}" class="${state.ui.chartRange === k ? 'on' : ''}">${v}</button>`).join('')}</div></div>
    </section>`;
    return html;
  }

  function viewLog() {
    const m = model();
    const f = state.ui.log;
    const list = state.payments.filter((p) => f === 'all' || p.contract === f || p.payer === f)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.updatedAt || '').localeCompare(a.updatedAt || '')));
    const byPerson = {};
    for (const p of state.payments) byPerson[p.payer] = (byPerson[p.payer] || 0) + Number(p.amount);
    const name = (id) => (m.contracts.find((x) => x.c.id === id) || { c: { name: id } }).c.name;
    let html = `<button class="btn block" data-action="pay-new" style="margin-bottom:14px">+ บันทึกการจ่าย</button>`;
    html += `<section class="card"><h2>จ่ายแล้วทั้งหมด</h2><div class="grid2">${Object.keys(byPerson).length ? Object.entries(byPerson).map(([k, v]) => `<div class="kpi"><div class="v num">${money(v)}</div><div class="l">${esc(k)}</div></div>`).join('') : '<div class="muted small">ยังไม่มีรายการ</div>'}</div></section>`;
    const opts = [['all', 'ทั้งหมด'], ...m.contracts.map((x) => [x.c.id, x.c.name]), ...m.S.people.map((p) => [p, p])];
    html += `<select data-logfilter style="margin-bottom:6px">${opts.map(([k, v]) => `<option value="${esc(k)}" ${f === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
    if (!list.length) return html + `<div class="empty">ยังไม่มีการบันทึก</div>`;
    let month = '';
    html += list.map((p) => {
      const h = p.date.slice(0, 7) !== month ? `${month ? '</ul></section>' : ''}<div class="month-h">${thaiMonth(p.date)}</div><section class="card" style="padding:4px 14px"><ul class="list">` : '';
      month = p.date.slice(0, 7);
      return h + `<li data-edit="${esc(p.id)}" style="cursor:pointer">
        <div class="row"><b>${esc(name(p.contract))}</b><span class="num"><b>${money(p.amount)}</b></span></div>
        <div class="row small muted wrap"><span>${thaiDate(p.date)} · ${p.type === 'extra' ? '<span class="pill warn">โปะ</span>' : `งวด ${p.installment}`} · ${esc(p.payer)}</span>
          <span>${p.bankBalance !== '' && p.bankBalance != null ? `คงเหลือ ${money(p.bankBalance)}` : ''}</span></div>
        ${p.note ? `<div class="small">${esc(p.note)}</div>` : ''}
      </li>`;
    }).join('') + '</ul></section>';
    return html;
  }

  function viewTable() {
    const m = model();
    const x = byId(m, state.ui.table) || m.contracts[0];
    const f = state.ui.tableFilter;
    const cur = x.firstOpen ? x.firstOpen.n : null;
    const rows = x.rows.filter((r) => f === 'all' || (f === 'open' && r.status !== 'paid' && r.due <= addMonths(m.today, 1)) || (f === 'year' && r.due.slice(0, 4) === m.today.slice(0, 4)));
    const segStarts = new Set(x.c.segments.map((s) => s.from));
    const statusCls = { paid: 'paid', overdue: 'overdue', partial: 'partial' };
    let html = `<div class="seg" style="margin-bottom:10px">${m.contracts.map((y) => `<button data-tablec="${y.c.id}" class="${y.c.id === x.c.id ? 'on' : ''}">${esc(y.c.name)}</button>`).join('')}</div>`;
    html += `<div class="row" style="margin-bottom:10px"><div class="seg" style="flex:1">${[['all', 'ทุกงวด'], ['open', 'ค้าง/ถึงกำหนด'], ['year', 'ปีนี้']].map(([k, v]) => `<button data-tablef="${k}" class="${f === k ? 'on' : ''}">${v}</button>`).join('')}</div>
      ${cur ? `<button class="btn ghost sm" data-action="jump">ไปงวด ${cur}</button>` : ''}</div>`;
    html += `<section class="card" style="padding:6px 10px">
      <div class="small muted" style="padding:6px 4px">ยอดตามแผน · <span>ตัวเล็ก = ขั้นต่ำตามตารางธนาคาร</span> · งวดที่ยังไม่จ่ายคำนวณจากยอดจริงล่าสุด</div>
      <table class="sched num"><thead><tr><th>งวด</th><th>วันที่</th><th>ยอด</th><th>คงเหลือ</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr id="r${r.n}" class="${statusCls[r.status] || ''} ${r.n === cur && r.status === 'upcoming' ? 'current' : ''} ${segStarts.has(r.n) && r.n > 1 ? 'phase' : ''}">
        <td>${r.n}</td>
        <td>${thaiDate(r.due).slice(0, 6)}${String(Number(r.due.slice(0, 4)) + 543).slice(2)}</td>
        <td>${money(r.pay)}${r.bankMin != null && Math.abs(r.bankMin - r.pay) > 0.5 ? `<div class="small muted">${money(r.bankMin, 0)}</div>` : ''}${r.status === 'partial' ? `<div class="small" style="color:var(--warn)">จ่าย ${money(r.paid)}</div>` : ''}</td>
        <td>${money(r.balance, 0)}</td>
        <td><button class="chk ${r.status === 'paid' ? 'on' : r.status === 'partial' ? 'part' : ''}" data-tick="${r.n}" aria-label="งวด ${r.n}"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></button></td>
      </tr>`).join('') || '<tr><td colspan="5" class="empty">ไม่มีงวดในตัวกรองนี้</td></tr>'}
      </tbody></table></section>`;
    if (x.bank) {
      const b = x.bank, bInt = b.reduce((a, r) => a + r.interest, 0);
      html += `<section class="card small"><h2>เทียบกับสัญญาเดิม (ตารางธนาคาร)</h2>
        <div class="grid2"><div class="kpi"><div class="v">${b.length} งวด</div><div class="l">สัญญาเดิมจบ ${thaiMonth(b[b.length - 1].due)}</div></div>
        <div class="kpi"><div class="v">${x.proj.endN} งวด</div><div class="l">แผนปัจจุบัน เร็วขึ้น ${ym(b.length - x.proj.endN)}</div></div>
        <div class="kpi"><div class="v num">${money(bInt, 0)}</div><div class="l">ดอกเบี้ยรวมสัญญาเดิม</div></div>
        <div class="kpi"><div class="v num">${money(x.rp.interestPaid + x.proj.totalInterest, 0)}</div><div class="l">ดอกเบี้ยรวมแผนปัจจุบัน</div></div></div>
        ${b.some((r) => r.computed) ? `<p class="muted">* งวด ${b.find((r) => r.computed).n}-${[...b].reverse().find((r) => r.computed).n} ไฟล์ไม่มีตัวเลข แอปคำนวณเติมด้วยสูตรเดียวกับธนาคาร</p>` : ''}
      </section>`;
    }
    return html;
  }
  const addMonths = (iso, k) => { const d = new Date(E.parse(iso)); d.setUTCMonth(d.getUTCMonth() + k); return E.fmt(d.getTime()); };

  function viewSim() {
    const m = model();
    const o = state.ui.sim;
    const x = byId(m, o.contract) || m.contracts[0];
    const startMin = x.rp.nextN;
    const start = Math.max(o.start || startMin, startMin);
    const st = { n: x.rp.nextN, balance: x.rp.balance, lastDate: x.rp.lastDate };
    const extraFn = (amount, mode, s) => (n) => (n < s ? 0 : mode === 'once' ? (n === s ? amount : 0) : mode === 'yearly' ? ((n - s) % 12 === 0 ? amount : 0) : amount);
    const base = x.proj;
    const run = (amt, mode) => E.project(m.S, x.c, st, extraFn(amt, mode, start));
    const sim = run(Number(o.amount) || 0, o.mode);
    const savedN = base.endN - sim.endN, savedI = base.totalInterest - sim.totalInterest;
    const extraTotal = sim.rows.reduce((a, r) => a + (r.extra || 0), 0);

    let html = `<section class="card stack">
      <label class="field"><span>สัญญา</span><select data-sim="contract">${m.contracts.map((y) => `<option value="${y.c.id}" ${y.c.id === x.c.id ? 'selected' : ''}>${esc(y.c.name)} (คงเหลือ ${money(y.rp.balance, 0)})</option>`).join('')}</select></label>
      <label class="field"><span>โปะเพิ่ม (บาท)</span><input type="number" inputmode="decimal" min="0" step="500" value="${esc(o.amount)}" data-sim="amount"></label>
      <div class="seg">${[['once', 'ครั้งเดียว'], ['monthly', 'ทุกเดือน'], ['yearly', 'ทุกปี']].map(([k, v]) => `<button data-simmode="${k}" class="${o.mode === k ? 'on' : ''}">${v}</button>`).join('')}</div>
      <label class="field"><span>เริ่มโปะงวดที่ (${thaiDate(E.dueDate(m.S, start))})</span><input type="number" inputmode="numeric" min="${startMin}" value="${start}" data-sim="start"></label>
    </section>`;
    if (x.rp.balance <= 0.005) return html + `<div class="empty">สัญญานี้ปิดแล้ว</div>`;
    html += `<section class="card">
      <h2>ผลลัพธ์ ${esc(x.c.name)}</h2>
      <div class="result-big">
        <div class="kpi"><div class="v">${savedN > 0 ? savedN + ' งวด' : '-'}</div><div class="l">จบเร็วขึ้น ${savedN > 0 ? '(' + ym(savedN) + ')' : ''}</div></div>
        <div class="kpi"><div class="v num">${money(savedI, 0)}</div><div class="l">ประหยัดดอกเบี้ย (บาท)</div></div>
      </div>
      <hr>
      <div class="grid2 small">
        <div><div class="muted">ไม่โปะ</div>จบงวด <b>${base.endN}</b> · ${thaiMonth(base.endDate)}<br>ดอกเบี้ย ${money(base.totalInterest, 0)}</div>
        <div><div class="muted">โปะตามนี้</div>จบงวด <b>${sim.endN}</b> · ${thaiMonth(sim.endDate)}<br>ดอกเบี้ย ${money(sim.totalInterest, 0)}</div>
      </div>
      <p class="small muted" style="margin-bottom:0">เงินโปะรวม ${money(extraTotal, 0)} บาท · ค่างวดเท่าเดิม จบเร็วขึ้น · ดอกเบี้ยรายวันตามอัตราในหน้าตั้งค่า${base.stuck ? ' · ⚠️ ค่างวดตามแผนไม่พอจ่ายดอกเบี้ย' : ''}</p>
    </section>`;
    const scen = o.mode === 'once' ? [50000, 100000, 200000, 300000, 500000] : o.mode === 'yearly' ? [20000, 50000, 100000, 150000, 200000] : [1000, 2000, 3000, 5000, 10000];
    html += `<section class="card"><h2>เทียบหลายยอด (${o.mode === 'once' ? 'ครั้งเดียว' : o.mode === 'yearly' ? 'ทุกปี' : 'ทุกเดือน'} เริ่มงวด ${start})</h2>
      <table class="sim-table num"><thead><tr><th>โปะ</th><th>จบงวด</th><th>เร็วขึ้น</th><th>ประหยัดดอกเบี้ย</th></tr></thead><tbody>
      ${scen.map((a) => { const r = run(a, o.mode); return `<tr data-simamt="${a}" style="cursor:pointer"><td>${money(a, 0)}</td><td>${r.endN}</td><td>${ym(base.endN - r.endN)}</td><td>${money(base.totalInterest - r.totalInterest, 0)}</td></tr>`; }).join('')}
      </tbody></table></section>`;
    return html;
  }

  function viewSettings() {
    const d = state.ui.draft || (state.ui.draft = clone(state.settings));
    const S = state.settings;
    const people = d.people;
    let html = `<section class="card stack">
      <h2>เชื่อมต่อ Google Sheets</h2>
      <label class="field"><span>Web App URL (…/exec)</span><input id="apiUrl" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(state.api.url)}"></label>
      <label class="field"><span>PIN</span><input id="apiPin" type="password" inputmode="numeric" autocomplete="off" value="${esc(state.api.pin)}"></label>
      <div class="row"><button class="btn" data-action="connect">เชื่อมต่อ</button>${remote() ? '<button class="btn ghost" data-action="disconnect">ใช้โหมดเครื่องนี้</button>' : ''}</div>
      <p class="small muted" style="margin:0">URL และ PIN เก็บในเครื่องนี้เท่านั้น แต่ละมือถือต้องกรอกครั้งแรก</p>
    </section>`;

    html += `<section class="card stack"><h2>อัตราดอกเบี้ย</h2>
      <label class="field"><span>MLR ปัจจุบัน (%)</span><input type="number" step="0.01" data-path="mlr" value="${d.mlr}"></label>
      <p class="small muted" style="margin:0">อัตราเปลี่ยนตาม "วันที่" แบบเดียวกับธนาคาร งวดที่คร่อมวันเปลี่ยนจะคิดดอกเบี้ยผสม</p>
      ${d.ratePeriods.map((p, i) => `<div class="seg-row" style="grid-template-columns:1.3fr 1fr .9fr 32px">
        <label class="field"><span>ตั้งแต่วันที่</span><input type="date" data-path="ratePeriods.${i}.from" value="${p.from}"></label>
        <label class="field"><span>แบบ</span><select data-path="ratePeriods.${i}.type"><option value="fixed" ${p.type === 'fixed' ? 'selected' : ''}>คงที่ %</option><option value="mlr" ${p.type === 'mlr' ? 'selected' : ''}>MLR ±</option></select></label>
        <label class="field"><span>= ${(p.type === 'mlr' ? Number(d.mlr) + Number(p.value) : Number(p.value)).toFixed(2)}%</span><input type="number" step="0.01" data-path="ratePeriods.${i}.value" value="${p.value}"></label>
        <button class="x" data-del="ratePeriods.${i}" aria-label="ลบ">×</button></div>`).join('')}
      <button class="btn ghost sm" data-add="ratePeriods">+ เพิ่มช่วงอัตรา</button>
    </section>`;

    html += d.contracts.map((c, ci) => `<section class="card stack"><h2>${esc(c.name)}</h2>
      <div class="grid2">
        <label class="field"><span>ชื่อสัญญา</span><input data-path="contracts.${ci}.name" value="${esc(c.name)}"></label>
        <label class="field"><span>เงินต้น</span><input type="number" step="0.01" data-path="contracts.${ci}.principal" value="${c.principal}"></label>
      </div>
      <label class="field"><span>ผู้รับผิดชอบหลัก</span><select data-path="contracts.${ci}.owner">${people.map((p) => `<option ${p === c.owner ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
      <div class="small muted">ค่างวดตามแผน แยกตามคนจ่าย (เว้น "ถึง" ว่าง = จนปิดหนี้, ถ้าใส่ "ถึง" งวดสุดท้ายจะปิดยอดที่เหลือ)</div>
      ${c.segments.map((s, si) => `<div class="seg-box">
        <div class="seg-row" style="grid-template-columns:1fr 1fr 1.2fr 32px">
          <label class="field"><span>งวด</span><input type="number" min="1" data-path="contracts.${ci}.segments.${si}.from" value="${s.from}"></label>
          <label class="field"><span>ถึง</span><input type="number" min="1" data-path="contracts.${ci}.segments.${si}.to" value="${s.to ?? ''}" placeholder="ปิดหนี้"></label>
          <div class="small muted" style="padding-bottom:10px">รวม <b class="num">${money(E.segAmount({ shares: Object.fromEntries(Object.entries(s.shares).map(([k, v]) => [k, Number(v) || 0])) }))}</b></div>
          <button class="x" data-del="contracts.${ci}.segments.${si}" aria-label="ลบ">×</button>
        </div>
        <div class="shares">${people.map((p) => `<label class="field"><span>${esc(p)} จ่าย</span><input type="number" step="0.01" inputmode="decimal" data-path="contracts.${ci}.segments.${si}.shares.${p}" value="${s.shares[p] ?? ''}"></label>`).join('')}</div>
      </div>`).join('')}
      <button class="btn ghost sm" data-add="contracts.${ci}.segments">+ เพิ่มช่วงค่างวด</button>
    </section>`).join('');

    html += `<section class="card stack"><h2>วันที่</h2>
      <div class="grid2">
        <label class="field"><span>วันเริ่มสัญญา</span><input type="date" data-path="startDate" value="${d.startDate}"></label>
        <label class="field"><span>งวดแรก</span><input type="date" data-path="firstDue" value="${d.firstDue}"></label>
      </div>
      <label class="field"><span>วันจ่ายทุกเดือน (ตรงเสาร์-อาทิตย์เลื่อนเป็นจันทร์)</span><input type="number" min="1" max="31" data-path="payDay" value="${d.payDay}"></label>
      <label class="field"><span>วันหยุดเพิ่มเติมที่ธนาคารเลื่อน (บรรทัดละวัน YYYY-MM-DD)</span><textarea data-path="holidays" data-kind="lines">${esc((d.holidays || []).join('\n'))}</textarea></label>
    </section>`;

    html += `<section class="card stack"><h2>แจ้งเตือนทางอีเมล</h2>
      <label class="field"><span>อีเมล (คั่นด้วย , )</span><input type="text" inputmode="email" data-path="emails" data-kind="csv" value="${esc((d.emails || []).join(', '))}"></label>
      <div class="grid2">
        <label class="field"><span>เตือนล่วงหน้า (วัน)</span><input type="number" min="0" max="10" data-path="remindDaysBefore" value="${d.remindDaysBefore}"></label>
        <label class="field"><span>ลิงก์แอป (ใส่ในอีเมล)</span><input type="url" data-path="appUrl" value="${esc(d.appUrl)}" placeholder="${esc(location.href.split('#')[0])}"></label>
      </div>
      ${remote() ? '<button class="btn ghost sm" data-action="test-email">ส่งอีเมลทดสอบ</button>' : '<p class="small muted" style="margin:0">ต้องเชื่อม Google Sheets ก่อน อีเมลจึงจะทำงาน</p>'}
    </section>`;

    const dirty = JSON.stringify(d) !== JSON.stringify(S);
    html += `<div class="stack" style="position:sticky;bottom:calc(var(--tabbar-h) + env(safe-area-inset-bottom,0px) + 8px)">
      <button class="btn block" data-action="save-settings" ${dirty ? '' : 'disabled'}>${dirty ? 'บันทึกและคำนวณแผนใหม่' : 'ไม่มีการเปลี่ยนแปลง'}</button></div>
      <section class="card stack" style="margin-top:14px"><h2>อื่นๆ</h2>
      <div class="row wrap"><button class="btn ghost sm" data-go="slip">🧪 ทดลองอ่านสลิป</button>
      <button class="btn ghost sm" data-action="export">ส่งออกข้อมูล (JSON)</button>
      <button class="btn danger sm" data-action="reset-settings">คืนค่าเริ่มต้นจากไฟล์ Excel</button></div>
      <p class="small muted" style="margin:0">ข้อมูลหลักอยู่ใน Google Sheets อยู่แล้ว ไฟล์ JSON ใช้สำรองเพิ่ม</p></section>`;
    return html;
  }

  // ---------------- ทดลองอ่านสลิป (OCR + QR ในเครื่อง, ไม่บันทึกข้อมูล) ----------------
  const LIBS = {
    tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    jsqr: 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
  };
  const loadScript = (src) => new Promise((res, rej) => {
    if ([...document.scripts].some((s) => s.src === src)) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('โหลดไลบรารีไม่ได้ (ต้องต่ออินเทอร์เน็ตครั้งแรก)'));
    document.head.appendChild(s);
  });
  const slip = { status: 'idle', progress: 0, msg: '', preview: '', text: '', parsed: null, qr: null, ms: 0, worker: null };

  function slipSetProgress(msg, p) {
    slip.msg = msg; if (p != null) slip.progress = p;
    const el = $('#slipProgress');
    if (el) { el.querySelector('.msg').textContent = msg; el.querySelector('.progress > div').style.width = Math.round(slip.progress * 100) + '%'; }
  }

  /** อ่านสลิปในเครื่อง (QR + OCR) → { preview, text, parsed, qr, dateCheck } — ใช้ร่วมกันทั้งฟอร์มบันทึกจ่ายและหน้าทดลอง */
  async function ocrSlip(file, onProgress, onPreview) {
    const progress = (msg, p) => onProgress && onProgress(msg, p);
    slip.onProgress = progress; // logger ของ worker ตัวเดียวกันส่ง progress มาที่ผู้เรียกปัจจุบัน
    const out = { preview: '', text: '', parsed: null, qr: null, dateCheck: null };
    {
      progress('กำลังเตรียมรูป…', 0.02);
      const img = await createImageBitmap(file);
      // ปรับตาม "ความกว้าง" ให้ตัวอักษรใหญ่พอ (ภาพหน้าจอมือถือยาวมาก ถ้าย่อด้านยาวตัวหนังสือจะเล็กเกิน)
      let scale = 1300 / img.width;
      if (img.height * scale > 4000) scale = 4000 / img.height;
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      out.preview = cv.toDataURL('image/jpeg', 0.7);
      if (onPreview) onPreview(out.preview);

      // QR ก่อน (เร็ว และแม่นกว่า OCR)
      progress('กำลังหา QR บนสลิป…', 0.05);
      await loadScript(LIBS.jsqr);
      const qrFrom = (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height); const r = window.jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' }); return r ? r.data : null; };
      let qrData = qrFrom(cv);
      if (!qrData) { // ลองย่อรูป บางครั้งเจอง่ายกว่า
        const small = document.createElement('canvas'), k = 800 / Math.max(cv.width, cv.height);
        if (k < 1) { small.width = cv.width * k; small.height = cv.height * k; small.getContext('2d').drawImage(cv, 0, 0, small.width, small.height); qrData = qrFrom(small); }
      }
      out.qr = qrData ? window.SlipReader.parseQR(qrData) : null;

      // ขาวดำ ช่วยสลิปที่มีพื้นสี
      const id = ctx.getImageData(0, 0, cv.width, cv.height), px = id.data;
      for (let i = 0; i < px.length; i += 4) { const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; px[i] = px[i + 1] = px[i + 2] = g; }
      ctx.putImageData(id, 0, 0);

      progress('กำลังโหลดตัวอ่าน OCR (ครั้งแรกประมาณ 5–8 MB)…', 0.1);
      await loadScript(LIBS.tesseract);
      if (!slip.worker) {
        slip.worker = await window.Tesseract.createWorker(['tha', 'eng'], 1, {
          logger: (m) => {
            if (m.status === 'recognizing text') slip.onProgress?.('กำลังอ่านตัวอักษร…', 0.3 + m.progress * 0.65);
            else if (/load|initializ/.test(m.status)) slip.onProgress?.('กำลังโหลดข้อมูลภาษา…', 0.1 + (m.progress || 0) * 0.2);
          },
        });
      }
      const { data } = await slip.worker.recognize(cv, {}, { text: true, blocks: true });
      out.text = data.text || '';
      out.parsed = window.SlipReader.parseText(out.text);

      // รอบ 2: ครอปบรรทัดที่น่าจะเป็นวันที่ (มีเวลา หรือ ตัวเลข+อักษรไทย) ขยาย 2.5 เท่าแล้วอ่านใหม่
      slip.onProgress = null;
      progress('กำลังอ่านบรรทัดวันที่ซ้ำแบบขยาย…', 0.97);
      const lines = data.lines || (data.blocks || []).flatMap((b) => (b.paragraphs || []).flatMap((p) => p.lines || []));
      const cands = lines.filter((l) => /(?<!\d)([01]?\d|2[0-3])[:.][0-5]\d(?!\d)|\d{1,2}\s*[เก-ฮ]/.test(l.text) && !/[A-Z0-9]{12,}/.test(l.text)).slice(0, 3);
      const zoomReads = [];
      for (const l of cands) {
        const { x0, y0, x1, y1 } = l.bbox, pad = Math.round((y1 - y0) * 0.4), Z = 2.5;
        const sx = Math.max(0, x0 - pad), sy = Math.max(0, y0 - pad), sw = Math.min(cv.width - sx, x1 - x0 + pad * 2), sh = Math.min(cv.height - sy, y1 - y0 + pad * 2);
        const zc = document.createElement('canvas'); zc.width = Math.round(sw * Z); zc.height = Math.round(sh * Z);
        const zx = zc.getContext('2d'); zx.imageSmoothingQuality = 'high'; zx.drawImage(cv, sx, sy, sw, sh, 0, 0, zc.width, zc.height);
        const r = await slip.worker.recognize(zc);
        const t = (r.data.text || '').trim();
        const dt = window.SlipReader.findDate(t);
        zoomReads.push({ text: t, date: dt ? dt.iso : '' });
      }
      const zoomDate = zoomReads.find((z) => z.date);
      out.dateCheck = { first: out.parsed.date, firstText: out.parsed.dateText, zoom: zoomDate ? zoomDate.date : '', zoomText: zoomDate ? zoomDate.text : '', reads: zoomReads };
      if (zoomDate) { out.parsed.date = zoomDate.date; out.parsed.dateText = zoomDate.text; }
      // OCR อ่านวันที่ไม่ได้ แต่ QR มีวันที่ในเลขอ้างอิง → ใช้ของ QR
      if (!out.parsed.date && out.qr && out.qr.refDate) { out.parsed.date = out.qr.refDate; out.parsed.dateText = 'จากเลขอ้างอิง QR'; }
    }
    return out;
  }

  async function slipRead(file) {
    const t0 = performance.now();
    Object.assign(slip, { status: 'working', progress: 0, text: '', parsed: null, qr: null, preview: '', dateCheck: null });
    rerender();
    try {
      const r = await ocrSlip(file, slipSetProgress, (src) => { slip.preview = src; const pv = $('#slipPreview'); if (pv) { pv.src = src; pv.hidden = false; } });
      Object.assign(slip, r, { ms: Math.round(performance.now() - t0), status: 'done' });
    } catch (e) {
      slip.status = 'error'; slip.msg = e.message || String(e);
    }
    if (state.tab === 'slip') rerender();
  }

  /** เดาว่ายอดนี้ตรงกับค่างวดอะไร (แสดงเฉยๆ ไม่บันทึก) */
  function slipGuess(amount) {
    if (!(amount > 0)) return '';
    const hits = [];
    for (const c of state.settings.contracts) for (const s of c.segments) {
      const range = `งวด ${s.from}${s.to ? '–' + s.to : '+'}`;
      if (Math.abs(E.segAmount(s) - amount) < 1) hits.push(`${c.name} ${range} (ยอดเต็ม)`);
      for (const [who, v] of Object.entries(s.shares)) if (Object.keys(s.shares).length > 1 && Math.abs(Number(v) - amount) < 1) hits.push(`${c.name} ${range} ส่วนของ${who}`);
    }
    return hits.length ? hits.join(' · ') : 'ไม่ตรงกับค่างวดใด (อาจเป็นการโปะ หรืออ่านยอดผิด)';
  }

  /** หมายเหตุใต้วันที่: ข้อความที่อ่านได้ + ตรวจเทียบรอบขยาย / QR / ความสมเหตุสมผล */
  function slipDateNote(p, q) {
    const notes = [];
    const dc = slip.dateCheck || {};
    if (p.dateText) notes.push(`อ่านได้ว่า "${esc(p.dateText)}"`);
    if (dc.first && dc.zoom && dc.first !== dc.zoom) notes.push(`<span class="pill warn">รอบแรกอ่านได้ ${thaiDate(dc.first)} รอบขยายได้ ${thaiDate(dc.zoom)}</span>`);
    if (q && q.valid && q.refDate && p.date) notes.push(q.refDate === p.date ? '<span class="pill ok">ตรงกับวันที่ในเลขอ้างอิง QR ✓</span>' : `<span class="pill warn">เลขอ้างอิง QR ระบุ ${thaiDate(q.refDate)}</span>`);
    if (!p.date && q && q.valid && q.refDate) notes.push(`OCR อ่านไม่ได้ แต่เลขอ้างอิง QR ระบุ ${thaiDate(q.refDate)}`);
    const today = todayStr();
    if (p.date && p.date > today) notes.push('<span class="pill bad">เป็นวันในอนาคต น่าจะอ่านผิด</span>');
    else if (p.date && E.daysBetween(p.date, today) > 730) notes.push('<span class="pill warn">เก่ากว่า 2 ปี ตรวจอีกครั้ง</span>');
    return notes.join('<br>');
  }

  function viewSlip() {
    const p = slip.parsed, q = slip.qr;
    const row = (k, v, note) => `<tr><td class="muted">${k}</td><td class="right"><b>${v || '<span class="muted">ไม่พบ</span>'}</b>${note ? `<div class="small muted">${note}</div>` : ''}</td></tr>`;
    let html = `<div class="banner">🧪 โหมดทดลอง อ่านแล้วแค่แสดงผล <b>ไม่บันทึกลงข้อมูลการผ่อน</b> และรูปไม่ออกจากเครื่อง (อ่านในมือถือทั้งหมด)</div>
      <section class="card stack">
        <label class="btn block" style="position:relative">📷 เลือกรูปสลิป / ถ่ายรูป
          <input type="file" accept="image/*" data-slipfile style="position:absolute;inset:0;opacity:0;cursor:pointer"></label>
        <p class="small muted" style="margin:0">ภาพหน้าจอสลิปจากแอปธนาคารอ่านได้แม่นกว่าการถ่ายรูปกระดาษ</p>
        <img id="slipPreview" alt="" style="max-height:260px;object-fit:contain;border-radius:10px;background:var(--bg)" ${slip.preview ? `src="${slip.preview}"` : 'hidden'}>
      </section>`;
    if (slip.status === 'working') {
      html += `<section class="card" id="slipProgress"><div class="msg small">${esc(slip.msg)}</div><div class="progress"><div style="width:${Math.round(slip.progress * 100)}%"></div></div></section>`;
    } else if (slip.status === 'error') {
      html += `<section class="card"><div class="pill bad">อ่านไม่สำเร็จ</div><p class="small">${esc(slip.msg)}</p></section>`;
    } else if (slip.status === 'done') {
      const refMatch = q && q.valid && p.ref ? (p.ref === q.transRef ? '<span class="pill ok">ตรงกับ QR ✓</span>' : '<span class="pill warn">ไม่ตรงกับ QR</span>') : '';
      html += `<section class="card"><div class="row"><h2>ผลที่อ่านได้</h2><span class="small muted">${(slip.ms / 1000).toFixed(1)} วินาที</span></div>
        <table class="sim-table"><tbody>
          ${row('ยอดเงิน', p.amount != null ? money(p.amount) + ' บาท' : '', p.amountFrom === 'largest' ? 'ไม่เจอคำว่า "จำนวนเงิน" จึงเลือกตัวเลขที่มากที่สุด ควรตรวจซ้ำ' : '')}
          ${row('ค่าธรรมเนียม', p.fee != null ? money(p.fee) : '')}
          ${row('วันที่', p.date ? thaiDateLong(p.date) : '', slipDateNote(p, q))}
          ${row('ธนาคารผู้โอน', p.bank || (q && q.valid && q.bank) || '', p.bank ? 'จากข้อความบนสลิป' : q && q.valid && q.bank ? 'จาก QR (ชื่อธนาคารบนสลิปมักเป็นโลโก้ OCR อ่านไม่ได้)' : '')}
          ${row('เลขอ้างอิง (OCR)', p.ref ? `<span style="word-break:break-all">${esc(p.ref)}</span>` : '', refMatch)}
        </tbody></table></section>
        <section class="card"><h2>QR บนสลิป</h2>
        ${!q ? '<p class="small muted" style="margin:0">ไม่พบ QR (ลองครอปให้ QR ชัดขึ้น หรือใช้ภาพหน้าจอแทนรูปถ่าย)</p>'
          : q.valid ? `<table class="sim-table"><tbody>${row('เลขอ้างอิงรายการ', `<span style="word-break:break-all">${esc(q.transRef)}</span>`)}${row('ธนาคารผู้โอน', `${esc(q.bank || 'ไม่รู้จัก')} (${esc(q.bankCode)})`)}</tbody></table>
            <p class="small muted" style="margin:6px 0 0">QR ของสลิปมีแค่เลขอ้างอิงกับรหัสธนาคาร ไม่มียอดเงิน แต่อ่านได้แม่น 100% จึงใช้กันบันทึกสลิปซ้ำได้</p>`
          : `<p class="small muted" style="margin:0">พบ QR แต่ไม่ใช่รูปแบบสลิปโอนเงิน</p><div class="small" style="word-break:break-all">${esc(q.raw.slice(0, 200))}</div>`}
        </section>
        <section class="card"><h2>ถ้าเป็นค่างวด น่าจะเป็น…</h2><p class="small" style="margin:0">${esc(slipGuess(p.amount))}</p>
          <p class="small muted" style="margin:6px 0 0">แค่เดาจากค่างวดในหน้าตั้งค่า ไม่ได้บันทึกอะไร</p></section>
        <section class="card"><details><summary class="small">ข้อความดิบจาก OCR (${p.lineCount} บรรทัด)</summary>
          <pre class="small" style="white-space:pre-wrap;word-break:break-word;margin:8px 0 0">${esc(slip.text)}</pre>
          ${(slip.dateCheck?.reads || []).length ? `<div class="small muted" style="margin-top:8px">อ่านบรรทัดวันที่แบบขยาย:</div><pre class="small" style="white-space:pre-wrap;margin:4px 0 0">${slip.dateCheck.reads.map((z) => esc(z.text) + (z.date ? '  → ' + thaiDate(z.date) : '')).join('\n')}</pre>` : ''}</details></section>`;
    }
    html += `<button class="btn ghost block" data-go="settings">← กลับไปตั้งค่า</button>`;
    return html;
  }

  // ---------------- payment modal ----------------
  function openPayment(p) {
    const m = model();
    const isNew = !p.id;
    const S = m.S;
    const dlg = $('#modal');
    const firstOpenN = (cid) => { const x = byId(m, cid); return x && x.firstOpen ? x.firstOpen.n : (x ? x.rp.nextN : 1); };
    const planFor = (cid, n) => { const x = byId(m, cid); const r = x && x.rows[n - 1]; return r ? E.r2(r.pay - (isNew ? r.paid : 0)) : 0; };
    const f = {
      id: p.id || '', date: p.date || m.today, contract: p.contract || 'house', type: p.type || 'normal',
      installment: p.installment || '', amount: p.amount ?? '', payer: p.payer || '', bankBalance: p.bankBalance ?? '', note: p.note || '',
    };
    if (!f.installment && f.type === 'normal') f.installment = firstOpenN(f.contract);
    if (f.amount === '' && f.type === 'normal') f.amount = planFor(f.contract, f.installment);
    if (!f.payer) f.payer = (S.contracts.find((c) => c.id === f.contract) || {}).owner || S.people[0];
    let amountTouched = !isNew;
    let splitOn = true;         // ติ๊ก "แยกบันทึกตามคนจ่าย"
    let slipBusy = false, slipInfo = ''; // สถานะการกรอกจากสลิป (คงไว้ข้ามการ redraw)

    const shares = () => { const c = S.contracts.find((c) => c.id === f.contract); return c && f.type === 'normal' ? E.segmentFor(c, Number(f.installment) || 1).shares : {}; };
    const draw = () => {
      const sh = shares(), multi = isNew && f.type === 'normal' && Object.keys(sh).length > 1;
      dlg.innerHTML = `<form class="modal-body stack" method="dialog">
        <h2>${isNew ? 'บันทึกการจ่าย' : 'แก้ไขรายการ'}</h2>
        <div class="seg">${[['normal', 'ค่างวดปกติ'], ['extra', 'โปะเงินต้น']].map(([k, v]) => `<button type="button" data-ptype="${k}" class="${f.type === k ? 'on' : ''}">${v}</button>`).join('')}</div>
        <label class="btn ghost block" style="position:relative;${slipBusy ? 'opacity:.6' : ''}">📷 กรอกยอดและวันที่จากสลิป
          <input type="file" accept="image/*" data-pslip ${slipBusy ? 'disabled' : ''} style="position:absolute;inset:0;opacity:0;cursor:pointer"></label>
        <div id="pslipStatus" class="small" ${slipInfo ? '' : 'hidden'}>${slipInfo}</div>
        <div class="grid2">
          <label class="field"><span>วันที่จ่าย</span><input type="date" name="date" value="${f.date}" required></label>
          <label class="field"><span>สัญญา</span><select name="contract">${S.contracts.map((c) => `<option value="${c.id}" ${c.id === f.contract ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
          <label class="field"><span>งวดที่${f.installment ? ' (' + thaiDate(E.dueDate(S, Number(f.installment))) + ')' : ''}</span><input type="number" name="installment" min="1" inputmode="numeric" value="${f.installment}" ${f.type === 'normal' ? 'required' : ''}></label>
          <label class="field"><span>ยอด (บาท)</span><input type="number" name="amount" step="0.01" min="0.01" inputmode="decimal" value="${f.amount}" required></label>
          <label class="field"><span>ใครจ่าย</span><select name="payer">${S.people.map((x) => `<option ${x === f.payer ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
          <label class="field"><span>คงเหลือตามธนาคาร</span><input type="number" name="bankBalance" step="0.01" inputmode="decimal" placeholder="ถ้ามี" value="${f.bankBalance}"></label>
        </div>
        ${multi ? `<label class="row small" style="justify-content:flex-start;gap:8px"><input type="checkbox" name="split" ${splitOn ? 'checked' : ''} style="width:auto"> แยกบันทึกตามคนจ่าย (${Object.entries(sh).map(([k, v]) => `${esc(k)} ${money(v)}`).join(' / ')})</label>` : ''}
        <label class="field"><span>หมายเหตุ</span><input name="note" value="${esc(f.note)}" placeholder="เช่น โอนผ่านแอป, เลขอ้างอิง"></label>
        <div class="row">${isNew ? '' : '<button type="button" class="btn danger" data-pdel>ลบ</button>'}
          <span style="flex:1"></span><button type="button" class="btn ghost" data-pclose>ยกเลิก</button><button class="btn" type="submit">บันทึก</button></div>
      </form>`;
    };
    const read = () => {
      const fd = new FormData($('form', dlg));
      for (const k of ['date', 'contract', 'installment', 'amount', 'payer', 'bankBalance', 'note']) f[k] = fd.get(k) ?? f[k];
      if ($('[name="split"]', dlg)) splitOn = !!fd.get('split');
      return fd;
    };
    draw();

    /** เลือกรูปสลิป → อ่านในเครื่อง → กรอกยอด + วันที่ (ประเภทปกติ/โปะ ผู้ใช้เลือกเอง, ไม่บันทึกอัตโนมัติ) */
    async function fillFromSlip(file) {
      read();
      slipBusy = true; slipInfo = 'กำลังอ่านสลิป…'; draw();
      const status = (msg, p) => { const el = $('#pslipStatus', dlg); if (el) { el.hidden = false; el.textContent = `${msg}${p != null ? ' ' + Math.round(p * 100) + '%' : ''}`; } };
      let r;
      try { r = await ocrSlip(file, status); }
      catch (e) { slipBusy = false; slipInfo = `<span class="pill bad">อ่านสลิปไม่สำเร็จ</span> ${esc(e.message || e)}`; if (dlg.open) draw(); return; }
      slipBusy = false;
      if (!dlg.open) return;
      read(); // เก็บค่าที่ผู้ใช้อาจแก้ระหว่างรอ
      const p = r.parsed, got = [], warn = [];
      if (p.amount > 0) { f.amount = p.amount; amountTouched = true; got.push(`ยอด ${money(p.amount)}`); } else warn.push('อ่านยอดเงินไม่ได้');
      if (p.date) { f.date = p.date; got.push(`วันที่ ${thaiDate(p.date)}`); } else warn.push('อ่านวันที่ไม่ได้');
      if (p.amountFrom === 'largest') warn.push('ไม่เจอคำว่า "จำนวนเงิน" — ตรวจยอดอีกครั้ง');
      if (p.date && p.date > todayStr()) warn.push('วันที่เป็นอนาคต น่าจะอ่านผิด');
      if (p.date && r.qr && r.qr.refDate && r.qr.refDate !== p.date) warn.push(`เลขอ้างอิง QR ระบุวันที่ ${thaiDate(r.qr.refDate)}`);
      // ยอดตรงกับส่วนของคนเดียวในงวดที่แบ่งจ่าย → ตั้งคนจ่ายให้ และไม่แยกบันทึก
      const sh = shares();
      if (p.amount > 0 && Object.keys(sh).length > 1) {
        const who = Object.entries(sh).find(([, v]) => Math.abs(Number(v) - p.amount) < 1);
        if (who) { f.payer = who[0]; splitOn = false; got.push(`เป็นส่วนของ${who[0]}`); }
      }
      if (p.amount > 0 && f.type === 'normal') {
        const plan = planFor(f.contract, Number(f.installment));
        if (!Object.values(sh).some((v) => Math.abs(Number(v) - p.amount) < 1) && Math.abs(plan - p.amount) >= 1) warn.push(`ไม่ตรงค่างวดของสัญญา/งวดที่เลือก (${money(plan)}) — ${slipGuess(p.amount)}`);
      }
      slipInfo = (got.length ? `<span class="pill ok">อ่านจากสลิป</span> ${esc(got.join(' · '))}` : '')
        + warn.map((w) => `<div style="color:var(--warn)">⚠️ ${esc(w)}</div>`).join('')
        + '<div class="muted">ตรวจตัวเลขและเลือกประเภทให้ถูก แล้วกดบันทึก</div>';
      draw();
    }
    dlg.onclick = (e) => {
      if (e.target === dlg) dlg.close();
      const t = e.target.closest('[data-ptype],[data-pclose],[data-pdel]');
      if (!t) return;
      if (t.dataset.ptype) {
        read(); f.type = t.dataset.ptype;
        if (f.type === 'extra' && !amountTouched) { f.amount = ''; }
        if (f.type === 'normal' && !f.installment) f.installment = firstOpenN(f.contract);
        if (f.type === 'normal' && !amountTouched) f.amount = planFor(f.contract, f.installment);
        draw();
      } else if (t.hasAttribute('data-pclose')) dlg.close();
      else if (t.hasAttribute('data-pdel')) {
        if (confirm('ลบรายการนี้?')) { dlg.close(); deletePayments([f.id]); }
      }
    };
    dlg.onchange = (e) => {
      if (e.target.matches('[data-pslip]') && e.target.files && e.target.files[0] && !slipBusy) fillFromSlip(e.target.files[0]);
    };
    dlg.oninput = (e) => {
      if (e.target.name === 'amount') amountTouched = true;
      if (e.target.name === 'contract' || e.target.name === 'installment') {
        read();
        if (e.target.name === 'contract') { f.installment = f.type === 'normal' ? firstOpenN(f.contract) : ''; f.payer = S.contracts.find((c) => c.id === f.contract).owner; }
        if (!amountTouched && f.type === 'normal') f.amount = planFor(f.contract, Number(f.installment));
        draw();
      }
    };
    dlg.onsubmit = (e) => {
      e.preventDefault();
      if (slipBusy) { toast('รออ่านสลิปให้เสร็จก่อน', true); return; }
      const fd = read();
      const base = { id: f.id || undefined, date: f.date, contract: f.contract, type: f.type, installment: f.installment === '' ? '' : Number(f.installment), payer: f.payer, bankBalance: f.bankBalance === '' ? '' : Number(f.bankBalance), note: f.note.trim() };
      let list;
      if (fd.get('split')) {
        const sh = shares(), full = Object.values(sh).reduce((a, v) => a + Number(v), 0), amt = Number(f.amount);
        const ents = Object.entries(sh);
        let left = amt;
        list = ents.map(([who, v], i) => {
          const a = i === ents.length - 1 ? E.r2(left) : E.r2(amt * Number(v) / full);
          left -= a;
          // ยอดคงเหลือธนาคารใส่ไว้กับรายการสุดท้าย
          return { ...base, id: undefined, payer: who, amount: a, bankBalance: i === ents.length - 1 ? base.bankBalance : '' };
        });
      } else list = [{ ...base, amount: Number(f.amount) }];
      dlg.close();
      savePayments(list);
    };
    dlg.showModal();
  }

  // ---------------- render & events ----------------
  function render() {
    const view = $('#view');
    const y = window.scrollY;
    const fn = { dash: viewDash, log: viewLog, table: viewTable, sim: viewSim, settings: viewSettings, slip: viewSlip }[state.tab] || viewDash;
    if (state.tab !== 'slip' && slip.preview && slip.status !== 'working') Object.assign(slip, { status: 'idle', preview: '', text: '', parsed: null, qr: null }); // ออกจากหน้าแล้วไม่เก็บรูปไว้
    view.innerHTML = fn();
    $('#pageTitle').textContent = state.tab === 'dash' ? 'ผ่อนบ้าน' : TABS[state.tab];
    const navTab = state.tab === 'slip' ? 'settings' : state.tab;
    $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === navTab));
    window.scrollTo(0, render.keepScroll ? y : 0);
    render.keepScroll = false;
  }
  const rerender = () => { render.keepScroll = true; render(); };

  function go(tab) { state.tab = tab; lsSet(LS.tab, tab); render(); }

  function setPath(obj, path, val) {
    const ks = path.split('.');
    let o = obj;
    for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
    o[ks[ks.length - 1]] = val;
  }
  function getPath(obj, path) { return path.split('.').reduce((o, k) => o[k], obj); }

  $('.tabbar').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) go(b.dataset.tab); });
  $('#refreshBtn').addEventListener('click', () => (remote() ? sync() : toast('โหมดเครื่องนี้ — ไม่มีอะไรต้องซิงก์')));

  $('#view').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-go],[data-action],[data-chart],[data-range],[data-tablec],[data-tablef],[data-tick],[data-edit],[data-simmode],[data-simamt],[data-add],[data-del]');
    if (!t) return;
    const ds = t.dataset;
    if (ds.go) { e.preventDefault(); go(ds.go); return; }
    if (ds.chart) { state.ui.chart = ds.chart; rerender(); return; }
    if (ds.range) { state.ui.chartRange = ds.range; rerender(); return; }
    if (ds.tablec) { state.ui.table = ds.tablec; rerender(); return; }
    if (ds.tablef) { state.ui.tableFilter = ds.tablef; rerender(); return; }
    if (ds.simmode) { state.ui.sim.mode = ds.simmode; rerender(); return; }
    if (ds.simamt) { state.ui.sim.amount = Number(ds.simamt); rerender(); return; }
    if (ds.edit) { const p = state.payments.find((x) => x.id === ds.edit); if (p) openPayment(p); return; }
    if (ds.tick) {
      const m = model(), x = byId(m, state.ui.table) || m.contracts[0], n = Number(ds.tick), r = x.rows[n - 1];
      if (r.status === 'paid') {
        const ps = state.payments.filter((p) => p.contract === x.c.id && p.type !== 'extra' && Number(p.installment) === n);
        if (confirm(`ยกเลิกการจ่ายงวด ${n} (${ps.length} รายการ)?`)) deletePayments(ps.map((p) => p.id));
      } else openPayment({ contract: x.c.id, installment: n, date: r.due <= m.today ? r.due : m.today });
      return;
    }
    if (ds.add) {
      const d = state.ui.draft, arr = getPath(d, ds.add);
      if (ds.add === 'ratePeriods') arr.push({ from: todayStr(), type: 'mlr', value: -1.72 });
      else { const last = arr[arr.length - 1]; arr.push({ from: last ? (Number(last.to) || Number(last.from)) + 1 : 1, to: null, shares: { ...(last ? last.shares : {}) } }); }
      rerender(); return;
    }
    if (ds.del) {
      const ks = ds.del.split('.'), i = Number(ks.pop()), arr = getPath(state.ui.draft, ks.join('.'));
      if (arr.length <= 1) { toast('ต้องมีอย่างน้อย 1 ช่วง', true); return; }
      arr.splice(i, 1); rerender(); return;
    }
    switch (ds.action) {
      case 'pay-new': openPayment({}); break;
      case 'pay-next': {
        const nd = nextDue(model());
        const x = nd && nd.items[0];
        openPayment(x ? { contract: x.c.id, installment: x.firstOpen.n, date: x.firstOpen.due <= todayStr() ? x.firstOpen.due : todayStr() } : {});
        break;
      }
      case 'jump': {
        if (state.ui.tableFilter !== 'all') { state.ui.tableFilter = 'all'; rerender(); }
        const x = byId(model(), state.ui.table);
        if (x && x.firstOpen) document.getElementById('r' + x.firstOpen.n)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        break;
      }
      case 'connect': await connect(); break;
      case 'disconnect':
        if (confirm('เลิกเชื่อม Google Sheets แล้วใช้ข้อมูลในเครื่องนี้?')) { state.api = { url: '', pin: '' }; lsSet(LS.api, state.api); const l = lsGet(LS.local, { payments: [], settings: null }); applyData(l.settings, l.payments); render(); setSync(); }
        break;
      case 'save-settings': {
        const d = normalizeDraft(state.ui.draft);
        if (d) await saveSettings(d);
        break;
      }
      case 'reset-settings':
        if (confirm('คืนค่าตั้งค่าทั้งหมดเป็นค่าจากไฟล์ Excel? (รายการจ่ายไม่ถูกลบ)')) { state.ui.draft = clone(window.DEFAULT_SETTINGS); state.ui.draft.emails = state.settings.emails; state.ui.draft.appUrl = state.settings.appUrl; rerender(); toast('กด "บันทึก" เพื่อยืนยัน'); }
        break;
      case 'test-email':
        await withBusy(async () => { if (!state.settings.emails.length) throw new Error('ยังไม่ได้ใส่อีเมลแล้วกดบันทึก'); await apiPost({ action: 'testEmail' }); }, 'ส่งอีเมลทดสอบแล้ว');
        break;
      case 'export': {
        const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), settings: state.settings, payments: state.payments }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = `home-loan-${todayStr()}.json`; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        break;
      }
    }
  });

  $('#view').addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.path && state.ui.draft) {
      let v = t.value;
      if (t.dataset.kind === 'lines') v = v.split(/\s+/).map((s) => s.trim()).filter(Boolean);
      else if (t.dataset.kind === 'csv') v = v.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean);
      else if (t.type === 'number') v = v === '' ? (t.dataset.path.endsWith('.to') ? null : '') : Number(v);
      setPath(state.ui.draft, t.dataset.path, v);
      const btn = $('[data-action="save-settings"]');
      if (btn) { const dirty = JSON.stringify(state.ui.draft) !== JSON.stringify(state.settings); btn.disabled = !dirty; btn.textContent = dirty ? 'บันทึกและคำนวณแผนใหม่' : 'ไม่มีการเปลี่ยนแปลง'; }
    }
    if (t.dataset.sim) {
      const o = state.ui.sim;
      if (t.dataset.sim === 'contract') { o.contract = t.value; o.start = null; rerender(); }
      else { o[t.dataset.sim] = t.value === '' ? '' : Number(t.value); clearTimeout(viewSim.t); viewSim.t = setTimeout(() => { const a = document.activeElement?.dataset?.sim; rerender(); if (a) { const el = $(`[data-sim="${a}"]`); if (el) { el.focus(); const L = el.value.length; try { el.setSelectionRange(L, L); } catch { /* number input */ } } } }, 350); }
    }
  });
  $('#view').addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-slipfile]') && t.files && t.files[0]) { if (slip.status !== 'working') slipRead(t.files[0]); t.value = ''; return; }
    if (t.matches('[data-logfilter]')) { state.ui.log = t.value; rerender(); }
    // อัปเดต % ที่แสดงข้างช่องอัตรา
    if (t.dataset.path && (t.tagName === 'SELECT' || t.dataset.path === 'mlr' || t.dataset.path.startsWith('ratePeriods'))) rerender();
  });

  function normalizeDraft(d) {
    d = clone(d);
    d.mlr = Number(d.mlr);
    d.payDay = Number(d.payDay) || 6;
    d.remindDaysBefore = Number(d.remindDaysBefore) || 0;
    d.ratePeriods = d.ratePeriods.filter((p) => p.from).map((p) => ({ from: p.from, type: p.type, value: Number(p.value) })).sort((a, b) => (a.from < b.from ? -1 : 1));
    for (const c of d.contracts) {
      c.principal = Number(c.principal);
      c.segments = c.segments.map((s) => ({
        from: Number(s.from), to: s.to === '' || s.to == null ? null : Number(s.to),
        shares: Object.fromEntries(Object.entries(s.shares).filter(([, v]) => v !== '' && v != null && Number(v) > 0).map(([k, v]) => [k, Number(v)])),
      })).sort((a, b) => a.from - b.from);
      if (c.segments.some((s) => !Object.keys(s.shares).length)) { toast(`${c.name}: ทุกช่วงต้องมีค่างวดอย่างน้อย 1 คน`, true); return null; }
      if (c.segments[0].from !== 1) { toast(`${c.name}: ช่วงแรกต้องเริ่มงวด 1`, true); return null; }
    }
    if (!d.ratePeriods.length) { toast('ต้องมีอัตราดอกเบี้ยอย่างน้อย 1 ช่วง', true); return null; }
    if (d.emails.some((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) { toast('รูปแบบอีเมลไม่ถูกต้อง', true); return null; }
    return d;
  }

  async function connect() {
    const url = $('#apiUrl').value.trim(), pin = $('#apiPin').value.trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) { toast('URL ต้องเป็น https://script.google.com/macros/s/…/exec', true); return; }
    const prev = state.api;
    state.api = { url, pin };
    state.syncing = true; setSync();
    try {
      const j = await apiGet();
      lsSet(LS.api, state.api);
      const localData = lsGet(LS.local, { payments: [], settings: null });
      if (!j.settings) await apiPost({ action: 'saveSettings', settings: withDefaults(localData.settings) });
      if (!j.payments.length && localData.payments.length && confirm(`อัปโหลดรายการจ่าย ${localData.payments.length} รายการจากเครื่องนี้ขึ้น Google Sheets?`)) {
        for (const p of localData.payments) await apiPost({ action: 'savePayment', payment: p });
      }
      state.syncing = false;
      await sync();
      toast('เชื่อมต่อสำเร็จ');
    } catch (e) {
      state.api = prev; state.syncing = false; setSync();
      toast('เชื่อมต่อไม่สำเร็จ: ' + e.message, true);
    }
  }

  // ---------------- boot ----------------
  const hashTab = () => { const h = location.hash.slice(1); if (TABS[h]) { state.tab = h; lsSet(LS.tab, h); } };
  hashTab();
  window.addEventListener('hashchange', () => { hashTab(); render(); });
  render();
  setSync();
  if (remote()) sync(true);
  window.addEventListener('online', () => remote() && sync(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && remote() && !state.syncing) sync(true); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
})();
