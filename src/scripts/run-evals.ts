// รันชุดทดสอบกับโมเดลจริง แล้วให้คะแนนด้วย src/grading.ts
//
//   npm run evals:run -- --split dev [--model X] [--repeat N] [--label "ข้อความ"]
//                        [--concurrency N] [--effort low|medium|high] [--max-rounds N]
//                        [--only q001,q002]   (เฉพาะ dev ใช้ดูทีละข้อตอนแก้)
//                        [--reveal]           (ชุด test เท่านั้น: ยอมแสดงผลรายข้อ)
//
// กติกาชุด test: แสดงและบันทึกเฉพาะผลรวม ไม่มีผลรายข้อทั้งบนจอและในไฟล์ เว้นแต่ใส่ --reveal
// ที่ไม่บันทึกรายข้อลงไฟล์ด้วยเพราะไฟล์ผลลัพธ์คือที่ที่ "แอบดู" ได้ง่ายที่สุด ถ้าเปิดดูเฉลยทีละข้อ
// แล้วกลับไปแก้ prompt ชุด test ก็จะกลายเป็นชุด dev อีกชุดและคะแนนจะสูงเกินจริง
//
// ทำไมต้อง --repeat: โมเดลให้ผลไม่เหมือนกันทุกครั้ง (มี thinking และไม่มี temperature ให้ตั้งเป็น 0)
// การแก้ที่ทำให้คะแนนขยับ 1-2 ข้อจากการรันครั้งเดียวอาจเป็นแค่ความแกว่ง จึงรายงานค่าเฉลี่ย
// พร้อมช่วงต่ำสุด-สูงสุด ถ้าช่วงของสองเวอร์ชันซ้อนกันมาก ยังสรุปไม่ได้ว่าอันไหนดีกว่า
import { execSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { ask, resolveConfig, type AskResult } from '../ask.js'
import type { AskError } from '../ask-errors.js'
import { loadQuestions, type EvalQuestion, type EvalType } from '../evals.js'
import { grade, type Grade, type Outcome } from '../grading.js'
import { closePools } from '../lib/db.js'
import { required } from '../lib/env.js'
import { addUsage, emptyUsage, estimateCostUsd, type TokenUsage } from '../pricing.js'
import { buildSystemPrompt, promptHash, PROMPT_VERSION, schemaPromptText } from '../prompt.js'

const RESULTS_DIR = 'evals/results'
const SUMMARY_FILE = `${RESULTS_DIR}/summary.md`
const TYPES: EvalType[] = ['count', 'ratio', 'trend', 'top-n', 'unanswerable']

interface QuestionRecord {
  id: string
  type: EvalType
  lang: string
  question: string
  pass: boolean
  outcome: Outcome
  reason: string
  must_mention_missing?: string[]
  answer: string
  final_sql: string | null
  rows_preview: Record<string, unknown>[]
  row_count: number
  caveats: string[]
  refused: AskResult['refused']
  error: AskError | null
  meta: AskResult['meta']
}

interface RepeatMetrics {
  n: number
  passed: number
  accuracy: number
  by_type: Record<string, { n: number; passed: number; accuracy: number }>
  /** ข้อที่ตอบไม่ได้: สัดส่วนที่ refused = true (ไม่สนว่าแต่งตัวเลขหรือไม่) */
  unanswerable_refusal_rate: number
  /** ข้อที่ตอบไม่ได้: สัดส่วนที่ปฏิเสธถูกครบเงื่อนไข (ปฏิเสธ + ไม่แต่งตัวเลข) = accuracy ของประเภทนี้ */
  unanswerable_correct_rate: number
  /** ข้อที่ตอบไม่ได้: สัดส่วนที่พบคำใน must_mention ครบ (ดูประกอบ ไม่ใช่คะแนน) */
  must_mention_full_rate: number
  /** ข้อที่ตอบได้: สัดส่วนที่โมเดลปฏิเสธ */
  false_refusal_rate: number
  false_refusals: number
  /** จำนวนครั้งที่ตัวตรวจปฏิเสธ / จำนวน SQL ทั้งหมดที่ส่งเข้าตัวตรวจ */
  guard_rejection_rate: number
  guard_rejections: number
  guard_checks: number
  questions_with_guard_rejection: number
  db_errors: number
  errors: number
  avg_tool_rounds: number
  avg_sql_calls: number
  hit_round_limit: number
  usage: TokenUsage
  avg_input_tokens_per_q: number
  avg_output_tokens_per_q: number
  cache_hit_ratio: number
  cost_usd: number | null
  cost_per_q_usd: number | null
  latency_ms: { mean: number; p50: number; p95: number; max: number }
  outcomes: Record<Outcome, number>
}

// ── อ่าน argument ──────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    split: { type: 'string' },
    model: { type: 'string' },
    repeat: { type: 'string', default: '1' },
    reveal: { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '4' },
    label: { type: 'string', default: '' },
    only: { type: 'string' },
    effort: { type: 'string' },
    'max-rounds': { type: 'string' },
  },
})

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

const split = args.split
if (split !== 'dev' && split !== 'test') fail('ต้องระบุ --split dev หรือ --split test')
const isTest = split === 'test'
const reveal = !isTest || args.reveal
if (isTest && args.only) fail('--only ใช้กับชุด test ไม่ได้ — ชุด test ต้องวัดครบทุกข้อพร้อมกันเท่านั้น')
const repeat = Number(args.repeat)
const concurrency = Number(args.concurrency)
if (!Number.isInteger(repeat) || repeat < 1) fail('--repeat ต้องเป็นจำนวนเต็มบวก')
if (!Number.isInteger(concurrency) || concurrency < 1) fail('--concurrency ต้องเป็นจำนวนเต็มบวก')

const askOptions = {
  ...(args.model ? { model: args.model } : {}),
  ...(args.effort ? { effort: args.effort as 'low' | 'medium' | 'high' } : {}),
  ...(args['max-rounds'] ? { maxToolRounds: Number(args['max-rounds']) } : {}),
}

// ── ตัวช่วย ────────────────────────────────────────────────────────────────

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const ratio = (a: number, b: number) => (b === 0 ? 0 : a / b)

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!
}

/** รันพร้อมกันไม่เกิน limit งาน หยุดหยิบงานใหม่เมื่อ shouldStop() เป็นจริง (งานที่กำลังรันอยู่ทำต่อจนจบ) */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
  shouldStop: () => boolean = () => false,
): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !shouldStop()) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return out
}

function gitInfo(): { commit: string; dirty: boolean } {
  try {
    const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim() !== ''
    return { commit, dirty }
  } catch {
    return { commit: 'unknown', dirty: true }
  }
}

// ── รันหนึ่งข้อ ────────────────────────────────────────────────────────────

async function runOne(q: EvalQuestion, promptText: string): Promise<QuestionRecord> {
  let result: AskResult
  try {
    result = await ask(q.question, askOptions)
  } catch (err) {
    // ask() คืน error ใน meta เองเกือบทุกกรณี ตรงนี้คือกรณีที่ไม่คาดคิดจริง ๆ
    const message = err instanceof Error ? err.message : String(err)
    const g: Grade = { pass: false, outcome: 'error', reason: `ask() threw: ${message}` }
    return {
      id: q.id, type: q.type, lang: q.lang, question: q.question, ...g,
      answer: '', final_sql: null, rows_preview: [], row_count: 0, caveats: [],
      refused: { value: false, reason: null }, error: null,
      meta: {} as AskResult['meta'],
    }
  }

  const g = grade(
    q,
    {
      answer: result.answer,
      rows: result.rows,
      caveats: result.caveats,
      refused: result.refused,
      error: result.error ? `${result.error.code}: ${result.error.detail}` : null,
      seen_rows: result.meta.trace.flatMap((t) => (t.preview_rows ? [t.preview_rows] : [])),
    },
    { promptText },
  )

  return {
    id: q.id,
    type: q.type,
    lang: q.lang,
    question: q.question,
    pass: g.pass,
    outcome: g.outcome,
    reason: g.reason,
    ...(g.must_mention_missing ? { must_mention_missing: g.must_mention_missing } : {}),
    answer: result.answer,
    final_sql: result.final_sql,
    rows_preview: result.rows.slice(0, 20),
    row_count: result.rows.length,
    caveats: result.caveats,
    refused: result.refused,
    error: result.error,
    meta: result.meta,
  }
}

// ── รวมผล ──────────────────────────────────────────────────────────────────

function metricsOf(records: QuestionRecord[], model: string): RepeatMetrics {
  const by_type: RepeatMetrics['by_type'] = {}
  for (const t of TYPES) {
    const rs = records.filter((r) => r.type === t)
    if (rs.length) {
      const passed = rs.filter((r) => r.pass).length
      by_type[t] = { n: rs.length, passed, accuracy: ratio(passed, rs.length) }
    }
  }

  const unans = records.filter((r) => r.type === 'unanswerable')
  const answerable = records.filter((r) => r.type !== 'unanswerable')
  const falseRefusals = answerable.filter((r) => r.outcome === 'false_refusal').length
  const metas = records.map((r) => r.meta)
  const usage = metas.reduce((acc, m) => (m.usage ? addUsage(acc, m.usage) : acc), emptyUsage())
  const latencies = metas.map((m) => m.latency_ms ?? 0)
  const guardChecks = metas.reduce((a, m) => a + (m.guard_checks ?? 0), 0)
  const guardRejections = metas.reduce((a, m) => a + (m.guard_rejections ?? 0), 0)
  const cost = estimateCostUsd(model, usage)
  const totalInput = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens

  const outcomes = Object.fromEntries(
    (['correct', 'wrong_rows', 'false_refusal', 'missed_refusal', 'fabricated_number', 'error'] as Outcome[]).map(
      (o) => [o, records.filter((r) => r.outcome === o).length],
    ),
  ) as Record<Outcome, number>

  const passed = records.filter((r) => r.pass).length
  return {
    n: records.length,
    passed,
    accuracy: ratio(passed, records.length),
    by_type,
    unanswerable_refusal_rate: ratio(unans.filter((r) => r.refused.value).length, unans.length),
    unanswerable_correct_rate: ratio(unans.filter((r) => r.pass).length, unans.length),
    must_mention_full_rate: ratio(
      unans.filter((r) => (r.must_mention_missing ?? []).length === 0).length,
      unans.length,
    ),
    false_refusal_rate: ratio(falseRefusals, answerable.length),
    false_refusals: falseRefusals,
    guard_rejection_rate: ratio(guardRejections, guardChecks),
    guard_rejections: guardRejections,
    guard_checks: guardChecks,
    questions_with_guard_rejection: metas.filter((m) => (m.guard_rejections ?? 0) > 0).length,
    db_errors: metas.reduce((a, m) => a + (m.db_errors ?? 0), 0),
    errors: records.filter((r) => r.outcome === 'error').length,
    avg_tool_rounds: mean(metas.map((m) => m.tool_rounds ?? 0)),
    avg_sql_calls: mean(metas.map((m) => m.sql_calls ?? 0)),
    hit_round_limit: metas.filter((m) => m.hit_round_limit).length,
    usage,
    avg_input_tokens_per_q: totalInput / records.length,
    avg_output_tokens_per_q: usage.output_tokens / records.length,
    cache_hit_ratio: ratio(usage.cache_read_input_tokens, totalInput),
    cost_usd: cost,
    cost_per_q_usd: cost === null ? null : cost / records.length,
    latency_ms: {
      mean: Math.round(mean(latencies)),
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: Math.max(...latencies),
    },
    outcomes,
  }
}

type Spread = { mean: number; min: number; max: number }
const spread = (xs: number[]): Spread => ({ mean: mean(xs), min: Math.min(...xs), max: Math.max(...xs) })

function acrossRepeats(ms: RepeatMetrics[]) {
  const pick = (f: (m: RepeatMetrics) => number) => spread(ms.map(f))
  return {
    accuracy: pick((m) => m.accuracy),
    by_type: Object.fromEntries(
      TYPES.filter((t) => ms[0]!.by_type[t]).map((t) => [t, pick((m) => m.by_type[t]!.accuracy)]),
    ),
    unanswerable_refusal_rate: pick((m) => m.unanswerable_refusal_rate),
    unanswerable_correct_rate: pick((m) => m.unanswerable_correct_rate),
    must_mention_full_rate: pick((m) => m.must_mention_full_rate),
    false_refusal_rate: pick((m) => m.false_refusal_rate),
    guard_rejection_rate: pick((m) => m.guard_rejection_rate),
    avg_tool_rounds: pick((m) => m.avg_tool_rounds),
    errors: pick((m) => m.errors),
    avg_input_tokens_per_q: pick((m) => m.avg_input_tokens_per_q),
    avg_output_tokens_per_q: pick((m) => m.avg_output_tokens_per_q),
    cache_hit_ratio: pick((m) => m.cache_hit_ratio),
    cost_per_q_usd: pick((m) => m.cost_per_q_usd ?? 0),
    cost_total_usd: ms.reduce((a, m) => a + (m.cost_usd ?? 0), 0),
    latency_p50_ms: pick((m) => m.latency_ms.p50),
    latency_p95_ms: pick((m) => m.latency_ms.p95),
  }
}

// ── แสดงผล ─────────────────────────────────────────────────────────────────

const fmtSpread = (s: Spread, f: (x: number) => string) =>
  s.min === s.max ? f(s.mean) : `${f(s.mean)}  [${f(s.min)} – ${f(s.max)}]`

function printSummary(agg: ReturnType<typeof acrossRepeats>, ms: RepeatMetrics[]) {
  const usd = (x: number) => `$${x.toFixed(4)}`
  const sec = (x: number) => `${(x / 1000).toFixed(1)}s`
  const num = (x: number) => x.toFixed(2)
  const intf = (x: number) => Math.round(x).toLocaleString('en-US')

  console.log('\nผลรวม' + (ms.length > 1 ? ` (ค่าเฉลี่ย [ต่ำสุด – สูงสุด] จาก ${ms.length} รอบ)` : ''))
  console.log('─'.repeat(78))
  console.log(`  accuracy รวม                 ${fmtSpread(agg.accuracy, pct)}   (${ms.map((m) => `${m.passed}/${m.n}`).join(', ')})`)
  for (const [t, s] of Object.entries(agg.by_type)) {
    console.log(`    ${t.padEnd(26)} ${fmtSpread(s, pct)}   (n=${ms[0]!.by_type[t]!.n})`)
  }
  console.log(`  ปฏิเสธในข้อที่ตอบไม่ได้          ${fmtSpread(agg.unanswerable_refusal_rate, pct)}`)
  console.log(`    ปฏิเสธถูก (ไม่แต่งตัวเลข)      ${fmtSpread(agg.unanswerable_correct_rate, pct)}`)
  console.log(`    พบคำใน must_mention ครบ     ${fmtSpread(agg.must_mention_full_rate, pct)}   (ดูประกอบ ไม่ใช่คะแนน)`)
  console.log(`  ปฏิเสธผิด (ข้อที่ตอบได้)         ${fmtSpread(agg.false_refusal_rate, pct)}`)
  console.log(`  ตัวตรวจ SQL ปฏิเสธ             ${fmtSpread(agg.guard_rejection_rate, pct)}   ของ SQL ที่ส่งเข้าตรวจทั้งหมด`)
  console.log(`  รอบ tool call เฉลี่ยต่อข้อ        ${fmtSpread(agg.avg_tool_rounds, num)}`)
  console.log(`  error                         ${fmtSpread(agg.errors, intf)}`)
  console.log(`  token ต่อข้อ (input / output)   ${intf(agg.avg_input_tokens_per_q.mean)} / ${intf(agg.avg_output_tokens_per_q.mean)}   cache hit ${pct(agg.cache_hit_ratio.mean)}`)
  console.log(`  ค่าใช้จ่ายต่อข้อ (ประมาณ)         ${fmtSpread(agg.cost_per_q_usd, usd)}   รวมทั้งการรันนี้ ${usd(agg.cost_total_usd)}`)
  console.log(`  latency ต่อข้อ p50 / p95       ${fmtSpread(agg.latency_p50_ms, sec)} / ${fmtSpread(agg.latency_p95_ms, sec)}`)
  console.log('─'.repeat(78))
}

function printPerQuestion(repeats: QuestionRecord[][]) {
  console.log('\nผลรายข้อ (✓ ผ่าน ✗ ไม่ผ่าน เรียงตามรอบ)')
  console.log('─'.repeat(100))
  const ids = repeats[0]!.map((r) => r.id)
  for (const id of ids) {
    const rs = repeats.map((rep) => rep.find((r) => r.id === id)!)
    const marks = rs.map((r) => (r.pass ? '✓' : '✗')).join('')
    const lastFail = [...rs].reverse().find((r) => !r.pass)
    const detail = lastFail ? `${lastFail.outcome}: ${lastFail.reason}` : rs[0]!.reason
    console.log(`  ${marks.padEnd(5)} ${id}  ${rs[0]!.type.padEnd(13)} ${detail.slice(0, 150)}`)
  }
  console.log('─'.repeat(100))
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  required('ANTHROPIC_API_KEY') // ล้มทันทีถ้าไม่มี key แทนที่จะไปล้มทีละข้อ

  const all = await loadQuestions()
  let questions = all.filter((q) => q.split === split)
  if (args.only) {
    const ids = new Set(args.only.split(',').map((s) => s.trim()))
    questions = questions.filter((q) => ids.has(q.id))
    if (questions.length === 0) fail(`ไม่พบข้อ ${args.only} ในชุด ${split}`)
  }

  const cfg = resolveConfig(askOptions)
  const promptText = buildSystemPrompt(await schemaPromptText(), { maxToolRounds: cfg.maxToolRounds })
  const hash = promptHash(promptText)
  const git = gitInfo()

  console.log(`ชุด ${split} ${questions.length} ข้อ × ${repeat} รอบ`)
  console.log(`model ${cfg.model} · effort ${cfg.effort} · max tool rounds ${cfg.maxToolRounds}`)
  console.log(`prompt ${PROMPT_VERSION} (${hash}) · git ${git.commit}${git.dirty ? ' (มีไฟล์ยังไม่ commit)' : ''}`)
  if (isTest && !reveal) console.log('ชุด test: แสดงเฉพาะผลรวม (ใส่ --reveal ถ้าต้องการดูรายข้อ)')

  const startedAt = new Date()
  const repeats: QuestionRecord[][] = []
  // error ที่ทำให้ทุกข้อล้มเหมือนกัน (เครดิตหมด, key ผิด) — เจอครั้งแรกหยุดทั้งชุด
  // ยิงต่อไปก็ได้ error เดิมทุกข้อ และผลที่ได้ครึ่ง ๆ กลาง ๆ ไม่ใช่การวัดโมเดล
  let fatal: { error: AskError; id: string } | undefined
  for (let r = 1; r <= repeat && !fatal; r++) {
    process.stdout.write(`\nรอบที่ ${r}/${repeat} `)
    const records = await mapPool(
      questions,
      concurrency,
      async (q) => {
        const rec = await runOne(q, promptText)
        if (rec.error?.fatal && !fatal) fatal = { error: rec.error, id: q.id }
        process.stdout.write(reveal ? (rec.pass ? '✓' : '✗') : '.')
        return rec
      },
      () => fatal !== undefined,
    )
    repeats.push(records.filter((x): x is QuestionRecord => x !== undefined))
  }
  console.log()

  if (fatal) {
    const done = repeats.flat()
    const spent = done.reduce((a, rec) => a + (rec.meta.cost_usd ?? 0), 0)
    const reason =
      fatal.error.code === 'out_of_credit'
        ? 'เครดิต Claude API หมด — เติมที่ console.anthropic.com → Settings → Billing แล้วรันใหม่'
        : 'API key ใช้ไม่ได้ — ตรวจ ANTHROPIC_API_KEY ใน .env แล้วรันใหม่'
    console.error(`\nหยุดการรัน: ${reason}`)
    console.error(`  เกิดที่ข้อ ${fatal.id} (${fatal.error.detail.slice(0, 160)})`)
    console.error(`  ทำไปแล้ว ${done.length} จาก ${questions.length * repeat} ข้อ · ค่าใช้จ่ายที่ใช้ไปแล้ว ~$${spent.toFixed(4)}`)
    console.error('  ไม่บันทึกผล เพราะเป็นผลที่ไม่ครบและไม่ได้สะท้อนความสามารถของโมเดล')
    process.exitCode = 1
    await closePools()
    return
  }

  const perRepeat = repeats.map((rs) => metricsOf(rs, cfg.model))
  const agg = acrossRepeats(perRepeat)
  if (reveal) printPerQuestion(repeats)
  printSummary(agg, perRepeat)

  // ── บันทึก ──
  // ถ้าทุกข้อ error (key ผิด เครดิตหมด เน็ตหลุด) ผลนี้ไม่ได้วัดโมเดล ไม่บันทึกให้ปนกับผลจริง
  if (perRepeat.every((m) => m.errors === m.n)) {
    const sample = repeats[0]?.[0]?.reason ?? ''
    console.error(`\nทุกข้อ error — ไม่บันทึกผล ตัวอย่าง: ${sample.slice(0, 200)}`)
    process.exitCode = 1
    await closePools()
    return
  }
  await mkdir(RESULTS_DIR, { recursive: true })
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const labelPart = args.label ? `_${args.label.replace(/[^\w-]+/g, '-').slice(0, 40)}` : ''
  const file = `${RESULTS_DIR}/${stamp}_${cfg.model}_${split}${labelPart}.json`

  const output = {
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    split,
    label: args.label,
    config: { ...cfg, repeat, concurrency, only: args.only ?? null },
    prompt: { version: PROMPT_VERSION, hash },
    git,
    across_repeats: agg,
    per_repeat: perRepeat,
    // ชุด test ที่ไม่ได้ใส่ --reveal: ไม่บันทึกรายข้อ (ดูเหตุผลที่หัวไฟล์)
    questions: reveal ? repeats : 'hidden (test split without --reveal)',
  }
  await writeFile(file, JSON.stringify(output, null, 2) + '\n', 'utf8')

  if (!existsSync(SUMMARY_FILE) || (await readFile(SUMMARY_FILE, 'utf8')).trim() === '') {
    await writeFile(
      SUMMARY_FILE,
      '# สรุปผลการรัน eval\n\n' +
        '> ไฟล์นี้เขียนต่อท้ายอัตโนมัติโดย `npm run evals:run` ทุกครั้งที่รัน ไฟล์ JSON รายละเอียดอยู่ในโฟลเดอร์เดียวกัน (ไม่ถูก commit)\n' +
        '> ค่าที่มีวงเล็บคือ ค่าเฉลี่ย [ต่ำสุด–สูงสุด] เมื่อรันหลายรอบ\n\n' +
        '| เวลา (UTC) | model | split | label | prompt | รอบ | accuracy | ปฏิเสธถูก (unans.) | ปฏิเสธผิด | guard ปฏิเสธ | tool rounds | $/ข้อ | p50 |\n' +
        '| --- | --- | --- | --- | --- | :-: | --- | --- | --- | --- | --- | --- | --- |\n',
      'utf8',
    )
  }
  const s = (x: Spread, f: (n: number) => string) => (x.min === x.max ? f(x.mean) : `${f(x.mean)} [${f(x.min)}–${f(x.max)}]`)
  const p = (n: number) => `${(n * 100).toFixed(1)}%`
  const line =
    `| ${startedAt.toISOString().slice(0, 16).replace('T', ' ')} | ${cfg.model} | ${split}${args.only ? ' (บางข้อ)' : ''} | ` +
    `${args.label || '—'} | ${PROMPT_VERSION} | ${repeat} | ${s(agg.accuracy, p)} | ${s(agg.unanswerable_correct_rate, p)} | ` +
    `${s(agg.false_refusal_rate, p)} | ${s(agg.guard_rejection_rate, p)} | ${agg.avg_tool_rounds.mean.toFixed(2)} | ` +
    `$${agg.cost_per_q_usd.mean.toFixed(5)} | ${(agg.latency_p50_ms.mean / 1000).toFixed(1)}s |\n`
  await appendFile(SUMMARY_FILE, line, 'utf8')

  console.log(`\nบันทึกผลที่ ${file}`)
  console.log(`เพิ่มบรรทัดสรุปใน ${SUMMARY_FILE}`)
  await closePools()
}

main().catch(async (err: unknown) => {
  console.error('รัน eval ไม่สำเร็จ:', err instanceof Error ? err.message : err)
  process.exitCode = 1
  await closePools()
})
