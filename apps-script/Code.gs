/**
 * Backend ติดตามการผ่อนบ้าน — Google Apps Script ผูกกับ Google Sheets
 * ชีต: Payments (รายการจ่าย), Settings (ค่าตั้งค่าเป็น JSON)
 * Script Properties: PIN = รหัสที่ใช้ร่วมกัน
 */

const TZ = 'Asia/Bangkok';
const PAY_HEADERS = ['id', 'date', 'contract', 'installment', 'amount', 'type', 'payer', 'bankBalance', 'note', 'createdAt', 'updatedAt'];

// ---------- Web API ----------

function doGet(e) {
  return handle_(() => {
    checkPin_(e.parameter.pin);
    return { payments: readPayments_(), settings: readSettings_() };
  });
}

function doPost(e) {
  return handle_(() => {
    const body = JSON.parse(e.postData.contents || '{}');
    checkPin_(body.pin);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      switch (body.action) {
        case 'savePayment': return { payment: savePayment_(body.payment) };
        case 'deletePayment': deletePayment_(body.id); return { deleted: body.id };
        case 'saveSettings': writeSettings_(body.settings); return { settings: readSettings_() };
        case 'testEmail': dailyReminder(true); return { sent: true };
        default: throw new Error('unknown action: ' + body.action);
      }
    } finally {
      lock.releaseLock();
    }
  });
}

function handle_(fn) {
  let out;
  try { out = Object.assign({ ok: true }, fn()); }
  catch (err) { out = { ok: false, error: String(err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function checkPin_(pin) {
  const expected = PropertiesService.getScriptProperties().getProperty('PIN');
  if (!expected) throw new Error('ยังไม่ได้ตั้ง PIN ใน Script Properties');
  if (String(pin || '') !== String(expected)) throw new Error('PIN ไม่ถูกต้อง');
}

// ---------- Sheets ----------

function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // เก็บวันที่เป็นข้อความ กัน Sheets แปลงเป็น Date
    sh.getRange('B:B').setNumberFormat('@');
  }
  return sh;
}

function readPayments_() {
  const sh = sheet_('Payments', PAY_HEADERS);
  const values = sh.getDataRange().getValues();
  const head = values.shift();
  return values.filter((r) => r[0] !== '').map((r) => {
    const o = {};
    head.forEach((h, i) => { o[h] = r[i]; });
    if (o.date instanceof Date) o.date = Utilities.formatDate(o.date, TZ, 'yyyy-MM-dd');
    o.amount = Number(o.amount);
    o.installment = o.installment === '' ? '' : Number(o.installment);
    o.bankBalance = o.bankBalance === '' ? '' : Number(o.bankBalance);
    return o;
  });
}

function savePayment_(p) {
  if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new Error('วันที่ไม่ถูกต้อง');
  if (!(Number(p.amount) > 0)) throw new Error('ยอดต้องมากกว่า 0');
  const sh = sheet_('Payments', PAY_HEADERS);
  const now = new Date().toISOString();
  const ids = sh.getRange(1, 1, sh.getLastRow(), 1).getValues().map((r) => String(r[0]));
  const idx = p.id ? ids.indexOf(String(p.id)) : -1;
  const rec = Object.assign({}, p, {
    id: p.id || Utilities.getUuid(),
    createdAt: idx > 0 ? sh.getRange(idx + 1, PAY_HEADERS.indexOf('createdAt') + 1).getValue() : now,
    updatedAt: now,
  });
  const row = PAY_HEADERS.map((h) => (rec[h] === undefined || rec[h] === null ? '' : rec[h]));
  if (idx > 0) sh.getRange(idx + 1, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
  return rec;
}

function deletePayment_(id) {
  const sh = sheet_('Payments', PAY_HEADERS);
  const ids = sh.getRange(1, 1, sh.getLastRow(), 1).getValues().map((r) => String(r[0]));
  const idx = ids.indexOf(String(id));
  if (idx > 0) sh.deleteRow(idx + 1);
}

function readSettings_() {
  const sh = sheet_('Settings', ['key', 'value']);
  const v = sh.getRange('B2').getValue();
  return v ? JSON.parse(v) : null;
}

function writeSettings_(s) {
  if (!s || !s.contracts) throw new Error('settings ไม่ถูกต้อง');
  const sh = sheet_('Settings', ['key', 'value']);
  sh.getRange('A2:B2').setValues([['settings', JSON.stringify(s)]]);
}

// ---------- แจ้งเตือนรายวัน ----------

/** รันครั้งเดียวจาก editor เพื่อสร้าง trigger รายวัน (08:00 น.) */
function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'dailyReminder')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyReminder').timeBased().everyDays(1).atHour(8).inTimezone(TZ).create();
}

/** ตรวจงวดที่ครบกำหนดใน N วัน ถ้ายังไม่บันทึกจ่าย → ส่งอีเมล (force = ส่งทดสอบ) */
function dailyReminder(force) {
  const s = readSettings_();
  if (!s || !s.emails || !s.emails.length) return;
  const payments = readPayments_();
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const before = Number(s.remindDaysBefore == null ? 1 : s.remindDaysBefore);
  const items = [];

  s.contracts.forEach((c) => {
    const closed = payments.some((p) => p.contract === c.id && p.bankBalance !== '' && Number(p.bankBalance) <= 0);
    if (closed) return;
    const lastSeg = c.segments[c.segments.length - 1];
    const maxN = lastSeg.to ? Number(lastSeg.to) : 600;
    for (let n = 1; n <= maxN; n++) {
      const due = dueDate_(s, n);
      const diff = daysBetween_(today, due);
      if (diff < before) continue;
      if (diff > before && !force) break;
      const seg = c.segments.find((g) => n >= g.from && (!g.to || n <= g.to)) || lastSeg;
      const planned = Object.keys(seg.shares).reduce((a, k) => a + Number(seg.shares[k] || 0), 0);
      const paid = payments.filter((p) => p.contract === c.id && p.type !== 'extra' && Number(p.installment) === n)
        .reduce((a, p) => a + Number(p.amount), 0);
      if (paid < planned - 1) items.push({ c, n, due, planned, paid, shares: seg.shares });
      break;
    }
  });

  if (!items.length) {
    if (force) MailApp.sendEmail(s.emails.join(','), '[ผ่อนบ้าน] ทดสอบอีเมล', 'ระบบแจ้งเตือนทำงานปกติ — ตอนนี้ไม่มีงวดค้างบันทึก');
    return;
  }

  const lines = items.map((it) => {
    const who = Object.keys(it.shares).map((k) => `${k} ${money_(it.shares[k])}`).join(', ');
    return `• ${it.c.name} งวดที่ ${it.n} ครบกำหนด ${thaiDate_(it.due)} ยอด ${money_(it.planned)} บาท (${who})` +
      (it.paid > 0 ? ` — บันทึกแล้ว ${money_(it.paid)}` : ' — ยังไม่ได้บันทึก');
  });
  const body = `ใกล้ถึงวันจ่ายค่างวดบ้าน\n\n${lines.join('\n')}\n\nจ่ายแล้วอย่าลืมบันทึกในแอป${s.appUrl ? '\n' + s.appUrl : ''}`;
  MailApp.sendEmail(s.emails.join(','), `[ผ่อนบ้าน] เตือนจ่ายงวด ${thaiDate_(items[0].due)}`, body);
}

// ---------- วันที่ (ต้องตรงกับ engine.js) ----------

function dueDate_(s, n) {
  const p = s.firstDue.split('-').map(Number);
  const mi = p[1] - 1 + (n - 1);
  const yy = p[0] + Math.floor(mi / 12), mm = mi % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  let t = Date.UTC(yy, mm, Math.min(s.payDay, last));
  const hol = s.holidays || [];
  for (let i = 0; i < 10; i++) {
    const d = new Date(t), wd = d.getUTCDay();
    if (wd === 0 || wd === 6 || hol.indexOf(d.toISOString().slice(0, 10)) >= 0) t += 86400000; else break;
  }
  return new Date(t).toISOString().slice(0, 10);
}

function daysBetween_(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

function thaiDate_(s) { const p = s.split('-'); return `${p[2]}/${p[1]}/${Number(p[0]) + 543}`; }
function money_(x) { return Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
