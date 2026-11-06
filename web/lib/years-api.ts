// ตรรกะของ /api/years — จำนวนผู้เสียชีวิตที่มีพิกัด รวมทั้งกรุงเทพฯ แยกรายปี (ใช้วาดไทม์ไลน์ใต้แผนที่)
//
// ทำไมแยกเป็น endpoint ใหม่ ไม่ให้หน้าเว็บยิง /api/h3 ทีละปี 14 ครั้งแล้วอ่าน summary.total_deaths:
// ได้ตัวเลขเดียวกัน (จึงไม่เปิดข้อมูลเพิ่ม) แต่คำขอเดียวแทน 14 และไม่ต้องลากหกเหลี่ยมนับพันช่องมาเพื่อใช้แค่ยอดรวม
//
// สิ่งที่ response ส่งออกไปได้ (และเฉพาะนี้): ต่อปี { year, deaths } หรือ { year, suppressed: true }
// ยอดรวมทั้งเมืองต่อปีอยู่ในหลักร้อย กฎ k จึงไม่น่าทำงานเลย แต่ยังใส่ไว้ เพื่อให้ทุกตัวเลขที่ออกจากเว็บ
// ผ่านกฎเดียวกัน ถ้าวันหนึ่งมีคนเพิ่มตัวกรองเขตหรือเดือนเข้ามา ตัวเลขเล็กจะไม่หลุดโดยไม่มีใครตั้งใจ
import { K_MIN } from './h3-api'
import { DATA_YEAR_MAX_COMPLETE, DATA_YEAR_MIN } from './years'

export interface YearRow {
  year: number
  deaths: number
}

export type YearTotal = { year: number; deaths: number } | { year: number; suppressed: true }

export interface YearsBody {
  /** ค.ศ. */
  year_from: number
  /** ค.ศ. */
  year_to: number
  k: number
  years: YearTotal[]
}

export interface YearsErrorBody {
  error: 'invalid_parameter' | 'service_unavailable'
  message: string
}

export interface YearsDeps {
  queryYears: () => Promise<YearRow[]>
  logError: (context: string, err: unknown) => void
}

export interface YearsResult {
  status: 200 | 400 | 503
  body: YearsBody | YearsErrorBody
}

/**
 * สร้าง body ให้ครบทุกปีที่ข้อมูลครบ (DATA_YEAR_MIN..DATA_YEAR_MAX_COMPLETE) เรียงตามปี
 * ปีที่ไม่มีแถวเลย = ตารางโหลดไม่ครบ (ทุกปีมีผู้เสียชีวิตแน่นอน) → throw ไม่ใช่เติม 0 เงียบ ๆ
 * ปีนอกช่วงที่ฐานข้อมูลส่งมา (เช่นลืมกรอง is_complete_year) → throw
 */
export function buildYearsBody(rows: readonly YearRow[]): YearsBody {
  const byYear = new Map<number, number>()
  for (const r of rows) {
    const year = Number(r.year)
    const deaths = Number(r.deaths)
    if (!Number.isInteger(year) || year < DATA_YEAR_MIN || year > DATA_YEAR_MAX_COMPLETE) {
      throw new Error(`unexpected year ${String(r.year)}`)
    }
    if (!Number.isInteger(deaths) || deaths < 1) throw new Error(`invalid death count for ${year}`)
    if (byYear.has(year)) throw new Error(`duplicate year ${year}`)
    byYear.set(year, deaths)
  }

  const years: YearTotal[] = []
  for (let y = DATA_YEAR_MIN; y <= DATA_YEAR_MAX_COMPLETE; y++) {
    const deaths = byYear.get(y)
    if (deaths === undefined) throw new Error(`missing year ${y}`)
    // สร้างจากฟิลด์ที่ระบุชื่อเองเหมือน buildH3Body ไม่ spread แถว
    years.push(deaths < K_MIN ? { year: y, suppressed: true } : { year: y, deaths })
  }
  return { year_from: DATA_YEAR_MIN, year_to: DATA_YEAR_MAX_COMPLETE, k: K_MIN, years }
}

const UNAVAILABLE: YearsErrorBody = {
  error: 'service_unavailable',
  message: 'The map data is temporarily unavailable. Please try again later.',
}

export async function handleYears(params: URLSearchParams, deps: YearsDeps): Promise<YearsResult> {
  // ไม่มีพารามิเตอร์ใดเลย ทุกอย่างที่ส่งมาคือการเปลี่ยน URL เพื่อหลบ cache → 400 (ไม่สะท้อนชื่อกลับไป)
  if ([...params.keys()].length > 0) {
    return { status: 400, body: { error: 'invalid_parameter', message: 'this endpoint takes no parameters' } }
  }

  let rows: YearRow[]
  try {
    rows = await deps.queryYears()
  } catch (err) {
    deps.logError('query failed', err)
    return { status: 503, body: UNAVAILABLE }
  }

  try {
    return { status: 200, body: buildYearsBody(rows) }
  } catch (err) {
    // รวมกรณีตารางว่าง (ทุกปีหายหมด) — ตอบ 503 ไม่ใช่ 200 กับไทม์ไลน์ศูนย์ทั้งเส้น
    deps.logError('invalid or incomplete data in app.h3_deaths_monthly', err)
    return { status: 503, body: UNAVAILABLE }
  }
}
