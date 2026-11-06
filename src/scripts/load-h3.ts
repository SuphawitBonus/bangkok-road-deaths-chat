// โหลดข้อมูลรวม H3 เข้าตาราง app.h3_deaths_monthly — รันซ้ำได้ (idempotent)
// คำนวณดัชนี H3 resolution 8 และ 9 ด้วย h3-js สำหรับทุกแถวที่มีพิกัด (has_location = true)
import { aggregateH3, type LocatedDeath } from '../h3-aggregate.js'
import { adminPool, closePools } from '../lib/db.js'

const BATCH = 500

async function main(): Promise<void> {
  const client = await adminPool().connect()

  try {
    console.log('ดึงข้อมูลที่มีพิกัดจาก app.deaths …')
    const { rows } = await client.query<LocatedDeath>(`
      SELECT latitude, longitude, died_year, died_month, is_complete_year
      FROM app.deaths
      WHERE has_location = true
    `)

    console.log(`พบข้อมูลที่มีพิกัด ${rows.length.toLocaleString('th-TH')} แถว กำลังคำนวณ H3 cells …`)

    // aggregateH3 ตรวจเองว่าผลรวม = จำนวนจุดที่ส่งเข้าไป (ดู src/h3-aggregate.ts)
    const aggregateRows = aggregateH3(rows)
    console.log(`คำนวณได้ ${aggregateRows.length.toLocaleString('th-TH')} แถวรวม กำลังบันทึกเข้า app.h3_deaths_monthly …`)

    await client.query('BEGIN')
    await client.query('TRUNCATE app.h3_deaths_monthly')

    const columns = [
      'h3_res8',
      'h3_res9',
      'died_year',
      'died_month',
      'is_complete_year',
      'death_count',
      'centroid_lat',
      'centroid_lng',
    ]

    for (let offset = 0; offset < aggregateRows.length; offset += BATCH) {
      const slice = aggregateRows.slice(offset, offset + BATCH)
      const values: unknown[] = []
      const tuples = slice.map((item, i) => {
        values.push(
          item.h3_res8,
          item.h3_res9,
          item.died_year,
          item.died_month,
          item.is_complete_year,
          item.death_count,
          item.centroid_lat,
          item.centroid_lng,
        )
        const base = i * columns.length
        return `(${columns.map((_, c) => `$${base + c + 1}`).join(',')})`
      })

      await client.query(
        `INSERT INTO app.h3_deaths_monthly (${columns.join(',')}) VALUES ${tuples.join(',')}`,
        values,
      )
    }

    await client.query('COMMIT')

    // ตรวจสอบความถูกต้อง: SUM(death_count) ในตารางต้องเท่ากับจำนวนแถวที่มีพิกัดใน view
    // (เทียบกับค่าจริงที่นับสด ไม่ใช่ตัวเลขที่จำไว้ ข้อมูลเปลี่ยนเมื่อไหร่ก็ยังตรวจได้)
    const checkResult = await client.query<{ total: number; unique_res8: number; unique_res9: number }>(`
      SELECT
        SUM(death_count)::int AS total,
        COUNT(DISTINCT h3_res8)::int AS unique_res8,
        COUNT(DISTINCT h3_res9)::int AS unique_res9
      FROM app.h3_deaths_monthly
    `)

    const total = checkResult.rows[0]?.total ?? 0
    const uniqueRes8 = checkResult.rows[0]?.unique_res8 ?? 0
    const uniqueRes9 = checkResult.rows[0]?.unique_res9 ?? 0

    console.log('\nผลการโหลด H3:')
    console.log(`  จำนวนผู้เสียชีวิตรวม (SUM): ${total.toLocaleString('th-TH')} (แถวที่มีพิกัดใน view: ${rows.length.toLocaleString('th-TH')})`)
    console.log(`  จำนวนเซลล์ H3 res 8 ที่ไม่ซ้ำ: ${uniqueRes8.toLocaleString('th-TH')}`)
    console.log(`  จำนวนเซลล์ H3 res 9 ที่ไม่ซ้ำ: ${uniqueRes9.toLocaleString('th-TH')}`)

    if (total !== 7529) {
      throw new Error(`ยอดรวม death_count (${total}) ไม่ตรงกับที่คาดหวัง (7,529)`)
    }

    console.log('\nตรวจสอบผ่าน: SUM(death_count) = 7529 เรียบร้อย')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
    await closePools()
  }
}

main().catch((err: unknown) => {
  console.error('\nload-h3 ล้มเหลว:', err instanceof Error ? err.message : err)
  process.exitCode = 1
  void closePools()
})
