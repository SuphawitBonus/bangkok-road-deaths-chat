// พิสูจน์ว่าชั้นฐานข้อมูลป้องกันได้จริง โดยยิงคำสั่งอันตรายด้วย role ของ AI ตรง ๆ
// ไม่ผ่านตัวตรวจในโค้ดเลย
//
// สคริปต์นี้คือหลักฐานว่าชั้นที่ 1 ยืนอยู่ได้ด้วยตัวเอง รันซ้ำได้ทุกเมื่อ และต้องรันอีกครั้ง
// หลังย้ายไป Neon เพราะสิทธิ์บนบริการที่จัดการให้อาจต่างจาก Postgres ในเครื่อง
import pg from 'pg'

import {
  H3_TABLE_COLUMNS,
  LOCATED_DEATHS,
  LOCATED_DEATHS_COMPLETE_YEARS,
  TOTAL_DEATHS,
  TOTAL_DEATHS_BY_YEAR,
} from '../../web/lib/dataset-facts.js'
import { DATA_YEAR_MAX_COMPLETE, DATA_YEAR_MIN } from '../../web/lib/years.js'
import { adminPool, aiPool, closePools, webPool } from '../lib/db.js'

interface Case {
  label: string
  sql: string
  /** คาดว่าจะถูกปฏิเสธ (true) หรือต้องผ่านได้ (false) */
  expectBlocked: boolean
}

const CASES: Case[] = [
  { label: 'SELECT บน view deaths', sql: 'SELECT count(*) FROM deaths', expectBlocked: false },
  { label: 'อ่านตารางดิบ deaths_raw', sql: 'SELECT * FROM app.deaths_raw LIMIT 1', expectBlocked: true },
  { label: 'INSERT', sql: "INSERT INTO app.deaths_raw (year_be, died_on) VALUES (2569, '2026-01-01')", expectBlocked: true },
  { label: 'UPDATE ผ่าน view', sql: 'UPDATE deaths SET age = 1', expectBlocked: true },
  { label: 'DELETE ผ่าน view', sql: 'DELETE FROM deaths', expectBlocked: true },
  { label: 'DROP VIEW', sql: 'DROP VIEW app.deaths', expectBlocked: true },
  { label: 'CREATE TABLE', sql: 'CREATE TABLE evil (x int)', expectBlocked: true },
  { label: 'สร้างตารางใน schema อื่น', sql: 'CREATE TABLE public.evil (x int)', expectBlocked: true },
  // ถ้า REVOKE ใน 03_security.sql สำเร็จจะโดนปฏิเสธเพราะไม่มีสิทธิ์
  // ถ้า REVOKE ไม่สำเร็จ (เช่นบน Neon) ก็ยังโดน statement_timeout อยู่ดี
  { label: 'pg_sleep นานเกิน statement_timeout', sql: 'SELECT pg_sleep(8)', expectBlocked: true },
  { label: 'อ่านไฟล์จากเครื่อง', sql: "SELECT pg_read_file('/etc/passwd')", expectBlocked: true },
  { label: 'เปลี่ยนรหัสผ่านตัวเอง', sql: "ALTER ROLE ai_reader PASSWORD 'hacked'", expectBlocked: true },
]

/** สิ่งที่ชั้นฐานข้อมูลกันไม่ได้ — ยืนยันว่ายังทำได้จริง เพื่อไม่ให้เข้าใจผิดว่าปลอดภัย 100% */
const KNOWN_GAPS: Case[] = [
  { label: 'อ่านรายชื่อตารางจาก pg_catalog', sql: 'SELECT count(*) FROM pg_catalog.pg_tables', expectBlocked: false },
  { label: 'อ่าน information_schema', sql: 'SELECT count(*) FROM information_schema.columns', expectBlocked: false },
]

/**
 * ผลขึ้นกับว่า REVOKE EXECUTE ทำได้ในสภาพแวดล้อมนั้นหรือไม่ จึงรายงานอย่างเดียว ไม่ตัดสินถูกผิด
 * ถ้าปล่อยผ่านได้ แปลว่าเหลือแค่ statement_timeout กับตัวตรวจในโค้ดที่กันช่องทางนี้
 */
const ENV_DEPENDENT: Case[] = [
  { label: 'pg_sleep สั้นกว่า timeout', sql: 'SELECT pg_sleep(0.2)', expectBlocked: true },
]

async function run(cases: Case[], title: string, pool: pg.Pool, judge = true): Promise<number> {
  console.log(`\n${title}`)
  console.log('─'.repeat(78))
  let failures = 0

  for (const c of cases) {
    let blocked = false
    let detail = ''
    const client = await pool.connect()
    try {
      await client.query(c.sql)
    } catch (err) {
      blocked = true
      detail = err instanceof Error ? err.message.split('\n')[0]! : String(err)
    } finally {
      client.release()
    }

    const pass = blocked === c.expectBlocked
    if (judge && !pass) failures++
    const mark = !judge ? '––  ' : pass ? 'ok  ' : 'FAIL'
    const verdict = blocked ? 'ถูกปฏิเสธ' : 'ผ่านได้'
    console.log(`  ${mark} ${c.label.padEnd(34)} ${verdict}`)
    if (blocked && detail) console.log(`       └ ${detail}`)
  }
  return failures
}

// ── web_reader ────────────────────────────────────────────────────────────

const PG_INSUFFICIENT_PRIVILEGE = '42501'
const PG_READ_ONLY_TRANSACTION = '25006'

const ALL_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']


const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`
const errorCode = (err: unknown) => (err as { code?: string } | null)?.code
const firstLine = (err: unknown) => (err instanceof Error ? err.message.split('\n')[0]! : String(err))

/** รันคำสั่งตามลำดับบน connection เดียว คืนข้อผิดพลาดของคำสั่งสุดท้าย (null ถ้าสำเร็จ) แล้วทิ้ง connection */
async function lastError(pool: pg.Pool, sqls: string[]): Promise<unknown> {
  const client = await pool.connect()
  let result: unknown = null
  try {
    for (const sql of sqls) await client.query(sql)
  } catch (err) {
    result = err
  } finally {
    // ทิ้ง connection แทนการคืนเข้า pool เพราะบางกรณีเปลี่ยนค่า session (เช่น SET) ห้ามรั่วไปถึงคำสั่งถัดไป
    client.release(true)
  }
  return result
}

async function checkWebReader(): Promise<number> {
  console.log('\nการตรวจ role web_reader (ข้อบังคับ ข้ามไม่ได้)')
  console.log('─'.repeat(78))

  let failures = 0
  const check = (pass: boolean, label: string, detail = '') => {
    if (!pass) failures++
    console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
  }

  // 0) ต้องเชื่อมต่อได้ — ถ้าไม่ได้ ล้มทันที ไม่ปล่อยให้ดูเหมือนตรวจผ่าน
  let web: pg.Pool
  try {
    web = webPool()
    const client = await web.connect()
    client.release()
  } catch (err) {
    check(false, 'เชื่อมต่อด้วย web_reader ไม่ได้ จึงพิสูจน์สิทธิ์ไม่ได้', `(${firstLine(err)})`)
    console.log('       └ ตั้ง WEB_DB_PASSWORD ใน .env แล้วรัน npm run db:migrate เพื่อสร้าง role ก่อน')
    return failures
  }
  const admin = adminPool()

  // 1) ตัวตนและสิทธิ์พิเศษ
  const who = await web.query<Record<string, unknown>>(
    `SELECT current_user::text AS me, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls
       FROM pg_roles r WHERE r.rolname = current_user`,
  )
  const me = who.rows[0]
  check(me?.me === 'web_reader', 'เชื่อมต่อในฐานะ web_reader', `(ได้ ${String(me?.me)})`)
  check(
    me !== undefined && !me.rolsuper && !me.rolcreaterole && !me.rolcreatedb && !me.rolreplication && !me.rolbypassrls,
    'ไม่มีสิทธิ์พิเศษ (superuser / createrole / createdb / replication / bypassrls)',
  )

  const settings = await web.query<{ name: string; setting: string }>(
    `SELECT name, setting FROM pg_settings
      WHERE name IN ('default_transaction_read_only','statement_timeout','search_path',
                     'idle_in_transaction_session_timeout','lock_timeout')
      ORDER BY name`,
  )
  console.log('\n  ค่าที่ติดมากับ role web_reader')
  for (const st of settings.rows) console.log(`    ${st.name.padEnd(38)} = ${st.setting}`)

  // 2) ตารางที่มีสิทธิ์ SELECT: ไล่ตรวจ "ทุกตารางและ view ใน schema app" ที่มีอยู่จริง
  //    (ไม่ใช่รายชื่อที่จำไว้ ตารางที่เพิ่มในอนาคตจึงถูกตรวจโดยอัตโนมัติ)
  const rels = await admin.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`,
  )
  const names = rels.rows.map((r) => r.relname)
  console.log(`\n  ตาราง/view ใน schema app (${names.length}): ${names.join(', ')}`)
  check(
    ['deaths', 'deaths_raw', 'h3_deaths_monthly'].every((n) => names.includes(n)),
    'พบ deaths, deaths_raw, h3_deaths_monthly ครบ (การตรวจด้านล่างไม่ว่างเปล่า)',
  )

  for (const name of names) {
    const mustRead = name === 'h3_deaths_monthly'
    let err: unknown = null
    try {
      await web.query(`SELECT 1 FROM app.${quoteIdent(name)} LIMIT 1`)
    } catch (e) {
      err = e
    }
    if (mustRead) {
      check(err === null, `SELECT app.${name} ได้`, err ? `(${firstLine(err)})` : '')
    } else {
      const denied = errorCode(err) === PG_INSUFFICIENT_PRIVILEGE
      check(
        denied,
        `SELECT app.${name} ไม่ได้ (permission denied)`,
        err === null ? '← อ่านได้! ผิด' : denied ? '' : `(ได้ error อื่น: ${firstLine(err)})`,
      )
    }
  }

  // 3) สิทธิ์ทุกชนิดบนทุกตาราง จาก catalog — web_reader ต้องมีแค่ SELECT บน h3_deaths_monthly อย่างเดียว
  const grants = await admin.query<{ relname: string; priv: string }>(
    `SELECT c.relname, p.priv
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest($1::text[]) AS p(priv)
      WHERE n.nspname = 'app' AND c.relkind IN ('r','p','v','m','f')
        AND ( has_table_privilege('web_reader', c.oid, p.priv)
              OR (p.priv IN ('SELECT','INSERT','UPDATE','REFERENCES')
                  AND has_any_column_privilege('web_reader', c.oid, p.priv)) )
      ORDER BY 1, 2`,
    [ALL_PRIVILEGES],
  )
  const granted = grants.rows.map((g) => `${g.relname}:${g.priv}`)
  check(
    granted.length === 1 && granted[0] === 'h3_deaths_monthly:SELECT',
    'สิทธิ์ทั้งหมดที่มีบนตารางใน schema app = SELECT บน h3_deaths_monthly อย่างเดียว',
    `(พบ: ${granted.join(', ') || 'ไม่มี'})`,
  )

  const seq = await admin.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relkind = 'S'
        AND (has_sequence_privilege('web_reader', c.oid, 'USAGE')
             OR has_sequence_privilege('web_reader', c.oid, 'SELECT')
             OR has_sequence_privilege('web_reader', c.oid, 'UPDATE'))`,
  )
  check(
    seq.rows.length === 0,
    'ไม่มีสิทธิ์บน sequence ใดใน schema app',
    seq.rows.length ? `(พบ: ${seq.rows.map((r) => r.relname).join(', ')})` : '',
  )

  const sch = await admin.query<{ app_create: boolean; public_create: boolean }>(
    `SELECT has_schema_privilege('web_reader','app','CREATE') AS app_create,
            has_schema_privilege('web_reader','public','CREATE') AS public_create`,
  )
  check(!sch.rows[0]!.app_create && !sch.rows[0]!.public_create, 'สร้างอะไรใน schema app / public ไม่ได้ (CREATE)')

  // 4) เขียนอะไรไม่ได้เลย — ลองจริง ไม่ใช่เชื่อ catalog อย่างเดียว
  console.log('\n  ลองเขียน / แก้โครงสร้าง (ทุกข้อต้องถูกปฏิเสธ)')
  const INSERT_H3 =
    "INSERT INTO app.h3_deaths_monthly (h3_res8, h3_res9, died_year, died_month, is_complete_year, death_count, centroid_lat, centroid_lng) VALUES ('x','x',2020,1,true,1,13.7,100.5)"
  const WRITE_CASES: [string, string[]][] = [
    ['INSERT', [INSERT_H3]],
    ['UPDATE', ['UPDATE app.h3_deaths_monthly SET death_count = 0']],
    ['DELETE', ['DELETE FROM app.h3_deaths_monthly']],
    ['TRUNCATE', ['TRUNCATE app.h3_deaths_monthly']],
    ['DROP TABLE', ['DROP TABLE app.h3_deaths_monthly']],
    ['ALTER TABLE', ['ALTER TABLE app.h3_deaths_monthly ADD COLUMN evil int']],
    ['CREATE TABLE ใน app', ['CREATE TABLE app.evil (x int)']],
    ['CREATE TABLE ใน public', ['CREATE TABLE public.evil (x int)']],
    ['CREATE SCHEMA', ['CREATE SCHEMA evil']],
    ['CREATE FUNCTION', ["CREATE FUNCTION app.evil() RETURNS int LANGUAGE sql AS 'SELECT 1'"]],
    ['CREATE INDEX', ['CREATE INDEX evil_idx ON app.h3_deaths_monthly (death_count)']],
    ['ให้สิทธิ์ตัวเองบน app.deaths', ['GRANT SELECT ON app.deaths TO web_reader']],
    ['เปลี่ยนรหัสผ่านตัวเอง', ["ALTER ROLE web_reader PASSWORD 'hacked'"]],
    ['สลับไปเป็น role แอดมิน', ['SET ROLE app_admin']],
    ['สลับไปเป็น ai_reader', ['SET ROLE ai_reader']],
    ['COPY ... TO PROGRAM', ["COPY app.h3_deaths_monthly TO PROGRAM 'cat'"]],
    ['อ่านไฟล์จากเครื่อง', ["SELECT pg_read_file('/etc/passwd')"]],
  ]
  for (const [label, sqls] of WRITE_CASES) {
    const err = await lastError(web, sqls)
    check(err !== null, label, err ? `← ${firstLine(err)}` : '← สำเร็จ! ผิด')
  }

  // ชั้น read-only ของ role เป็นแค่ค่าเริ่มต้นที่เซสชันปิดเองได้ จึงต้องพิสูจน์ว่าต่อให้ปิดแล้ว
  // ชั้น "สิทธิ์" ก็ยังกันอยู่เอง (ต้องได้ permission denied ไม่ใช่ read-only error)
  const bypass: [string, string[]][] = [
    ['ปิด read-only ของเซสชันแล้ว INSERT', ['SET default_transaction_read_only = off', INSERT_H3]],
    ['BEGIN READ WRITE แล้ว INSERT', ['BEGIN READ WRITE', INSERT_H3]],
    ['BEGIN READ WRITE แล้ว DELETE', ['BEGIN READ WRITE', 'DELETE FROM app.h3_deaths_monthly']],
  ]
  for (const [label, sqls] of bypass) {
    const err = await lastError(web, sqls)
    const code = errorCode(err)
    const note = code === PG_READ_ONLY_TRANSACTION ? ' = read-only ชั้นเดียว' : ''
    check(
      code === PG_INSUFFICIENT_PRIVILEGE,
      `${label} → ถูกกันด้วยสิทธิ์ (ไม่ใช่แค่ read-only)`,
      code === PG_INSUFFICIENT_PRIVILEGE ? '' : `(ได้ ${code ?? 'สำเร็จ'}${note})`,
    )
  }

  // 5) ข้อมูลในตารางสรุป
  console.log('\n  ตารางสรุป app.h3_deaths_monthly')
  const cols = await admin.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'h3_deaths_monthly' ORDER BY column_name`,
  )
  const colNames = cols.rows.map((c) => c.column_name)
  const colsOk = JSON.stringify(colNames) === JSON.stringify(H3_TABLE_COLUMNS)
  check(
    colsOk,
    'มีเฉพาะคอลัมน์ที่ตั้งใจ (ไม่มี id / วันที่ / อายุ / เพศ — ไม่มีข้อมูลรายคน)',
    colsOk ? '' : `(พบ: ${colNames.join(', ')})`,
  )

  // อ่านด้วย web_reader เอง เพื่อพิสูจน์ด้วยว่าอ่านได้จริงและเห็นตัวเลขเดียวกับแอดมิน
  const agg = await web.query<{ total: number; rows: number; min_count: number; res8: number; res9: number }>(
    `SELECT sum(death_count)::int AS total, count(*)::int AS rows, min(death_count)::int AS min_count,
            count(DISTINCT h3_res8)::int AS res8, count(DISTINCT h3_res9)::int AS res9
       FROM app.h3_deaths_monthly`,
  )
  const a = agg.rows[0]!
  const located = await admin.query<{ n: number; total: number }>(
    `SELECT count(*) FILTER (WHERE has_location)::int AS n, count(*)::int AS total FROM app.deaths`,
  )
  const l = located.rows[0]!
  check(a.total === l.n, 'ผลรวม death_count ในตาราง = จำนวนแถวที่มีพิกัดใน view', `(${a.total} กับ ${l.n})`)
  check(
    a.total === LOCATED_DEATHS,
    `ผลรวม death_count = ${LOCATED_DEATHS.toLocaleString('en-US')} (ตัวเลขที่หน้าเว็บแสดง)`,
    `(ได้ ${a.total})`,
  )
  check(
    l.total === TOTAL_DEATHS,
    `ผู้เสียชีวิตทั้งหมดใน view = ${TOTAL_DEATHS.toLocaleString('en-US')} (ตัวเลขที่หน้าเว็บแสดง)`,
    `(ได้ ${l.total})`,
  )
  check(a.min_count >= 1, 'ทุกแถวมี death_count ≥ 1', `(ต่ำสุด ${a.min_count})`)
  console.log(
    `       จำนวนแถว ${a.rows.toLocaleString('en-US')} · ช่อง res8 ที่ไม่ซ้ำ ${a.res8.toLocaleString('en-US')} · ช่อง res9 ที่ไม่ซ้ำ ${a.res9.toLocaleString('en-US')}`,
  )

  // 6) ปี: ค่าคงที่ในเว็บต้องตรงกับตารางจริง
  const yrs = await admin.query<{ lo: number; hi_complete: number; consistent: boolean }>(
    `SELECT min(died_year)::int AS lo,
            max(died_year) FILTER (WHERE is_complete_year)::int AS hi_complete,
            bool_and(is_complete_year = (died_year <= $1)) AS consistent
       FROM app.h3_deaths_monthly`,
    [DATA_YEAR_MAX_COMPLETE],
  )
  const y = yrs.rows[0]!
  check(y.lo === DATA_YEAR_MIN, `ปีแรกในตาราง = ${DATA_YEAR_MIN} ค.ศ. (DATA_YEAR_MIN)`, `(ได้ ${y.lo})`)
  check(
    y.hi_complete === DATA_YEAR_MAX_COMPLETE,
    `ปีสุดท้ายที่ข้อมูลครบ = ${DATA_YEAR_MAX_COMPLETE} ค.ศ. (DATA_YEAR_MAX_COMPLETE)`,
    `(ได้ ${y.hi_complete})`,
  )
  check(y.consistent, 'is_complete_year ตรงกับช่วงปีในทุกแถว (ปี ≤ ปีสุดท้ายที่ครบ ⇔ ครบ)')

  // 7) query แบบเดียวกับที่ API ใช้ ผลรวมต้องเท่ากับต้นทางของปีที่ครบ
  const complete = await admin.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM app.deaths WHERE has_location AND is_complete_year',
  )
  for (const col of ['h3_res8', 'h3_res9']) {
    const r = await web.query<{ total: number }>(
      `SELECT sum(c)::int AS total FROM (
         SELECT sum(death_count) AS c FROM app.h3_deaths_monthly
          WHERE is_complete_year AND died_year BETWEEN $1 AND $2 GROUP BY ${col}) t`,
      [DATA_YEAR_MIN, DATA_YEAR_MAX_COMPLETE],
    )
    check(
      r.rows[0]!.total === complete.rows[0]!.n,
      `ผลรวมของ query แบบ API (${col}) = ผู้เสียชีวิตที่มีพิกัดในปีที่ครบ`,
      `(${r.rows[0]!.total} กับ ${complete.rows[0]!.n})`,
    )
  }

  check(
    complete.rows[0]!.n === LOCATED_DEATHS_COMPLETE_YEARS,
    `ผู้เสียชีวิตที่มีพิกัดในปีที่ครบ = ${LOCATED_DEATHS_COMPLETE_YEARS.toLocaleString('en-US')} (ค่าคงที่ที่ neon:check ใช้เทียบกับ Neon)`,
    `(ได้ ${complete.rows[0]!.n})`,
  )

  // 8) ยอดรายปีที่ไทม์ไลน์ใช้: ผู้เสียชีวิตทั้งหมด (ค่าคงที่ในเว็บ) และที่มีพิกัด (query แบบ /api/years ด้วย web_reader)
  const perYear = await admin.query<{ year: number; total: number; located: number }>(
    `SELECT died_year::int AS year, count(*)::int AS total, count(*) FILTER (WHERE has_location)::int AS located
       FROM app.deaths WHERE is_complete_year GROUP BY died_year ORDER BY died_year`,
  )
  const actualTotals = Object.fromEntries(perYear.rows.map((r) => [r.year, r.total]))
  const totalsOk = JSON.stringify(actualTotals) === JSON.stringify(TOTAL_DEATHS_BY_YEAR)
  check(
    totalsOk,
    'ผู้เสียชีวิตทั้งหมดรายปี = TOTAL_DEATHS_BY_YEAR ในเว็บ (ใช้วาดแท่งเต็มของไทม์ไลน์)',
    totalsOk ? '' : `(ได้ ${JSON.stringify(actualTotals)})`,
  )
  const webYears = await web.query<{ year: number; deaths: number }>(
    `SELECT died_year AS year, SUM(death_count)::int AS deaths FROM app.h3_deaths_monthly
      WHERE is_complete_year GROUP BY died_year ORDER BY died_year`,
  )
  const locatedOk =
    JSON.stringify(webYears.rows.map((r) => [Number(r.year), r.deaths])) ===
    JSON.stringify(perYear.rows.map((r) => [r.year, r.located]))
  check(locatedOk, 'query แบบ /api/years (web_reader) = ผู้เสียชีวิตที่มีพิกัดรายปีใน view ทุกปี')

  return failures
}

async function main(): Promise<void> {
  console.log('ยิงคำสั่งด้วย role ai_reader ตรง ๆ โดยไม่ผ่านตัวตรวจในโค้ด')

  const settings = await aiPool().query<{ name: string; setting: string }>(
    `SELECT name, setting FROM pg_settings
      WHERE name IN ('default_transaction_read_only','statement_timeout','search_path',
                     'idle_in_transaction_session_timeout','lock_timeout')
      ORDER BY name`,
  )
  console.log('\nค่าที่ติดมากับ role ai_reader')
  console.log('─'.repeat(78))
  for (const s of settings.rows) console.log(`  ${s.name.padEnd(38)} = ${s.setting}`)

  let failures = await run(CASES, 'สิ่งที่ชั้นฐานข้อมูลต้องกันได้ (ai_reader)', aiPool())
  failures += await run(KNOWN_GAPS, 'สิ่งที่ชั้นฐานข้อมูลกันไม่ได้ (ชั้นโค้ดต้องรับไป)', aiPool())
  await run(ENV_DEPENDENT, 'ขึ้นกับสภาพแวดล้อม (รายงานอย่างเดียว)', aiPool(), false)

  // web_reader เป็นข้อบังคับ: ไม่มีรหัสผ่านหรือเชื่อมต่อไม่ได้ = ล้ม ไม่ใช่ข้าม
  // (เวอร์ชันเก่าพิมพ์ว่าข้ามแล้วยังรายงาน "ผ่านทุกข้อ" ทำให้เข้าใจผิดว่าตรวจแล้ว)
  failures += await checkWebReader()

  console.log('─'.repeat(78))
  if (failures === 0) {
    console.log('ผ่านทุกข้อ — ชั้นฐานข้อมูลทำงานตามที่ออกแบบไว้')
  } else {
    console.log(`มี ${failures} ข้อไม่เป็นไปตามที่คาด`)
    process.exitCode = 1
  }
  await closePools()
}

main().catch((err: unknown) => {
  console.error('ตรวจไม่สำเร็จ:', err instanceof Error ? err.message : err)
  process.exitCode = 1
  void closePools()
})
