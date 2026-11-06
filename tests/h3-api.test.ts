// ทดสอบ /api/h3 ที่ชั้นตรรกะ (web/lib/h3-api.ts) — ไม่ต้องใช้ฐานข้อมูลหรือเซิร์ฟเวอร์ Next
// ส่วนที่ต่อสายกับ pool จริงตรวจด้วย curl ในรายงานท้ายงาน
import { describe, expect, it, vi } from 'vitest'

import {
  buildH3Body,
  canonicalQuery,
  handleH3,
  parseH3Request,
  K_MIN,
  parseH3Params,
  type H3Body,
  type H3Deps,
  type H3Query,
  type H3Row,
} from '../web/lib/h3-api.js'
import { DATA_YEAR_MAX_COMPLETE, DATA_YEAR_MIN, toBuddhistYear, toCommonEra } from '../web/lib/years.js'

const q = (s = '') => parseH3Params(new URLSearchParams(s))
const DEFAULT_QUERY = 'res=8&year_from=2011&year_to=2024'
const query: H3Query = { resolution: 9, yearFrom: 2011, yearTo: 2024 }

describe('parseH3Params', () => {
  it('ไม่ใส่อะไรเลย → ค่าเริ่มต้น res8 และทุกปีที่ข้อมูลครบ (2011–2024 ค.ศ. = 2554–2567 พ.ศ.)', () => {
    expect(q()).toEqual({ ok: true, query: { resolution: 8, yearFrom: 2011, yearTo: 2024 } })
  })

  it('รับ res 9 และช่วงปีที่ถูกต้อง รวมขอบเขตทั้งสองฝั่ง', () => {
    expect(q('res=9&year_from=2015&year_to=2015')).toEqual({
      ok: true,
      query: { resolution: 9, yearFrom: 2015, yearTo: 2015 },
    })
    expect(q(`year_from=${DATA_YEAR_MIN}&year_to=${DATA_YEAR_MAX_COMPLETE}`).ok).toBe(true)
  })

  it.each(['abc', '', '20.5', '-2015', '2e3', '0x7DF', ' 2015', '2015 ', '２０１５', 'NaN', 'Infinity', '20150'])(
    'year_from=%j → 400',
    (v) => {
      expect(q(`year_from=${encodeURIComponent(v)}`).ok).toBe(false)
    },
  )

  it('year_to=abc → 400', () => {
    expect(q('year_to=abc').ok).toBe(false)
  })

  it('ปีนอกช่วงที่มีข้อมูล → 400 (รวมปี 2025–2026 ที่ข้อมูลยังไม่ครบ)', () => {
    expect(q(`year_from=${DATA_YEAR_MIN - 1}`).ok).toBe(false)
    expect(q(`year_to=${DATA_YEAR_MAX_COMPLETE + 1}`).ok).toBe(false)
    expect(q('year_to=2026').ok).toBe(false)
  })

  it('ส่งปี พ.ศ. มา → 400 พร้อมบอกว่าต้องเป็น ค.ศ. (ไม่ใช่ได้ข้อมูลผิดปีเงียบ ๆ)', () => {
    const r = q('year_from=2554')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/Common Era/)
    expect(q('year_to=2567').ok).toBe(false)
  })

  it('year_from หลัง year_to → 400', () => {
    expect(q('year_from=2020&year_to=2015').ok).toBe(false)
  })

  it.each(['7', '10', 'abc', '', '08', '8.0'])('res=%j → 400', (v) => {
    expect(q(`res=${v}`).ok).toBe(false)
  })

  it('พารามิเตอร์ซ้ำหรือไม่รู้จัก → 400', () => {
    expect(q('year_from=2012&year_from=2013').ok).toBe(false)
    expect(q('foo=1').ok).toBe(false)
    expect(q('_=123456').ok).toBe(false)
  })

  it('ข้อความ error ไม่สะท้อนค่าที่ผู้ใช้ส่งมา', () => {
    const r = q('year_from=<script>alert(1)</script>')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).not.toContain('script')
  })
})

describe('buildH3Body — ซ่อนช่องที่น้อยกว่า k', () => {
  const rows: H3Row[] = [
    { h3_index: 'c', count: 1 },
    { h3_index: 'a', count: 2 },
    { h3_index: 'b', count: 3 },
    { h3_index: 'd', count: 40 },
  ]
  const body = buildH3Body(rows, query)

  it('k เท่ากับ 3', () => {
    expect(K_MIN).toBe(3)
    expect(body.k).toBe(3)
  })

  it('ช่องที่มี 1 หรือ 2 ราย ไม่ส่งตัวเลขจริง — มีแค่ h3_index กับ suppressed', () => {
    const hidden = body.cells.filter((c) => 'suppressed' in c)
    expect(hidden).toHaveLength(2)
    for (const c of hidden) expect(Object.keys(c).sort()).toEqual(['h3_index', 'suppressed'])
    expect(JSON.stringify(hidden)).not.toMatch(/count/)
  })

  it('ช่องที่มี 3 รายขึ้นไปแสดงตัวเลขจริง (ขอบเขต: 3 ไม่ถูกซ่อน)', () => {
    expect(body.cells.find((c) => c.h3_index === 'b')).toEqual({ h3_index: 'b', count: 3 })
    expect(body.cells.find((c) => c.h3_index === 'd')).toEqual({ h3_index: 'd', count: 40 })
  })

  it('สรุปยอดถูกต้อง และยอดรวมเท่ากับผลรวมของทุกแถวที่ส่งเข้ามา', () => {
    expect(body.summary).toEqual({
      total_deaths: 46,
      visible_deaths: 43,
      suppressed_cells: 2,
      suppressed_deaths: 3,
    })
    expect(body.summary.total_deaths).toBe(rows.reduce((s, r) => s + r.count, 0))
  })

  it('เรียงตาม h3_index ไม่ใช่ตามจำนวน — ตำแหน่งของช่องที่ซ่อนต้องไม่บอกว่าเป็น 1 หรือ 2 ราย', () => {
    expect(body.cells.map((c) => c.h3_index)).toEqual(['a', 'b', 'c', 'd'])
    // สลับลำดับแถวขาเข้า ผลต้องเหมือนเดิมทุกประการ
    expect(buildH3Body([...rows].reverse(), query).cells).toEqual(body.cells)
  })

  it('ช่องทั้งหมดซ่อน (เช่นกรองเหลือปีเดียวที่ res9 บางพื้นที่) → ไม่มี count ใดหลุด', () => {
    const all = buildH3Body([{ h3_index: 'x', count: 1 }, { h3_index: 'y', count: 2 }], query)
    expect(all.summary.visible_deaths).toBe(0)
    expect(all.cells.every((c) => !('count' in c))).toBe(true)
  })

  it('ไม่ spread ฟิลด์จากแถวฐานข้อมูล — ฟิลด์แปลกปลอมไม่หลุดออกไป', () => {
    const dirty = [{ h3_index: 'z', count: 5, centroid_lat: 13.7, death_date: '2020-01-01' }] as unknown as H3Row[]
    expect(buildH3Body(dirty, query).cells[0]).toEqual({ h3_index: 'z', count: 5 })
  })

  it('จำนวนที่ผิดปกติ (0, ติดลบ, ทศนิยม, NaN) → throw ไม่ปล่อยผ่าน', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => buildH3Body([{ h3_index: 'x', count: bad }], query)).toThrow()
    }
  })
})

describe('handleH3 — response', () => {
  const ok = (rows: H3Row[]): H3Deps => ({ queryRows: async () => rows, logError: vi.fn() })

  /** ชื่อฟิลด์ทุกตัวที่ปรากฏได้ในคำตอบ 200 — อะไรนอกจากนี้ถือว่าหลุด */
  const ALLOWED_KEYS = new Set([
    'resolution', 'year_from', 'year_to', 'k', 'cells', 'summary',
    'h3_index', 'count', 'suppressed',
    'total_deaths', 'visible_deaths', 'suppressed_cells', 'suppressed_deaths',
  ])
  const collectKeys = (v: unknown, out = new Set<string>()): Set<string> => {
    if (Array.isArray(v)) v.forEach((x) => collectKeys(x, out))
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        out.add(k)
        collectKeys(x, out)
      }
    }
    return out
  }

  it('200: มีเฉพาะฟิลด์ที่อนุญาต — ไม่มีพิกัด ชื่อ role หรือข้อความ error', async () => {
    const r = await handleH3('res=9&year_from=2011&year_to=2024', ok([
      { h3_index: '89283082803ffff', count: 12 },
      { h3_index: '89283082807ffff', count: 1 },
    ]))
    expect(r.status).toBe(200)
    expect([...collectKeys(r.body)].filter((k) => !ALLOWED_KEYS.has(k))).toEqual([])
    const text = JSON.stringify(r.body)
    expect(text).not.toMatch(/lat|lng|lon|role|web_reader|detail|error|password|postgres/i)
  })

  it('ส่งช่วงปีและความละเอียดที่ใช้จริงกลับไปให้หน้าเว็บ (ค.ศ.)', async () => {
    const r = await handleH3('res=9&year_from=2015&year_to=2018', ok([{ h3_index: 'a', count: 5 }]))
    const body = r.body as H3Body
    expect([body.resolution, body.year_from, body.year_to]).toEqual([9, 2015, 2018])
  })

  it('ส่งพารามิเตอร์ที่ตรวจแล้วเข้า query (ไม่ใช่ข้อความดิบ)', async () => {
    const queryRows = vi.fn(async () => [{ h3_index: 'a', count: 5 }])
    await handleH3('res=9&year_from=2015&year_to=2018', { queryRows, logError: vi.fn() })
    expect(queryRows).toHaveBeenCalledWith({ resolution: 9, yearFrom: 2015, yearTo: 2018 })
  })

  it('400: year_from=abc ไม่แตะฐานข้อมูล และไม่มีรายละเอียดภายใน', async () => {
    const deps = ok([{ h3_index: 'a', count: 5 }])
    const spy = vi.spyOn(deps, 'queryRows')
    const r = await handleH3('year_from=abc', deps)
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ error: 'invalid_parameter' })
    expect(spy).not.toHaveBeenCalled()
  })

  const SECRET = 'password authentication failed for user "web_reader" at 10.1.2.3:5435 (db roaddeaths)'

  it('503: ฐานข้อมูลล้ม → ข้อความกลาง ๆ ไม่มีชื่อ role / host / SQLSTATE / ข้อความจากฐานข้อมูล', async () => {
    const logError = vi.fn()
    const err = Object.assign(new Error(SECRET), { code: '28P01' })
    const r = await handleH3(DEFAULT_QUERY, { queryRows: async () => { throw err }, logError })
    expect(r.status).toBe(503)
    const text = JSON.stringify(r.body)
    for (const leak of ['web_reader', '10.1.2.3', '5435', 'roaddeaths', '28P01', 'password', 'authentication']) {
      expect(text).not.toContain(leak)
    }
    expect(Object.keys(r.body).sort()).toEqual(['error', 'message'])
    // รายละเอียดจริงต้องไปอยู่ใน log
    expect(logError).toHaveBeenCalledWith(expect.any(String), err)
  })

  it('503 (ไม่ใช่ 200 ว่าง): ตารางยังไม่มี (42P01)', async () => {
    const err = Object.assign(new Error('relation "app.h3_deaths_monthly" does not exist'), { code: '42P01' })
    const r = await handleH3(DEFAULT_QUERY, { queryRows: async () => { throw err }, logError: vi.fn() })
    expect(r.status).toBe(503)
    expect(JSON.stringify(r.body)).not.toContain('h3_deaths_monthly')
  })

  it('503: ไม่มีสิทธิ์หรือไม่มีรหัสผ่านของ web_reader (fail closed ก็ตอบ 503 ไม่หลุดรายละเอียด)', async () => {
    const r = await handleH3(DEFAULT_QUERY, {
      queryRows: async () => { throw new Error('WEB_DB_PASSWORD (or WEB_DATABASE_URL) is not set') },
      logError: vi.fn(),
    })
    expect(r.status).toBe(503)
    expect(JSON.stringify(r.body)).not.toContain('WEB_DB_PASSWORD')
  })

  it('503 (ไม่ใช่ 200 ว่าง): ช่วงปีที่ถูกต้องแต่ผลว่าง = ตารางยังไม่ได้โหลด', async () => {
    const r = await handleH3(DEFAULT_QUERY, ok([]))
    expect(r.status).toBe(503)
  })

  it('503: ข้อมูลในตารางผิดปกติ (count = 0)', async () => {
    const r = await handleH3(DEFAULT_QUERY, ok([{ h3_index: 'a', count: 0 }]))
    expect(r.status).toBe(503)
  })
})

describe('ชุด URL ที่ยอมรับต้องจำกัด (ปิดช่องหลบ cache ของ CDN → ไม่ยิงฐานข้อมูล Neon ฟรีจนเกินโควตา)', () => {
  const years = Array.from({ length: DATA_YEAR_MAX_COMPLETE - DATA_YEAR_MIN + 1 }, (_, i) => DATA_YEAR_MIN + i)

  it('มี URL ที่ถูกต้องแค่ 2 ความละเอียด × 105 ช่วงปี = 210 เส้น และแต่ละเส้นมีรูปเดียว', () => {
    const accepted: string[] = []
    for (const res of [8, 9] as const) {
      for (const from of years) {
        for (const to of years) {
          const qs = canonicalQuery({ resolution: res, yearFrom: from, yearTo: to })
          const r = parseH3Request(qs)
          if (from > to) expect(r.ok).toBe(false)
          else {
            expect(r).toEqual({ ok: true, query: { resolution: res, yearFrom: from, yearTo: to } })
            accepted.push(qs)
          }
        }
      }
    }
    expect(accepted).toHaveLength(210)
    expect(new Set(accepted).size).toBe(210)
  })

  it('ยอมรับเมื่อมี "?" นำหน้า (รูปที่ request.nextUrl.search ให้มา) เท่านั้น', () => {
    expect(parseH3Request('?res=8&year_from=2011&year_to=2024').ok).toBe(true)
    expect(parseH3Request('res=8&year_from=2011&year_to=2024').ok).toBe(true)
  })

  // คำถามเดียวกัน (res8 ทุกปี) เขียนได้หลายแบบ — ทุกแบบที่ไม่ใช่รูปมาตรฐานต้องถูกปฏิเสธ
  it.each([
    ['ไม่ใส่อะไรเลย', ''],
    ['ตัดค่าเริ่มต้นออก (res)', 'year_from=2011&year_to=2024'],
    ['ตัดค่าเริ่มต้นออก (ปี)', 'res=8'],
    ['สลับลำดับ', 'year_from=2011&year_to=2024&res=8'],
    ['สลับลำดับอีกแบบ', 'year_to=2024&year_from=2011&res=8'],
    ['เติม & ท้ายสุด', 'res=8&year_from=2011&year_to=2024&'],
    ['เติม & นำหน้า', '&res=8&year_from=2011&year_to=2024'],
    ['& ซ้อนกลางสาย', 'res=8&&year_from=2011&year_to=2024'],
    ['เข้ารหัส 2011 เป็น %32%30%31%31', 'res=8&year_from=%32%30%31%31&year_to=2024'],
    ['เข้ารหัสชื่อพารามิเตอร์', 'r%65s=8&year_from=2011&year_to=2024'],
    ['เข้ารหัสด้วยตัวพิมพ์เล็ก/ใหญ่ต่างกัน', 'res=8&year_from=%32011&year_to=2024'],
    ['ใช้ ; คั่น', 'res=8;year_from=2011;year_to=2024'],
    ['เติม # ท้าย', 'res=8&year_from=2011&year_to=2024#x'],
    ['พารามิเตอร์แปลกปลอม', 'res=8&year_from=2011&year_to=2024&_=1'],
    ['พารามิเตอร์แปลกปลอมกับ cache buster', 'res=8&year_from=2011&year_to=2024&cb=123456'],
    ['ซ้ำ', 'res=8&res=8&year_from=2011&year_to=2024'],
    ['0 นำหน้า', 'res=08&year_from=2011&year_to=2024'],
    ['เว้นวรรค (+) ในค่า', 'res=8&year_from=2011&year_to=2024+'],
  ])('ไม่ยอมรับ: %s', (_label, qs) => {
    expect(parseH3Request(qs).ok).toBe(false)
    expect(parseH3Request('?' + qs).ok).toBe(false)
  })

  it('400 และไม่แตะฐานข้อมูล สำหรับรูปที่ไม่ใช่รูปมาตรฐาน (ทุกคำขอแบบนี้ไม่ถึง Neon)', async () => {
    const queryRows = vi.fn(async () => [{ h3_index: 'a', count: 5 }])
    for (const qs of ['', '?res=8', '?year_to=2024&year_from=2011&res=8', '?res=8&year_from=2011&year_to=2024&cb=1']) {
      const r = await handleH3(qs, { queryRows, logError: vi.fn() })
      expect(r.status).toBe(400)
      expect(r.body).toMatchObject({ error: 'invalid_parameter' })
    }
    expect(queryRows).not.toHaveBeenCalled()
  })

  it('ข้อความ 400 ไม่สะท้อนสิ่งที่ผู้ใช้ส่งมา', async () => {
    const r = await handleH3('?res=8&year_from=2011&year_to=2024&cb=<script>alert(1)</script>', {
      queryRows: async () => [],
      logError: vi.fn(),
    })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).not.toMatch(/script|alert|cb=/)
  })

  it('คำตอบ 400 และ 503 ห้าม cache (ที่ route.ts ตั้ง no-store) — ตรวจจากไฟล์ route', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../web/app/api/h3/route.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/result\.status === 200[\s\S]*public, max-age=300, s-maxage=3600[\s\S]*'no-store'/)
    expect(src).toContain('request.nextUrl.search')
    expect(src).not.toContain('searchParams')
  })
})

describe('ปี: พ.ศ. ↔ ค.ศ. ใช้ค่าเดียวกันทั้งระบบ', () => {
  it('แปลงได้สองทาง และช่วงที่ข้อมูลครบ = พ.ศ. 2554–2567', () => {
    expect(toBuddhistYear(DATA_YEAR_MIN)).toBe(2554)
    expect(toBuddhistYear(DATA_YEAR_MAX_COMPLETE)).toBe(2567)
    expect(toCommonEra(2567)).toBe(2024)
    for (let y = DATA_YEAR_MIN; y <= DATA_YEAR_MAX_COMPLETE; y++) {
      expect(toCommonEra(toBuddhistYear(y))).toBe(y)
    }
  })
})
