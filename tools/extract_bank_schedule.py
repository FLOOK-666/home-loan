"""ดึงตารางผ่อนธนาคาร 3 สัญญาจาก home_loan_payment_schedule.xlsx -> bank-schedule.js
ใช้ Python stdlib ล้วน (ไม่ต้องติดตั้ง openpyxl)

    python tools/extract_bank_schedule.py

แต่ละแถว = [งวด, ค่างวด, ตัดเงินต้น, ตัดดอกเบี้ย, เงินต้นคงค้าง]  (null = ในไฟล์ไม่มีตัวเลข)
"""
import json, os, re, zipfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, 'home_loan_payment_schedule.xlsx')
OUT = os.path.join(ROOT, 'bank-schedule.js')

M = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
SHEETS = {'house': 'ตารางการผ่อนชำระงวดบ้าน', 'decor': 'ตารางผ่อนตกแต่ง', 'mrta': 'ตารางผ่อนประกัน'}


def read_sheets(path):
    z = zipfile.ZipFile(path)
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).iter(M + 'si'):
            shared.append(''.join(t.text or '' for t in si.iter(M + 't')))
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    rels = {r.get('Id'): r.get('Target') for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
    out = {}
    for s in wb.iter(M + 'sheet'):
        target = rels[s.get(R + 'id')].lstrip('/')
        target = target if target.startswith('xl/') else 'xl/' + target
        rows = []
        for row in ET.fromstring(z.read(target)).iter(M + 'row'):
            vals = {}
            for c in row.iter(M + 'c'):
                v = c.find(M + 'v')
                if v is None:
                    continue
                col = sum((ord(ch) - 64) * 26 ** i for i, ch in enumerate(reversed(re.match(r'[A-Z]+', c.get('r')).group(0)))) - 1
                vals[col] = shared[int(v.text)] if c.get('t') == 's' else v.text
            if vals:
                rows.append([vals.get(k, '') for k in range(max(vals) + 1)])
        out[s.get('name')] = rows
    return out


def num(x):
    try:
        return round(float(x), 2)
    except (TypeError, ValueError):
        return None


def extract(rows):
    table = []
    for r in rows:
        if len(r) < 6 or num(r[0]) is None or num(r[2]) is None:
            continue
        n = int(float(r[0]))
        if n == 0:
            continue
        pay, prin, intr, bal = num(r[2]), num(r[3]), num(r[4]), num(r[5])
        if pay == 0 and (bal in (0, None)):
            break  # หลังปิดยอดแล้ว
        table.append([n, pay, prin, intr, bal])
    return table


def main():
    sheets = read_sheets(SRC)
    data = {}
    for key, name in SHEETS.items():
        t = extract(sheets[name])
        gaps = [r[0] for r in t if r[4] is None]
        data[key] = {'sheet': name, 'rows': t}
        print(f'{key}: {len(t)} งวด (ปิดงวด {t[-1][0]}), แถวไม่มีตัวเลข {len(gaps)}' + (f' ({gaps[0]}-{gaps[-1]})' if gaps else ''))
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write('/* สร้างอัตโนมัติจาก home_loan_payment_schedule.xlsx โดย tools/extract_bank_schedule.py — อย่าแก้มือ */\n')
        f.write('/* แถว: [งวด, ค่างวด, ตัดเงินต้น, ตัดดอกเบี้ย, เงินต้นคงค้าง] — null = ไฟล์ไม่มีตัวเลข (แอปคำนวณเติมให้) */\n')
        f.write('(function (root) {\n  const BANK_SCHEDULE = ')
        f.write(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
        f.write(";\n  if (typeof module !== 'undefined' && module.exports) module.exports = BANK_SCHEDULE; else root.BANK_SCHEDULE = BANK_SCHEDULE;\n})(this);\n")
    print('->', OUT)


if __name__ == '__main__':
    main()
