/**
 * ชั้นที่ 2 ของการป้องกัน: ตรวจ SQL ที่ AI เขียนก่อนส่งเข้าฐานข้อมูล
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ทำไมต้องใช้ parser ไม่ใช่ regex
 * ──────────────────────────────────────────────────────────────────────────
 * regex อ่าน SQL เป็นข้อความ แต่ Postgres อ่านเป็นไวยากรณ์ ช่องว่างระหว่างสองอย่างนี้
 * คือช่องโหว่ ตัวอย่างที่ regex ทั่วไปพลาด:
 *
 *   - `SELECT 1 /*; DROP TABLE x; *​/`     คอมเมนต์ที่หน้าตาเหมือนมีหลายคำสั่ง
 *   - `SELECT ';'`                          อัฒภาคที่อยู่ใน string ไม่ใช่ตัวคั่นคำสั่ง
 *   - `WITH d AS (DELETE FROM deaths ...)`  คำสั่งลบที่ซ่อนใน CTE ของ SELECT
 *   - `SELECT * INTO evil FROM deaths`      SELECT ที่สร้างตารางขึ้นมา
 *
 * ที่นี่ใช้ libpg-query ซึ่งคือ parser ตัวจริงของ PostgreSQL คอมไพล์เป็น WASM
 * ข้อดีคือสิ่งที่ตัวตรวจเห็น ตรงกับสิ่งที่เซิร์ฟเวอร์จะเห็นเป๊ะ ๆ ไม่มีไวยากรณ์
 * คนละชุดให้เกิดช่องว่าง (ถ้าใช้ parser ที่เขียนเลียนแบบ จะมีความเสี่ยงว่า
 * parser อ่านอย่างหนึ่งแต่เซิร์ฟเวอร์อ่านอีกอย่าง)
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ชั้นนี้ไม่ใช่ชั้นหลัก
 * ──────────────────────────────────────────────────────────────────────────
 * ชั้นหลักคือสิทธิ์ในฐานข้อมูล (db/03_security.sql) ชั้นนี้มีไว้เพื่อ
 *   1. ปิดช่องที่ชั้นฐานข้อมูลปิดไม่ได้ โดยเฉพาะการอ่าน pg_catalog
 *   2. ปฏิเสธตั้งแต่ก่อนเปิด connection จึงได้ข้อความผิดพลาดที่อธิบายได้
 *      และเอาไปป้อนกลับให้ AI แก้ SQL ในสัปดาห์ที่ 2 ได้
 *   3. บังคับ LIMIT เพื่อไม่ให้คำตอบยาวจนล้น
 * ถ้าไฟล์นี้มีบั๊ก ฐานข้อมูลยังปฏิเสธคำสั่งอันตรายอยู่ดี
 */
import { parse } from 'libpg-query'

export type GuardFailureCode =
  | 'PARSE_ERROR'
  | 'EMPTY'
  | 'MULTIPLE_STATEMENTS'
  | 'NOT_A_SELECT'
  | 'FORBIDDEN_STATEMENT'
  | 'SELECT_INTO'
  | 'FORBIDDEN_RELATION'
  | 'FORBIDDEN_FUNCTION'
  | 'FORBIDDEN_CONSTRUCT'
  | 'INTERNAL'

export interface GuardOptions {
  /** ตารางหรือ view ที่อ้างถึงได้ ค่าเริ่มต้นคือ view deaths เท่านั้น */
  allowedRelations?: readonly string[]
  /** schema ที่ยอมให้ระบุนำหน้าชื่อตารางได้ */
  allowedSchemas?: readonly string[]
  /** เพดานแถว ถ้า SQL ไม่มี LIMIT จะถูกครอบให้ */
  maxRows?: number
  /** ฟังก์ชันที่เรียกได้ ถ้าไม่ส่งมาใช้ชุดมาตรฐานด้านล่าง */
  allowedFunctions?: ReadonlySet<string>
}

export interface GuardSuccess {
  ok: true
  /** SQL ที่ตรวจผ่านแล้วและต้องเอาไปรัน — ห้ามรันข้อความต้นฉบับ */
  sql: string
  limit: 'already-present' | 'added' | 'capped'
  relations: string[]
  functions: string[]
}

export interface GuardFailure {
  ok: false
  code: GuardFailureCode
  /** ข้อความภาษาไทยสำหรับแสดงผู้ใช้ และป้อนกลับให้ AI แก้ */
  message: string
}

export type GuardResult = GuardSuccess | GuardFailure

/**
 * ฟังก์ชันที่อนุญาต — เป็น allowlist ไม่ใช่ denylist โดยตั้งใจ
 *
 * denylist ต้องไล่ปิดทีละช่องและจะพลาดเสมอเมื่อมีฟังก์ชันใหม่ ส่วน allowlist
 * ผิดพลาดไปทางปฏิเสธของที่ควรผ่าน ซึ่งแก้ได้ด้วยการเติมชื่อเข้ามา ปลอดภัยกว่า
 *
 * สิ่งที่จงใจไม่ใส่: generate_series (สร้างแถวได้ไม่จำกัด), pg_sleep, pg_read_file,
 * dblink, lo_* , query_to_xml, set_config และฟังก์ชันระบบทั้งหมด
 */
export const DEFAULT_ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  // รวมยอด
  'count', 'sum', 'avg', 'min', 'max', 'stddev', 'stddev_pop', 'stddev_samp',
  'variance', 'var_pop', 'var_samp', 'corr', 'mode',
  'percentile_cont', 'percentile_disc', 'array_agg', 'string_agg',
  // ตัวเลข
  'abs', 'ceil', 'ceiling', 'floor', 'round', 'trunc', 'mod', 'div',
  'power', 'sqrt', 'exp', 'ln', 'log', 'sign', 'greatest', 'least', 'width_bucket',
  // วันเวลา
  'date_part', 'date_trunc', 'extract', 'age', 'to_char', 'to_date', 'to_timestamp',
  'make_date', 'now', 'date_bin', 'justify_interval',
  // ข้อความ
  'lower', 'upper', 'initcap', 'length', 'char_length', 'character_length',
  'substring', 'substr', 'trim', 'btrim', 'ltrim', 'rtrim', 'lpad', 'rpad',
  'concat', 'concat_ws', 'replace', 'split_part', 'left', 'right', 'reverse',
  'strpos', 'position', 'starts_with', 'format', 'md5',
  // window
  'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile',
  'lag', 'lead', 'first_value', 'last_value', 'nth_value',
  // อื่น ๆ ที่ใช้บ่อยในงานวิเคราะห์
  'coalesce', 'nullif', 'cast', 'to_number', 'cardinality', 'unnest',
])

const DEFAULT_RELATIONS = ['deaths'] as const
const DEFAULT_SCHEMAS = ['app'] as const
const DEFAULT_MAX_ROWS = 1000

interface Relation {
  schema?: string
  name: string
}

interface Walked {
  statementNodes: Set<string>
  relations: Relation[]
  functions: { qualified: string; bare: string; schema?: string }[]
  cteNames: Set<string>
  hasIntoClause: boolean
  hasLocking: boolean
}

/** เดินทั้งต้นไม้ ไม่ใช่แค่ชั้นบนสุด เพราะของอันตรายชอบซ่อนอยู่ในชั้นลึก */
function walk(node: unknown, acc: Walked): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, acc)
    return
  }
  if (node === null || typeof node !== 'object') return

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    switch (key) {
      case 'RangeVar': {
        const v = value as { schemaname?: string; relname?: string }
        if (v.relname) acc.relations.push({ schema: v.schemaname, name: v.relname })
        break
      }
      case 'FuncCall': {
        const v = value as { funcname?: { String?: { sval?: string } }[] }
        const parts = (v.funcname ?? []).map((p) => p.String?.sval ?? '')
        const bare = parts[parts.length - 1] ?? ''
        acc.functions.push({
          qualified: parts.join('.'),
          bare: bare.toLowerCase(),
          schema: parts.length > 1 ? parts[0] : undefined,
        })
        break
      }
      case 'CommonTableExpr': {
        const v = value as { ctename?: string }
        if (v.ctename) acc.cteNames.add(v.ctename.toLowerCase())
        break
      }
      case 'intoClause':
        if (value !== null && value !== undefined) acc.hasIntoClause = true
        break
      case 'LockingClause':
        acc.hasLocking = true
        break
      default:
        // ชื่อ node ของคำสั่งทุกชนิดลงท้ายด้วย Stmt เช่น SelectStmt, DeleteStmt, DropStmt
        if (key.endsWith('Stmt')) acc.statementNodes.add(key)
        break
    }
    walk(value, acc)
  }
}

const fail = (code: GuardFailureCode, message: string): GuardFailure => ({ ok: false, code, message })

/** ชื่อคำสั่งแบบอ่านรู้เรื่อง สำหรับใส่ในข้อความผิดพลาด */
function readableStatement(node: string): string {
  const name = node.replace(/Stmt$/, '')
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase()
}

function limitConstant(limitCount: unknown): number | null {
  const node = limitCount as { A_Const?: { ival?: { ival?: number }; isnull?: boolean } } | undefined
  if (!node?.A_Const || node.A_Const.isnull) return null
  // protobuf ตัด field ที่เป็นศูนย์ทิ้ง ค่า LIMIT 0 จึงมาเป็น {} ต้องตีความเป็น 0
  return node.A_Const.ival?.ival ?? 0
}

/**
 * ตรวจและทำให้ SQL ปลอดภัยก่อนรัน
 *
 * คืน `sql` ที่ต้องเอาไปรันจริง ซึ่งอาจถูกครอบ LIMIT เพิ่ม ห้ามเอาข้อความต้นฉบับไปรัน
 */
export async function guardSql(input: string, options: GuardOptions = {}): Promise<GuardResult> {
  const allowedRelations = new Set(
    (options.allowedRelations ?? DEFAULT_RELATIONS).map((r) => r.toLowerCase()),
  )
  const allowedSchemas = new Set(
    (options.allowedSchemas ?? DEFAULT_SCHEMAS).map((s) => s.toLowerCase()),
  )
  const allowedFunctions = options.allowedFunctions ?? DEFAULT_ALLOWED_FUNCTIONS
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS

  return validate(input, { allowedRelations, allowedSchemas, allowedFunctions, maxRows }, false)
}

interface Resolved {
  allowedRelations: Set<string>
  allowedSchemas: Set<string>
  allowedFunctions: ReadonlySet<string>
  maxRows: number
}

async function validate(input: string, opts: Resolved, isRewrite: boolean): Promise<GuardResult> {
  const sql = input.trim()
  if (sql === '') return fail('EMPTY', 'ไม่มีคำสั่ง SQL ส่งมา')

  // 1) ต้อง parse ผ่านด้วยไวยากรณ์จริงของ Postgres
  let tree: { stmts?: { stmt?: unknown }[] }
  try {
    tree = (await parse(sql)) as { stmts?: { stmt?: unknown }[] }
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err)
    return fail('PARSE_ERROR', `SQL ผิดไวยากรณ์ของ PostgreSQL: ${detail}`)
  }

  const stmts = tree.stmts ?? []
  if (stmts.length === 0) return fail('EMPTY', 'ไม่มีคำสั่ง SQL ส่งมา')

  // 2) หนึ่งคำสั่งเท่านั้น — กัน `SELECT 1; DROP TABLE deaths`
  //    ตัวนับมาจาก parser จึงไม่โดนหลอกด้วยอัฒภาคในคอมเมนต์หรือใน string
  if (stmts.length > 1) {
    return fail(
      'MULTIPLE_STATEMENTS',
      `ส่งมา ${stmts.length} คำสั่ง อนุญาตครั้งละหนึ่งคำสั่งเท่านั้น`,
    )
  }

  const top = stmts[0]?.stmt as Record<string, unknown> | undefined
  if (!top) return fail('EMPTY', 'ไม่มีคำสั่ง SQL ส่งมา')

  const topKind = Object.keys(top)[0] ?? ''
  if (topKind !== 'SelectStmt') {
    return fail(
      'NOT_A_SELECT',
      `อนุญาตเฉพาะ SELECT หรือ WITH ... SELECT เท่านั้น แต่ได้รับคำสั่ง ${readableStatement(topKind)}`,
    )
  }

  // 3) เดินทั้งต้นไม้
  const acc: Walked = {
    statementNodes: new Set(),
    relations: [],
    functions: [],
    cteNames: new Set(),
    hasIntoClause: false,
    hasLocking: false,
  }
  walk(top, acc)

  // 4) ห้ามมีคำสั่งชนิดอื่นแฝงอยู่ที่ไหนก็ตาม
  //    เคสสำคัญคือ `WITH d AS (DELETE FROM deaths RETURNING *) SELECT * FROM d`
  //    ซึ่งชั้นบนสุดเป็น SelectStmt แต่ข้างในลบข้อมูลจริง
  const otherStatements = [...acc.statementNodes].filter((s) => s !== 'SelectStmt')
  if (otherStatements.length > 0) {
    return fail(
      'FORBIDDEN_STATEMENT',
      `พบคำสั่ง ${otherStatements.map(readableStatement).join(', ')} ซ่อนอยู่ในคำสั่ง ` +
        'อนุญาตเฉพาะการอ่านข้อมูลเท่านั้น',
    )
  }

  // 5) SELECT ... INTO สร้างตารางใหม่ ทั้งที่ชั้นบนสุดยังเป็น SelectStmt
  if (acc.hasIntoClause) {
    return fail('SELECT_INTO', 'ห้ามใช้ SELECT ... INTO เพราะเป็นการสร้างตารางใหม่')
  }

  // 6) FOR UPDATE / FOR SHARE เป็นการล็อกแถว ไม่ใช่การอ่านอย่างเดียว
  if (acc.hasLocking) {
    return fail('FORBIDDEN_CONSTRUCT', 'ห้ามใช้ FOR UPDATE / FOR SHARE')
  }

  // 7) อ้างถึงได้แค่ view ที่อนุญาต (บวกชื่อ CTE ที่นิยามในคำสั่งเดียวกัน)
  //    ข้อนี้คือสิ่งที่ชั้นฐานข้อมูลทำแทนไม่ได้ เพราะ pg_catalog เปิดให้ทุก role อ่าน
  for (const rel of acc.relations) {
    const name = rel.name.toLowerCase()
    const schema = rel.schema?.toLowerCase()

    if (schema !== undefined && !opts.allowedSchemas.has(schema)) {
      return fail(
        'FORBIDDEN_RELATION',
        `ห้ามอ้างถึง schema "${rel.schema}" — อ้างได้เฉพาะ ${[...opts.allowedRelations].join(', ')}`,
      )
    }
    // ชื่อ CTE ใช้ได้เฉพาะตอนไม่ระบุ schema นำหน้า
    if (schema === undefined && acc.cteNames.has(name)) continue
    if (!opts.allowedRelations.has(name)) {
      return fail(
        'FORBIDDEN_RELATION',
        `ห้ามอ้างถึงตาราง "${rel.schema ? `${rel.schema}.` : ''}${rel.name}" — ` +
          `อ้างได้เฉพาะ ${[...opts.allowedRelations].join(', ')}`,
      )
    }
  }

  // 8) ฟังก์ชันต้องอยู่ใน allowlist
  for (const fn of acc.functions) {
    const schema = fn.schema?.toLowerCase()
    // ไวยากรณ์มาตรฐานอย่าง EXTRACT / SUBSTRING ถูก parser แปลงเป็น pg_catalog.xxx เอง
    if (schema !== undefined && schema !== 'pg_catalog') {
      return fail('FORBIDDEN_FUNCTION', `ห้ามเรียกฟังก์ชันข้าม schema: ${fn.qualified}`)
    }
    if (!opts.allowedFunctions.has(fn.bare)) {
      return fail(
        'FORBIDDEN_FUNCTION',
        `ฟังก์ชัน ${fn.bare}() ไม่อยู่ในรายการที่อนุญาต ` +
          '(อนุญาตเฉพาะฟังก์ชันรวมยอด วันเวลา ข้อความ และ window ที่ใช้ในงานวิเคราะห์)',
      )
    }
  }

  // 9) บังคับ LIMIT
  const select = top['SelectStmt'] as { limitCount?: unknown }
  const existing = select.limitCount === undefined ? null : limitConstant(select.limitCount)
  const hasLimitClause = select.limitCount !== undefined

  if (hasLimitClause && existing !== null && existing <= opts.maxRows) {
    return {
      ok: true,
      sql,
      limit: 'already-present',
      relations: [...new Set(acc.relations.map((r) => r.name.toLowerCase()))],
      functions: [...new Set(acc.functions.map((f) => f.bare))],
    }
  }

  if (isRewrite) {
    // ครอบไปแล้วรอบหนึ่งแต่ยังไม่มี LIMIT แปลว่าตรรกะการครอบมีปัญหา
    return fail('INTERNAL', 'ครอบ LIMIT ไม่สำเร็จ')
  }

  // ครอบด้วย subquery แทนการต่อข้อความ LIMIT ท้ายคำสั่ง เพราะการต่อข้อความ
  // จะพังเมื่อคำสั่งเดิมเป็น UNION หรือมี LIMIT/OFFSET อยู่แล้ว ส่วนการครอบ
  // ใช้ได้กับทุกรูปแบบ และผลลัพธ์ถูกเอาไป parse ตรวจซ้ำอีกรอบ
  const inner = sql.replace(/;\s*$/, '')
  const wrapped = `SELECT * FROM (\n${inner}\n) AS guarded_result LIMIT ${opts.maxRows}`

  const recheck = await validate(wrapped, opts, true)
  if (!recheck.ok) return recheck

  return {
    ...recheck,
    limit: hasLimitClause ? 'capped' : 'added',
  }
}
