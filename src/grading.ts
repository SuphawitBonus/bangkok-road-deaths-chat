// ตัวให้คะแนนของ eval — ตัดสินว่าคำตอบของ ask() ถูกหรือผิด
//
// ไฟล์นี้เป็นฟังก์ชันล้วน ไม่เรียก API ไม่แตะฐานข้อมูล จึงทดสอบได้ใน tests/grading.test.ts
// เหตุผลของทุกกฎเขียนไว้ใน docs/evals.md หัวข้อ "การให้คะแนนผลของโมเดล" ด้วย
//
// ──────────────────────────────────────────────────────────────────────────
// ผลลัพธ์ของการให้คะแนน (outcome) มีชนิดเดียวต่อข้อ
// ──────────────────────────────────────────────────────────────────────────
//   correct            ข้อที่ตอบได้: ผลจากฐานข้อมูลตรงเฉลย / ข้อที่ตอบไม่ได้: ปฏิเสธและไม่แต่งตัวเลข
//   wrong_rows         ข้อที่ตอบได้: ตอบแต่ผลไม่ตรงเฉลย
//   false_refusal      ข้อที่ตอบได้: แต่โมเดลปฏิเสธ  ← "ปฏิเสธผิด" นับแยกไว้
//   missed_refusal     ข้อที่ตอบไม่ได้: แต่โมเดลตอบ
//   fabricated_number  ข้อที่ตอบไม่ได้: ปฏิเสธแล้ว แต่ยังมีตัวเลขที่หาที่มาไม่ได้ในคำตอบ
//   error              ask() ล้มเหลว (API error, SQL สุดท้ายรันไม่ผ่าน ฯลฯ) นับเป็นผิด
//
// ทำไมแยก false_refusal ออกมา: ถ้านับรวมเป็นแค่ "ผิด" ระบบที่ขี้ปฏิเสธจะดูไม่ต่างจากระบบที่
// คำนวณผิด ทั้งที่ปัญหาคนละแบบและแก้คนละทาง และถ้ารายงานแค่ "ปฏิเสธถูกกี่ % ในข้อที่ตอบไม่ได้"
// ระบบที่ปฏิเสธทุกข้อจะได้ 100% — ตัวเลขคู่กันคืออัตราปฏิเสธผิดที่ต้องต่ำด้วย

import type { EvalQuestion, ExpectedRow } from './evals.js'

export type Outcome =
  | 'correct'
  | 'wrong_rows'
  | 'false_refusal'
  | 'missed_refusal'
  | 'fabricated_number'
  | 'error'

export interface Grade {
  pass: boolean
  outcome: Outcome
  reason: string
  /** เฉพาะข้อที่ตอบไม่ได้: คำใน must_mention ที่ไม่พบในคำตอบ (ใช้ดูประกอบ ไม่มีผลต่อคะแนน) */
  must_mention_missing?: string[]
  /** เฉพาะข้อที่ตอบไม่ได้: ตัวเลขที่หาที่มาไม่ได้ */
  untraced_numbers?: number[]
}

/** ส่วนของ AskResult ที่ตัวให้คะแนนต้องใช้ — แยกไว้เพื่อให้ทดสอบได้โดยไม่ต้องสร้าง AskResult เต็ม */
export interface GradableAnswer {
  answer: string
  rows: Record<string, unknown>[]
  caveats: string[]
  refused: { value: boolean; reason: string | null }
  error: string | null
  /** แถวทุกชุดที่โมเดลเห็นระหว่างตอบ — ตัวเลขจากตรงนี้ถือว่ามีที่มา */
  seen_rows: Record<string, unknown>[][]
}

export interface GradeContext {
  /** ข้อความทั้งหมดที่โมเดลได้รับใน system prompt — ตัวเลขในเอกสาร schema ถือว่ามีที่มา */
  promptText: string
}

export function grade(q: EvalQuestion, a: GradableAnswer, ctx: GradeContext): Grade {
  if (q.expected.kind === 'refusal') return gradeUnanswerable(q, a, ctx)
  return gradeAnswerable(q, a)
}

// ══════════════════════════════════════════════════════════════════════════
// ข้อที่ตอบได้: เทียบด้วยค่า ไม่ใช่ด้วยชื่อคอลัมน์
// ══════════════════════════════════════════════════════════════════════════

function gradeAnswerable(q: EvalQuestion, a: GradableAnswer): Grade {
  if (a.error) return { pass: false, outcome: 'error', reason: a.error }
  if (a.refused.value) {
    return { pass: false, outcome: 'false_refusal', reason: `ปฏิเสธทั้งที่ตอบได้: ${a.refused.reason ?? ''}` }
  }
  if (q.expected.kind !== 'rows') throw new Error('unreachable')

  const result = compareByValue(a.rows, q.expected.rows, {
    ordered: q.type === 'trend' || q.type === 'top-n',
    tiesUnordered: q.type === 'top-n',
    tolerance: q.tolerance ?? 0,
    ignoredColumns: inventedLabelColumns(q.expected.rows, q.gold_sql ?? ''),
    percentColumns: q.type === 'ratio' || q.type === 'trend' ? /pct|percent/i : null,
  })
  return result.ok
    ? { pass: true, outcome: 'correct', reason: result.reason }
    : { pass: false, outcome: 'wrong_rows', reason: result.reason }
}

export interface CompareOptions {
  /** ลำดับแถวมีความหมาย (trend: ตามเวลา, top-n: ตามอันดับ) */
  ordered: boolean
  /** แถวที่อยู่ติดกันและเสมอกัน สลับลำดับกันได้ (ใช้กับ top-n) */
  tiesUnordered: boolean
  tolerance: number
  /** คอลัมน์ในเฉลยที่ไม่ต้องตรวจ เพราะเป็นป้ายชื่อที่ gold_sql ตั้งขึ้นเอง */
  ignoredColumns: Set<string>
  /** คอลัมน์ในเฉลยที่เป็นร้อยละ — ยอมรับคำตอบที่เป็นสัดส่วน 0-1 ด้วย */
  percentColumns: RegExp | null
}

/**
 * เทียบตารางผลลัพธ์ด้วยค่า
 *
 * วิธีคิด: หา "การจับคู่คอลัมน์" จากคอลัมน์ในเฉลยไปยังคอลัมน์ในคำตอบ (คอลัมน์ละหนึ่งตัว ไม่ซ้ำกัน)
 * ที่ทำให้ทุกแถวตรงกัน ถ้ามีอย่างน้อยหนึ่งแบบ ถือว่าตรง — เท่ากับยอมให้โมเดลตั้งชื่อคอลัมน์เองได้
 * (total แทน n) และมีคอลัมน์เกินได้ แต่ห้ามขาดค่าที่เฉลยต้องการ
 *
 * ทำไมจับคู่ทั้งคอลัมน์ ไม่ใช่หาค่าในแถวทีละแถว: ถ้าดูทีละแถว ค่า 51 ในเฉลยอาจไปตรงกับ
 * คอลัมน์ไหนก็ได้ที่บังเอิญเป็น 51 การบังคับให้ทุกแถวใช้คอลัมน์เดียวกันตัดความบังเอิญนี้ออก
 *
 * จำนวนแถวต้องเท่ากัน: rows คือตารางคำตอบ ถ้าถาม "ปีไหนมากที่สุด" แล้วได้มา 14 แถว
 * แปลว่า final_sql ไม่ได้ตอบคำถาม แม้แถวแรกจะถูกก็ตาม
 */
export function compareByValue(
  actual: Record<string, unknown>[],
  expected: ExpectedRow[],
  opts: CompareOptions,
): { ok: boolean; reason: string } {
  if (actual.length !== expected.length) {
    return { ok: false, reason: `ได้ ${actual.length} แถว แต่เฉลยมี ${expected.length} แถว` }
  }
  if (expected.length === 0) return { ok: true, reason: 'ตารางว่างทั้งคู่' }

  const expCols = Object.keys(expected[0]!).filter((c) => !opts.ignoredColumns.has(c))
  const actCols = [...new Set(actual.flatMap((r) => Object.keys(r)))]

  if (expCols.length > actCols.length) {
    return { ok: false, reason: `เฉลยต้องการ ${expCols.length} ค่าต่อแถว แต่คำตอบมีแค่ ${actCols.length} คอลัมน์` }
  }

  // ลองทุกการจับคู่ (เฉลยมีไม่เกิน 3 คอลัมน์ และคำตอบมีไม่กี่คอลัมน์ จำนวนแบบจึงน้อยมาก)
  let bestReason = ''
  for (const mapping of injectiveMappings(expCols, actCols)) {
    const r = tablesMatch(actual, expected, mapping, opts)
    if (r.ok) {
      const renamed = Object.entries(mapping)
        .filter(([e, a]) => e !== a)
        .map(([e, a]) => `${e}→${a}`)
      return { ok: true, reason: renamed.length ? `ตรง (จับคู่คอลัมน์ ${renamed.join(', ')})` : 'ตรง' }
    }
    // แสดงเหตุผลของการจับคู่แบบแรก ซึ่งเลือกคอลัมน์ชื่อเดียวกันก่อน จึงอ่านเข้าใจง่ายที่สุด
    if (!bestReason) bestReason = r.reason
  }
  return { ok: false, reason: bestReason || 'ไม่มีการจับคู่คอลัมน์แบบไหนที่ทำให้ค่าตรงกัน' }
}

function* injectiveMappings(
  expCols: string[],
  actCols: string[],
  used = new Set<string>(),
  acc: Record<string, string> = {},
): Generator<Record<string, string>> {
  if (Object.keys(acc).length === expCols.length) {
    yield { ...acc }
    return
  }
  const col = expCols[Object.keys(acc).length]!
  // ลองคอลัมน์ชื่อเดียวกันก่อน ส่วนใหญ่จะเจอตั้งแต่แบบแรก
  const ordered = [...actCols].sort((x, y) => Number(y === col) - Number(x === col))
  for (const a of ordered) {
    if (used.has(a)) continue
    used.add(a)
    acc[col] = a
    yield* injectiveMappings(expCols, actCols, used, acc)
    delete acc[col]
    used.delete(a)
  }
}

function tablesMatch(
  actual: Record<string, unknown>[],
  expected: ExpectedRow[],
  mapping: Record<string, string>,
  opts: CompareOptions,
): { ok: boolean; reason: string } {
  const rowMatches = (e: ExpectedRow, a: Record<string, unknown>): string | null => {
    for (const [ec, ac] of Object.entries(mapping)) {
      const why = cellMismatch(e[ec] ?? null, a[ac], ec, opts)
      if (why) return `${ec}${ec === ac ? '' : `(${ac})`}: ${why}`
    }
    return null
  }

  if (!opts.ordered) {
    // ไม่สนลำดับ: ทุกแถวของเฉลยต้องจับคู่กับแถวของคำตอบได้หนึ่งต่อหนึ่ง
    return multisetMatch(expected, actual, rowMatches, 0)
  }

  // สนลำดับ: แบ่งแถวของเฉลยเป็นกลุ่มที่เสมอกัน แต่ละกลุ่มต้องอยู่ตำแหน่งเดิม สลับกันเองในกลุ่มได้
  const groups: [number, number][] = opts.tiesUnordered
    ? tieGroups(expected, Object.keys(mapping))
    : expected.map((_, i) => [i, i + 1])
  for (const [start, end] of groups) {
    const r = multisetMatch(expected.slice(start, end), actual.slice(start, end), rowMatches, start)
    if (!r.ok) return r
  }
  return { ok: true, reason: 'ตรง' }
}

/**
 * กลุ่มของแถวที่ "เสมอกัน" ในข้อ top-n: แถวที่อยู่ติดกันและต่างกันแค่คอลัมน์เดียว (ป้ายชื่อ)
 * เช่น q035 (เขตจตุจักร, 51) กับ (เขตหนองจอก, 51) ต่างกันแค่ชื่อเขต อันดับระหว่างสองแถวนี้
 * ขึ้นกับตัวตัดสินเสมอที่ gold_sql เลือกเอง (เรียงตามชื่อ) ซึ่งคำถามไม่ได้ขอ จึงสลับกันได้
 * แต่ทั้งกลุ่มต้องอยู่ที่อันดับ 3-4 เหมือนเดิม
 */
function tieGroups(expected: ExpectedRow[], cols: string[]): [number, number][] {
  const groups: [number, number][] = []
  let start = 0
  for (let i = 1; i <= expected.length; i++) {
    const tied =
      i < expected.length &&
      cols.filter((c) => expected[i - 1]![c] !== expected[i]![c]).length <= 1
    if (!tied) {
      groups.push([start, i])
      start = i
    }
  }
  return groups
}

/** จับคู่แถวแบบหนึ่งต่อหนึ่ง (bipartite matching แบบ augmenting path) */
function multisetMatch(
  expected: ExpectedRow[],
  actual: Record<string, unknown>[],
  rowMatches: (e: ExpectedRow, a: Record<string, unknown>) => string | null,
  offset: number,
): { ok: boolean; reason: string } {
  const owner: (number | undefined)[] = new Array(actual.length).fill(undefined)
  const tryAssign = (ei: number, seen: Set<number>): boolean => {
    for (let ai = 0; ai < actual.length; ai++) {
      if (seen.has(ai) || rowMatches(expected[ei]!, actual[ai]!) !== null) continue
      seen.add(ai)
      if (owner[ai] === undefined || tryAssign(owner[ai]!, seen)) {
        owner[ai] = ei
        return true
      }
    }
    return false
  }
  for (let ei = 0; ei < expected.length; ei++) {
    if (!tryAssign(ei, new Set())) {
      // แสดงเหตุผลเทียบกับแถวตำแหน่งเดียวกัน ซึ่งมักเป็นแถวที่ควรตรง
      const why = actual[ei] ? rowMatches(expected[ei]!, actual[ei]!) : 'ไม่มีแถวนี้'
      return { ok: false, reason: `แถวที่ ${offset + ei + 1} ไม่ตรง — ${why}` }
    }
  }
  return { ok: true, reason: 'ตรง' }
}

/** คืนเหตุผลถ้าค่าไม่ตรง หรือ null ถ้าตรง */
function cellMismatch(want: number | string | null, got: unknown, col: string, opts: CompareOptions): string | null {
  if (want === null) return got === null || got === undefined ? null : `คาด null ได้ ${String(got)}`

  if (typeof want === 'number') {
    const n = toNumber(got)
    if (n === null) return `คาดตัวเลข ${want} ได้ ${String(got)}`
    const tol = opts.tolerance + 1e-9
    if (Math.abs(n - want) <= tol) return null

    // ร้อยละเทียบกับสัดส่วน: 92.52 กับ 0.9252 คือค่าเดียวกันคนละหน่วย
    // เทียบด้วย tolerance เดิมหลังแปลงเป็นร้อยละ จึงไม่ได้ผ่อนความแม่นยำ
    if (opts.percentColumns?.test(col) && Math.abs(n * 100 - want) <= tol) return null

    // ปี พ.ศ. กับ ค.ศ.: ตรวจแล้วว่า year_be = died_year + 543 ทุกแถว (ดู docs/evals.md)
    // คำถามภาษาอังกฤษจึงตอบเป็น 2019 แทน 2562 ได้โดยไม่ผิด
    if (/year/i.test(col) && Number.isInteger(want) && (n + 543 === want || n - 543 === want)) return null

    return `คาด ${want} ได้ ${n} (ต่าง ${round6(Math.abs(n - want))} เกิน ${opts.tolerance})`
  }

  if (got === null || got === undefined) return `คาด "${want}" ได้ null`
  return String(got).trim() === want.trim() ? null : `คาด "${want}" ได้ "${String(got)}"`
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

/**
 * คอลัมน์ที่เป็นป้ายชื่อซึ่ง gold_sql ตั้งขึ้นเอง ไม่ได้มาจากข้อมูล
 *
 * ตัวอย่าง q028: `CASE WHEN ... THEN 'covid' ELSE 'before' END AS period` — คำว่า 'covid' กับ
 * 'before' เป็นชื่อที่คนเขียนเฉลยเลือก เหมือนชื่อคอลัมน์ โมเดลจะตั้งว่า 'โควิด' หรือ 'pandemic'
 * ก็ถูกเท่ากัน (notes ของข้อนี้เขียนไว้ว่า "ชื่อช่วงไม่สำคัญ ตัวเลขสำคัญ")
 *
 * ตรวจจากตัว gold_sql เอง: ถ้าทุกค่าของคอลัมน์นั้นปรากฏเป็น literal หลัง THEN หรือ ELSE
 * แปลว่าเป็นป้ายที่ตั้งขึ้น ส่วนค่าที่มาจากข้อมูลจริง (เช่นชื่อเขต) ไม่มีทางอยู่ในรูปนั้น จึงยังถูกตรวจ
 */
export function inventedLabelColumns(expected: ExpectedRow[], goldSql: string): Set<string> {
  const out = new Set<string>()
  if (expected.length === 0) return out
  for (const col of Object.keys(expected[0]!)) {
    const values = expected.map((r) => r[col])
    const allInvented = values.every(
      (v) => typeof v === 'string' && new RegExp(`\\b(THEN|ELSE)\\s+'${escapeRegex(v)}'`, 'i').test(goldSql),
    )
    if (allInvented) out.add(col)
  }
  return out
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ══════════════════════════════════════════════════════════════════════════
// ข้อที่ตอบไม่ได้: ต้องปฏิเสธ และห้ามมีตัวเลขที่หาที่มาไม่ได้
// ══════════════════════════════════════════════════════════════════════════

function gradeUnanswerable(q: EvalQuestion, a: GradableAnswer, ctx: GradeContext): Grade {
  if (q.expected.kind !== 'refusal') throw new Error('unreachable')
  const visible = [a.answer, a.refused.reason ?? '', ...a.caveats].join('\n')
  const lower = visible.toLowerCase()
  const must_mention_missing = q.expected.must_mention.filter((m) => !lower.includes(m.toLowerCase()))

  if (a.error) return { pass: false, outcome: 'error', reason: a.error, must_mention_missing }
  if (!a.refused.value) {
    return { pass: false, outcome: 'missed_refusal', reason: 'ตอบทั้งที่ข้อมูลตอบไม่ได้', must_mention_missing }
  }

  const untraced = untracedNumbers(visible, [q.question, ctx.promptText], a.seen_rows)
  if (untraced.length > 0) {
    return {
      pass: false,
      outcome: 'fabricated_number',
      reason: `ปฏิเสธแล้วแต่มีตัวเลขที่หาที่มาไม่ได้: ${untraced.join(', ')}`,
      must_mention_missing,
      untraced_numbers: untraced,
    }
  }
  return {
    pass: true,
    outcome: 'correct',
    reason: must_mention_missing.length ? `ปฏิเสธถูก (ไม่พบคำ: ${must_mention_missing.join(', ')})` : 'ปฏิเสธถูก',
    must_mention_missing,
  }
}

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙'

/** ดึงตัวเลขจากข้อความ รองรับเลขไทย ตัวคั่นหลักพัน และทศนิยม */
export function extractNumbers(text: string): { value: number; decimals: number }[] {
  const normalized = text.replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)))
  const out: { value: number; decimals: number }[] = []
  for (const m of normalized.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) {
    const raw = m[0].replace(/,/g, '')
    out.push({ value: Number(raw), decimals: raw.includes('.') ? raw.split('.')[1]!.length : 0 })
  }
  return out
}

/**
 * ตัวเลขในคำปฏิเสธที่ "หาที่มาไม่ได้"
 *
 * ตัวเลขมีที่มาเมื่อตรงกับ (หลังปัดให้เท่าความละเอียดที่เขียน) ตัวเลขใน
 *   - คำถาม (เช่น "ต่อ 100,000 คน", "2027")
 *   - เอกสาร schema ที่อยู่ใน prompt (เช่น 12,146 ราย, 52%, 2554-2569)
 *   - ผลของ query ที่โมเดลรันระหว่างตอบ
 * นอกจากนี้ยกเว้น
 *   - จำนวนเต็ม 0-10 เพราะมักเป็นคำนับทั่วไป ("3 ฐานข้อมูล", "2 ปีล่าสุด")
 *   - ปีในช่วงข้อมูล (ค.ศ. 2011-2026 / พ.ศ. 2554-2569) เพราะการบอกขอบเขตข้อมูลไม่ใช่การแต่งตัวเลข
 *
 * ข้อจำกัดที่รู้อยู่: ถ้าโมเดลคำนวณตัวเลขใหม่จากผล query เอง (เช่นหารสองค่า) จะถูกนับว่าหาที่มาไม่ได้
 * ยอมรับได้เพราะในคำปฏิเสธ ตัวเลขที่คำนวณขึ้นใหม่ควรถูกตั้งคำถามอยู่แล้ว
 */
export function untracedNumbers(
  visibleText: string,
  sourceTexts: string[],
  seenRows: Record<string, unknown>[][],
): number[] {
  const allowed: number[] = []
  for (const t of sourceTexts) for (const n of extractNumbers(t)) allowed.push(n.value)
  for (const rows of seenRows)
    for (const row of rows)
      for (const v of Object.values(row)) {
        const n = toNumber(v)
        if (n !== null) allowed.push(n)
        else if (typeof v === 'string') for (const x of extractNumbers(v)) allowed.push(x.value)
      }

  const untraced: number[] = []
  for (const { value, decimals } of extractNumbers(visibleText)) {
    if (Number.isInteger(value) && value <= 10) continue
    if ((value >= 2011 && value <= 2026) || (value >= 2554 && value <= 2569)) continue
    const scale = 10 ** decimals
    const traced = allowed.some((a) => Math.round(a * scale) / scale === value || a === value)
    if (!traced && !untraced.includes(value)) untraced.push(value)
  }
  return untraced
}
