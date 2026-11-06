// web/lib/db.ts — connection pool ของเว็บ: web_reader เท่านั้น ไม่มีทางเลือกอื่น
//
// ไฟล์นี้ไม่มี pool ของ role อื่น และไม่มีฟังก์ชันสลับ role (รอบก่อนมี getActivePool() ที่สลับไปใช้
// แอดมินเมื่อไม่มีรหัสผ่าน — ลบทิ้งแล้ว) ถ้าค่าตั้งไม่ครบ ทุกทางออกคือ throw
// เหตุผลเต็ม ๆ อยู่ใน docs/privacy.md หัวข้อ "ทำไมเว็บต้องไม่มีสิทธิ์แอดมิน"
//
// สัปดาห์ 3: เว็บจะเพิ่มการเรียก ask() ซึ่งใช้ role ai_reader ได้ (อ่านได้แค่ view deaths ที่ผ่านตัวตรวจ SQL)
// แต่ต้องเพิ่มเป็น pool แยกที่ประกาศชัดเจนเหมือนไฟล์นี้ ห้ามสร้างทางลัดไปหาแอดมินไม่ว่ากรณีใด
import pg from 'pg'

import { loadLocalWebEnv } from './local-env'
import { assertUnprivilegedWebRole, resolveWebDbConfig, WebConfigError } from './web-config'

let pool: pg.Pool | undefined
let verified = false
let blocked: WebConfigError | undefined

/**
 * ตรวจว่าค่าตั้งครบและถูกต้อง โดยยังไม่เชื่อมต่อฐานข้อมูล — throw ถ้าไม่ครบ
 * เรียกตอนเซิร์ฟเวอร์เริ่มทำงาน (instrumentation.ts) เพื่อให้ล้มตั้งแต่เริ่ม ไม่ใช่ล้มตอนมีผู้ใช้คนแรกเข้า
 */
export function assertWebConfig(): void {
  loadLocalWebEnv()
  resolveWebDbConfig(process.env)
}

function webPool(): pg.Pool {
  if (pool) return pool
  assertWebConfig()
  const cfg = resolveWebDbConfig(process.env)
  pool =
    cfg.kind === 'url'
      ? new pg.Pool({ connectionString: cfg.connectionString, max: 4, connectionTimeoutMillis: 5000 })
      : new pg.Pool({
          host: cfg.host,
          port: cfg.port,
          database: cfg.database,
          user: cfg.user,
          password: cfg.password,
          max: 4,
          connectionTimeoutMillis: 5000,
        })
  // connection ที่ idle แล้วหลุดจะส่ง error มาที่ pool ถ้าไม่มีตัวรับ process จะล้ม
  pool.on('error', (err) => console.error('[db] idle connection error:', err.message))
  return pool
}

/**
 * pool ที่ผ่านการตรวจแล้วว่าเชื่อมต่อในฐานะ web_reader จริง และ role นั้นไม่มีสิทธิ์พิเศษ
 *
 * ชั้นที่สองต่อจากการตรึงชื่อใน resolveWebDbConfig: ต่อให้ใครไปให้สิทธิ์ superuser / createrole /
 * bypassrls กับ web_reader (หรือ URL ชี้ไปฐานข้อมูลที่ชื่อ role ซ้ำกันแต่สิทธิ์ต่างกัน) เว็บจะไม่ยอมทำงาน
 * ตรวจครั้งเดียวต่อ process เมื่อผ่านแล้วไม่ตรวจซ้ำ ส่วนการเชื่อมต่อล้มเหลวชั่วคราว (ฐานข้อมูลล่ม) ไม่ถูกจำ
 * จะลองใหม่ในคำขอถัดไป แต่ถ้า role ผิด จะถูกจำและปฏิเสธทุกคำขอ
 */
export async function getWebPool(): Promise<pg.Pool> {
  if (blocked) throw blocked
  const p = webPool()
  if (verified) return p

  const { rows } = await p.query<{ role: string; privileged: boolean }>(
    `SELECT current_user::text AS role,
            coalesce((SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls
                        FROM pg_roles WHERE rolname = current_user), true) AS privileged`,
  )
  try {
    assertUnprivilegedWebRole(rows[0])
  } catch (err) {
    blocked = err as WebConfigError
    await p.end().catch(() => undefined)
    pool = undefined
    throw blocked
  }
  verified = true
  return p
}
