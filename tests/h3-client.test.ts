// ทดสอบตรรกะฝั่งเบราว์เซอร์ที่เป็นฟังก์ชันล้วน (เลือก resolution, สี, แยกช่องที่ถูกซ่อน)
import { describe, expect, it, vi } from 'vitest'

import { K_MIN, parseH3Request, type H3Cell } from '../web/lib/h3-api.js'
import {
  ApiError,
  COLOR_RAMP,
  colorFor,
  describeError,
  fetchH3,
  rankCells,
  resolutionForZoom,
  splitCells,
  yearInsight,
  ZOOM_SWITCH,
} from '../web/lib/h3-client.js'
import type { YearTotal } from '../web/lib/years-api.js'

describe('rankCells', () => {
  const visible = [
    { h3_index: 'b', count: 5 },
    { h3_index: 'a', count: 9 },
    { h3_index: 'd', count: 5 },
    { h3_index: 'c', count: 3 },
  ]

  it('เรียงมากไปน้อย จำนวนเท่ากันเรียงตาม h3_index (ผลคงที่ทุกครั้ง)', () => {
    expect(rankCells(visible).ordered.map((c) => c.h3_index)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('อันดับแบบแข่งขัน: เท่ากันได้อันดับเดียวกัน อันดับถัดไปข้าม (1, 2, 2, 4)', () => {
    const { rankOf } = rankCells(visible)
    expect([rankOf.get('a'), rankOf.get('b'), rankOf.get('d'), rankOf.get('c')]).toEqual([1, 2, 2, 4])
  })

  it('จัดอันดับเฉพาะช่องที่แสดงตัวเลข — ช่องที่ซ่อนส่งเข้ามาไม่ได้และไม่มีอันดับ', () => {
    const { visible: v, hidden } = splitCells([
      { h3_index: 'x', count: 4 },
      { h3_index: 'y', suppressed: true },
    ])
    const { rankOf, ordered } = rankCells(v)
    expect(ordered).toHaveLength(1)
    expect(rankOf.has(hidden[0]!.h3_index)).toBe(false)
  })

  it('ไม่แก้ลำดับของอาร์เรย์ที่ส่งเข้ามา', () => {
    const copy = visible.map((c) => ({ ...c }))
    rankCells(visible)
    expect(visible).toEqual(copy)
  })
})

describe('yearInsight', () => {
  // ยอดทั้งหมดรายปี กับยอดที่มีพิกัด — ปี 2013 มีพิกัดแค่ 30% (แบบเดียวกับปี 2024 ในข้อมูลจริง)
  const totals = { 2011: 800, 2012: 1000, 2013: 900, 2014: 900 }
  const located: YearTotal[] = [
    { year: 2011, deaths: 560 },
    { year: 2012, deaths: 700 },
    { year: 2013, deaths: 270 },
    { year: 2014, suppressed: true },
  ]

  it('ปีเดียว: ยอดทั้งหมดของปีนั้นเทียบค่าเฉลี่ยทุกปี และบอกสัดส่วนที่อยู่บนแผนที่', () => {
    const r = yearInsight(located, totals, 2012, 2012)
    expect(r.total).toBe(1000)
    expect(r.overallPerYear).toBe(900)
    expect(r.diffPercent).toBe(11)
    expect(r.located).toBe(700)
    expect(r.coverage).toBeCloseTo(0.7)
    expect(r.lowCoverageYears).toEqual([])
  })

  it('แนวโน้มคิดจากยอดทั้งหมด ไม่ใช่ยอดที่มีพิกัด: ปีที่พิกัดหายไม่ถูกสรุปว่าเป็นปีที่ผู้เสียชีวิตน้อยสุด', () => {
    const r = yearInsight(located, totals, 2011, 2013)
    expect(r.total).toBe(2700)
    expect(r.perYear).toBe(900)
    expect(r.peak).toEqual({ year: 2012, deaths: 1000 })
    // ถ้าคิดจากยอดที่มีพิกัด ปี 2013 (270) จะเป็นปีที่น้อยสุด ซึ่งผิด — ยอดจริงน้อยสุดคือ 2011
    expect(r.low).toEqual({ year: 2011, deaths: 800 })
  })

  it('เตือนปีที่มีพิกัดไม่ถึงครึ่ง', () => {
    expect(yearInsight(located, totals, 2011, 2013).lowCoverageYears).toEqual([2013])
  })

  it('ปีที่ยอดที่มีพิกัดถูกซ่อนไม่ถูกเดาค่า (นับเป็น 0 ในส่วนที่มีพิกัด)', () => {
    const r = yearInsight(located, totals, 2014, 2014)
    expect(r.total).toBe(900)
    expect(r.located).toBe(0)
  })
})

describe('resolutionForZoom', () => {
  it('ซูมออกใช้ res8 ซูมเข้าใช้ res9 โดยตัดที่ ZOOM_SWITCH', () => {
    expect(resolutionForZoom(9)).toBe(8)
    expect(resolutionForZoom(ZOOM_SWITCH - 0.01)).toBe(8)
    expect(resolutionForZoom(ZOOM_SWITCH)).toBe(9)
    expect(resolutionForZoom(16)).toBe(9)
  })
})

describe('splitCells', () => {
  const cells: H3Cell[] = [
    { h3_index: 'a', count: 5 },
    { h3_index: 'b', suppressed: true },
    { h3_index: 'c', count: 41 },
    { h3_index: 'd', suppressed: true },
  ]

  it('แยกช่องที่แสดงกับช่องที่ซ่อน และหาค่ามากสุดจากช่องที่แสดงเท่านั้น', () => {
    const { visible, hidden, maxCount } = splitCells(cells)
    expect(visible).toEqual([{ h3_index: 'a', count: 5 }, { h3_index: 'c', count: 41 }])
    expect(hidden).toEqual([{ h3_index: 'b' }, { h3_index: 'd' }])
    expect(maxCount).toBe(41)
  })

  it('ช่องที่ซ่อนไม่มีฟิลด์ count ติดไปด้วย', () => {
    for (const h of splitCells(cells).hidden) expect(Object.keys(h)).toEqual(['h3_index'])
  })

  it('ซ่อนหมด → ไม่มีช่องที่แสดง ค่ามากสุดเป็น 0', () => {
    expect(splitCells([{ h3_index: 'x', suppressed: true }])).toEqual({
      visible: [],
      hidden: [{ h3_index: 'x' }],
      maxCount: 0,
    })
  })
})

describe('colorFor', () => {
  it('น้อยสุด (k) ได้สีอ่อนสุด มากสุดได้สีเข้มสุด', () => {
    const lo = colorFor(K_MIN, 40)
    const hi = colorFor(40, 40)
    expect(lo.slice(0, 3)).toEqual([...COLOR_RAMP[0]!])
    expect(hi.slice(0, 3)).toEqual([...COLOR_RAMP.at(-1)!])
  })

  it('เข้มขึ้นเรื่อย ๆ ตามจำนวน (ความสว่างไม่เพิ่ม)', () => {
    const lum = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
    let prev = Infinity
    for (let n = K_MIN; n <= 40; n++) {
      const l = lum(colorFor(n, 40))
      expect(l).toBeLessThanOrEqual(prev + 1e-9)
      prev = l
    }
  })

  it('ค่านอกช่วงหรือ max เล็กผิดปกติไม่ทำให้พัง (ไม่มี NaN)', () => {
    for (const [n, max] of [[0, 40], [1000, 40], [3, 3], [3, 0], [5, 4]] as const) {
      expect(colorFor(n, max).every((v) => Number.isFinite(v))).toBe(true)
    }
  })
})

describe('describeError', () => {
  it('ข้อความผู้ใช้ไม่มีรายละเอียดภายในและไม่มีตัวเลขสถานะ', () => {
    for (const e of [new ApiError(400), new ApiError(503), new ApiError(500), new TypeError('Failed to fetch')]) {
      const m = describeError(e)
      expect(m).toMatch(/[ก-๙]/)
      expect(m).not.toMatch(/\d{3}|fetch|API|web_reader/i)
    }
  })
})

describe('fetchH3', () => {
  it('ขอด้วย query string รูปมาตรฐานเสมอ (เซิร์ฟเวอร์ปฏิเสธรูปอื่นด้วย 400)', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url)
      return new Response(JSON.stringify({ cells: [], summary: { total_deaths: 0 } }), { status: 200 })
    })
    try {
      for (const [res, from, to] of [[8, 2011, 2024], [9, 2020, 2020], [8, 2015, 2018]] as const) {
        await fetchH3(res, from, to)
      }
    } finally {
      vi.unstubAllGlobals()
    }
    expect(seen).toHaveLength(3)
    for (const url of seen) {
      expect(url.startsWith('/api/h3?')).toBe(true)
      expect(parseH3Request(url.slice('/api/h3'.length)).ok).toBe(true)
    }
  })
})
