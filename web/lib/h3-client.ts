// ฝั่งเบราว์เซอร์: เรียก /api/h3 และแปลงผลเป็นสิ่งที่แผนที่ใช้
// ส่วนที่เป็นฟังก์ชันล้วน (เลือก resolution สี การแยกช่องที่ถูกซ่อน) ทดสอบใน tests/h3-client.test.ts
import { canonicalQuery, K_MIN, type H3Body, type H3Cell, type H3Resolution } from './h3-api'
import type { YearsBody, YearTotal } from './years-api'

/**
 * ซูมตั้งแต่ระดับนี้ขึ้นไปใช้ res9 ต่ำกว่านี้ใช้ res8
 * ที่ละติจูดกรุงเทพฯ 1 พิกเซลที่ซูม 12.5 ≈ 26 เมตร: ช่อง res9 (กว้าง ~350 ม.) ได้ ~13 พิกเซล พออ่านออก
 * ต่ำกว่านั้น res9 จะเล็กเกินจนเป็นจุดเล็ก ๆ รกตา ขณะที่ res8 (กว้าง ~920 ม.) ยังได้ 25 พิกเซลที่ซูม 12
 */
export const ZOOM_SWITCH = 12.5

export const resolutionForZoom = (zoom: number): H3Resolution => (zoom >= ZOOM_SWITCH ? 9 : 8)

/**
 * ความสูงสูงสุดของแท่ง (เมตร) ของช่องที่มีจำนวนมากที่สุดในมุมมองนั้น
 * res8 ใช้ตอนซูมออก ต้องสูงพอให้เห็นความต่างจากระยะไกล ส่วน res9 ใช้ตอนซูมเข้าไปจนเห็นตึก ถ้าสูงเกินไป
 * แท่งจะบังตึก 3 มิติที่เป็นเหตุผลที่ซูมเข้ามาดู (ตึกส่วนใหญ่ในกรุงเทพฯ สูงหลักสิบถึงหลักร้อยเมตร)
 */
export const MAX_BAR_HEIGHT_M: Record<H3Resolution, number> = { 8: 2200, 9: 500 }

export interface VisibleCell {
  h3_index: string
  count: number
}
export interface HiddenCell {
  h3_index: string
}

export function splitCells(cells: readonly H3Cell[]): {
  visible: VisibleCell[]
  hidden: HiddenCell[]
  maxCount: number
} {
  const visible: VisibleCell[] = []
  const hidden: HiddenCell[] = []
  let maxCount = 0
  for (const c of cells) {
    if ('suppressed' in c) {
      hidden.push({ h3_index: c.h3_index })
    } else {
      visible.push({ h3_index: c.h3_index, count: c.count })
      if (c.count > maxCount) maxCount = c.count
    }
  }
  return { visible, hidden, maxCount }
}

// ── สี ──────────────────────────────────────────────────────────────────

/** ไล่จากเหลืองอ่อน (น้อย) ไปน้ำตาลแดงเข้ม (มาก) อ่านออกบนพื้นหลังสว่างและสำหรับผู้ที่ตาบอดสีส่วนใหญ่ */
export const COLOR_RAMP: readonly (readonly [number, number, number])[] = [
  [255, 237, 160],
  [254, 196, 79],
  [253, 141, 60],
  [227, 74, 51],
  [177, 0, 38],
  [100, 0, 30],
]

/** ใช้รากที่สองเพราะจำนวนต่อช่องเบ้ขวามาก (ส่วนใหญ่ 3–10 ราย มีไม่กี่ช่องที่สูงเป็นสิบ) ถ้าเป็นเส้นตรงเกือบทุกช่องจะเป็นสีอ่อนเท่ากัน */
export function colorFor(count: number, maxCount: number): [number, number, number, number] {
  const lo = Math.sqrt(K_MIN)
  const hi = Math.sqrt(Math.max(maxCount, K_MIN + 1))
  const t = Math.min(1, Math.max(0, (Math.sqrt(count) - lo) / (hi - lo)))
  const pos = t * (COLOR_RAMP.length - 1)
  const i = Math.min(COLOR_RAMP.length - 2, Math.floor(pos))
  const f = pos - i
  const a = COLOR_RAMP[i]!
  const b = COLOR_RAMP[i + 1]!
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
    235,
  ]
}

// ── เรียก API ───────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`API ${status}`)
    this.name = 'ApiError'
  }
}

export async function fetchH3(
  resolution: H3Resolution,
  yearFrom: number,
  yearTo: number,
  signal?: AbortSignal,
): Promise<H3Body> {
  // ต้องเป็นรูปมาตรฐานเท่านั้น เซิร์ฟเวอร์ปฏิเสธรูปอื่นด้วย 400 (ดู canonicalQuery)
  const url = `/api/h3?${canonicalQuery({ resolution, yearFrom, yearTo })}`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new ApiError(res.status)
  const body = (await res.json()) as H3Body
  // ตรวจรูปทรงขั้นต่ำ: ถ้า API เปลี่ยนรูปแบบ จะล้มดัง ๆ แทนที่จะวาดแผนที่ว่างเงียบ ๆ
  if (!Array.isArray(body.cells) || typeof body.summary?.total_deaths !== 'number') {
    throw new ApiError(502)
  }
  return body
}

export async function fetchYears(signal?: AbortSignal): Promise<YearsBody> {
  const res = await fetch('/api/years', { signal })
  if (!res.ok) throw new ApiError(res.status)
  const body = (await res.json()) as YearsBody
  if (!Array.isArray(body.years) || body.years.length === 0) throw new ApiError(502)
  return body
}

// ── อันดับช่อง ──────────────────────────────────────────────────────────

export interface CellRanking {
  /** ช่องที่แสดงตัวเลข เรียงจากมากไปน้อย (เท่ากันเรียงตาม h3_index ให้ผลคงที่) */
  ordered: VisibleCell[]
  /** อันดับแบบแข่งขัน (1, 2, 2, 4): จำนวนเท่ากันได้อันดับเดียวกัน */
  rankOf: Map<string, number>
}

/**
 * จัดอันดับเฉพาะช่องที่แสดงตัวเลข — ช่องที่ถูกซ่อนไม่มีอันดับ
 * ถ้าให้อันดับช่องที่ซ่อน (เช่น "อันดับ 900 จาก 1,450") จะบอกได้ว่าเป็น 1 หรือ 2 ราย ซึ่งคือสิ่งที่ซ่อนอยู่
 */
export function rankCells(visible: readonly VisibleCell[]): CellRanking {
  const ordered = [...visible].sort((a, b) => b.count - a.count || (a.h3_index < b.h3_index ? -1 : 1))
  const rankOf = new Map<string, number>()
  let rank = 0
  ordered.forEach((c, i) => {
    if (i === 0 || c.count !== ordered[i - 1]!.count) rank = i + 1
    rankOf.set(c.h3_index, rank)
  })
  return { ordered, rankOf }
}

// ── สรุปไทม์ไลน์รายปี ────────────────────────────────────────────────────

/** ปีที่มีพิกัดต่ำกว่าสัดส่วนนี้ ถือว่าแผนที่ของปีนั้นเบากว่าความจริงมาก ต้องเตือน (ปีปกติ 63–73%) */
export const LOW_COVERAGE = 0.5

export interface YearInsight {
  /** ผู้เสียชีวิตทั้งหมดในช่วงที่เลือก (รวมรายที่ไม่มีพิกัด) */
  total: number
  /** ในจำนวนนั้น มีพิกัด (อยู่บนแผนที่) กี่ราย */
  located: number
  /** located / total */
  coverage: number
  perYear: number
  /** ค่าเฉลี่ยต่อปีของทุกปีที่ข้อมูลครบ (ยอดทั้งหมด) */
  overallPerYear: number
  /** ช่วงที่เลือกต่างจากค่าเฉลี่ยรวมกี่ % (บวก = มากกว่า) */
  diffPercent: number
  peak: { year: number; deaths: number } | null
  low: { year: number; deaths: number } | null
  /** ปีในช่วงที่เลือกที่มีพิกัดน้อยกว่า LOW_COVERAGE */
  lowCoverageYears: number[]
}

/**
 * สรุปไทม์ไลน์ — แนวโน้ม (ค่าเฉลี่ย มากสุด น้อยสุด) คิดจาก "ยอดทั้งหมด" ไม่ใช่ยอดที่มีพิกัด
 * เพราะสัดส่วนที่มีพิกัดขึ้นลงตามปี (ปี 2024 เหลือ 42%) ถ้าคิดจากยอดที่มีพิกัด จะสรุปผิดว่าผู้เสียชีวิตลดลงครึ่งหนึ่ง
 */
export function yearInsight(
  located: readonly YearTotal[],
  totals: Readonly<Record<number, number>>,
  from: number,
  to: number,
): YearInsight {
  const all = Object.entries(totals)
    .map(([y, d]) => ({ year: Number(y), deaths: d }))
    .sort((a, b) => a.year - b.year)
  const sum = (xs: readonly { deaths: number }[]) => xs.reduce((s, y) => s + y.deaths, 0)
  const inRange = all.filter((y) => y.year >= from && y.year <= to)
  const locatedOf = new Map(located.map((y) => [y.year, 'deaths' in y ? y.deaths : 0]))
  const total = sum(inRange)
  const locatedSum = inRange.reduce((s, y) => s + (locatedOf.get(y.year) ?? 0), 0)
  const overallPerYear = all.length ? sum(all) / all.length : 0
  const perYear = inRange.length ? total / inRange.length : 0
  const byDeaths = [...inRange].sort((a, b) => b.deaths - a.deaths || a.year - b.year)
  return {
    total,
    located: locatedSum,
    coverage: total > 0 ? locatedSum / total : 0,
    perYear,
    overallPerYear,
    diffPercent: overallPerYear > 0 ? Math.round(((perYear - overallPerYear) / overallPerYear) * 100) : 0,
    peak: byDeaths[0] ?? null,
    low: byDeaths.at(-1) ?? null,
    lowCoverageYears: inRange
      .filter((y) => y.deaths > 0 && (locatedOf.get(y.year) ?? 0) / y.deaths < LOW_COVERAGE)
      .map((y) => y.year),
  }
}

/** ข้อความภาษาไทยสำหรับผู้ใช้ — ไม่มีรายละเอียดภายใน */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 400) return 'ช่วงปีที่เลือกไม่ถูกต้อง ลองเลือกใหม่อีกครั้ง'
    if (err.status === 503) return 'ข้อมูลแผนที่ยังไม่พร้อมให้บริการ ลองใหม่อีกครั้งภายหลัง'
  }
  return 'โหลดข้อมูลแผนที่ไม่สำเร็จ ตรวจสอบการเชื่อมต่อแล้วลองใหม่'
}
