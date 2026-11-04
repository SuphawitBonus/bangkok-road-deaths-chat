// โหลด CSV เข้าตารางดิบ — รันซ้ำได้ (idempotent)
//
// วิธีที่ใช้คือ TRUNCATE แล้วใส่ใหม่ทั้งหมดใน transaction เดียว เหมาะกับชุดข้อมูล
// ขนาดนี้ (12,146 แถว) และให้ผลที่คาดเดาได้: หลังรันเสร็จ ตารางตรงกับไฟล์ CSV เสมอ
// ไม่ว่าจะรันรอบแรกหรือรอบที่สิบ ถ้าระหว่างทางพัง transaction จะ rollback
// ข้อมูลเดิมอยู่ครบ ไม่มีสถานะโหลดค้างครึ่ง ๆ กลาง ๆ
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { parse } from 'csv-parse/sync'

import { adminPool, closePools } from '../lib/db.js'

const CSV_PATH = resolve('data', 'bangkok-road-deaths.csv')
const BATCH = 500

/** คอลัมน์ใน CSV ต้นทาง (ชื่อตามที่ data/fetch_data.py เขียนออกมา) */
interface CsvRow {
  year_th: string
  dead_date: string
  age: string
  sex: string
  nationality: string
  home_district: string
  acc_district: string
  acc_subdistrict: string
  vehicle: string
  helmet: string
  seatbelt: string
  icd10: string
  lat: string
  lng: string
  rec_date: string
  rec_time: string
}

const text = (v: string | undefined): string | null => {
  const t = (v ?? '').trim()
  return t === '' ? null : t
}

const int = (v: string | undefined): number | null => {
  const t = text(v)
  if (t === null) return null
  const n = Number(t)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

const num = (v: string | undefined): number | null => {
  const t = text(v)
  if (t === null) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** '2026-02-09T00:00:00' -> '2026-02-09' */
const isoDate = (v: string | undefined): string | null => {
  const t = text(v)
  return t === null ? null : t.slice(0, 10)
}

/** ต้นทางเก็บเวลาเป็น timestamp ปลอมปี 1900 เอาเฉพาะส่วนเวลา */
const timeOfDay = (v: string | undefined): string | null => {
  const t = text(v)
  if (t === null) return null
  const m = /\d{2}:\d{2}:\d{2}/.exec(t)
  return m ? m[0] : null
}

async function main(): Promise<void> {
  const csv = await readFile(CSV_PATH, 'utf8')
  const rows = parse(csv, { columns: true, bom: true, skip_empty_lines: true }) as CsvRow[]
  console.log(`อ่าน CSV ได้ ${rows.length.toLocaleString('th-TH')} แถว`)

  const client = await adminPool().connect()
  try {
    await client.query('BEGIN')

    // RESTART IDENTITY เพื่อให้ id เริ่มที่ 1 ทุกครั้ง ผลลัพธ์จึงเหมือนเดิมเป๊ะทุกรอบ
    await client.query('TRUNCATE app.deaths_raw RESTART IDENTITY')

    const columns = [
      'year_be', 'died_on', 'age', 'sex', 'nationality',
      'residence_district', 'crash_district', 'crash_subdistrict',
      'vehicle', 'helmet', 'seatbelt', 'icd10_code',
      'latitude', 'longitude', 'record_date_raw', 'record_time',
    ]

    let inserted = 0
    for (let start = 0; start < rows.length; start += BATCH) {
      const slice = rows.slice(start, start + BATCH)
      const values: unknown[] = []
      const tuples = slice.map((r, i) => {
        values.push(
          int(r.year_th), isoDate(r.dead_date), int(r.age), text(r.sex), text(r.nationality),
          text(r.home_district), text(r.acc_district), text(r.acc_subdistrict),
          text(r.vehicle), text(r.helmet), text(r.seatbelt), text(r.icd10),
          num(r.lat), num(r.lng), text(r.rec_date), timeOfDay(r.rec_time),
        )
        const base = i * columns.length
        return `(${columns.map((_, c) => `$${base + c + 1}`).join(',')})`
      })

      await client.query(
        `INSERT INTO app.deaths_raw (${columns.join(',')}) VALUES ${tuples.join(',')}`,
        values,
      )
      inserted += slice.length
    }

    await client.query('COMMIT')
    console.log(`โหลดเข้า app.deaths_raw แล้ว ${inserted.toLocaleString('th-TH')} แถว`)

    const checks = await client.query<{ label: string; n: string }>(`
      SELECT 'แถวใน view'                AS label, count(*)::text                          AS n FROM app.deaths
      UNION ALL SELECT 'ปีที่ข้อมูลครบ',          count(*) FILTER (WHERE is_complete_year)::text   FROM app.deaths
      UNION ALL SELECT 'ระบุพาหนะได้',           count(*) FILTER (WHERE vehicle_known)::text      FROM app.deaths
      UNION ALL SELECT 'มีอายุที่ใช้ได้',          count(age)::text                                 FROM app.deaths
      UNION ALL SELECT 'มีพิกัดที่ใช้ได้',         count(*) FILTER (WHERE has_location)::text       FROM app.deaths
      UNION ALL SELECT 'มีเวลาบันทึก',           count(record_hour)::text                         FROM app.deaths
    `)
    console.log('\nตรวจหลังโหลด:')
    for (const row of checks.rows) {
      console.log(`  ${row.label.padEnd(18)} ${Number(row.n).toLocaleString('th-TH')}`)
    }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
    await closePools()
  }
}

main().catch((err: unknown) => {
  console.error('\nload ล้มเหลว:', err instanceof Error ? err.message : err)
  process.exitCode = 1
  void closePools()
})
