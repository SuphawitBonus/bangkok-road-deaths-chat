// npm run neon:sync — คัดลอกตารางสรุป app.h3_deaths_monthly จากฐานข้อมูลในเครื่องขึ้น Neon (production)
//
// สิ่งที่ production มี: schema app, ตาราง app.h3_deaths_monthly, role web_reader — แค่นี้
// สิ่งที่ production ไม่มีและสคริปต์นี้ไม่ทำให้มี: app.deaths, app.deaths_raw, ai_reader, ข้อมูลรายคนใด ๆ
//   → ไม่รัน db/01–03, ไม่อ่านจาก view/ตารางรายคนเลย (ต้นทางอ่านด้วย web_reader ในเครื่อง ซึ่งอ่านได้แค่ตารางสรุป)
//
// ใช้ NEON_ADMIN_URL (host แบบ direct) เท่านั้นเพื่อสร้าง schema/role/ตาราง ห้ามเว็บอ่านมัน ห้ามขึ้น Vercel
// รันซ้ำได้: ผลเหมือนเดิมทุกครั้ง (CREATE ... IF NOT EXISTS, ALTER ROLE, TRUNCATE แล้ว INSERT ใน transaction เดียว)
// ไม่พิมพ์รหัสผ่านหรือ connection string ที่ใดเลย
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

import { LOCATED_DEATHS, LOCATED_DEATHS_COMPLETE_YEARS } from '../../web/lib/dataset-facts.js'
import { optional, required } from '../lib/env.js'
import {
  ADMIN_ENV,
  appendEnvLine,
  buildWebUrl,
  generatePassword,
  isLocalHost,
  parseNeonAdminUrl,
  parseNeonWebUrl,
  safeMessage,
  WEB_ENV,
  WEB_ROLE,
} from '../lib/neon.js'

const TABLE = 'app.h3_deaths_monthly'
const COLUMNS = [
  'h3_res8',
  'h3_res9',
  'died_year',
  'died_month',
  'is_complete_year',
  'death_count',
  'centroid_lat',
  'centroid_lng',
] as const
const BATCH = 1000

interface Row {
  h3_res8: string
  h3_res9: string
  died_year: number
  died_month: number
  is_complete_year: boolean
  death_count: number
  centroid_lat: number
  centroid_lng: number
}

interface Fingerprint {
  rows: number
  total: number
  complete: number
  digest: string
}

// เรียงด้วย COLLATE "C" ทั้งสองฝั่ง: collation ของ Neon กับ Postgres ในเครื่องอาจต่างกัน ถ้าไม่ตรึง ลำดับสตริงต่างกัน
// แล้ว digest จะไม่ตรงทั้งที่ข้อมูลเหมือนกันทุกแถว
const FINGERPRINT_SQL = `
  SELECT count(*)::int AS rows,
         coalesce(sum(death_count), 0)::int AS total,
         coalesce(sum(death_count) FILTER (WHERE is_complete_year), 0)::int AS complete,
         md5(coalesce(string_agg(
               concat_ws('|', h3_res8, h3_res9, died_year, died_month, is_complete_year, death_count, centroid_lat, centroid_lng),
               E'\\n' ORDER BY h3_res8 COLLATE "C", h3_res9 COLLATE "C", died_year, died_month, is_complete_year), '')) AS digest
    FROM ${TABLE}`

const fmt = (n: number) => n.toLocaleString('en-US')
const secrets: string[] = []

function fail(message: string): never {
  console.error(`\nหยุด: ${message}`)
  process.exit(1)
}

async function fingerprint(db: pg.ClientBase | pg.Pool): Promise<Fingerprint> {
  const { rows } = await db.query<Fingerprint>(FINGERPRINT_SQL)
  return rows[0]!
}

/** ต้นทาง: ฐานข้อมูลในเครื่อง อ่านด้วย web_reader (อ่านได้เฉพาะตารางสรุป) ไม่ใช่แอดมิน */
async function readSource(): Promise<{ rows: Row[]; fp: Fingerprint }> {
  const host = optional('POSTGRES_HOST', 'localhost')
  if (!isLocalHost(host)) fail('POSTGRES_HOST ไม่ใช่เครื่องนี้ — ต้นทางของ sync ต้องเป็นฐานข้อมูลในเครื่องเท่านั้น')
  const password = required('WEB_DB_PASSWORD')
  secrets.push(password)
  const pool = new pg.Pool({
    host,
    port: Number(optional('POSTGRES_PORT', '5435')),
    database: optional('POSTGRES_DB', 'roaddeaths'),
    user: WEB_ROLE,
    password,
    max: 1,
    connectionTimeoutMillis: 8000,
  })
  try {
    const fp = await fingerprint(pool)
    const { rows } = await pool.query<Row>(
      `SELECT ${COLUMNS.join(', ')} FROM ${TABLE}
        ORDER BY h3_res8 COLLATE "C", h3_res9 COLLATE "C", died_year, died_month, is_complete_year`,
    )
    return { rows, fp }
  } finally {
    await pool.end()
  }
}

async function copyRows(neon: pg.Client, rows: readonly Row[]): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const part = rows.slice(i, i + BATCH)
    await neon.query(
      `INSERT INTO ${TABLE} (${COLUMNS.join(', ')})
       SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::int[], $5::bool[], $6::int[], $7::float8[], $8::float8[])`,
      COLUMNS.map((c) => part.map((r) => r[c])),
    )
  }
}

async function main(): Promise<void> {
  console.log('neon:sync — คัดลอกตารางสรุปขึ้น Neon')

  // ── 1) ค่าตั้ง (ไม่พิมพ์ค่า) ───────────────────────────────────────────
  const adminRaw = optional(ADMIN_ENV)
  if (adminRaw === '') fail(`ไม่พบ ${ADMIN_ENV} ใน .env`)
  secrets.push(adminRaw)
  let admin: URL
  try {
    admin = parseNeonAdminUrl(adminRaw)
  } catch (err) {
    return fail(safeMessage(err, secrets))
  }
  secrets.push(decodeURIComponent(admin.password), admin.password)
  console.log(`  ok  ${ADMIN_ENV}: มี และผ่านการตรวจ (ไม่ใช่เครื่องตัวเอง ไม่ใช่ ${WEB_ROLE} ไม่ใช่ pooled)`)

  // ── 2) ต้นทาง (ในเครื่อง) ─────────────────────────────────────────────
  let source: { rows: Row[]; fp: Fingerprint }
  try {
    source = await readSource()
  } catch (err) {
    return fail(`อ่านตารางต้นทางในเครื่องไม่ได้ (${safeMessage(err, secrets)}) — เปิด container และรัน npm run db:migrate ก่อน`)
  }
  const { rows, fp: local } = source
  console.log(`  ok  ต้นทางในเครื่อง: ${fmt(local.rows)} แถว · ผลรวม death_count ${fmt(local.total)} · ปีที่ครบ ${fmt(local.complete)}`)
  if (local.rows === 0) fail('ตารางต้นทางว่าง — รัน npm run db:load-h3 ก่อน')
  if (rows.length !== local.rows) fail('จำนวนแถวที่อ่านไม่ตรงกับที่นับ (ต้นทางเปลี่ยนระหว่างอ่าน?) ลองใหม่')
  if (local.total !== LOCATED_DEATHS || local.complete !== LOCATED_DEATHS_COMPLETE_YEARS) {
    fail(
      `ผลรวมต้นทาง (${fmt(local.total)} / ${fmt(local.complete)}) ไม่ตรงกับค่าคงที่ใน web/lib/dataset-facts.ts ` +
        `(${fmt(LOCATED_DEATHS)} / ${fmt(LOCATED_DEATHS_COMPLETE_YEARS)}) — ข้อมูลเปลี่ยน? รัน npm run db:check และแก้ค่าคงที่ก่อน`,
    )
  }

  // ── 3) ต่อ Neon (direct) และตรวจก่อนเริ่ม ───────────────────────────────
  const neon = new pg.Client({ connectionString: adminRaw, connectionTimeoutMillis: 15000 })
  neon.on('error', () => undefined)
  try {
    await neon.connect()
  } catch (err) {
    return fail(`ต่อ Neon ไม่ได้: ${safeMessage(err, secrets)}`)
  }

  let exitCode = 0
  try {
    const info = await neon.query<{ me: string; ver: string; db: string }>(
      `SELECT current_user::text AS me, current_setting('server_version') AS ver, current_database()::text AS db`,
    )
    console.log(`  ok  ต่อ Neon (direct) ได้ · Postgres ${info.rows[0]!.ver}`)

    // production ต้องไม่มีอย่างอื่นนอกจากตารางสรุป: ถ้ามีตารางอื่นใน schema app (เช่นเผลอรัน 01–03 มาก่อน) หยุดทันที
    const extra = await neon.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relkind IN ('r','p','v','m','f') AND c.relname <> 'h3_deaths_monthly'`,
    )
    if (extra.rows.length > 0) {
      fail(`พบ ${extra.rows.map((r) => `app.${r.relname}`).join(', ')} บน Neon — production ต้องมีแค่ h3_deaths_monthly ไม่แตะอะไรเลย ตรวจก่อน`)
    }

    // ── 4) รหัสผ่านของ web_reader: ใช้ค่าเดิมใน .env ถ้ามี ไม่มีก็สุ่มแล้วต่อท้ายไฟล์ ─
    const existing = optional(WEB_ENV)
    let webPassword: string
    if (existing !== '') {
      secrets.push(existing)
      try {
        webPassword = parseNeonWebUrl(existing).password
      } catch (err) {
        return fail(safeMessage(err, secrets))
      }
      console.log(`  ok  ${WEB_ENV}: มีอยู่แล้ว ใช้ค่าเดิม`)
    } else {
      webPassword = generatePassword()
      const url = buildWebUrl(admin, webPassword)
      secrets.push(url)
      try {
        appendEnvLine(resolve('.env'), WEB_ENV, url)
      } catch (err) {
        return fail(`${safeMessage(err, secrets)} (ยังไม่ได้แตะฐานข้อมูล Neon)`)
      }
      console.log(`  ok  ${WEB_ENV}: สุ่มรหัสผ่านใหม่ แล้วต่อท้าย .env (ไม่แตะบรรทัดเดิม ไม่พิมพ์ค่า)`)
    }
    secrets.push(webPassword)

    // ── 5) ทำทุกอย่างใน transaction เดียว ───────────────────────────────
    // role, schema, สิทธิ์, ตาราง, ข้อมูล: ผิดตรงไหน ROLLBACK ทั้งก้อน Neon จะไม่ค้างอยู่ในสภาพครึ่ง ๆ กลาง ๆ
    await neon.query('BEGIN')
    try {
      await neon.query('CREATE SCHEMA IF NOT EXISTS app')
      // is_local = true: ค่านี้อยู่แค่ใน transaction นี้ แล้วหายไปเอง
      await neon.query(`SELECT set_config('app.web_password', $1, true)`, [webPassword])
      // ใช้ไฟล์เดียวกับที่ใช้ในเครื่อง เพื่อให้ role บน Neon จำกัดสิทธิ์ด้วยตรรกะเดียวกันเป๊ะ
      // (สร้างด้วย SQL: role ที่สร้างจาก console ของ Neon จะได้ CREATEROLE/CREATEDB ติดมา)
      await neon.query(readFileSync('db/04_web_security.sql', 'utf8'))
      await neon.query(readFileSync('db/05_h3_aggregate.sql', 'utf8'))
      // 04 รันก่อนมีตาราง จึงยังไม่ได้ให้ SELECT รอบแรก — 05 ให้ต่อให้เมื่อสร้างตารางแล้ว (และ 04 ให้เองเมื่อรันซ้ำ)
      await neon.query(`SELECT set_config('app.web_password', '', true)`)

      await neon.query(`TRUNCATE ${TABLE}`)
      await copyRows(neon, rows)

      const after = await fingerprint(neon)
      const same = after.rows === local.rows && after.total === local.total && after.complete === local.complete && after.digest === local.digest
      if (!same) {
        throw new Error(
          `ข้อมูลบน Neon ไม่ตรงกับต้นทางหลังคัดลอก (แถว ${fmt(after.rows)}/${fmt(local.rows)}, ผลรวม ${fmt(after.total)}/${fmt(local.total)}, ` +
            `digest ${after.digest === local.digest ? 'ตรง' : 'ไม่ตรง'}) — ROLLBACK`,
        )
      }
      await neon.query('COMMIT')
      console.log(`  ok  คัดลอกแล้ว ${fmt(after.rows)} แถว · ผลรวม death_count ${fmt(after.total)} · ตรงกับต้นทางทุกแถว (เทียบ digest md5)`)
    } catch (err) {
      await neon.query('ROLLBACK').catch(() => undefined)
      throw err
    }

    // ── 6) อ่านซ้ำหลัง COMMIT จาก session ใหม่ ──────────────────────────
    const check = new pg.Client({ connectionString: adminRaw, connectionTimeoutMillis: 15000 })
    check.on('error', () => undefined)
    await check.connect()
    try {
      const final = await fingerprint(check)
      if (final.digest !== local.digest || final.rows !== local.rows || final.total !== local.total) {
        throw new Error('อ่านซ้ำหลัง COMMIT แล้วไม่ตรงกับต้นทาง')
      }
      console.log('  ok  อ่านซ้ำหลัง COMMIT จาก session ใหม่ ตรงกับต้นทาง')
    } finally {
      await check.end()
    }
  } catch (err) {
    console.error(`\nล้มเหลว: ${safeMessage(err, secrets)}`)
    exitCode = 1
  } finally {
    await neon.end().catch(() => undefined)
  }

  if (exitCode === 0) console.log('\nเสร็จ — รัน npm run neon:check เพื่อตรวจสิทธิ์ของ web_reader และเนื้อหาบน Neon')
  process.exit(exitCode)
}

main().catch((err: unknown) => {
  console.error(`\nล้มเหลว: ${safeMessage(err, secrets)}`)
  process.exit(1)
})
