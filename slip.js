/* slip.js — แยกข้อมูลจากสลิปโอนเงิน (ข้อความ OCR + QR ตรวจสอบสลิป) ไม่มี DOM ใช้ได้ทั้ง browser และ node
 * โหมดทดลอง: ผลลัพธ์ใช้แสดงเท่านั้น ไม่ถูกบันทึกลงข้อมูลการผ่อน
 */
(function (root) {
  'use strict';

  const BANKS = {
    '002': 'กรุงเทพ', '004': 'กสิกรไทย', '006': 'กรุงไทย', '011': 'ทีทีบี', '014': 'ไทยพาณิชย์',
    '022': 'ซีไอเอ็มบี', '024': 'ยูโอบี', '025': 'กรุงศรี', '030': 'ออมสิน', '033': 'ธอส.',
    '034': 'ธ.ก.ส.', '067': 'ทิสโก้', '069': 'เกียรตินาคินภัทร', '073': 'แลนด์ แอนด์ เฮ้าส์',
  };
  const BANK_WORDS = [
    [/krungthai|กรุงไทย|ktb/i, 'กรุงไทย'], [/k\s*plus|kasikorn|กสิกร|kbank/i, 'กสิกรไทย'],
    [/\bscb\b|ไทยพาณิชย์/i, 'ไทยพาณิชย์'], [/bangkok\s*bank|กรุงเทพ|\bbbl\b/i, 'กรุงเทพ'],
    [/krungsri|กรุงศรี/i, 'กรุงศรี'], [/\bttb\b|ทหารไทย|ธนชาต/i, 'ทีทีบี'], [/ออมสิน|\bgsb\b|mymo/i, 'ออมสิน'],
  ];
  const TH_MONTH_KEYS = ['มค', 'กพ', 'มีค', 'เมย', 'พค', 'มิย', 'กค', 'สค', 'กย', 'ตค', 'พย', 'ธค'];
  const EN_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  /** อ่าน TLV แบบ EMV (id 2 หลัก + ความยาว 2 หลัก + ค่า) */
  function tlv(s) {
    const out = {};
    let i = 0;
    while (i + 4 <= s.length) {
      const id = s.slice(i, i + 2), len = Number(s.slice(i + 2, i + 4));
      if (!/^\d{2}$/.test(id) || isNaN(len) || i + 4 + len > s.length) return null;
      out[id] = s.slice(i + 4, i + 4 + len);
      i += 4 + len;
    }
    return i === s.length ? out : null;
  }

  /** QR บนสลิป (มาตรฐาน slip verification ของ ธปท.): tag 00 → {01: API id, 02: รหัสธนาคารผู้โอน, 03: เลขอ้างอิงรายการ} */
  function parseQR(payload) {
    if (!payload) return null;
    const top = tlv(payload.trim());
    const sub = top && top['00'] ? tlv(top['00']) : null;
    if (!sub || !sub['03']) return { raw: payload, valid: false };
    return { raw: payload, valid: true, bankCode: sub['02'] || '', bank: BANKS[sub['02']] || '', transRef: sub['03'], country: top['51'] || '' };
  }

  // แก้ตัวอักษรที่ OCR สับสนบ่อยในบริบทตัวเลข
  const fixDigits = (s) => s.replace(/(?<=\d)[oO](?=[\d,.])|(?<=[\d,.])[oO](?=\d)/g, '0').replace(/(?<=\d)[lI|](?=\d)/g, '1');

  /** ตัวเลขเงินในบรรทัด → [ค่า] (รองรับ 10,200.00 / 10.200.00 / 10 200.00 / 10,200) */
  function amountsIn(line) {
    const out = [];
    const re = /(?<![\d.,])(\d{1,3}(?:[,. ]\d{3})+|\d+)(?:[.,](\d{2}))?(?![\d])/g;
    let m;
    while ((m = re.exec(fixDigits(line)))) {
      const int = m[1].replace(/[,. ]/g, '');
      if (!m[2] && !/[,. ]/.test(m[1])) continue; // เลขเปล่าไม่มีทศนิยม/คอมมา → ไม่ใช่จำนวนเงิน (เช่น เลขบัญชี)
      const v = Number(int + '.' + (m[2] || '00'));
      if (v >= 0 && v < 1e8) out.push(v);
    }
    return out;
  }

  function toISO(d, m, y) {
    y = Number(y);
    if (y < 100) y += y >= 50 ? 2500 : 2000; // 69 → 2569 (พ.ศ.), 26 → 2026 (ค.ศ.)
    if (y > 2400) y -= 543;
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y < 2100)) return '';
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function findDate(text) {
    const t = text.replace(/\s+/g, ' ');
    // 26 ก.ย. 69 / 26 ก.ย 2569 — OCR มักทำจุดหายหรืออ่านจุดเป็นสระล่าง/วรรณยุกต์ (เช่น "กุย.")
    // จึงตัดจุด ช่องว่าง สระ ั ุ ู และวรรณยุกต์ทิ้งก่อนเทียบ (เก็บ ิ ี เ ไว้แยก มิ.ย / มี.ค / เม.ย)
    const reTh = /(\d{1,2})\s*([เก-ฮ][฀-๿.\s]{1,7}?)\s*(\d{4}|\d{2})(?!\d)/g;
    let m;
    while ((m = reTh.exec(t))) {
      const key = m[2].replace(/[.\sัุู็-๎]/g, '');
      const mi = TH_MONTH_KEYS.indexOf(key);
      const iso = mi >= 0 ? toISO(Number(m[1]), mi + 1, m[3]) : '';
      if (iso) return { iso, text: m[0].trim() };
      reTh.lastIndex = m.index + 1;
    }
    m = new RegExp(`(\\d{1,2})[\\s-]*(${EN_MONTHS.join('|')})[a-z]*\\.?\\s*(\\d{4}|\\d{2})(?!\\d)`, 'i').exec(t);
    if (m) { const iso = toISO(Number(m[1]), EN_MONTHS.indexOf(m[2].toLowerCase()) + 1, m[3]); if (iso) return { iso, text: m[0] }; }
    m = /(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})(?!\d)/.exec(t);
    if (m) { const iso = toISO(Number(m[1]), Number(m[2]), m[3]); if (iso) return { iso, text: m[0] }; }
    return null;
  }

  const findTime = (text) => { const m = /(?<!\d)([01]?\d|2[0-3])[:.]([0-5]\d)(?::[0-5]\d)?(?!\d)\s*(น\.?)?/.exec(text); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : ''; };

  function findRef(lines) {
    const kw = /(รหัสอ้างอิง|เลขที่อ้างอิง|หมายเลขอ้างอิง|เลขที่รายการ|รหัสรายการ|ref(?:erence)?\.?\s*(?:no|id)?|transaction\s*(?:id|no))/i;
    for (let i = 0; i < lines.length; i++) {
      if (!kw.test(lines[i])) continue;
      for (const l of [lines[i].replace(kw, ''), lines[i + 1] || '']) {
        const m = /([A-Za-z0-9]{10,})/.exec(l.replace(/[\s:：-]/g, ''));
        if (m) return m[1];
      }
    }
    return '';
  }

  /** แยกข้อมูลจากข้อความ OCR */
  function parseText(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const amountKw = /จำนวนเงิน|จํานวนเงิน|จำนวน|จํานวน|amount|ยอดเงิน|ยอดโอน|ยอดชำระ/i;
    const skipKw = /ค่าธรรมเนียม|ค่าธรรม|fee|คงเหลือ|balance/i;
    let amount = null, amountFrom = '';
    for (let i = 0; i < lines.length && amount == null; i++) {
      if (!amountKw.test(lines[i]) || skipKw.test(lines[i])) continue;
      const same = amountsIn(lines[i]).filter((v) => v > 0);
      const next = lines[i + 1] && !skipKw.test(lines[i + 1]) ? amountsIn(lines[i + 1]).filter((v) => v > 0) : [];
      const v = same[0] ?? next[0];
      if (v != null) { amount = v; amountFrom = 'keyword'; }
    }
    if (amount == null) {
      const all = lines.filter((l) => !skipKw.test(l)).flatMap(amountsIn).filter((v) => v > 0);
      if (all.length) { amount = Math.max(...all); amountFrom = 'largest'; }
    }
    const fee = (() => { const l = lines.find((x) => /ค่าธรรมเนียม|fee/i.test(x)); const a = l ? amountsIn(l) : []; return a.length ? a[0] : null; })();
    const bank = (BANK_WORDS.find(([re]) => re.test(text)) || [])[1] || '';
    const date = findDate(text);
    return { amount, amountFrom, fee, date: date ? date.iso : '', dateText: date ? date.text : '', time: findTime(text), ref: findRef(lines), bank, lineCount: lines.length };
  }

  const api = { parseText, parseQR, amountsIn, findDate, BANKS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SlipReader = api;
})(this);
