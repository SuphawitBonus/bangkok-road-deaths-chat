// /api/years — ยอดรวมทั้งเมืองรายปีสำหรับไทม์ไลน์ ทดสอบที่ชั้นตรรกะ ไม่ต้องมีฐานข้อมูล
import { describe, expect, it, vi } from 'vitest'

import { K_MIN } from '../web/lib/h3-api.js'
import { buildYearsBody, handleYears, type YearRow, type YearsBody, type YearsDeps } from '../web/lib/years-api.js'
import { DATA_YEAR_MAX_COMPLETE, DATA_YEAR_MIN } from '../web/lib/years.js'

const allYears = (deaths = (y: number) => 400 + (y % 7)): YearRow[] =>
  Array.from({ length: DATA_YEAR_MAX_COMPLETE - DATA_YEAR_MIN + 1 }, (_, i) => ({
    year: DATA_YEAR_MIN + i,
    deaths: deaths(DATA_YEAR_MIN + i),
  }))

const deps = (rows: YearRow[] | Error): YearsDeps => ({
  queryYears: vi.fn(async () => {
    if (rows instanceof Error) throw rows
    return rows
  }),
  logError: vi.fn(),
})

describe('buildYearsBody', () => {
  it('ครบทุกปีที่ข้อมูลครบ เรียงตามปี (ค.ศ.) และผลรวมเท่ากับแถวที่ส่งเข้า', () => {
    const rows = allYears()
    const body = buildYearsBody([...rows].reverse())
    expect(body.years.map((y) => y.year)).toEqual(rows.map((r) => r.year))
    expect(body.year_from).toBe(DATA_YEAR_MIN)
    expect(body.year_to).toBe(DATA_YEAR_MAX_COMPLETE)
    const sum = body.years.reduce((s, y) => s + ('deaths' in y ? y.deaths : 0), 0)
    expect(sum).toBe(rows.reduce((s, r) => s + r.deaths, 0))
  })

  it('ปีที่น้อยกว่า k ถูกซ่อนเหมือนช่อง H3 (ไม่มี deaths ติดไป)', () => {
    const body = buildYearsBody(allYears((y) => (y === 2015 ? K_MIN - 1 : y === 2016 ? K_MIN : 500)))
    expect(body.years.find((y) => y.year === 2015)).toEqual({ year: 2015, suppressed: true })
    expect(body.years.find((y) => y.year === 2016)).toEqual({ year: 2016, deaths: K_MIN })
  })

  it('ขาดปีใดปีหนึ่ง (ตารางโหลดไม่ครบ) → throw ไม่เติม 0 เงียบ ๆ', () => {
    expect(() => buildYearsBody(allYears().filter((r) => r.year !== 2018))).toThrow()
    expect(() => buildYearsBody([])).toThrow()
  })

  it('ปีนอกช่วงที่ข้อมูลครบ (ลืมกรอง is_complete_year) / ปีซ้ำ / จำนวนผิดปกติ → throw', () => {
    expect(() => buildYearsBody([...allYears(), { year: 2025, deaths: 300 }])).toThrow()
    expect(() => buildYearsBody([...allYears(), { year: 2011, deaths: 1 }])).toThrow()
    expect(() => buildYearsBody(allYears((y) => (y === 2012 ? 0 : 5)))).toThrow()
    expect(() => buildYearsBody(allYears((y) => (y === 2012 ? 2.5 : 5)))).toThrow()
  })

  it('ไม่ spread ฟิลด์จากแถว — ฟิลด์แปลกปลอมไม่หลุด', () => {
    const rows = allYears().map((r) => ({ ...r, h3_res9: '89283082803ffff', lat: 13.7 }))
    const body = buildYearsBody(rows)
    for (const y of body.years) expect(Object.keys(y).sort()).toEqual(['deaths', 'year'])
  })
})

describe('handleYears', () => {
  it('200: มีเฉพาะฟิลด์ที่อนุญาต', async () => {
    const r = await handleYears('', deps(allYears()))
    expect(r.status).toBe(200)
    const body = r.body as YearsBody
    expect(Object.keys(body).sort()).toEqual(['k', 'year_from', 'year_to', 'years'])
    expect(JSON.stringify(body)).not.toMatch(/web_reader|lat|lng|h3_|error/)
  })

  it('400: มีพารามิเตอร์ใด ๆ (กันการเปลี่ยน URL เพื่อหลบ cache) ไม่แตะฐานข้อมูล และไม่สะท้อนค่ากลับ', async () => {
    const d = deps(allYears())
    const r = await handleYears('?year_from=abc<script>', d)
    expect(r.status).toBe(400)
    expect(d.queryYears).not.toHaveBeenCalled()
    expect(JSON.stringify(r.body)).not.toContain('script')
    expect(JSON.stringify(r.body)).not.toContain('year_from')
  })

  it.each(['?a=1', '?&', '?=', '?%20', '?cb=123', '?year_from=2011'])(
    '400: query string ใด ๆ ที่ต่อท้ายมา (%s) — กันการเปลี่ยน URL เพื่อหลบ cache แม้ถอดรหัสแล้วไม่มีพารามิเตอร์',
    async (qs) => {
      const d = deps(allYears())
      const r = await handleYears(qs, d)
      expect(r.status).toBe(400)
      expect(d.queryYears).not.toHaveBeenCalled()
    },
  )

  it('503: ฐานข้อมูลล้ม → ข้อความกลาง ๆ ไม่มีรายละเอียดภายใน', async () => {
    const err = Object.assign(new Error('permission denied for table h3_deaths_monthly (role web_reader)'), { code: '42501' })
    const d = deps(err)
    const r = await handleYears('', d)
    expect(r.status).toBe(503)
    expect(JSON.stringify(r.body)).not.toMatch(/42501|web_reader|permission|h3_deaths/)
    expect(d.logError).toHaveBeenCalled()
  })

  it('503 (ไม่ใช่ 200 กับไทม์ไลน์ศูนย์): ตารางว่าง', async () => {
    const r = await handleYears('', deps([]))
    expect(r.status).toBe(503)
  })
})
