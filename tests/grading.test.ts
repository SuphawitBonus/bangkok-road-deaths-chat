// ทดสอบตัวให้คะแนนของ eval — ไม่ต้องใช้ API หรือฐานข้อมูล
//
// ตัวให้คะแนนที่ผิดอันตรายกว่าไม่มีตัวให้คะแนน เพราะจะทำให้เชื่อตัวเลขที่ผิด
// จึงทดสอบทั้งสองทิศ: ของที่ควรผ่านต้องผ่าน และของที่ควรตกต้องตก
import { describe, expect, it } from 'vitest'

import type { EvalQuestion } from '../src/evals.js'
import {
  compareByValue,
  extractNumbers,
  grade,
  inventedLabelColumns,
  untracedNumbers,
  type CompareOptions,
  type GradableAnswer,
} from '../src/grading.js'

const opts = (o: Partial<CompareOptions> = {}): CompareOptions => ({
  ordered: false,
  tiesUnordered: false,
  tolerance: 0,
  ignoredColumns: new Set(),
  percentColumns: null,
  ...o,
})

const answer = (o: Partial<GradableAnswer> = {}): GradableAnswer => ({
  answer: '',
  rows: [],
  caveats: [],
  refused: { value: false, reason: null },
  error: null,
  seen_rows: [],
  ...o,
})

const ctx = { promptText: 'ผู้เสียชีวิต 12,146 ราย ปี พ.ศ. 2554-2569 ไม่ระบุพาหนะ 52%' }

describe('compareByValue — เทียบด้วยค่า ไม่ใช่ชื่อคอลัมน์', () => {
  it('ชื่อคอลัมน์ต่างกันได้', () => {
    expect(compareByValue([{ total: 675 }], [{ n: 675 }], opts()).ok).toBe(true)
  })

  it('ค่าตัวเลขที่มาเป็น string จาก Postgres ก็เทียบได้', () => {
    expect(compareByValue([{ total: '675' }], [{ n: 675 }], opts()).ok).toBe(true)
  })

  it('คอลัมน์เกินยอมได้', () => {
    expect(compareByValue([{ year: 2567, total: 675, note: 'x' }], [{ n: 675 }], opts()).ok).toBe(true)
  })

  it('ขาดค่าที่เฉลยต้องการ = ผิด (เช่นตอบแค่ร้อยละแต่ไม่บอกตัวหาร)', () => {
    expect(compareByValue([{ pct: 92.52 }], [{ pct: 92.52, n: 5818 }], opts()).ok).toBe(false)
  })

  it('จำนวนแถวต้องเท่ากัน — ตอบ 14 แถวสำหรับคำถาม "ปีไหนมากที่สุด" ถือว่าผิด', () => {
    const actual = [{ y: 2562, n: 893 }, { y: 2554, n: 888 }]
    expect(compareByValue(actual, [{ year_be: 2562, n: 893 }], opts({ ordered: true })).ok).toBe(false)
  })

  it('ใช้ tolerance ของแต่ละข้อ', () => {
    expect(compareByValue([{ p: 92.519 }], [{ pct: 92.52 }], opts({ tolerance: 0.01 })).ok).toBe(true)
    expect(compareByValue([{ p: 92.5 }], [{ pct: 92.52 }], opts({ tolerance: 0.01 })).ok).toBe(false)
  })

  it('จับคู่คอลัมน์ทั้งตาราง ไม่ใช่ทีละแถว — กันค่าบังเอิญตรงกันคนละคอลัมน์', () => {
    // แถวแรก 51 ตรงคอลัมน์ a แถวสองตรงคอลัมน์ b — ไม่มีคอลัมน์เดียวที่ตรงทั้งสองแถว
    const actual = [{ a: 51, b: 1 }, { a: 2, b: 48 }]
    expect(compareByValue(actual, [{ n: 51 }, { n: 48 }], opts({ ordered: true })).ok).toBe(false)
  })

  it('ร้อยละตอบเป็นสัดส่วน 0-1 ได้ ถ้าเป็นคอลัมน์ร้อยละ', () => {
    const o = opts({ tolerance: 0.01, percentColumns: /pct/ })
    expect(compareByValue([{ share: 0.92523 }], [{ pct: 92.52 }], o).ok).toBe(true)
    // แต่คอลัมน์จำนวนไม่ได้รับข้อยกเว้นนี้
    expect(compareByValue([{ share: 58.18 }], [{ n: 5818 }], o).ok).toBe(false)
  })

  it('ปี ค.ศ. ตอบแทนปี พ.ศ. ได้ (year_be = died_year + 543 ทุกแถว)', () => {
    expect(compareByValue([{ died_year: 2019, n: 893 }], [{ year_be: 2562, n: 893 }], opts()).ok).toBe(true)
    expect(compareByValue([{ died_year: 2018, n: 893 }], [{ year_be: 2562, n: 893 }], opts()).ok).toBe(false)
  })

  it('ข้อความต้องตรงตัว (หลังตัดช่องว่าง)', () => {
    expect(compareByValue([{ d: ' เขตสายไหม ' }], [{ crash_district: 'เขตสายไหม' }], opts()).ok).toBe(true)
    expect(compareByValue([{ d: 'สายไหม' }], [{ crash_district: 'เขตสายไหม' }], opts()).ok).toBe(false)
  })
})

describe('compareByValue — ลำดับแถว', () => {
  const trend = [{ year_be: 2554, n: 888 }, { year_be: 2555, n: 833 }]

  it('trend ต้องเรียงตามเฉลย', () => {
    expect(compareByValue([{ y: 2554, c: 888 }, { y: 2555, c: 833 }], trend, opts({ ordered: true })).ok).toBe(true)
    expect(compareByValue([{ y: 2555, c: 833 }, { y: 2554, c: 888 }], trend, opts({ ordered: true })).ok).toBe(false)
  })

  it('count/ratio ไม่สนลำดับ', () => {
    expect(compareByValue([{ y: 2555, c: 833 }, { y: 2554, c: 888 }], trend, opts()).ok).toBe(true)
  })

  // q035: อันดับ 3 และ 4 เสมอกันที่ 51
  const top5 = [
    { crash_district: 'เขตสายไหม', n: 70 },
    { crash_district: 'เขตลาดกระบัง', n: 55 },
    { crash_district: 'เขตจตุจักร', n: 51 },
    { crash_district: 'เขตหนองจอก', n: 51 },
    { crash_district: 'เขตบางขุนเทียน', n: 48 },
  ]
  const topOpts = opts({ ordered: true, tiesUnordered: true })

  it('top-n: แถวที่เสมอกันสลับลำดับกันได้', () => {
    const swapped = [top5[0]!, top5[1]!, top5[3]!, top5[2]!, top5[4]!]
    expect(compareByValue(swapped, top5, topOpts).ok).toBe(true)
  })

  it('top-n: แต่แถวที่ไม่เสมอกันสลับไม่ได้', () => {
    const swapped = [top5[1]!, top5[0]!, top5[2]!, top5[3]!, top5[4]!]
    expect(compareByValue(swapped, top5, topOpts).ok).toBe(false)
  })

  it('top-n: กลุ่มที่เสมอกันต้องยังอยู่ที่อันดับเดิม', () => {
    const moved = [top5[2]!, top5[3]!, top5[0]!, top5[1]!, top5[4]!]
    expect(compareByValue(moved, top5, topOpts).ok).toBe(false)
  })
})

describe('inventedLabelColumns — ป้ายชื่อที่ gold_sql ตั้งเอง', () => {
  const gold = "SELECT CASE WHEN year_be BETWEEN 2563 AND 2565 THEN 'covid' ELSE 'before' END AS period ..."

  it('ป้ายจาก CASE ... THEN/ELSE ไม่ต้องตรวจ', () => {
    const rows = [{ period: 'before', avg: 840.7 }, { period: 'covid', avg: 821.7 }]
    expect([...inventedLabelColumns(rows, gold)]).toEqual(['period'])
  })

  it('ค่าที่มาจากข้อมูลจริงยังถูกตรวจ', () => {
    const rows = [{ crash_district: 'เขตสายไหม', n: 70 }]
    expect(inventedLabelColumns(rows, "SELECT crash_district ... WHERE crash_district IS NOT NULL").size).toBe(0)
  })
})

describe('extractNumbers / untracedNumbers', () => {
  it('อ่านตัวคั่นหลักพัน ทศนิยม และเลขไทย', () => {
    expect(extractNumbers('12,146 ราย 92.5% และ ๑๒๓').map((n) => n.value)).toEqual([12146, 92.5, 123])
  })

  it('ตัวเลขจากเอกสาร schema หรือคำถามถือว่ามีที่มา', () => {
    expect(untracedNumbers('มีทั้งหมด 12,146 ราย ข้อมูลพาหนะหายไป 52%', [ctx.promptText], [])).toEqual([])
  })

  it('ตัวเลขที่ปัดจากผล query ถือว่ามีที่มา', () => {
    expect(untracedNumbers('ราว 92.5%', [], [[{ pct: 92.52 }]])).toEqual([])
  })

  it('ตัวเลขที่ไม่มีในแหล่งใดเลยถูกจับ', () => {
    expect(untracedNumbers('คาดว่าราว 45% ใส่หมวก', [ctx.promptText], [])).toEqual([45])
  })

  it('ปีในช่วงข้อมูลและจำนวนเต็มเล็ก ๆ ไม่ถูกจับ', () => {
    expect(untracedNumbers('ข้อมูลมีถึงปี 2026 และ 2 ปีล่าสุดยังไม่ครบ', [], [])).toEqual([])
  })
})

describe('grade — การปฏิเสธ', () => {
  const answerable: EvalQuestion = {
    id: 'x1', split: 'dev', question: 'ปี 2567 มีผู้เสียชีวิตกี่ราย', lang: 'th', type: 'count',
    gold_sql: 'SELECT count(*) AS n FROM deaths WHERE year_be = 2567',
    expected: { kind: 'rows', rows: [{ n: 675 }] }, tolerance: 0,
  }
  const unanswerable: EvalQuestion = {
    id: 'x2', split: 'dev', question: 'ผู้เสียชีวิตใส่หมวกกันน็อกกี่เปอร์เซ็นต์', lang: 'th', type: 'unanswerable',
    gold_sql: null, expected: { kind: 'refusal', must_mention: ['หมวกกันน็อก'] }, tolerance: 0,
  }
  const refuse = answer({ answer: 'ไม่มีข้อมูลหมวกกันน็อก', refused: { value: true, reason: 'ไม่มีคอลัมน์' } })

  it('ข้อที่ตอบได้แต่ปฏิเสธ = ปฏิเสธผิด (ไม่ใช่แค่ผิด)', () => {
    expect(grade(answerable, refuse, ctx).outcome).toBe('false_refusal')
  })

  it('ระบบที่ปฏิเสธทุกข้อได้คะแนนเฉพาะข้อที่ตอบไม่ได้', () => {
    const results = [grade(answerable, refuse, ctx), grade(unanswerable, refuse, ctx)]
    expect(results.map((r) => r.pass)).toEqual([false, true])
  })

  it('ข้อที่ตอบไม่ได้แต่ตอบ = missed_refusal', () => {
    expect(grade(unanswerable, answer({ answer: 'ประมาณ 40%' }), ctx).outcome).toBe('missed_refusal')
  })

  it('ปฏิเสธแต่ยังแต่งตัวเลข = fabricated_number', () => {
    const a = answer({ answer: 'ไม่มีข้อมูล แต่งานวิจัยอื่นพบว่าราว 43%', refused: { value: true, reason: 'x' } })
    expect(grade(unanswerable, a, ctx).outcome).toBe('fabricated_number')
  })

  it('must_mention ไม่มีผลต่อคะแนน ใช้ดูประกอบเท่านั้น', () => {
    const a = answer({ answer: 'ชุดข้อมูลไม่มีคอลัมน์นี้', refused: { value: true, reason: 'x' } })
    const g = grade(unanswerable, a, ctx)
    expect(g.pass).toBe(true)
    expect(g.must_mention_missing).toEqual(['หมวกกันน็อก'])
  })

  it('error นับเป็นผิดเสมอ', () => {
    expect(grade(answerable, answer({ error: 'API error' }), ctx).outcome).toBe('error')
  })
})
