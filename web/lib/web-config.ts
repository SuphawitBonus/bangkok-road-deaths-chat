// ค่าตั้งการเชื่อมต่อฐานข้อมูลของเว็บ — ฟังก์ชันล้วน ไม่แตะไฟล์ ไม่แตะ process.env เอง
// (รับ env เข้ามาเป็นอาร์กิวเมนต์ จึงทดสอบได้ว่า "ไม่มีรหัสผ่านแล้วต้อง error" โดยไม่ขึ้นกับเครื่องที่รัน)
//
// ──────────────────────────────────────────────────────────────────────────
// หลัก: fail closed
// ──────────────────────────────────────────────────────────────────────────
// เว็บเชื่อมต่อฐานข้อมูลได้ในฐานะ role web_reader เท่านั้น ถ้าข้อมูลไม่ครบหรือไม่ใช่ role นี้ ต้อง throw
// ห้ามเลือก role อื่นมาแทนเพื่อให้ "ทำงานต่อได้" เพราะ role ที่ใช้แทนได้ก็คือ role ที่มีสิทธิ์มากกว่า
// (เหตุการณ์จริงที่เคยเกิด: โค้ดรอบก่อนสลับไปใช้ superuser เงียบ ๆ เมื่อไม่มีรหัสผ่านของ web_reader
// ทำให้ช่องโหว่ในเว็บกลายเป็นการเข้าถึงข้อมูลรายคนและสิทธิ์แอดมินทั้งหมด)
//
// ชื่อ role ตรึงไว้ที่ web_reader ทั้งกรณีใช้ WEB_DATABASE_URL และกรณีแยกตัวแปร เพื่อให้ใส่ชื่อ role อื่น
// (เช่นแอดมิน) ผ่านตัวแปรสภาพแวดล้อมไม่ได้ แม้ผู้ตั้งค่าจะพิมพ์ผิดหรือตั้งใจ

export const WEB_ROLE = 'web_reader'

export class WebConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebConfigError'
  }
}

export type WebDbConfig =
  | { kind: 'url'; connectionString: string }
  | { kind: 'params'; host: string; port: number; database: string; user: string; password: string }

type Env = Readonly<Record<string, string | undefined>>

const has = (v: string | undefined): v is string => v !== undefined && v.trim() !== ''

export function resolveWebDbConfig(env: Env): WebDbConfig {
  const url = env.WEB_DATABASE_URL
  if (has(url)) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      // ไม่แนบ url ลงในข้อความ เพราะมีรหัสผ่านอยู่ข้างใน
      throw new WebConfigError('WEB_DATABASE_URL is not a valid URL')
    }
    if (decodeURIComponent(parsed.username) !== WEB_ROLE) {
      throw new WebConfigError(`WEB_DATABASE_URL must connect as ${WEB_ROLE}`)
    }
    if (parsed.password === '') {
      throw new WebConfigError(`WEB_DATABASE_URL has no password for ${WEB_ROLE}`)
    }
    return { kind: 'url', connectionString: url }
  }

  if (!has(env.WEB_DB_PASSWORD)) {
    throw new WebConfigError(
      `WEB_DB_PASSWORD (or WEB_DATABASE_URL) is not set. The web app only runs as ${WEB_ROLE} ` +
        'and never falls back to another database role.',
    )
  }

  const user = has(env.WEB_DB_USER) ? env.WEB_DB_USER.trim() : WEB_ROLE
  if (user !== WEB_ROLE) {
    throw new WebConfigError(`WEB_DB_USER must be ${WEB_ROLE}`)
  }

  const portText = has(env.POSTGRES_PORT) ? env.POSTGRES_PORT.trim() : '5435'
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new WebConfigError('POSTGRES_PORT is not a valid port number')
  }

  return {
    kind: 'params',
    host: has(env.POSTGRES_HOST) ? env.POSTGRES_HOST.trim() : 'localhost',
    port,
    database: has(env.POSTGRES_DB) ? env.POSTGRES_DB.trim() : 'roaddeaths',
    user,
    password: env.WEB_DB_PASSWORD,
  }
}

export interface RoleProbe {
  role: string
  /** superuser / createrole / createdb / replication / bypassrls ข้อใดข้อหนึ่ง */
  privileged: boolean
}

/**
 * ตรวจผลของ `SELECT current_user` ที่ได้หลังเชื่อมต่อ: ต้องเป็น web_reader และไม่มีสิทธิ์พิเศษ
 * ถ้า probe ว่าง (หา role ไม่เจอ) ถือว่าไม่ผ่าน — ไม่ยอมเดาว่าปลอดภัย
 */
export function assertUnprivilegedWebRole(probe: RoleProbe | undefined): void {
  if (!probe || probe.role !== WEB_ROLE || probe.privileged) {
    throw new WebConfigError(
      `The database connection is not an unprivileged ${WEB_ROLE}; refusing to serve requests.`,
    )
  }
}
