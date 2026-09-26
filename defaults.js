/* ค่าเริ่มต้น (จาก home_loan_payment_schedule.xlsx) — แก้ได้ในหน้า "ตั้งค่า" ค่าที่บันทึกแล้วจะเก็บใน Google Sheets */
(function (root) {
  const DEFAULT_SETTINGS = {
    people: ['ฟลุ๊ค', 'พัช'],
    startDate: '2026-09-25',         // วันเริ่มสัญญา (งวด 0) — ใช้คิดดอกเบี้ยงวดแรก
    firstDue: '2026-10-06',          // งวด 1 = 06/10/2569
    payDay: 6,                       // ตรงเสาร์-อาทิตย์เลื่อนเป็นจันทร์ (ธนาคารไม่เลื่อนวันหยุดนักขัตฤกษ์)
    mlr: 6.30,
    ratePeriods: [                   // อัตราเปลี่ยนตามวันที่ (ครบ 3 ปี 25/09/2572)
      { from: '2026-09-25', type: 'fixed', value: 2.10 },
      { from: '2029-09-25', type: 'mlr', value: -1.72 },
    ],
    contracts: [
      {
        id: 'house', name: 'สินเชื่อบ้าน', principal: 3281000, owner: 'ฟลุ๊ค',
        segments: [
          { from: 1, to: 12, shares: { 'ฟลุ๊ค': 10200 } },
          { from: 13, to: 36, shares: { 'ฟลุ๊ค': 14760.20 } },
          { from: 37, to: null, shares: { 'ฟลุ๊ค': 16980, 'พัช': 10000 } },
        ],
      },
      {
        id: 'mrta', name: 'ประกัน MRTA', principal: 98000, owner: 'ฟลุ๊ค',
        segments: [{ from: 1, to: 36, shares: { 'ฟลุ๊ค': 2811.25 } }],
      },
      {
        id: 'decor', name: 'ตกแต่ง', principal: 328000, owner: 'พัช',
        segments: [{ from: 1, to: 36, shares: { 'พัช': 9409.09 } }],
      },
    ],
    holidays: [],                    // วันหยุดเพิ่มเติม 'YYYY-MM-DD' ถ้าธนาคารแจ้งเลื่อน
    emails: [],                      // อีเมลรับแจ้งเตือน
    remindDaysBefore: 1,
    appUrl: '',                      // ลิงก์แอป (แนบในอีเมล)
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = DEFAULT_SETTINGS; else root.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
})(this);
