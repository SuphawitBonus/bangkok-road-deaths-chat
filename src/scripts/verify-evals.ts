// ตรวจว่า "เฉลย" ในชุดคำถามถูกต้องจริง
//
// สคริปต์นี้ยังไม่ยุ่งกับ AI เลย มันตอบคำถามเดียวคือ
//   เฉลยที่เราเขียนไว้ ตรงกับสิ่งที่ฐานข้อมูลตอบจริงหรือเปล่า
//
// ทำไมต้องมี: ถ้าเฉลยผิด การวัดผลโมเดลในสัปดาห์ที่ 2 จะไร้ความหมายทันที
// โมเดลอาจตอบถูกแต่ถูกนับว่าผิด หรือแย่กว่านั้นคือตอบผิดแล้วถูกนับว่าถูก
// ชุดทดสอบที่ไม่เคยถูกตรวจ คือชุดทดสอบที่เชื่อไม่ได้
//
// นอกจากเทียบตัวเลขแล้ว ยังส่ง gold_sql ทุกข้อผ่านตัวตรวจ SQL ด้วย
// ถ้าเฉลยเองยังเขียน SQL ที่ตัวตรวจไม่ยอมให้ผ่าน แปลว่าเราตั้งกฎไว้แคบเกินไป
import { adminPool, aiPool, closePools } from '../lib/db.js'
import { compareRows, loadQuestions, type EvalQuestion } from '../evals.js'
import { guardSql } from '../sql-guard.js'

interface Outcome {
  id: string
  type: string
  status: 'ok' | 'fail'
  detail: string
}

async function checkAnswerable(q: EvalQuestion): Promise<Outcome> {
  const base = { id: q.id, type: q.type }

  // 1) gold_sql ต้องผ่านตัวตรวจ และรันด้วย SQL ที่ตัวตรวจคืนมา ไม่ใช่ข้อความต้นฉบับ
  const guarded = await guardSql(q.gold_sql!)
  if (!guarded.ok) {
    return { ...base, status: 'fail', detail: `ตัวตรวจ SQL ปฏิเสธเฉลย [${guarded.code}] ${guarded.message}` }
  }

  // 2) รันด้วย role ที่อ่านได้อย่างเดียว เหมือนที่ SQL จาก AI จะถูกรันจริง
  let rows: Record<string, unknown>[]
  try {
    const result = await aiPool().query(guarded.sql)
    rows = result.rows as Record<string, unknown>[]
  } catch (err) {
    return { ...base, status: 'fail', detail: `รันไม่ผ่าน: ${err instanceof Error ? err.message : err}` }
  }

  if (q.expected.kind !== 'rows') {
    return { ...base, status: 'fail', detail: 'expected ไม่ใช่ชนิด rows' }
  }

  const comparison = compareRows(rows, q.expected.rows, q.tolerance ?? 0)
  if (!comparison.ok) return { ...base, status: 'fail', detail: comparison.reason }

  const preview = rows
    .slice(0, 2)
    .map((r) => Object.entries(r).map(([k, v]) => `${k}=${String(v)}`).join(' '))
    .join(' | ')
  return {
    ...base,
    status: 'ok',
    detail: `${preview}${rows.length > 2 ? ` … รวม ${rows.length} แถว` : ''}` +
      (guarded.limit === 'added' ? '  (ตัวตรวจเติม LIMIT ให้)' : ''),
  }
}

async function checkUnanswerable(q: EvalQuestion): Promise<Outcome> {
  const base = { id: q.id, type: q.type }
  if (q.expected.kind !== 'refusal') {
    return { ...base, status: 'fail', detail: 'expected ไม่ใช่ชนิด refusal' }
  }
  if (!q.expected.proof_sql || !q.expected.proof_rows) {
    return { ...base, status: 'fail', detail: 'ไม่มี proof_sql — ข้อนี้จะกลายเป็นเฉลยที่ตรวจสอบไม่ได้' }
  }

  // proof_sql รันด้วย admin เพราะมักต้องอ่าน metadata ซึ่ง role ของ AI เข้าไม่ถึง
  // (และนั่นคือสิ่งที่ถูกต้อง — AI ไม่ควรสำรวจ schema เองได้)
  let rows: Record<string, unknown>[]
  try {
    const result = await adminPool().query(q.expected.proof_sql)
    rows = result.rows as Record<string, unknown>[]
  } catch (err) {
    return { ...base, status: 'fail', detail: `proof_sql รันไม่ผ่าน: ${err instanceof Error ? err.message : err}` }
  }

  const comparison = compareRows(rows, q.expected.proof_rows, q.tolerance ?? 0)
  if (!comparison.ok) {
    return { ...base, status: 'fail', detail: `proof ไม่ยืนยันคำปฏิเสธ: ${comparison.reason}` }
  }
  return {
    ...base,
    status: 'ok',
    detail: `พิสูจน์แล้วว่าตอบไม่ได้จริง · คำตอบต้องพูดถึง: ${q.expected.must_mention.join(', ')}`,
  }
}

async function main(): Promise<void> {
  const questions = await loadQuestions()
  console.log(`ชุดคำถาม ${questions.length} ข้อ\n`)

  const byType = new Map<string, number>()
  for (const q of questions) byType.set(q.type, (byType.get(q.type) ?? 0) + 1)

  const outcomes: Outcome[] = []
  for (const q of questions) {
    outcomes.push(q.type === 'unanswerable' ? await checkUnanswerable(q) : await checkAnswerable(q))
  }

  console.log('ผลตรวจเฉลย')
  console.log('─'.repeat(92))
  for (const o of outcomes) {
    const mark = o.status === 'ok' ? 'ok  ' : 'FAIL'
    console.log(`  ${mark} ${o.id}  ${o.type.padEnd(13)} ${o.detail}`)
  }
  console.log('─'.repeat(92))

  const failed = outcomes.filter((o) => o.status === 'fail')
  console.log(`\nผ่าน ${outcomes.length - failed.length}/${outcomes.length} ข้อ`)
  console.log('แยกตามประเภท: ' + [...byType].map(([t, n]) => `${t} ${n}`).join(' · '))

  if (failed.length > 0) process.exitCode = 1
  await closePools()
}

main().catch((err: unknown) => {
  console.error('ตรวจเฉลยไม่สำเร็จ:', err instanceof Error ? err.message : err)
  process.exitCode = 1
  void closePools()
})
