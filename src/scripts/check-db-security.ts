// พิสูจน์ว่าชั้นฐานข้อมูลป้องกันได้จริง โดยยิงคำสั่งอันตรายด้วย role ของ AI ตรง ๆ
// ไม่ผ่านตัวตรวจในโค้ดเลย
//
// สคริปต์นี้คือหลักฐานว่าชั้นที่ 1 ยืนอยู่ได้ด้วยตัวเอง รันซ้ำได้ทุกเมื่อ และต้องรันอีกครั้ง
// หลังย้ายไป Neon เพราะสิทธิ์บนบริการที่จัดการให้อาจต่างจาก Postgres ในเครื่อง
import { aiPool, closePools } from '../lib/db.js'

interface Case {
  label: string
  sql: string
  /** คาดว่าจะถูกปฏิเสธ (true) หรือต้องผ่านได้ (false) */
  expectBlocked: boolean
}

const CASES: Case[] = [
  { label: 'SELECT บน view deaths', sql: 'SELECT count(*) FROM deaths', expectBlocked: false },
  { label: 'อ่านตารางดิบ deaths_raw', sql: 'SELECT * FROM app.deaths_raw LIMIT 1', expectBlocked: true },
  { label: 'INSERT', sql: "INSERT INTO app.deaths_raw (year_be, died_on) VALUES (2569, '2026-01-01')", expectBlocked: true },
  { label: 'UPDATE ผ่าน view', sql: 'UPDATE deaths SET age = 1', expectBlocked: true },
  { label: 'DELETE ผ่าน view', sql: 'DELETE FROM deaths', expectBlocked: true },
  { label: 'DROP VIEW', sql: 'DROP VIEW app.deaths', expectBlocked: true },
  { label: 'CREATE TABLE', sql: 'CREATE TABLE evil (x int)', expectBlocked: true },
  { label: 'สร้างตารางใน schema อื่น', sql: 'CREATE TABLE public.evil (x int)', expectBlocked: true },
  // ถ้า REVOKE ใน 03_security.sql สำเร็จจะโดนปฏิเสธเพราะไม่มีสิทธิ์
  // ถ้า REVOKE ไม่สำเร็จ (เช่นบน Neon) ก็ยังโดน statement_timeout อยู่ดี
  { label: 'pg_sleep นานเกิน statement_timeout', sql: 'SELECT pg_sleep(8)', expectBlocked: true },
  { label: 'อ่านไฟล์จากเครื่อง', sql: "SELECT pg_read_file('/etc/passwd')", expectBlocked: true },
  { label: 'เปลี่ยนรหัสผ่านตัวเอง', sql: "ALTER ROLE ai_reader PASSWORD 'hacked'", expectBlocked: true },
]

/** สิ่งที่ชั้นฐานข้อมูลกันไม่ได้ — ยืนยันว่ายังทำได้จริง เพื่อไม่ให้เข้าใจผิดว่าปลอดภัย 100% */
const KNOWN_GAPS: Case[] = [
  { label: 'อ่านรายชื่อตารางจาก pg_catalog', sql: 'SELECT count(*) FROM pg_catalog.pg_tables', expectBlocked: false },
  { label: 'อ่าน information_schema', sql: 'SELECT count(*) FROM information_schema.columns', expectBlocked: false },
]

/**
 * ผลขึ้นกับว่า REVOKE EXECUTE ทำได้ในสภาพแวดล้อมนั้นหรือไม่ จึงรายงานอย่างเดียว ไม่ตัดสินถูกผิด
 * ถ้าปล่อยผ่านได้ แปลว่าเหลือแค่ statement_timeout กับตัวตรวจในโค้ดที่กันช่องทางนี้
 */
const ENV_DEPENDENT: Case[] = [
  { label: 'pg_sleep สั้นกว่า timeout', sql: 'SELECT pg_sleep(0.2)', expectBlocked: true },
]

async function run(cases: Case[], title: string, judge = true): Promise<number> {
  console.log(`\n${title}`)
  console.log('─'.repeat(78))
  let failures = 0

  for (const c of cases) {
    let blocked = false
    let detail = ''
    const client = await aiPool().connect()
    try {
      await client.query(c.sql)
    } catch (err) {
      blocked = true
      detail = err instanceof Error ? err.message.split('\n')[0]! : String(err)
    } finally {
      client.release()
    }

    const pass = blocked === c.expectBlocked
    if (judge && !pass) failures++
    const mark = !judge ? '––  ' : pass ? 'ok  ' : 'FAIL'
    const verdict = blocked ? 'ถูกปฏิเสธ' : 'ผ่านได้'
    console.log(`  ${mark} ${c.label.padEnd(34)} ${verdict}`)
    if (blocked && detail) console.log(`       └ ${detail}`)
  }
  return failures
}

async function main(): Promise<void> {
  console.log('ยิงคำสั่งด้วย role ai_reader ตรง ๆ โดยไม่ผ่านตัวตรวจในโค้ด')

  const settings = await aiPool().query<{ name: string; setting: string }>(
    `SELECT name, setting FROM pg_settings
      WHERE name IN ('default_transaction_read_only','statement_timeout','search_path',
                     'idle_in_transaction_session_timeout','lock_timeout')
      ORDER BY name`,
  )
  console.log('\nค่าที่ติดมากับ role')
  console.log('─'.repeat(78))
  for (const s of settings.rows) console.log(`  ${s.name.padEnd(38)} = ${s.setting}`)

  let failures = await run(CASES, 'สิ่งที่ชั้นฐานข้อมูลต้องกันได้')
  failures += await run(KNOWN_GAPS, 'สิ่งที่ชั้นฐานข้อมูลกันไม่ได้ (ชั้นโค้ดต้องรับไป)')
  await run(ENV_DEPENDENT, 'ขึ้นกับสภาพแวดล้อม (รายงานอย่างเดียว)', false)

  console.log('─'.repeat(78))
  if (failures === 0) {
    console.log('ผ่านทุกข้อ — ชั้นฐานข้อมูลทำงานตามที่ออกแบบไว้')
  } else {
    console.log(`มี ${failures} ข้อไม่เป็นไปตามที่คาด`)
    process.exitCode = 1
  }
  await closePools()
}

main().catch((err: unknown) => {
  console.error('ตรวจไม่สำเร็จ:', err instanceof Error ? err.message : err)
  process.exitCode = 1
  void closePools()
})
