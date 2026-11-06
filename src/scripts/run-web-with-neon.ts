// npm run web:neon -- <build|start|start-wrong-user> [port]
//
// รันเว็บ (next build / next start) ในเครื่องนี้โดยต่อ Neon: อ่าน NEON_WEB_DATABASE_URL จาก .env แล้วส่งให้ process ลูกเป็น
// WEB_DATABASE_URL ทาง env ของ process เท่านั้น — เหมือนที่ Vercel ส่งให้ตอนรันจริง
//
//   - ไม่พิมพ์ค่าใด ๆ จาก .env และไม่ใส่ค่านั้นลง process.env ของตัวเอง (parse ไฟล์แล้วหยิบมาตัวเดียว)
//   - NEON_ADMIN_URL ไม่ถูกส่งไปให้เว็บเด็ดขาด: process ลูกได้ env ของระบบปฏิบัติการเดิม + WEB_DATABASE_URL ตัวเดียว
//   - start-wrong-user: ทดสอบว่าเว็บไม่ยอมใช้ role อื่น โดยเปลี่ยนแค่ "ชื่อผู้ใช้" ใน URL เป็นชื่อเจ้าของฐานข้อมูล
//     (รหัสผ่านที่ส่งไปยังเป็นของ web_reader ไม่ใช่ของแอดมิน เว็บต้องปฏิเสธตั้งแต่ตรวจ URL ก่อนต่อฐานข้อมูล)
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'

import { ADMIN_ENV, parseNeonAdminUrl, parseNeonWebUrl, WEB_ENV } from '../lib/neon.js'

const MODES = ['build', 'start', 'start-wrong-user'] as const
type Mode = (typeof MODES)[number]

function main(): void {
  const [modeArg, portArg = '3011'] = process.argv.slice(2)
  if (!MODES.includes(modeArg as Mode)) {
    console.error(`ใช้: npm run web:neon -- <${MODES.join('|')}> [port]`)
    process.exit(2)
  }
  const mode = modeArg as Mode

  const file = parseEnv(readFileSync(resolve('.env'), 'utf8'))
  const raw = file[WEB_ENV]
  if (!raw) {
    console.error(`ไม่พบ ${WEB_ENV} ใน .env — รัน npm run neon:sync ก่อน`)
    process.exit(1)
  }
  parseNeonWebUrl(raw) // ต้องเป็น web_reader ไม่ใช่เครื่องตัวเอง (throw ถ้าไม่ใช่ โดยข้อความไม่มีค่า)

  let value = raw
  if (mode === 'start-wrong-user') {
    const adminRaw = file[ADMIN_ENV]
    if (!adminRaw) {
      console.error(`ไม่พบ ${ADMIN_ENV} ใน .env`)
      process.exit(1)
    }
    const url = new URL(raw)
    url.username = parseNeonAdminUrl(adminRaw).username // เอาแค่ชื่อผู้ใช้ ไม่เอารหัสผ่านของแอดมิน
    value = url.toString()
  }

  // env ลูก = env ของระบบเดิม + WEB_DATABASE_URL (ไม่มีอะไรจาก .env นอกจากค่านี้)
  const env: NodeJS.ProcessEnv = { ...process.env, WEB_DATABASE_URL: value }
  // ค่าเก่าที่ชี้ไปที่อื่นต้องไม่รอดมา (เช่น เทอร์มินัลที่ตั้ง WEB_DB_PASSWORD ไว้) เพื่อให้ผลทดสอบมาจาก URL นี้เท่านั้น
  delete env.WEB_DB_PASSWORD
  delete env.WEB_DB_USER

  const next = resolve('web/node_modules/next/dist/bin/next')
  const args = mode === 'build' ? [next, 'build'] : [next, 'start', '--port', portArg]
  console.log(`web:neon ${mode}${mode === 'build' ? '' : ` (พอร์ต ${portArg})`} — WEB_DATABASE_URL มาจาก ${WEB_ENV} (ไม่พิมพ์ค่า)`)
  const child = spawn(process.execPath, args, { cwd: resolve('web'), env, stdio: 'inherit' })
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig))
}

try {
  main()
} catch (err) {
  console.error(err instanceof Error ? err.message : 'ผิดพลาด')
  process.exit(1)
}
