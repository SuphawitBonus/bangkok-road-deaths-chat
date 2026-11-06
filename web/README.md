# web — กรุงเทพฯ 3 มิติ

หน้าเว็บ Next.js แสดงจำนวนผู้เสียชีวิตจากอุบัติเหตุทางถนนเป็นช่องหกเหลี่ยม H3 บนแผนที่ 3 มิติ
(MapLibre GL + deck.gl + OpenFreeMap) เอกสารฝั่งความเป็นส่วนตัวและการตัดสินใจอยู่ที่
[`../docs/privacy.md`](../docs/privacy.md) และ [`../docs/decisions-web.md`](../docs/decisions-web.md)

## เปิดดูในเครื่อง

ต้องเตรียมฐานข้อมูลก่อน (ที่รากโปรเจกต์) แล้วค่อยเปิดเว็บ

```bash
# ที่รากโปรเจกต์
npm run db:up
# ใส่ WEB_DB_PASSWORD ใน .env ก่อน แล้ว
npm run db:setup      # สร้างตาราง + role web_reader + โหลดข้อมูล
npm run db:check      # ตรวจสิทธิ์ (web_reader ต้องผ่านด้วย)

# ที่โฟลเดอร์ web/
npm run dev           # http://localhost:3010 (พอร์ต 3000 มักถูกโปรเจกต์อื่นใช้)
npm run build         # build (ไม่ต้องมีรหัสผ่านฐานข้อมูล)
npm run typecheck
```

เว็บเริ่มทำงานไม่ได้ถ้าไม่มี `WEB_DB_PASSWORD` (หรือ `WEB_DATABASE_URL`) โดยตั้งใจ — ไม่มีการสลับไปใช้ role อื่น

## โปรเจกต์อิสระ

`web/` เป็นโปรเจกต์ของตัวเอง: มี `package.json`, `package-lock.json` และ `node_modules` เอง ไม่ import อะไรจากนอก `web/`
(มี test ตรวจ) และ `package.json` ที่รากไม่มี `workspaces` แล้ว ติดตั้งแพ็กเกจในโฟลเดอร์นี้ได้ตามปกติด้วย `npm install <แพ็กเกจ>`
บน Vercel ตั้ง Root Directory = `web` ขั้นตอน deploy ทั้งหมดอยู่ใน [docs/deploy.md](../docs/deploy.md)

`npm run typecheck` รัน `next typegen` ก่อน (สร้างชนิด `LayoutProps` ฯลฯ) เพราะในเครื่องที่เพิ่ง clone ยังไม่มีโฟลเดอร์ `.next`

## เวอร์ชันที่ล็อกไว้โดยตั้งใจ

`maplibre-gl` ใช้ **5.x** ไม่ใช่ 6.x: deck.gl 9.4 อ่าน `map.transform` ซึ่ง maplibre-gl 6 ย้ายออกไปแล้ว ทำให้แผนที่ไม่แสดงผล
(พิสูจน์ในเบราว์เซอร์แล้ว) อย่าอัปเกรดจนกว่า deck.gl จะรองรับ
