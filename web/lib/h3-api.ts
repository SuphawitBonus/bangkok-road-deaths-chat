// ตรรกะของ /api/h3 — ฟังก์ชันล้วน รับ "ตัวดึงข้อมูล" เข้ามาจากข้างนอก (dependency injection)
// เพื่อทดสอบได้ครบทั้ง 200 / 400 / 503 โดยไม่ต้องมีฐานข้อมูลหรือเซิร์ฟเวอร์ Next
// route.ts เป็นแค่ตัวต่อสายบาง ๆ ที่เอา pool จริงมาเสียบ
//
// ──────────────────────────────────────────────────────────────────────────
// สิ่งที่ response ส่งออกไปได้ (และเฉพาะนี้)
// ──────────────────────────────────────────────────────────────────────────
//   ต่อช่อง:  { h3_index, count }  หรือ  { h3_index, suppressed: true }
//   รวม:      resolution, year_from, year_to, k, summary (ตัวเลขรวม 4 ตัว)
// ไม่มีพิกัด ไม่มีวันที่ ไม่มีชื่อ role ไม่มีข้อความ error จากฐานข้อมูล
// ข้อมูลทั้งหมดมาจากตาราง app.h3_deaths_monthly ซึ่งไม่มีข้อมูลรายคนอยู่แล้ว (ดู docs/privacy.md)
import { DATA_YEAR_MAX_COMPLETE, DATA_YEAR_MIN } from './years'

/**
 * ช่องที่มีผู้เสียชีวิตน้อยกว่าเลขนี้จะไม่ส่งตัวเลขจริง (ส่งแค่ว่า "ซ่อนอยู่")
 * ใช้กับทุกความละเอียดและทุกช่วงปี เพราะตัดสินจากยอดของช่องหลังกรองแล้ว ไม่ใช่ยอดตลอดกาล
 * (res9 เฉลี่ย 2.1 รายต่อช่อง พอกรองเป็นปีเดียว ช่องส่วนใหญ่จะเหลือ 1 ราย)
 */
export const K_MIN = 3

export type H3Resolution = 8 | 9

export interface H3Query {
  resolution: H3Resolution
  /** ค.ศ. */
  yearFrom: number
  /** ค.ศ. */
  yearTo: number
}

export interface H3Row {
  h3_index: string
  count: number
}

export type H3Cell = { h3_index: string; count: number } | { h3_index: string; suppressed: true }

export interface H3Summary {
  /** ผู้เสียชีวิตทุกรายในช่วงที่เลือก รวมช่องที่ถูกซ่อน */
  total_deaths: number
  visible_deaths: number
  suppressed_cells: number
  /** ผู้เสียชีวิตที่อยู่ในช่องที่ถูกซ่อน (ช่องละ 1–2 ราย) */
  suppressed_deaths: number
}

export interface H3Body {
  resolution: H3Resolution
  year_from: number
  year_to: number
  k: number
  cells: H3Cell[]
  summary: H3Summary
}

export interface H3ErrorBody {
  error: 'invalid_parameter' | 'service_unavailable'
  message: string
}

export interface H3Deps {
  queryRows: (query: H3Query) => Promise<H3Row[]>
  /** บันทึกรายละเอียดของความผิดพลาดฝั่งเซิร์ฟเวอร์ — ห้ามส่งต่อไปยังผู้ใช้ */
  logError: (context: string, err: unknown) => void
}

export interface H3Result {
  status: 200 | 400 | 503
  body: H3Body | H3ErrorBody
}

// ── ตรวจพารามิเตอร์ ──────────────────────────────────────────────────────

const ALLOWED_PARAMS = ['res', 'year_from', 'year_to'] as const

export type ParseResult = { ok: true; query: H3Query } | { ok: false; message: string }

const bad = (message: string): ParseResult => ({ ok: false, message })

function parseYear(raw: string | null, fallback: number, name: string): number | string {
  if (raw === null) return fallback
  if (!/^\d{4}$/.test(raw)) {
    return `${name} must be a 4-digit integer year in the Common Era (CE), e.g. ${DATA_YEAR_MIN}`
  }
  const year = Number(raw)
  if (year < DATA_YEAR_MIN || year > DATA_YEAR_MAX_COMPLETE) {
    return `${name} must be between ${DATA_YEAR_MIN} and ${DATA_YEAR_MAX_COMPLETE} in the Common Era (CE); Buddhist-era years are not accepted`
  }
  return year
}

export function parseH3Params(params: URLSearchParams): ParseResult {
  const allowed = new Set<string>(ALLOWED_PARAMS)
  for (const key of params.keys()) {
    // ไม่สะท้อนชื่อพารามิเตอร์กลับไป และไม่ปล่อยให้เปลี่ยน URL แบบสุ่มเพื่อหลบ cache ไปโดนฐานข้อมูลทุกครั้ง
    if (!allowed.has(key)) return bad('unknown parameter')
  }
  for (const key of ALLOWED_PARAMS) {
    if (params.getAll(key).length > 1) return bad(`${key} was given more than once`)
  }

  const resRaw = params.get('res')
  if (resRaw !== null && resRaw !== '8' && resRaw !== '9') return bad('res must be 8 or 9')
  const resolution: H3Resolution = resRaw === '9' ? 9 : 8

  const from = parseYear(params.get('year_from'), DATA_YEAR_MIN, 'year_from')
  if (typeof from === 'string') return bad(from)
  const to = parseYear(params.get('year_to'), DATA_YEAR_MAX_COMPLETE, 'year_to')
  if (typeof to === 'string') return bad(to)
  if (from > to) return bad('year_from must not be after year_to')

  return { ok: true, query: { resolution, yearFrom: from, yearTo: to } }
}

// ── ชุด URL ที่เป็นไปได้ต้องมีจำนวนจำกัด ─────────────────────────────────────

/**
 * query string รูปเดียวที่ยอมรับสำหรับคำถามหนึ่ง: ครบทั้งสามตัว เรียงตามนี้ ไม่เข้ารหัสอักขระ
 *
 * ทำไมเข้มขนาดนี้: ผลของ /api/h3 ถูก cache ที่ CDN โดยใช้ URL ทั้งเส้นเป็นกุญแจ ถ้ายอมให้เขียนคำถามเดียวกันได้หลายแบบ
 * (สลับลำดับพารามิเตอร์ ตัดค่าเริ่มต้นออก เติม "&" ซ้ำ เข้ารหัส "2011" เป็น "%32%30%31%31") ใครก็สร้าง URL ใหม่
 * ที่ cache ไม่เคยเห็นได้ไม่จำกัด แต่ละอันทะลุไปถึงฐานข้อมูล ซึ่งบน Neon ฟรีหมายถึงโควตาชั่วโมงประมวลผลที่ถูกเผาได้ด้วย curl วนลูป
 * ตอนนี้คำถามที่ถูกต้องมีแค่ 2 ความละเอียด × 105 ช่วงปี = 210 URL
 *
 * ตรวจสองชั้น: proxy.ts (lib/api-guard.ts) ตรวจ URL ดิบก่อนถึง cache — ชั้นนี้เป็นด่านจริง เพราะ route handler เห็นแต่ query
 * ที่ Next เขียนใหม่แล้ว (ไม่เห็นความต่างของ %32011 กับ 2011) — ส่วน handleH3 ตรวจซ้ำเป็นชั้นสำรอง
 */
export const canonicalQuery = (q: H3Query): string =>
  `res=${q.resolution}&year_from=${q.yearFrom}&year_to=${q.yearTo}`

/**
 * ตรวจ query string ดิบของคำขอ (ค่าของ request.nextUrl.search) ทั้งความหมายและรูปแบบ
 * ข้อความ error ไม่สะท้อนสิ่งที่ผู้ใช้ส่งมา
 */
export function parseH3Request(search: string): ParseResult {
  const raw = search.startsWith('?') ? search.slice(1) : search
  const parsed = parseH3Params(new URLSearchParams(raw))
  if (!parsed.ok) return parsed
  if (raw !== canonicalQuery(parsed.query)) {
    return bad('the query string must be exactly res=<8|9>&year_from=<yyyy>&year_to=<yyyy>, all three, in that order')
  }
  return parsed
}

// ── ซ่อนช่องที่น้อยเกินไป ────────────────────────────────────────────────

/**
 * สร้าง body จากแถวที่รวมแล้ว: ช่องที่ count < K_MIN ถูกแทนด้วย { suppressed: true } ไม่มี count
 *
 * สองข้อที่ตั้งใจ
 *  1. สร้างแต่ละ cell จากฟิลด์ที่ระบุชื่อเอง ไม่ spread แถวจากฐานข้อมูล ฟิลด์ใหม่ที่ใครเพิ่มใน SQL
 *     จึงหลุดไปถึงผู้ใช้ไม่ได้
 *  2. เรียงตาม h3_index ไม่ใช่ตามจำนวน ถ้าเรียงตามจำนวน ตำแหน่งของช่องที่ถูกซ่อนจะบอกว่าเป็น 1 หรือ 2 ราย
 */
export function buildH3Body(rows: readonly H3Row[], query: H3Query): H3Body {
  const cells: H3Cell[] = []
  let visible = 0
  let suppressedCells = 0
  let suppressedDeaths = 0

  for (const row of rows) {
    const count = Number(row.count)
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`invalid death count ${String(row.count)} for cell ${row.h3_index}`)
    }
    if (count < K_MIN) {
      cells.push({ h3_index: row.h3_index, suppressed: true })
      suppressedCells++
      suppressedDeaths += count
    } else {
      cells.push({ h3_index: row.h3_index, count })
      visible += count
    }
  }

  cells.sort((a, b) => (a.h3_index < b.h3_index ? -1 : a.h3_index > b.h3_index ? 1 : 0))

  return {
    resolution: query.resolution,
    year_from: query.yearFrom,
    year_to: query.yearTo,
    k: K_MIN,
    cells,
    summary: {
      total_deaths: visible + suppressedDeaths,
      visible_deaths: visible,
      suppressed_cells: suppressedCells,
      suppressed_deaths: suppressedDeaths,
    },
  }
}

// ── ตัวจัดการหลัก ────────────────────────────────────────────────────────

const UNAVAILABLE: H3ErrorBody = {
  error: 'service_unavailable',
  message: 'The map data is temporarily unavailable. Please try again later.',
}

/** @param search query string ดิบของคำขอ (`request.nextUrl.search`) ไม่ใช่ URLSearchParams ที่ถอดรหัสแล้ว */
export async function handleH3(search: string, deps: H3Deps): Promise<H3Result> {
  const parsed = parseH3Request(search)
  if (!parsed.ok) {
    return { status: 400, body: { error: 'invalid_parameter', message: parsed.message } }
  }

  let rows: H3Row[]
  try {
    rows = await deps.queryRows(parsed.query)
  } catch (err) {
    // ตารางไม่มี / ไม่มีสิทธิ์ / ฐานข้อมูลล่ม / ไม่มีรหัสผ่าน — ผู้ใช้เห็นข้อความเดียวกันหมด
    // รายละเอียดจริง (รวมรหัส SQLSTATE) อยู่ใน log ฝั่งเซิร์ฟเวอร์
    deps.logError('query failed', err)
    return { status: 503, body: UNAVAILABLE }
  }

  // ช่วงปีที่ผ่านการตรวจแล้วอยู่ในปีที่ข้อมูลครบ ซึ่งมีผู้เสียชีวิตทุกปีแน่นอน ถ้าผลว่างแปลว่าตารางยังไม่ได้โหลด
  // ตอบ 200 พร้อมแผนที่ว่างจะดูเหมือน "ไม่มีผู้เสียชีวิตเลย" ซึ่งเป็นข้อมูลที่ผิดร้ายแรง จึงตอบ 503 แทน
  if (rows.length === 0) {
    deps.logError('empty result for a valid filter (is app.h3_deaths_monthly loaded?)', null)
    return { status: 503, body: UNAVAILABLE }
  }

  try {
    return { status: 200, body: buildH3Body(rows, parsed.query) }
  } catch (err) {
    deps.logError('invalid data in app.h3_deaths_monthly', err)
    return { status: 503, body: UNAVAILABLE }
  }
}
