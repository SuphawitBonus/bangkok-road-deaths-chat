// สร้าง schema, view และ role — รันซ้ำได้ ทุกไฟล์เขียนแบบ CREATE IF NOT EXISTS /
// CREATE OR REPLACE / ALTER จึงรันกี่รอบก็ได้ผลเหมือนเดิม
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { adminPool, closePools } from '../lib/db.js'
import { required } from '../lib/env.js'

const FILES = ['01_schema.sql', '02_view.sql', '03_security.sql'] as const

async function main(): Promise<void> {
  const aiPassword = required('AI_DB_PASSWORD')
  const client = await adminPool().connect()

  try {
    // ส่งรหัสผ่านเข้าไปเป็นค่าของ session ไม่ใช่เขียนลงไฟล์ SQL
    // 03_security.sql อ่านค่านี้ด้วย current_setting('app.ai_password')
    await client.query('SELECT set_config($1, $2, false)', ['app.ai_password', aiPassword])

    for (const name of FILES) {
      const sql = await readFile(resolve('db', name), 'utf8')
      process.stdout.write(`  ${name} … `)
      await client.query(sql)
      console.log('ok')
    }

    // ลบค่าออกจาก session ทันทีที่ใช้เสร็จ
    await client.query('SELECT set_config($1, $2, false)', ['app.ai_password', ''])

    const { rows } = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM app.deaths')
    console.log(`\nเรียบร้อย — view app.deaths มี ${Number(rows[0]!.n).toLocaleString('th-TH')} แถว`)
    if (rows[0]!.n === '0') {
      console.log('ยังไม่มีข้อมูล รันต่อด้วย  npm run db:load')
    }
  } finally {
    client.release()
    await closePools()
  }
}

main().catch((err: unknown) => {
  console.error('\nmigrate ล้มเหลว:', err instanceof Error ? err.message : err)
  process.exitCode = 1
  void closePools()
})
