// ตัวช่วยของ npm run neon:sync และ neon:check — ส่วนที่เป็นฟังก์ชันล้วนอยู่ที่นี่ เพื่อทดสอบได้โดยไม่ต้องต่อ Neon
//
// ──────────────────────────────────────────────────────────────────────────
// กติกาที่ไฟล์นี้บังคับ
// ──────────────────────────────────────────────────────────────────────────
// 1. NEON_ADMIN_URL ใช้ในสคริปต์สองตัวนี้เท่านั้น (รันจากเครื่องนี้) ไม่มีโค้ดใน web/ แตะมัน — tests/web-db-config.test.ts
//    สแกน web/ ว่าไม่มีคำว่า NEON_ และ pickAllowedEnv ไม่เคยคืนมัน
// 2. ไม่มีสิ่งใดที่มีรหัสผ่านหรือ host ถูกพิมพ์ออกหน้าจอ: ทุกข้อความ error ผ่าน safeMessage() ก่อน
// 3. ถ้าค่าไม่ปลอดภัย (ชี้เครื่องตัวเอง, เป็น web_reader, เป็น pooled) ให้หยุดก่อนต่อฐานข้อมูล
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

export const ADMIN_ENV = 'NEON_ADMIN_URL'
export const WEB_ENV = 'NEON_WEB_DATABASE_URL'
export const WEB_ROLE = 'web_reader'

export class NeonConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NeonConfigError'
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'host.docker.internal'])

export const isLocalHost = (host: string): boolean => LOCAL_HOSTS.has(host.toLowerCase())

function parseUrl(raw: string, name: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // ห้ามแนบ raw ลงในข้อความ: มีรหัสผ่านอยู่ข้างใน
    throw new NeonConfigError(`${name} ไม่ใช่ URL ที่อ่านได้`)
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new NeonConfigError(`${name} ต้องขึ้นต้นด้วย postgresql://`)
  }
  return url
}

/**
 * ตรวจ NEON_ADMIN_URL ก่อนใช้งาน — หยุดถ้าชี้เครื่องตัวเอง, เป็น web_reader, หรือเป็น host แบบ pooled
 * (DDL และ TRUNCATE ต้องใช้ direct: pooled ผ่าน PgBouncer แบบ transaction ไม่เหมาะกับงาน session)
 */
export function parseNeonAdminUrl(raw: string): URL {
  const url = parseUrl(raw, ADMIN_ENV)
  if (isLocalHost(url.hostname)) {
    throw new NeonConfigError(`${ADMIN_ENV} ชี้เครื่องตัวเอง (localhost) — สคริปต์นี้ใช้กับ Neon เท่านั้น`)
  }
  if (decodeURIComponent(url.username) === WEB_ROLE) {
    throw new NeonConfigError(`${ADMIN_ENV} เป็น ${WEB_ROLE} — ต้องเป็น role เจ้าของฐานข้อมูลของ Neon (ใช้สร้าง schema/role ได้)`)
  }
  if (url.username === '') throw new NeonConfigError(`${ADMIN_ENV} ไม่มีชื่อผู้ใช้`)
  if (url.password === '') throw new NeonConfigError(`${ADMIN_ENV} ไม่มีรหัสผ่าน`)
  if (url.hostname.split('.')[0]!.endsWith('-pooler')) {
    throw new NeonConfigError(`${ADMIN_ENV} เป็น host แบบ pooled (-pooler) — ใช้แบบ direct (ไม่มี -pooler) สำหรับ sync`)
  }
  if (url.pathname.replace('/', '') === '') throw new NeonConfigError(`${ADMIN_ENV} ไม่ระบุชื่อฐานข้อมูล`)
  return url
}

/** host แบบ pooled ของ Neon: ใส่ -pooler ต่อท้ายชื่อ endpoint (ส่วนแรกของ host) */
export function toPooledHost(host: string): string {
  const [first, ...rest] = host.split('.')
  if (!first) throw new NeonConfigError('host ว่าง')
  return [first.endsWith('-pooler') ? first : `${first}-pooler`, ...rest].join('.')
}

/**
 * สร้าง NEON_WEB_DATABASE_URL จาก admin URL: host แบบ pooled, ผู้ใช้ web_reader, sslmode=verify-full
 * ไม่ส่งต่อพารามิเตอร์อื่นของ admin URL (เช่น channel_binding ที่ pooler ไม่รองรับ)
 * รหัสผ่านต้องเป็นอักขระที่ไม่ต้องเข้ารหัสใน URL (generatePassword ให้แบบนั้น)
 */
export function buildWebUrl(admin: URL, password: string): string {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(password)) throw new NeonConfigError('รหัสผ่านมีอักขระที่ใช้ใน URL ตรง ๆ ไม่ได้')
  const host = toPooledHost(admin.hostname)
  const port = admin.port ? `:${admin.port}` : ''
  const db = admin.pathname.replace('/', '')
  return `postgresql://${WEB_ROLE}:${password}@${host}${port}/${db}?sslmode=verify-full`
}

/** รหัสผ่านสุ่ม 32 ตัว (a-z A-Z 0-9 - _) จาก 24 ไบต์ของตัวสุ่มระดับ crypto */
export const generatePassword = (): string => randomBytes(24).toString('base64url')

/** ตรวจ NEON_WEB_DATABASE_URL ที่มีอยู่แล้ว: ต้องเป็น web_reader มีรหัสผ่าน แล้วคืนรหัสผ่านที่ถอดรหัสแล้ว */
export function parseNeonWebUrl(raw: string): { url: URL; password: string } {
  const url = parseUrl(raw, WEB_ENV)
  if (decodeURIComponent(url.username) !== WEB_ROLE) throw new NeonConfigError(`${WEB_ENV} ต้องเชื่อมต่อในฐานะ ${WEB_ROLE}`)
  if (url.password === '') throw new NeonConfigError(`${WEB_ENV} ไม่มีรหัสผ่าน`)
  if (isLocalHost(url.hostname)) throw new NeonConfigError(`${WEB_ENV} ชี้เครื่องตัวเอง`)
  return { url, password: decodeURIComponent(url.password) }
}

export const isPooledHost = (host: string): boolean => host.split('.')[0]!.endsWith('-pooler')

// ── ปิดข้อมูลลับก่อนพิมพ์ ─────────────────────────────────────────────────

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'")]+/gi
const NEON_HOST_PATTERN = /\bep-[a-z0-9-]+(?:\.[a-z0-9-]+)*\.neon\.tech\b/gi

/** ลบ URL, host ของ Neon และสตริงลับที่ระบุออกจากข้อความ */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(URL_PATTERN, '[url]').replace(NEON_HOST_PATTERN, '[host]')
  for (const s of secrets) {
    if (s.length >= 6) out = out.split(s).join('***')
  }
  return out
}

/** ข้อความบรรทัดแรกของ error ที่ปิดข้อมูลลับแล้ว */
export function safeMessage(err: unknown, secrets: readonly string[] = []): string {
  const msg = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: string } | null)?.code
  const first = redact(msg.split('\n')[0] ?? '', secrets)
  return code ? `${first} [${code}]` : first
}

// ── ต่อท้ายไฟล์ .env โดยไม่แตะบรรทัดเดิม ────────────────────────────────────

export class EnvFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvFileError'
  }
}

/**
 * คำนวณไบต์ที่ต้องต่อท้ายไฟล์ .env (ฟังก์ชันล้วน) — รักษาตัวคั่นบรรทัดเดิม (CRLF หรือ LF) และเติมตัวคั่นก่อนถ้าไฟล์
 * ไม่ได้จบด้วยขึ้นบรรทัดใหม่ ปฏิเสธไฟล์ UTF-16 (BOM หรือมี NUL) เพราะการต่อท้ายด้วย UTF-8 จะทำให้ไฟล์เสีย
 */
export function planEnvAppend(existing: Buffer, line: string): Buffer {
  if (existing.length >= 2 && ((existing[0] === 0xff && existing[1] === 0xfe) || (existing[0] === 0xfe && existing[1] === 0xff))) {
    throw new EnvFileError('.env เป็น UTF-16 — ต่อท้ายอัตโนมัติไม่ได้โดยไม่เปลี่ยน encoding (แปลงเป็น UTF-8 ก่อน หรือเพิ่มบรรทัดเอง)')
  }
  if (existing.includes(0)) throw new EnvFileError('.env มีไบต์ NUL (ไม่ใช่ UTF-8) — ต่อท้ายอัตโนมัติไม่ได้')
  const eol = existing.includes(Buffer.from('\r\n')) ? '\r\n' : '\n'
  const endsWithEol = existing.length === 0 || existing[existing.length - 1] === 0x0a
  return Buffer.from((endsWithEol ? '' : eol) + line + eol, 'utf8')
}

/**
 * ต่อท้าย `KEY=value` ที่ท้ายไฟล์ แล้วตรวจว่า (1) ไบต์เดิมทั้งหมดอยู่ครบเหมือนเดิม (2) อ่านค่ากลับมาได้ตรงกัน
 * ไม่พิมพ์ค่าและไม่ throw ข้อความที่มีค่า
 */
export function appendEnvLine(file: string, key: string, value: string): void {
  if (/[\r\n]/.test(value) || /[\s'"`#]/.test(value)) throw new EnvFileError('ค่ามีอักขระที่เขียนลง .env ตรง ๆ ไม่ได้')
  const before = existsSync(file) ? readFileSync(file) : Buffer.alloc(0)
  if (key in parseEnv(before.toString('utf8'))) {
    throw new EnvFileError(`${key} มีอยู่ใน .env แล้ว (ค่าว่าง?) — ลบบรรทัดนั้นเองก่อน สคริปต์ไม่เขียนทับ`)
  }
  appendFileSync(file, planEnvAppend(before, `${key}=${value}`))
  const after = readFileSync(file)
  if (!after.subarray(0, before.length).equals(before)) throw new EnvFileError('ไบต์เดิมของ .env ถูกเปลี่ยน — ตรวจไฟล์ด้วยตนเอง')
  if (parseEnv(after.toString('utf8'))[key] !== value) throw new EnvFileError(`เขียน ${key} แล้วอ่านกลับไม่ตรง — ตรวจ .env ด้วยตนเอง`)
}
