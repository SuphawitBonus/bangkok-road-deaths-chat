// รูปแบบของชุดคำถามทดสอบ และตัวอ่านไฟล์ evals/questions.jsonl
//
// ใช้ JSON Lines (หนึ่งคำถามต่อหนึ่งบรรทัด) แทน JSON ก้อนเดียว เพราะ
//   - เพิ่มคำถามทีละข้อแล้ว diff ใน git อ่านง่าย เห็นว่าเพิ่มข้อไหน
//   - ไฟล์พังหนึ่งบรรทัดไม่ทำให้ทั้งไฟล์ใช้ไม่ได้ และบอกได้ว่าพังบรรทัดที่เท่าไร
//   - สัปดาห์ที่ 2 จะอ่านทีละบรรทัดแบบ stream ตอนรันกับโมเดลได้เลย
import { readFile } from 'node:fs/promises'

export type EvalType = 'count' | 'ratio' | 'trend' | 'top-n' | 'unanswerable'

/** แถวผลลัพธ์ที่คาดหวัง ค่าเป็นตัวเลข ข้อความ หรือ null */
export type ExpectedRow = Record<string, number | string | null>

export interface ExpectedRows {
  kind: 'rows'
  rows: ExpectedRow[]
}

export interface ExpectedRefusal {
  kind: 'refusal'
  /** คำที่คำตอบต้องพูดถึง ใช้ตรวจแบบหยาบ ๆ ในสัปดาห์ที่ 2 */
  must_mention: string[]
  /** SQL ที่พิสูจน์ว่าข้อมูลตอบคำถามนี้ไม่ได้จริง — ทำให้เฉลย "ปฏิเสธ" ตรวจสอบได้ */
  proof_sql?: string
  proof_rows?: ExpectedRow[]
}

export interface EvalQuestion {
  id: string
  /** dev ใช้ตอนปรับ prompt ส่วน test ห้ามดูผลรายข้อจนถึงรอบวัดผลสุดท้าย */
  split: 'dev' | 'test'
  question: string
  lang: 'th' | 'en'
  type: EvalType
  /** null เมื่อเป็นคำถามที่ข้อมูลตอบไม่ได้ */
  gold_sql: string | null
  expected: ExpectedRows | ExpectedRefusal
  /** ความคลาดเคลื่อนที่ยอมรับได้สำหรับตัวเลขทศนิยม */
  tolerance?: number
  notes?: string
}

export async function loadQuestions(path = 'evals/questions.jsonl'): Promise<EvalQuestion[]> {
  const text = await readFile(path, 'utf8')
  const questions: EvalQuestion[] = []
  const seen = new Set<string>()

  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('//')) return

    let parsed: EvalQuestion
    try {
      parsed = JSON.parse(trimmed) as EvalQuestion
    } catch (err) {
      throw new Error(
        `บรรทัดที่ ${index + 1} ไม่ใช่ JSON ที่ถูกต้อง: ${err instanceof Error ? err.message : err}`,
      )
    }

    if (!parsed.id) throw new Error(`บรรทัดที่ ${index + 1} ไม่มี id`)
    if (parsed.split !== 'dev' && parsed.split !== 'test') {
      throw new Error(`${parsed.id}: split ต้องเป็น dev หรือ test`)
    }
    if (seen.has(parsed.id)) throw new Error(`id ซ้ำ: ${parsed.id} (บรรทัดที่ ${index + 1})`)
    seen.add(parsed.id)

    if (parsed.type === 'unanswerable') {
      if (parsed.gold_sql !== null) {
        throw new Error(`${parsed.id}: คำถามประเภท unanswerable ต้องมี gold_sql เป็น null`)
      }
      if (parsed.expected.kind !== 'refusal') {
        throw new Error(`${parsed.id}: คำถามประเภท unanswerable ต้องมี expected.kind = refusal`)
      }
    } else {
      if (!parsed.gold_sql) throw new Error(`${parsed.id}: ขาด gold_sql`)
      if (parsed.expected.kind !== 'rows') {
        throw new Error(`${parsed.id}: expected.kind ต้องเป็น rows`)
      }
    }

    questions.push(parsed)
  })

  return questions
}

/**
 * เทียบผลจากฐานข้อมูลกับเฉลย
 *
 * ตัวเลขเทียบแบบมีค่าความคลาดเคลื่อน เพราะ numeric ของ Postgres กลับมาเป็น string
 * และการปัดเศษอาจต่างกันในหลักสุดท้าย ส่วนข้อความเทียบแบบตรงตัวหลังตัดช่องว่าง
 */
export function compareRows(
  actual: Record<string, unknown>[],
  expected: ExpectedRow[],
  tolerance = 0,
): { ok: true } | { ok: false; reason: string } {
  if (actual.length !== expected.length) {
    return { ok: false, reason: `ได้ ${actual.length} แถว แต่เฉลยมี ${expected.length} แถว` }
  }

  for (const [i, expectedRow] of expected.entries()) {
    const actualRow = actual[i]!
    for (const [key, want] of Object.entries(expectedRow)) {
      if (!(key in actualRow)) {
        return { ok: false, reason: `แถวที่ ${i + 1} ไม่มีคอลัมน์ "${key}"` }
      }
      const got = actualRow[key]

      if (want === null) {
        if (got !== null) return { ok: false, reason: `แถวที่ ${i + 1} ${key}: คาด null ได้ ${String(got)}` }
        continue
      }

      if (typeof want === 'number') {
        const gotNum = Number(got)
        if (!Number.isFinite(gotNum)) {
          return { ok: false, reason: `แถวที่ ${i + 1} ${key}: คาดตัวเลข ${want} ได้ ${String(got)}` }
        }
        if (Math.abs(gotNum - want) > tolerance) {
          return {
            ok: false,
            reason: `แถวที่ ${i + 1} ${key}: คาด ${want} ได้ ${gotNum} (ต่างกัน ${Math.abs(gotNum - want)} เกินค่าที่ยอมรับ ${tolerance})`,
          }
        }
        continue
      }

      if (String(got).trim() !== want.trim()) {
        return { ok: false, reason: `แถวที่ ${i + 1} ${key}: คาด "${want}" ได้ "${String(got)}"` }
      }
    }
  }

  return { ok: true }
}
