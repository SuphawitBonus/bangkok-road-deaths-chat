// SQL ของ /api/h3 และ /api/years — รันด้วย web_reader ผ่าน getWebPool() เท่านั้น
import { getWebPool } from './db'
import type { H3Query, H3Row } from './h3-api'
import type { YearRow } from './years-api'

/** ยอดรวมทั้งกรุงเทพฯ ต่อปี เฉพาะปีที่ข้อมูลครบ — ไม่มีตัวกรองจากผู้ใช้เลย */
export async function queryYearRows(): Promise<YearRow[]> {
  const pool = await getWebPool()
  const { rows } = await pool.query<{ year: number; deaths: number }>(
    `SELECT died_year AS year, SUM(death_count)::int AS deaths
       FROM app.h3_deaths_monthly
      WHERE is_complete_year
      GROUP BY died_year
      ORDER BY died_year`,
  )
  return rows.map((r) => ({ year: Number(r.year), deaths: Number(r.deaths) }))
}

// ชื่อคอลัมน์เลือกจากตารางตายตัวตาม resolution ที่ผ่านการตรวจแล้ว (8 หรือ 9) ไม่เคยต่อข้อความจากผู้ใช้
const COLUMN = { 8: 'h3_res8', 9: 'h3_res9' } as const

export async function queryH3Rows(query: H3Query): Promise<H3Row[]> {
  const pool = await getWebPool()
  const column = COLUMN[query.resolution]

  // is_complete_year: ปี 2025–2026 ข้อมูลยังไม่ครบ ไม่แสดงบนแผนที่ (ดู DATA_YEAR_MAX_COMPLETE)
  const { rows } = await pool.query<{ h3_index: string; count: number }>(
    `SELECT ${column} AS h3_index, SUM(death_count)::int AS count
       FROM app.h3_deaths_monthly
      WHERE is_complete_year
        AND died_year BETWEEN $1 AND $2
      GROUP BY ${column}`,
    [query.yearFrom, query.yearTo],
  )
  return rows.map((r) => ({ h3_index: String(r.h3_index), count: Number(r.count) }))
}
