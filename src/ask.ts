// ask(question) — ให้ Claude เขียน SQL ไปค้นข้อมูล แล้วตอบเป็นโครงสร้างตายตัว
//
// ──────────────────────────────────────────────────────────────────────────
// ภาพรวมของหนึ่งคำถาม
// ──────────────────────────────────────────────────────────────────────────
//   คำถาม → Claude เรียก run_sql(sql) → guardSql() → รันด้วย ai_reader → ผลย่อส่งกลับ
//        → (วนได้ไม่เกิน maxToolRounds รอบ) → Claude ตอบเป็น JSON ตาม schema
//        → รัน final_sql อีกครั้งถ้ายังไม่เคยรัน → คืน AskResult
//
// ──────────────────────────────────────────────────────────────────────────
// การตัดสินใจหลัก
// ──────────────────────────────────────────────────────────────────────────
// 1. rows ในคำตอบมาจากฐานข้อมูลเสมอ ไม่ได้มาจากข้อความของโมเดล
//    โมเดลบอกแค่ final_sql ส่วน rows เราได้จากการรัน SQL นั้นเอง โมเดลจึงแต่งแถวขึ้นมาเองไม่ได้
//    ถ้า final_sql เคยรันผ่าน tool แล้วใช้ผลเดิม ถ้ายังไม่เคยก็ส่งผ่าน guardSql() แล้วรันใหม่
//
// 2. คำตอบสุดท้ายบังคับรูปด้วย structured outputs (output_config.format) ไม่ใช่ขอใน prompt
//    API รับประกันว่าได้ JSON ตรง schema ไม่ต้องเขียนตัวแกะข้อความที่พังได้
//    ใช้คู่กับ adaptive thinking ที่เปิดไว้ เพราะเอกสารของ Haiku 5.5 เตือนว่าถ้าปิด thinking
//    แล้วขอ JSON พร้อมมี tool โมเดลอาจข้ามการเรียก tool ที่จำเป็น
//
// 3. จำกัดรอบ tool ไว้ที่ maxToolRounds (ค่าเริ่มต้น 4) นับทุกรอบ ไม่ใช่แค่รอบที่ผิด
//    เพื่อให้ต้นทุนและเวลาต่อคำถามมีเพดานแน่นอน พอครบรอบจะส่ง system message บอกให้ตอบ
//    และตั้ง tool_choice เป็น none ซึ่งเป็นการบังคับจาก API ไม่ใช่ขอร้องใน prompt
//
// 4. ผลที่ส่งกลับให้โมเดลถูกย่อ: ไม่เกิน MAX_PREVIEW_ROWS แถว และไม่เกิน MAX_RESULT_CHARS ตัวอักษร
//    พร้อมบอกจำนวนแถวจริงและว่าถูกตัด โมเดลจึงรู้ว่าเห็นไม่ครบ ไม่สรุปผิดจากข้อมูลบางส่วน
//
// 5. prompt caching: system prompt + tool definition เหมือนกันทุกคำถาม จึงวาง breakpoint
//    ไว้ท้าย system และเปิด cache อัตโนมัติท้ายบทสนทนาด้วย เพื่อให้รอบที่ 2, 3, ... ของคำถาม
//    เดียวกันอ่านประวัติจาก cache แทนการคิดเงินเต็มทุกรอบ
import Anthropic from '@anthropic-ai/sdk'
import pg from 'pg'

import { askError, classifyApiError, userMessage, type AskError, type AskErrorCode } from './ask-errors.js'
import { aiPool } from './lib/db.js'
import { optionalNumber, required } from './lib/env.js'
import { addUsage, emptyUsage, estimateCostUsd, type TokenUsage } from './pricing.js'
import { buildSystemPrompt, promptHash, PROMPT_VERSION, schemaPromptText } from './prompt.js'
import { guardSql } from './sql-guard.js'

export const DEFAULT_MODEL = 'claude-haiku-5-5'
export const DEFAULT_MAX_TOOL_ROUNDS = 4
export const DEFAULT_EFFORT: Effort = 'medium'

/** แถวที่ส่งให้โมเดลดูต่อหนึ่ง query — คำตอบเชิงสถิติแทบไม่เคยต้องดูเกินนี้ */
export const MAX_PREVIEW_ROWS = 50
/** เพดานขนาดผลลัพธ์ต่อหนึ่ง query ที่ส่งเข้า context (~2-3K token) */
export const MAX_RESULT_CHARS = 8000
/** query พร้อมกันในรอบเดียวได้ไม่เกินนี้ กันโมเดลยิงทีละสิบ query */
const MAX_PARALLEL_CALLS = 3

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AskOptions {
  model?: string
  effort?: Effort
  maxToolRounds?: number
  /** ส่ง client มาเองได้ (เช่นตอนทดสอบ) ถ้าไม่ส่งจะสร้างจาก ANTHROPIC_API_KEY ใน .env */
  client?: Anthropic
}

export interface TraceStep {
  round: number
  sql: string
  /** ผลของตัวตรวจ: 'ok' หรือรหัสที่ถูกปฏิเสธ */
  guard: string
  guard_message?: string
  db_error?: string
  row_count?: number
  /** แถวที่โมเดลเห็นจริง (หลังย่อ) — ใช้ตรวจว่าตัวเลขในคำตอบมีที่มาหรือไม่ */
  preview_rows?: Record<string, unknown>[]
  truncated?: boolean
  ms: number
}

export interface AskResult {
  /** คำตอบสำหรับผู้ใช้ ภาษาเดียวกับคำถาม */
  answer: string
  /** SQL ที่ใช้ตอบจริง (หลังผ่าน guardSql แล้ว) — null ถ้าปฏิเสธหรือรันไม่สำเร็จ */
  final_sql: string | null
  /** ผลของ final_sql จากฐานข้อมูล ไม่ใช่จากโมเดล */
  rows: Record<string, unknown>[]
  /** ข้อควรระวังของข้อมูลที่เกี่ยวกับคำตอบนี้ */
  caveats: string[]
  /** ปฏิเสธเพราะข้อมูลตอบคำถามนี้ไม่ได้หรือไม่ พร้อมเหตุผล */
  refused: { value: boolean; reason: string | null }
  /**
   * ตอบไม่สำเร็จเพราะอะไร — null ถ้าปกติ
   * เมื่อไม่ใช่ null: answer คือข้อความขออภัยสำหรับผู้ใช้ (ไม่มีตัวเลข), rows ว่าง, refused เป็น false
   * เพราะระบบไม่ได้ตัดสินว่าข้อมูลตอบไม่ได้ แค่ตอบไม่สำเร็จ (ดู src/ask-errors.ts)
   */
  error: AskError | null
  meta: AskMeta
}

export interface AskMeta {
  model: string
  effort: Effort
  prompt_version: string
  prompt_hash: string
  max_tool_rounds: number
  /** จำนวนรอบที่โมเดลเรียก tool (หนึ่งรอบอาจมีหลาย query) */
  tool_rounds: number
  sql_calls: number
  /** จำนวนครั้งที่ guardSql ปฏิเสธ รวมตอนรัน final_sql ซ้ำด้วย */
  guard_rejections: number
  guard_checks: number
  db_errors: number
  hit_round_limit: boolean
  final_sql_source: 'tool_call' | 'reexecuted' | 'none'
  api_calls: number
  usage: TokenUsage
  cost_usd: number | null
  latency_ms: number
  trace: TraceStep[]
}

const RUN_SQL_TOOL: Anthropic.Tool = {
  name: 'run_sql',
  description:
    'Run one read-only PostgreSQL SELECT (or WITH ... SELECT) against the `deaths` view and get the result. ' +
    'Only the `deaths` view and common aggregate/date/text/window functions are allowed. ' +
    `Results longer than ${MAX_PREVIEW_ROWS} rows are truncated, so aggregate in SQL instead of fetching raw rows. ` +
    'If the query is rejected or fails, the error message explains why; fix the query and try again.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      sql: { type: 'string', description: 'A single SELECT statement.' },
    },
    required: ['sql'],
    additionalProperties: false,
  },
}

/** schema ของคำตอบสุดท้าย — API บังคับให้ข้อความสุดท้ายของโมเดลตรงตามนี้ */
const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    final_sql: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    caveats: { type: 'array', items: { type: 'string' } },
    refused: { type: 'boolean' },
    refusal_reason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['answer', 'final_sql', 'caveats', 'refused', 'refusal_reason'],
  additionalProperties: false,
} as const

interface ModelAnswer {
  answer: string
  final_sql: string | null
  caveats: string[]
  refused: boolean
  refusal_reason: string | null
}

// ── การรัน SQL ─────────────────────────────────────────────────────────────

const { types } = pg
const NUMERIC_OIDS = new Set([20, 21, 23, 700, 701, 1700]) // int8 int2 int4 float4 float8 numeric
const DATE_OIDS = new Set([1082, 1114, 1184]) // date timestamp timestamptz

/**
 * ตัวแปลงชนิดเฉพาะ query ของ AI (ไม่แตะค่าตั้งต้นของ pg ทั้ง process)
 *  - ตัวเลข: pg คืน bigint/numeric เป็น string เพื่อกันเสียความแม่นยำ ข้อมูลชุดนี้ไม่มีเลขใหญ่ขนาดนั้น
 *    จึงแปลงเป็น number ให้โมเดลและหน้าเว็บใช้ได้เลย
 *  - วันที่: pg แปลง date เป็น Date ตาม timezone ของเครื่อง ซึ่งทำให้ '2023-04-11' กลายเป็น
 *    '2023-04-10T17:00:00Z' ตอนแปลงเป็น JSON — คืนเป็นข้อความเดิมจากฐานข้อมูลแทน
 */
const AI_TYPES = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (NUMERIC_OIDS.has(oid)) return (v: string) => Number(v)
    if (DATE_OIDS.has(oid)) return (v: string) => v
    return types.getTypeParser(oid, format)
  },
}

type SqlOutcome =
  | { ok: true; sql: string; rows: Record<string, unknown>[]; columns: string[]; limit: string }
  | { ok: false; stage: 'guard' | 'database'; code: string; message: string }

async function runGuardedSql(sql: string): Promise<SqlOutcome> {
  const guarded = await guardSql(sql)
  if (!guarded.ok) return { ok: false, stage: 'guard', code: guarded.code, message: guarded.message }
  try {
    // รัน guarded.sql เท่านั้น ไม่ใช่ข้อความต้นฉบับ (อาจถูกครอบ LIMIT เพิ่ม)
    const res = await aiPool().query({ text: guarded.sql, types: AI_TYPES })
    return {
      ok: true,
      sql: guarded.sql,
      rows: res.rows as Record<string, unknown>[],
      columns: res.fields.map((f) => f.name),
      limit: guarded.limit,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, stage: 'database', code: 'DB_ERROR', message }
  }
}

/** ย่อผลลัพธ์ก่อนส่งเข้า context: จำกัดทั้งจำนวนแถวและขนาดตัวอักษร */
function toToolResult(outcome: Extract<SqlOutcome, { ok: true }>): {
  text: string
  preview: Record<string, unknown>[]
  truncated: boolean
} {
  let n = Math.min(outcome.rows.length, MAX_PREVIEW_ROWS)
  for (;;) {
    const preview = outcome.rows.slice(0, n)
    const truncated = n < outcome.rows.length
    const payload: Record<string, unknown> = {
      row_count: outcome.rows.length,
      columns: outcome.columns,
      rows: preview,
    }
    if (truncated) {
      payload.note =
        `Showing only the first ${n} of ${outcome.rows.length} rows. ` +
        'Aggregate in SQL if you need the rest.'
    }
    if (outcome.limit === 'added' || outcome.limit === 'capped') {
      payload.row_limit = 'The guard wrapped this query in LIMIT 1000; the full result may be larger.'
    }
    const text = JSON.stringify(payload)
    if (text.length <= MAX_RESULT_CHARS || n <= 1) return { text, preview, truncated }
    n = Math.max(1, Math.floor(n / 2))
  }
}

/** เทียบ SQL แบบไม่สนช่องว่างและ ; ท้าย เพื่อดูว่า final_sql คือ query ที่รันไปแล้วหรือไม่ */
const normalizeSql = (s: string) => s.trim().replace(/;\s*$/, '').replace(/\s+/g, ' ')

// ── ตัวหลัก ───────────────────────────────────────────────────────────────

let defaultClient: Anthropic | undefined

function getClient(): Anthropic {
  // key อ่านจาก .env เท่านั้น (ผ่าน required ซึ่งโหลด .env ให้) ไม่เคยเขียนลงไฟล์อื่น
  defaultClient ??= new Anthropic({
    apiKey: required('ANTHROPIC_API_KEY'),
    maxRetries: 4,
    timeout: 120_000,
  })
  return defaultClient
}

function usageOf(u: Anthropic.Usage): TokenUsage {
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    thinking_tokens: u.output_tokens_details?.thinking_tokens ?? 0,
  }
}

export function resolveConfig(options: AskOptions = {}) {
  const model = options.model ?? process.env.ASK_MODEL ?? DEFAULT_MODEL
  const effort = (options.effort ?? process.env.ASK_EFFORT ?? DEFAULT_EFFORT) as Effort
  const maxToolRounds =
    options.maxToolRounds ?? optionalNumber('ASK_MAX_TOOL_ROUNDS', DEFAULT_MAX_TOOL_ROUNDS)
  return { model, effort, maxToolRounds }
}

export async function ask(question: string, options: AskOptions = {}): Promise<AskResult> {
  const started = performance.now()
  // resolveConfig อ่าน env ผ่าน optionalNumber ซึ่งโหลด .env ให้ก่อน
  const { model, effort, maxToolRounds } = resolveConfig(options)
  const client = options.client ?? getClient()

  const system = buildSystemPrompt(await schemaPromptText(), { maxToolRounds })

  const meta: AskMeta = {
    model,
    effort,
    prompt_version: PROMPT_VERSION,
    prompt_hash: promptHash(system),
    max_tool_rounds: maxToolRounds,
    tool_rounds: 0,
    sql_calls: 0,
    guard_rejections: 0,
    guard_checks: 0,
    db_errors: 0,
    hit_round_limit: false,
    final_sql_source: 'none',
    api_calls: 0,
    usage: emptyUsage(),
    cost_usd: null,
    latency_ms: 0,
    trace: [],
  }

  const finish = (partial: Omit<AskResult, 'meta' | 'error'>, error: AskError | null = null): AskResult => {
    meta.cost_usd = estimateCostUsd(model, meta.usage)
    meta.latency_ms = Math.round(performance.now() - started)
    return { ...partial, error, meta }
  }
  // ตอบไม่สำเร็จ: ทิ้งทุกอย่างที่โมเดลเขียนมา เพราะไม่มีผลจากฐานข้อมูลรองรับ
  // แทนด้วยข้อความขออภัยที่ไม่มีตัวเลข และไม่ตั้ง refused (ไม่ใช่การปฏิเสธเพราะข้อมูลไม่พอ)
  const failedWith = (e: AskError): AskResult =>
    finish(
      { answer: userMessage(e, question), final_sql: null, rows: [], caveats: [], refused: { value: false, reason: null } },
      e,
    )
  const failed = (code: AskErrorCode, detail: string): AskResult => failedWith(askError(code, detail))

  // ผลเต็มของ query ที่รันสำเร็จ เก็บไว้ใช้ซ้ำเมื่อ final_sql คือ query เดิม
  const executed = new Map<string, Extract<SqlOutcome, { ok: true }>>()
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }]

  let answer: ModelAnswer | undefined
  // +1 คือรอบสุดท้ายที่บังคับให้ตอบ (tool_choice: none)
  for (let turn = 0; turn <= maxToolRounds + 1; turn++) {
    const forceFinal = meta.tool_rounds >= maxToolRounds

    let response: Anthropic.Message
    try {
      response = await client.messages.create({
        model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: {
          effort,
          format: { type: 'json_schema', schema: ANSWER_SCHEMA as unknown as Record<string, unknown> },
        },
        // breakpoint ที่ 1: ท้าย system (ครอบ tools + system ซึ่งเหมือนกันทุกคำถาม)
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools: [RUN_SQL_TOOL],
        tool_choice: forceFinal ? { type: 'none' } : { type: 'auto' },
        // breakpoint ที่ 2: อัตโนมัติท้ายบทสนทนา ให้รอบถัดไปของคำถามเดียวกันอ่านประวัติจาก cache
        cache_control: { type: 'ephemeral' },
        messages,
      })
    } catch (err) {
      // จับเฉพาะ error ของ SDK (API ตอบ error / เชื่อมต่อไม่ได้) ส่วน error อื่นคือบั๊กของเรา ให้ล้มดัง ๆ
      if (err instanceof Anthropic.AnthropicError) return failedWith(classifyApiError(err))
      throw err
    }
    meta.api_calls += 1
    meta.usage = addUsage(meta.usage, usageOf(response.usage))

    if (response.stop_reason === 'refusal') {
      // การปฏิเสธของตัวกรองความปลอดภัยของ API — ไม่ใช่การปฏิเสธเพราะข้อมูลไม่พอ จึงนับเป็น error
      return failed('model_safety_refusal', `stop_reason=refusal category=${response.stop_details?.category ?? 'unknown'}`)
    }
    if (response.stop_reason === 'max_tokens') return failed('model_max_tokens', 'response hit max_tokens')

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')

    if (toolUses.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
      try {
        answer = JSON.parse(text) as ModelAnswer
      } catch {
        return failed('model_invalid_output', `final answer is not valid JSON: ${text.slice(0, 200)}`)
      }
      break
    }

    if (forceFinal) return failed('model_round_limit', 'model kept calling tools after the round limit')

    // ส่งทุก content block กลับไปตามเดิม (รวม thinking block) ตามที่ API กำหนด
    messages.push({ role: 'assistant', content: response.content })
    meta.tool_rounds += 1

    const results: Anthropic.ToolResultBlockParam[] = []
    for (const [i, use] of toolUses.entries()) {
      const sql = typeof (use.input as { sql?: unknown }).sql === 'string'
        ? (use.input as { sql: string }).sql
        : ''
      if (i >= MAX_PARALLEL_CALLS) {
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: true,
          content: `Too many queries in one turn (max ${MAX_PARALLEL_CALLS}). This one was not run.`,
        })
        continue
      }

      const t0 = performance.now()
      const outcome = await runGuardedSql(sql)
      const ms = Math.round(performance.now() - t0)
      meta.sql_calls += 1
      meta.guard_checks += 1

      if (!outcome.ok) {
        if (outcome.stage === 'guard') meta.guard_rejections += 1
        else meta.db_errors += 1
        meta.trace.push({
          round: meta.tool_rounds,
          sql,
          guard: outcome.stage === 'guard' ? outcome.code : 'ok',
          ...(outcome.stage === 'guard'
            ? { guard_message: outcome.message }
            : { db_error: outcome.message }),
          ms,
        })
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: true,
          content: JSON.stringify({
            error_stage: outcome.stage === 'guard' ? 'rejected by the SQL guard (not run)' : 'database error',
            code: outcome.code,
            message: outcome.message,
          }),
        })
        continue
      }

      executed.set(normalizeSql(sql), outcome)
      executed.set(normalizeSql(outcome.sql), outcome)
      const { text, preview, truncated } = toToolResult(outcome)
      meta.trace.push({
        round: meta.tool_rounds,
        sql,
        guard: 'ok',
        row_count: outcome.rows.length,
        preview_rows: preview,
        truncated,
        ms,
      })
      results.push({ type: 'tool_result', tool_use_id: use.id, content: text })
    }

    messages.push({ role: 'user', content: results })

    if (meta.tool_rounds >= maxToolRounds) {
      meta.hit_round_limit = true
      // แจ้งผ่าน system message แยกต่างหาก ไม่ปนใน tool_result (เอกสารของ model แนะนำแบบนี้)
      messages.push({
        role: 'system',
        content:
          `You have used all ${maxToolRounds} queries. Do not call run_sql again. ` +
          'Write the final JSON answer now from the results you already have.',
      })
    }
  }

  if (!answer) return failed('model_round_limit', 'no final answer within the turn limit')

  const refused = answer.refused === true
  const base = {
    answer: answer.answer,
    caveats: Array.isArray(answer.caveats) ? answer.caveats : [],
    refused: { value: refused, reason: refused ? answer.refusal_reason : null },
  }

  if (refused || !answer.final_sql) {
    // ปฏิเสธ หรือตอบโดยไม่มี SQL — ไม่มี rows เพราะไม่มีอะไรจากฐานข้อมูลรองรับ
    return finish({ ...base, final_sql: null, rows: [] })
  }

  const reused = executed.get(normalizeSql(answer.final_sql))
  if (reused) {
    meta.final_sql_source = 'tool_call'
    return finish({ ...base, final_sql: reused.sql, rows: reused.rows })
  }

  // final_sql ไม่ตรงกับ query ที่เคยรัน — ไม่เชื่อ ส่งผ่านตัวตรวจและรันใหม่
  const t0 = performance.now()
  const outcome = await runGuardedSql(answer.final_sql)
  meta.guard_checks += 1
  meta.final_sql_source = 'reexecuted'
  if (!outcome.ok) {
    if (outcome.stage === 'guard') meta.guard_rejections += 1
    else meta.db_errors += 1
    meta.trace.push({
      round: meta.tool_rounds + 1,
      sql: answer.final_sql,
      guard: outcome.stage === 'guard' ? outcome.code : 'ok',
      ...(outcome.stage === 'guard' ? { guard_message: outcome.message } : { db_error: outcome.message }),
      ms: Math.round(performance.now() - t0),
    })
    // ตัวเลขในคำตอบของโมเดลไม่มีผลจากฐานข้อมูลรองรับ จึงไม่แสดงคำตอบนั้น
    return failed('final_sql_failed', `final_sql failed (${outcome.code}): ${outcome.message}`)
  }
  return finish({ ...base, final_sql: outcome.sql, rows: outcome.rows })
}
