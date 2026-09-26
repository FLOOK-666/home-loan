/* engine.js — คำนวณตารางผ่อน / ยอดคงเหลือจริง / จำลองการโปะ (ไม่มี DOM ใช้ได้ทั้ง browser และ node)
 * วิธีคิดตรงกับตารางธนาคาร: ดอกเบี้ยรายวัน = เงินต้น × อัตรา × วัน / 365, อัตราเปลี่ยนตาม "วันที่" (คิดผสมในงวดที่คร่อม)
 * ตรวจแล้วกับตารางบ้านของธนาคาร: ดอกเบี้ยรวม 2,770,167.16 vs 2,770,167.23, ปิดงวด 392 ตรงกัน
 */
(function (root) {
  'use strict';

  const DAY = 86400000;
  const MAX_N = 600;

  // วันที่เก็บเป็น 'YYYY-MM-DD' เสมอ คำนวณด้วย UTC กันปัญหา timezone
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const fmt = (t) => new Date(t).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / DAY);
  const r2 = (x) => Math.round(x * 100) / 100;

  function dueDate(cfg, n) {
    const [y, m] = cfg.firstDue.split('-').map(Number);
    const mi = m - 1 + (n - 1);
    const yy = y + Math.floor(mi / 12), mm = ((mi % 12) + 12) % 12;
    const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
    let t = Date.UTC(yy, mm, Math.min(cfg.payDay, last));
    const hol = new Set(cfg.holidays || []);
    for (let i = 0; i < 10; i++) {
      const wd = new Date(t).getUTCDay();
      if (wd === 0 || wd === 6 || hol.has(fmt(t))) t += DAY; else break;
    }
    return fmt(t);
  }

  const periodRate = (cfg, p) => (p.type === 'mlr' ? Number(cfg.mlr) + Number(p.value) : Number(p.value));
  const sortedPeriods = (cfg) => cfg.ratePeriods.slice().sort((a, b) => (a.from < b.from ? -1 : 1));

  /** อัตรา (% ต่อปี) ที่ใช้ในวันที่ date */
  function rateAt(cfg, date) {
    const ps = sortedPeriods(cfg);
    let r = periodRate(cfg, ps[0]);
    for (const p of ps) if (p.from <= date) r = periodRate(cfg, p);
    return r;
  }

  /** ดอกเบี้ยช่วง (from, to] แบบรายวัน แยกคิดตามช่วงอัตรา */
  function interestBetween(cfg, balance, from, to) {
    if (to <= from || balance <= 0) return 0;
    const cuts = sortedPeriods(cfg).map((p) => p.from).filter((d) => d > from && d < to);
    const pts = [from, ...cuts, to];
    let sum = 0;
    for (let i = 0; i < pts.length - 1; i++) sum += balance * rateAt(cfg, pts[i]) / 100 * daysBetween(pts[i], pts[i + 1]) / 365;
    return r2(sum);
  }

  // หางวดที่วันที่นี้ตกอยู่ (งวด n = ช่วง due(n-1) < date <= due(n))
  function installmentAt(cfg, date) {
    for (let n = 1; n <= MAX_N; n++) if (dueDate(cfg, n) >= date) return n;
    return MAX_N;
  }

  const isOpen = (to) => to == null || to === '';
  function segmentFor(contract, n) {
    const segs = contract.segments;
    return segs.find((s) => n >= s.from && (isOpen(s.to) || n <= s.to)) || segs[segs.length - 1];
  }
  const segAmount = (s) => r2(Object.values(s.shares).reduce((a, b) => a + Number(b || 0), 0));
  const amountFor = (contract, n) => segAmount(segmentFor(contract, n));
  /** งวดที่แผนตั้งใจปิดสัญญา (ช่วงสุดท้ายมี to) หรือ null */
  const closingN = (contract) => { const s = contract.segments[contract.segments.length - 1]; return isOpen(s.to) ? null : Number(s.to); };

  /**
   * จำลองไปข้างหน้าจาก state {n, balance, lastDate}
   * extra: (n) => ยอดโปะเพิ่มในงวด n,  opts.minOnly: ใช้ค่างวดขั้นต่ำธนาคาร
   */
  function project(cfg, contract, state, extra, opts) {
    opts = opts || {};
    const rows = [];
    const closeAt = opts.noClose ? null : closingN(contract);
    let bal = state.balance, last = state.lastDate;
    for (let n = state.n; n <= MAX_N && bal > 0.005; n++) {
      const due = dueDate(cfg, n);
      const interest = interestBetween(cfg, bal, last, due);
      const planned = opts.amount ? opts.amount(n) : amountFor(contract, n);
      const ex = extra ? Number(extra(n) || 0) : 0;
      const pay = r2(closeAt && n >= closeAt ? bal + interest : Math.min(planned + ex, bal + interest));
      const principal = r2(pay - interest);
      if (principal <= 0) { rows.push({ n, due, interest, pay, planned, extra: ex, principal, balance: bal, stuck: true }); break; }
      bal = Math.max(0, r2(bal - principal));
      rows.push({ n, due, rate: rateAt(cfg, due), interest, pay, planned, extra: ex, principal, balance: bal });
      last = due;
    }
    const totalInterest = r2(rows.reduce((a, r) => a + r.interest, 0));
    const end = rows[rows.length - 1];
    return { rows, totalInterest, endN: end ? end.n : state.n - 1, endDate: end ? end.due : state.lastDate, stuck: !!(end && end.stuck) || bal > 0.005 };
  }

  const initialState = (cfg, contract) => ({ n: 1, balance: Number(contract.principal), lastDate: cfg.startDate });

  const hasBankBal = (p) => p.bankBalance !== '' && p.bankBalance != null && !isNaN(p.bankBalance);

  /** เล่นย้อนรายการจ่ายจริง → ยอดคงเหลือปัจจุบัน + จุดกราฟ (ถ้ามียอดคงเหลือตามธนาคาร ใช้ค่านั้นเป็นหลัก) */
  function replay(cfg, contract, payments) {
    const ps = payments.filter((p) => p.contract === contract.id)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.type === 'extra') - (b.type === 'extra')));
    let bal = Number(contract.principal), last = cfg.startDate, maxN = 0, interestPaid = 0, paidTotal = 0, extraPaid = 0;
    const points = [];
    for (const p of ps) {
      const amt = Number(p.amount);
      const interest = Math.min(interestBetween(cfg, bal, last, p.date), amt);
      bal = r2(bal - (amt - interest));
      interestPaid += interest; paidTotal += amt;
      if (p.type === 'extra') extraPaid += amt;
      if (hasBankBal(p)) bal = Number(p.bankBalance);
      bal = Math.max(0, bal);
      if (p.date > last) last = p.date;
      if (p.type !== 'extra' && Number(p.installment) > maxN) maxN = Number(p.installment);
      points.push({ date: p.date, balance: bal, n: installmentAt(cfg, p.date), bank: hasBankBal(p) });
    }
    return { balance: bal, lastDate: last, nextN: maxN + 1, interestPaid: r2(interestPaid), paidTotal: r2(paidTotal), extraPaid: r2(extraPaid), points, count: ps.length };
  }

  /** สถานะงวด: paid / partial / overdue / upcoming */
  function installmentStatus(contract, payments, n, due, planned, today) {
    const sum = payments.filter((p) => p.contract === contract.id && p.type !== 'extra' && Number(p.installment) === n)
      .reduce((a, p) => a + Number(p.amount), 0);
    if (sum >= planned - 1) return { status: 'paid', paid: sum };
    if (sum > 0) return { status: 'partial', paid: sum };
    if (due < today) return { status: 'overdue', paid: 0 };
    return { status: 'upcoming', paid: 0 };
  }

  const api = { dueDate, rateAt, interestBetween, installmentAt, segmentFor, segAmount, amountFor, closingN, project, initialState, replay, installmentStatus, daysBetween, r2, parse, fmt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LoanEngine = api;
})(this);
