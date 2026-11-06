// npm run neon:check — พิสูจน์ด้วยของจริงว่า Neon (production) ปลอดภัยตามที่ออกแบบ
//
// ต่อสองทาง
//   NEON_WEB_DATABASE_URL (web_reader, host แบบ pooled) — ยิงคำสั่งอันตรายด้วย role ที่เว็บใช้จริง ผ่านทางเดียวกับที่เว็บใช้
//   NEON_ADMIN_URL (direct)                              — อ่าน catalog ว่ามีอะไรอยู่บน Neon ทั้งหมด (web_reader อาจมองไม่เห็นบางอย่าง)
//
// ข้อไหนไม่ผ่าน = exit 1 ไม่มีข้อที่ข้ามเงียบ ๆ และไม่พิมพ์รหัสผ่าน/connection string/host
//
// ทุกคำสั่งที่ลองเขียนอยู่ใน transaction ที่ ROLLBACK เสมอ และไม่ใช้ SET ระดับ session เลย: ผ่าน pooler (PgBouncer แบบ transaction)
// ค่า session ที่ตั้งทิ้งไว้อาจค้างไปที่ผู้ใช้คนอื่นที่ได้ connection หลังเรา — ใช้ BEGIN READ WRITE แทนการ SET ปิด read-only
import pg from 'pg'

import {
  H3_TABLE_COLUMNS,
  LOCATED_DEATHS,
  LOCATED_DEATHS_COMPLETE_YEARS,
} from '../../web/lib/dataset-facts.js'
import { DATA_YEAR_MAX_COMPLETE, DATA_YEAR_MIN } from '../../web/lib/years.js'
import { optional } from '../lib/env.js'
import {
  ADMIN_ENV,
  isPooledHost,
  parseNeonAdminUrl,
  parseNeonWebUrl,
  safeMessage,
  WEB_ENV,
  WEB_ROLE,
} from '../lib/neon.js'

const PG_INSUFFICIENT_PRIVILEGE = '42501'
const PG_READ_ONLY_TRANSACTION = '25006'
const ALL_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']

const secrets: string[] = []
let failures = 0

const errorCode = (err: unknown) => (err as { code?: string } | null)?.code
const msg = (err: unknown) => safeMessage(err, secrets)
const fmt = (n: number) => n.toLocaleString('en-US')

function check(pass: boolean, label: string, detail = ''): void {
  if (!pass) failures++
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
}

function section(title: string): void {
  console.log(`\n${title}`)
  console.log('─'.repeat(78))
}

/**
 * รันคำสั่งใน transaction แล้ว ROLLBACK เสมอ — คืน error ของคำสั่งที่ล้ม (null ถ้าทุกคำสั่งสำเร็จ)
 * ถ้าคำสั่งอันตรายผ่านได้ขึ้นมาจริง ๆ ก็ไม่มีผลถาวร (DDL, TRUNCATE และ ALTER ROLE ของ Postgres ย้อนกลับได้)
 */
async function attempt(c: pg.Client, sqls: string[], readWrite = false): Promise<unknown> {
  let result: unknown = null
  try {
    await c.query(readWrite ? 'BEGIN READ WRITE' : 'BEGIN')
    for (const sql of sqls) await c.query(sql)
  } catch (err) {
    result = err
  } finally {
    await c.query('ROLLBACK').catch(() => undefined)
  }
  return result
}

const INSERT_H3 =
  "INSERT INTO app.h3_deaths_monthly (h3_res8, h3_res9, died_year, died_month, is_complete_year, death_count, centroid_lat, centroid_lng) VALUES ('x','x',2020,1,true,1,13.7,100.5)"

async function connect(connectionString: string, label: string): Promise<pg.Client | null> {
  const c = new pg.Client({ connectionString, connectionTimeoutMillis: 15000 })
  c.on('error', () => undefined)
  try {
    await c.connect()
    return c
  } catch (err) {
    check(false, `เชื่อมต่อ ${label} ไม่ได้`, `(${msg(err)})`)
    return null
  }
}

async function main(): Promise<void> {
  console.log('neon:check — ตรวจ Neon (production)')

  // ── 0) ค่าตั้ง ─────────────────────────────────────────────────────────
  section('ค่าตั้ง (ไม่พิมพ์ค่า)')
  const adminRaw = optional(ADMIN_ENV)
  const webRaw = optional(WEB_ENV)
  check(adminRaw !== '', `${ADMIN_ENV} มีใน .env`)
  check(webRaw !== '', `${WEB_ENV} มีใน .env (รัน npm run neon:sync เพื่อสร้าง)`)
  if (adminRaw === '' || webRaw === '') return
  secrets.push(adminRaw, webRaw)

  let admin: URL
  let web: { url: URL; password: string }
  try {
    admin = parseNeonAdminUrl(adminRaw)
    check(true, `${ADMIN_ENV}: ไม่ใช่เครื่องตัวเอง ไม่ใช่ ${WEB_ROLE} เป็น direct`)
  } catch (err) {
    check(false, `${ADMIN_ENV} ไม่ผ่านการตรวจ`, `(${msg(err)})`)
    return
  }
  try {
    web = parseNeonWebUrl(webRaw)
    check(true, `${WEB_ENV}: ผู้ใช้ = ${WEB_ROLE} และมีรหัสผ่าน`)
  } catch (err) {
    check(false, `${WEB_ENV} ไม่ผ่านการตรวจ`, `(${msg(err)})`)
    return
  }
  secrets.push(decodeURIComponent(admin.password), admin.password, web.password, decodeURIComponent(admin.username))
  check(isPooledHost(web.url.hostname), `${WEB_ENV} ใช้ host แบบ pooled (-pooler) สำหรับเว็บ`)
  check(!isPooledHost(admin.hostname), `${ADMIN_ENV} ใช้ host แบบ direct (ไม่มี -pooler)`)
  check(
    web.url.searchParams.get('sslmode') === 'verify-full',
    `${WEB_ENV} ใช้ sslmode=verify-full`,
    `(ได้ ${web.url.searchParams.get('sslmode') ?? 'ไม่ระบุ'})`,
  )
  check(admin.hostname !== web.url.hostname, 'เว็บกับแอดมินใช้ host คนละแบบ (pooled กับ direct)')

  const adminDb = await connect(adminRaw, 'Neon ด้วยแอดมิน (direct)')
  const webDb = await connect(webRaw, `Neon ด้วย ${WEB_ROLE} (pooled)`)
  try {
    if (!adminDb || !webDb) return
    await run(adminDb, webDb, decodeURIComponent(admin.username))
  } finally {
    await Promise.all([adminDb?.end().catch(() => undefined), webDb?.end().catch(() => undefined)])
  }
}

async function run(adminDb: pg.Client, webDb: pg.Client, adminUser: string): Promise<void> {
  const ver = await adminDb.query<{ v: string }>(`SELECT current_setting('server_version') AS v`)
  console.log(`  ––   Postgres ${ver.rows[0]!.v}`)

  // ── 1) ตัวตนและสิทธิ์พิเศษ ──────────────────────────────────────────────
  section(`1) ${WEB_ROLE}: ตัวตนและสิทธิ์พิเศษ (เชื่อมต่อผ่าน pooler)`)
  const who = await webDb.query<Record<string, unknown>>(
    `SELECT current_user::text AS me, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls
       FROM pg_roles r WHERE r.rolname = current_user`,
  )
  const me = who.rows[0]
  check(me?.me === WEB_ROLE, `current_user = ${WEB_ROLE}`, `(ได้ ${String(me?.me)})`)
  check(me?.rolsuper === false, 'ไม่ใช่ superuser')
  check(me?.rolcreaterole === false, 'ไม่มี CREATEROLE')
  check(me?.rolcreatedb === false, 'ไม่มี CREATEDB')
  check(me?.rolreplication === false, 'ไม่มี REPLICATION')
  check(me?.rolbypassrls === false, 'ไม่มี BYPASSRLS')

  const member = await adminDb.query<{ rolname: string }>(
    `SELECT r.rolname FROM pg_roles r WHERE r.rolname <> $1 AND pg_has_role($1, r.oid, 'member') ORDER BY 1`,
    [WEB_ROLE],
  )
  check(
    member.rows.length === 0,
    `${WEB_ROLE} ไม่ได้เป็นสมาชิกของ role อื่นเลย (ทั้งตรงและผ่านการสืบทอด รวม neon_superuser)`,
    member.rows.length ? `(เป็นสมาชิกของ: ${member.rows.map((r) => r.rolname).join(', ')})` : '',
  )
  const direct = await adminDb.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = $1`,
    [WEB_ROLE],
  )
  check(direct.rows[0]!.n === 0, `ไม่มีแถวใน pg_auth_members ที่ ${WEB_ROLE} เป็นสมาชิก`, `(พบ ${direct.rows[0]!.n})`)

  // ── 2) ค่าที่ติดมากับ role ───────────────────────────────────────────────
  section('2) ค่าที่ติดมากับ role (ตั้งที่ตัว role จึงใช้ได้แม้ผ่าน pooler)')
  const show = async (name: string) => (await webDb.query<Record<string, string>>(`SHOW ${name}`)).rows[0]![name]
  const timeout = await show('statement_timeout')
  const readOnly = await show('default_transaction_read_only')
  check(timeout === '5s', 'statement_timeout = 5s', `(ได้ ${timeout})`)
  check(readOnly === 'on', 'default_transaction_read_only = on', `(ได้ ${readOnly})`)
  for (const name of ['search_path', 'idle_in_transaction_session_timeout', 'lock_timeout']) {
    console.log(`  ––   ${name.padEnd(38)} = ${await show(name)}`)
  }

  // ── 3) อ่านได้เฉพาะตารางเดียว ────────────────────────────────────────────
  section('3) อ่านได้ (SELECT)')
  let readErr: unknown = null
  let rowsRead = 0
  try {
    rowsRead = Number((await webDb.query<{ n: number }>('SELECT count(*)::int AS n FROM app.h3_deaths_monthly')).rows[0]!.n)
  } catch (err) {
    readErr = err
  }
  check(readErr === null && rowsRead > 0, 'SELECT app.h3_deaths_monthly ได้', readErr ? `(${msg(readErr)})` : `(${fmt(rowsRead)} แถว)`)

  // ── 4) เขียนไม่ได้ ───────────────────────────────────────────────────────
  section('4) เขียน / แก้โครงสร้างไม่ได้ (ลองจริง แล้ว ROLLBACK ทุกครั้ง)')
  console.log('  ค่าเริ่มต้นของ role (read-only เปิดอยู่): ทุกข้อต้องถูกปฏิเสธ')
  const WRITES: [string, string[]][] = [
    ['INSERT', [INSERT_H3]],
    ['UPDATE', ['UPDATE app.h3_deaths_monthly SET death_count = 0']],
    ['DELETE', ['DELETE FROM app.h3_deaths_monthly']],
    ['TRUNCATE', ['TRUNCATE app.h3_deaths_monthly']],
    ['CREATE TABLE ใน app', ['CREATE TABLE app.evil (x int)']],
    ['CREATE TABLE ใน public', ['CREATE TABLE public.evil (x int)']],
    ['DROP TABLE', ['DROP TABLE app.h3_deaths_monthly']],
    ['เปลี่ยนรหัสผ่านตัวเอง', ["ALTER ROLE web_reader PASSWORD 'hacked'"]],
  ]
  for (const [label, sqls] of WRITES) {
    const err = await attempt(webDb, sqls)
    check(err !== null, label, err ? `← ${errorCode(err) ?? ''} ${msg(err)}` : '← สำเร็จ! ผิด')
  }

  console.log('\n  ปิด read-only เอง (BEGIN READ WRITE): ต้องถูกกันด้วยสิทธิ์ (42501) ไม่ใช่แค่ read-only')
  // รายการที่สามต่อท้าย = ข้อความ error อีกแบบที่ยอมรับว่า "ถูกกันจริง": Neon แก้ Postgres ให้ปฏิเสธการ SET ROLE ไปเป็น role ที่จำกัดไว้
  // (neon_superuser และ pg_* ที่อันตราย) ด้วย XX000 "It is not allowed to change role to ..." ซึ่งเข้มกว่า 42501 ไม่ใช่การรั่ว
  // (ตรวจเจอตอนรันจริงครั้งแรก — ผูกกับข้อความนี้เท่านั้น ไม่ใช่ยอมรับ XX000 ทุกกรณี)
  const NEON_RESTRICTED = /^It is not allowed to change role to /
  const BYPASS: [string, string[], RegExp?][] = [
    ['INSERT', [INSERT_H3]],
    ['UPDATE', ['UPDATE app.h3_deaths_monthly SET death_count = 0']],
    ['DELETE', ['DELETE FROM app.h3_deaths_monthly']],
    ['TRUNCATE', ['TRUNCATE app.h3_deaths_monthly']],
    ['CREATE TABLE ใน app', ['CREATE TABLE app.evil (x int)']],
    ['CREATE TABLE ใน public', ['CREATE TABLE public.evil (x int)']],
    ['CREATE SCHEMA', ['CREATE SCHEMA evil']],
    ['CREATE FUNCTION', ["CREATE FUNCTION app.evil() RETURNS int LANGUAGE sql AS 'SELECT 1'"]],
    ['ALTER TABLE', ['ALTER TABLE app.h3_deaths_monthly ADD COLUMN evil int']],
    ['DROP TABLE', ['DROP TABLE app.h3_deaths_monthly']],
    ['ให้สิทธิ์ตัวเองบน role แอดมิน', [`GRANT "${adminUser.replaceAll('"', '""')}" TO web_reader`]],
    ['สลับไปเป็น role แอดมิน', [`SET LOCAL ROLE "${adminUser.replaceAll('"', '""')}"`]],
    ['สลับไปเป็น neon_superuser', ['SET LOCAL ROLE neon_superuser'], NEON_RESTRICTED],
    ['สลับไปเป็น pg_read_server_files', ['SET LOCAL ROLE pg_read_server_files'], NEON_RESTRICTED],
    ['อ่านไฟล์จากเครื่อง', ["SELECT pg_read_file('/etc/passwd')"]],
    ['COPY ... TO PROGRAM', ["COPY app.h3_deaths_monthly TO PROGRAM 'cat'"]],
  ]
  for (const [label, sqls, alsoBlockedBy] of BYPASS) {
    const err = await attempt(webDb, sqls, true)
    const code = errorCode(err)
    const byPrivilege = code === PG_INSUFFICIENT_PRIVILEGE
    const byNeon = alsoBlockedBy !== undefined && err instanceof Error && alsoBlockedBy.test(err.message)
    check(
      byPrivilege || byNeon,
      label,
      byPrivilege
        ? ''
        : byNeon
          ? '(ถูกปฏิเสธโดยข้อจำกัดของ Neon เอง)'
          : `(ได้ ${code ?? 'สำเร็จ'}${code === PG_READ_ONLY_TRANSACTION ? ' = read-only ชั้นเดียว' : ''}: ${err ? msg(err) : ''})`,
    )
  }

  // ── 5) สิทธิ์จาก catalog (ดูโดยแอดมิน) ───────────────────────────────────
  section('5) สิทธิ์ตาม catalog (อ่านด้วยแอดมิน ไม่เชื่อแค่ผลลองเขียน)')
  const grants = await adminDb.query<{ nsp: string; relname: string; priv: string }>(
    `SELECT n.nspname AS nsp, c.relname, p.priv
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest($1::text[]) AS p(priv)
      WHERE c.relkind IN ('r','p','v','m','f')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        AND ( has_table_privilege($2, c.oid, p.priv)
              OR (p.priv IN ('SELECT','INSERT','UPDATE','REFERENCES') AND has_any_column_privilege($2, c.oid, p.priv)) )
      ORDER BY 1, 2, 3`,
    [ALL_PRIVILEGES, WEB_ROLE],
  )
  const granted = grants.rows.map((g) => `${g.nsp}.${g.relname}:${g.priv}`)
  check(
    granted.length === 1 && granted[0] === 'app.h3_deaths_monthly:SELECT',
    'สิทธิ์บนตารางทุกตารางในทุก schema = SELECT บน app.h3_deaths_monthly อย่างเดียว',
    `(พบ: ${granted.join(', ') || 'ไม่มี'})`,
  )
  const sch = await adminDb.query<{ app_c: boolean; pub_c: boolean; db_c: boolean }>(
    `SELECT has_schema_privilege($1, 'app', 'CREATE') AS app_c, has_schema_privilege($1, 'public', 'CREATE') AS pub_c,
            has_database_privilege($1, current_database(), 'CREATE') AS db_c`,
    [WEB_ROLE],
  )
  check(!sch.rows[0]!.app_c, 'CREATE ใน schema app ไม่ได้ (catalog)')
  check(!sch.rows[0]!.pub_c, 'CREATE ใน schema public ไม่ได้ (catalog)')
  check(!sch.rows[0]!.db_c, 'CREATE schema ในฐานข้อมูลไม่ได้ (catalog)')

  // ── 6) Neon มีแค่ตารางสรุป ───────────────────────────────────────────────
  section('6) Neon มีเฉพาะตารางสรุป ไม่มีข้อมูลรายคนหรือ role อื่นของโปรเจกต์')
  // ตัดความสัมพันธ์ที่เป็นของ extension ออก (เช่น view ของ pg_stat_statements) แต่แสดงจำนวนไว้ให้เห็น ไม่ซ่อน
  const tables = await adminDb.query<{ nsp: string; relname: string; ext: boolean }>(
    `SELECT n.nspname AS nsp, c.relname,
            EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e') AS ext
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p','v','m','f')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
      ORDER BY 1, 2`,
  )
  const own = tables.rows.filter((t) => !t.ext).map((t) => `${t.nsp}.${t.relname}`)
  const ext = tables.rows.filter((t) => t.ext).length
  check(
    own.length === 1 && own[0] === 'app.h3_deaths_monthly',
    'ตาราง/view ที่ไม่ใช่ของระบบหรือ extension มีแค่ app.h3_deaths_monthly',
    `(พบ ${own.length}: ${own.join(', ') || 'ไม่มี'})`,
  )
  console.log(`  ––   ความสัมพันธ์ที่เป็นของ extension (ไม่นับ): ${ext}`)
  for (const name of ['deaths', 'deaths_raw']) {
    const r = await adminDb.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relname = $1`,
      [name],
    )
    check(r.rows[0]!.n === 0, `ไม่มี app.${name} บน Neon`)
  }
  const roles = await adminDb.query<{ rolname: string }>(
    `SELECT rolname FROM pg_roles WHERE rolname IN ('ai_reader', 'app_admin') ORDER BY 1`,
  )
  check(roles.rows.length === 0, 'ไม่มี role ai_reader / app_admin บน Neon', roles.rows.length ? `(พบ ${roles.rows.map((r) => r.rolname).join(', ')})` : '')
  const login = await adminDb.query<{ rolcanlogin: boolean }>(`SELECT rolcanlogin FROM pg_roles WHERE rolname = $1`, [WEB_ROLE])
  check(login.rows[0]?.rolcanlogin === true, `${WEB_ROLE} มีอยู่และ login ได้`)

  const cols = await adminDb.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'h3_deaths_monthly' ORDER BY column_name`,
  )
  const colNames = cols.rows.map((c) => c.column_name)
  check(
    JSON.stringify(colNames) === JSON.stringify(H3_TABLE_COLUMNS),
    'ตารางมีเฉพาะคอลัมน์ที่ตั้งใจ (ไม่มี id / วันที่ / อายุ / เพศ — ไม่มีข้อมูลรายคน)',
    colNames.join(',') === H3_TABLE_COLUMNS.join(',') ? '' : `(พบ: ${colNames.join(', ')})`,
  )

  // ── 7) ตัวเลข: ผ่านทางเดียวกับที่เว็บใช้ ─────────────────────────────────
  section('7) ตัวเลขที่เว็บเห็น (web_reader ผ่าน pooler, query แบบเดียวกับ /api/h3)')
  const all = await webDb.query<{ total: number }>('SELECT sum(death_count)::int AS total FROM app.h3_deaths_monthly')
  check(all.rows[0]!.total === LOCATED_DEATHS, `ผลรวม death_count ทุกปี = ${fmt(LOCATED_DEATHS)}`, `(ได้ ${fmt(all.rows[0]!.total)})`)
  for (const col of ['h3_res8', 'h3_res9']) {
    const r = await webDb.query<{ total: number; cells: number }>(
      `SELECT sum(c)::int AS total, count(*)::int AS cells FROM (
         SELECT sum(death_count) AS c FROM app.h3_deaths_monthly
          WHERE is_complete_year AND died_year BETWEEN $1 AND $2 GROUP BY ${col}) t`,
      [DATA_YEAR_MIN, DATA_YEAR_MAX_COMPLETE],
    )
    check(
      r.rows[0]!.total === LOCATED_DEATHS_COMPLETE_YEARS,
      `ผลรวมแบบ API (${col}, ทุกปีที่ครบ) = ${fmt(LOCATED_DEATHS_COMPLETE_YEARS)}`,
      `(ได้ ${fmt(r.rows[0]!.total)} ใน ${fmt(r.rows[0]!.cells)} ช่อง)`,
    )
  }
}

main()
  .then(() => {
    console.log('\n' + '─'.repeat(78))
    if (failures > 0) {
      console.log(`ล้ม ${failures} ข้อ — ห้ามเปิดเว็บ production จนกว่าจะแก้`)
      process.exit(1)
    }
    console.log('ผ่านทุกข้อ — Neon ตรงตามที่ออกแบบไว้')
  })
  .catch((err: unknown) => {
    console.error(`\nล้มเหลว: ${msg(err)}`)
    process.exit(1)
  })
