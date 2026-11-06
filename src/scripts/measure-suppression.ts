// วัดผลของกฎซ่อนช่อง <3 ราย กับ /api/h3 ที่กำลังรันอยู่ — ใช้ API สาธารณะอย่างเดียว เหมือนผู้ใช้ทั่วไป
//
//   npm run web:dev        (อีกเทอร์มินัล)  หรือ next start ที่พอร์ต 3010
//   npx tsx src/scripts/measure-suppression.ts [http://localhost:3010]
//
// วัดสองอย่าง
//   1) สัดส่วนช่องและผู้เสียชีวิตที่ถูกซ่อน ที่แต่ละความละเอียด (ราคาของกฎนี้ต่อประโยชน์ของแผนที่)
//   2) ขอช่วงปี [ปีแรก..Y] ทุกปี แล้วลบผลของปีติดกัน กู้ได้กี่รายการช่อง-ปีที่ "ควรถูกซ่อน" (1–2 ราย)
//      ข้อ 2 คือหลักฐานว่ากฎ k<3 เป็นกฎแสดงผล ไม่ใช่การรับประกันต่อผู้ที่ตั้งใจ (ดู docs/privacy.md)
import { DATA_YEAR_MAX_COMPLETE, DATA_YEAR_MIN } from '../../web/lib/years.js'
import type { H3Body } from '../../web/lib/h3-api.js'

const base = process.argv[2] ?? 'http://localhost:3010'

async function get(res: 8 | 9, from: number, to: number): Promise<H3Body> {
  const r = await fetch(`${base}/api/h3?res=${res}&year_from=${from}&year_to=${to}`)
  if (!r.ok) throw new Error(`API ตอบ ${r.status} — เปิดเว็บที่ ${base} แล้วหรือยัง (และมี web_reader)`)
  return (await r.json()) as H3Body
}

const pct = (a: number, b: number) => `${((100 * a) / b).toFixed(1)}%`

async function main(): Promise<void> {
  console.log(`API: ${base}\n`)

  console.log('1) สัดส่วนที่ถูกซ่อน')
  const cases: [string, 8 | 9, number, number][] = [
    ['ทุกปีที่ข้อมูลครบ', 8, DATA_YEAR_MIN, DATA_YEAR_MAX_COMPLETE],
    ['ทุกปีที่ข้อมูลครบ', 9, DATA_YEAR_MIN, DATA_YEAR_MAX_COMPLETE],
    ['ปีเดียว (ค.ศ. 2020)', 8, 2020, 2020],
    ['ปีเดียว (ค.ศ. 2020)', 9, 2020, 2020],
  ]
  for (const [label, res, from, to] of cases) {
    const b = await get(res, from, to)
    const s = b.summary
    console.log(
      `  res${res} ${label.padEnd(22)} ช่อง ${String(b.cells.length).padStart(5)} ซ่อน ${String(s.suppressed_cells).padStart(5)} ` +
        `(${pct(s.suppressed_cells, b.cells.length)}) · ผู้เสียชีวิต ${String(s.total_deaths).padStart(5)} ในช่องที่ซ่อน ${String(s.suppressed_deaths).padStart(5)} (${pct(s.suppressed_deaths, s.total_deaths)})`,
    )
  }

  console.log('\n2) กู้ตัวเลขที่ควรถูกซ่อนด้วยการลบผลของสองคำขอ')
  for (const res of [8, 9] as const) {
    // ผลของแต่ละปีสะสม [ปีแรก..Y]: ช่องที่ไม่อยู่ในผลคือ 0 ราย, ช่องที่ซ่อนคือ 1–2 (ไม่รู้ค่าแน่), ที่เหลือรู้ค่าจริง
    const prefix = new Map<number, Map<string, number | 'hidden'>>()
    for (let y = DATA_YEAR_MIN; y <= DATA_YEAR_MAX_COMPLETE; y++) {
      const b = await get(res, DATA_YEAR_MIN, y)
      prefix.set(y, new Map(b.cells.map((c) => [c.h3_index, 'count' in c ? c.count : 'hidden'])))
    }
    const known = (m: Map<string, number | 'hidden'>, id: string): number | null => {
      const v = m.get(id)
      return v === undefined ? 0 : v === 'hidden' ? null : v
    }
    const ids = new Set([...prefix.values()].flatMap((m) => [...m.keys()]))
    let recovered = 0
    for (const id of ids) {
      for (let y = DATA_YEAR_MIN + 1; y <= DATA_YEAR_MAX_COMPLETE; y++) {
        const before = known(prefix.get(y - 1)!, id)
        const after = known(prefix.get(y)!, id)
        // ส่วนต่างที่ทราบแน่ และเป็น 1 หรือ 2 = ปีนั้นช่องนี้มี 1–2 ราย ทั้งที่ควรถูกซ่อน
        if (before !== null && after !== null && after - before >= 1 && after - before <= 2) recovered++
      }
    }
    console.log(`  res${res}: กู้ได้ ${recovered} รายการช่อง-ปี ว่า "ปีนั้นช่องนี้มี 1 หรือ 2 ราย" (ใช้ ${prefix.size} คำขอ)`)
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
