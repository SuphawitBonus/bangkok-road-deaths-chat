// ตัวช่วยของ neon:sync / neon:check — ส่วนที่เป็นฟังก์ชันล้วน ไม่ต่อ Neon
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  appendEnvLine,
  buildWebUrl,
  generatePassword,
  isPooledHost,
  parseNeonAdminUrl,
  parseNeonWebUrl,
  planEnvAppend,
  redact,
  safeMessage,
  toPooledHost,
} from '../src/lib/neon.js'

// ค่าปลอมทั้งหมด (ไม่ใช่ของจริง)
const HOST = 'ep-fake-cloud-123456.ap-southeast-1.aws.neon.tech'
const ADMIN = `postgresql://neondb_owner:adm1n-fake-pw@${HOST}/neondb?sslmode=require&channel_binding=require`

describe('parseNeonAdminUrl', () => {
  it('รับ URL แบบ direct ของ Neon', () => {
    expect(parseNeonAdminUrl(ADMIN).hostname).toBe(HOST)
  })

  it.each([
    ['localhost', 'postgresql://neondb_owner:pw12345@localhost:5432/neondb'],
    ['127.0.0.1', 'postgresql://neondb_owner:pw12345@127.0.0.1:5435/neondb'],
    ['::1', 'postgresql://neondb_owner:pw12345@[::1]:5432/neondb'],
    ['web_reader', `postgresql://web_reader:pw12345@${HOST}/neondb`],
    ['pooled', 'postgresql://neondb_owner:pw12345@ep-fake-cloud-123456-pooler.ap-southeast-1.aws.neon.tech/neondb'],
    ['ไม่มีรหัสผ่าน', `postgresql://neondb_owner@${HOST}/neondb`],
    ['ไม่มีชื่อฐานข้อมูล', `postgresql://neondb_owner:pw12345@${HOST}`],
    ['ไม่ใช่ postgres', `https://neondb_owner:pw12345@${HOST}/neondb`],
    ['ไม่ใช่ URL', 'not a url pw12345'],
  ])('หยุดเมื่อ: %s', (_label, url) => {
    expect(() => parseNeonAdminUrl(url)).toThrow()
  })

  it('ข้อความ error ไม่มีรหัสผ่านหรือ URL', () => {
    const bad = [`postgresql://web_reader:secret-pw-1@${HOST}/neondb`, 'garbage secret-pw-2', 'postgresql://u:secret-pw-3@localhost/db']
    for (const url of bad) {
      let message = ''
      try {
        parseNeonAdminUrl(url)
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).not.toBe('')
      expect(message).not.toMatch(/secret-pw|ep-fake|neon\.tech|postgresql:\/\//)
    }
  })
})

describe('pooled host และ NEON_WEB_DATABASE_URL', () => {
  it('toPooledHost ใส่ -pooler ต่อท้ายชื่อ endpoint เท่านั้น และไม่ซ้ำ', () => {
    expect(toPooledHost(HOST)).toBe('ep-fake-cloud-123456-pooler.ap-southeast-1.aws.neon.tech')
    expect(toPooledHost(toPooledHost(HOST))).toBe(toPooledHost(HOST))
    expect(isPooledHost(toPooledHost(HOST))).toBe(true)
    expect(isPooledHost(HOST)).toBe(false)
  })

  it('buildWebUrl: web_reader + pooled + verify-full ไม่เอา channel_binding / ผู้ใช้ / รหัสของแอดมินไป', () => {
    const pw = generatePassword()
    const built = buildWebUrl(parseNeonAdminUrl(ADMIN), pw)
    const u = new URL(built)
    expect(u.username).toBe('web_reader')
    expect(decodeURIComponent(u.password)).toBe(pw)
    expect(u.hostname).toBe('ep-fake-cloud-123456-pooler.ap-southeast-1.aws.neon.tech')
    expect(u.pathname).toBe('/neondb')
    expect(u.searchParams.get('sslmode')).toBe('verify-full')
    expect([...u.searchParams.keys()]).toEqual(['sslmode'])
    expect(built).not.toContain('neondb_owner')
    expect(built).not.toContain('adm1n-fake-pw')
    expect(parseNeonWebUrl(built).password).toBe(pw)
  })

  it('buildWebUrl ไม่ยอมรับรหัสผ่านที่ต้องเข้ารหัสใน URL', () => {
    expect(() => buildWebUrl(parseNeonAdminUrl(ADMIN), 'has space and @ sign 1234567')).toThrow()
    expect(() => buildWebUrl(parseNeonAdminUrl(ADMIN), 'short')).toThrow()
  })

  it('generatePassword: 32 ตัว อักขระปลอดภัยใน URL และไม่ซ้ำกัน', () => {
    const seen = new Set(Array.from({ length: 50 }, generatePassword))
    expect(seen.size).toBe(50)
    for (const p of seen) expect(p).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })

  it('parseNeonWebUrl: ต้องเป็น web_reader เท่านั้น (ใส่ URL ของแอดมินแล้วหยุด)', () => {
    expect(() => parseNeonWebUrl(ADMIN)).toThrow(/web_reader/)
    expect(() => parseNeonWebUrl(`postgresql://web_reader@${HOST}/neondb`)).toThrow()
    expect(() => parseNeonWebUrl('postgresql://web_reader:pw12345@localhost/neondb')).toThrow()
  })
})

describe('redact / safeMessage', () => {
  it('ลบ URL, host ของ Neon และสตริงลับ', () => {
    const text = `connect failed to ${ADMIN} via ${HOST} with password adm1n-fake-pw`
    const out = redact(text, ['adm1n-fake-pw'])
    expect(out).not.toMatch(/adm1n-fake-pw|neondb_owner|ep-fake|neon\.tech|postgresql:/)
  })

  it('safeMessage เก็บ SQLSTATE และแค่บรรทัดแรก', () => {
    const err = Object.assign(new Error(`password authentication failed for ${HOST}\nDETAIL: leak`), { code: '28P01' })
    const out = safeMessage(err)
    expect(out).toContain('28P01')
    expect(out).not.toMatch(/leak|neon\.tech/)
  })
})

describe('ต่อท้าย .env โดยไม่แตะบรรทัดเดิม', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'neon-env-'))
    file = join(dir, '.env')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const KEY = 'NEON_WEB_DATABASE_URL'
  const VALUE =
    'postgresql://web_reader:abcDEF123_-abcDEF123_-abcDEF123_-xy@ep-x-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=verify-full'

  it('ไฟล์ LF ที่จบด้วยขึ้นบรรทัดใหม่: ไบต์เดิมครบ ค่าใหม่อ่านกลับได้', () => {
    const original = Buffer.from('A=1\n# comment\nB="two words"\n')
    writeFileSync(file, original)
    appendEnvLine(file, KEY, VALUE)
    const after = readFileSync(file)
    expect(after.subarray(0, original.length).equals(original)).toBe(true)
    expect(after.subarray(original.length).toString()).toBe(`${KEY}=${VALUE}\n`)
    expect(parseEnv(after.toString('utf8'))).toMatchObject({ A: '1', B: 'two words', [KEY]: VALUE })
  })

  it('ไฟล์ที่ไม่จบด้วยขึ้นบรรทัดใหม่: เติมตัวคั่นก่อน ไม่ต่อติดบรรทัดสุดท้าย', () => {
    writeFileSync(file, 'A=1\nB=2')
    appendEnvLine(file, KEY, VALUE)
    expect(parseEnv(readFileSync(file, 'utf8'))).toMatchObject({ A: '1', B: '2', [KEY]: VALUE })
  })

  it('ไฟล์ CRLF: ใช้ CRLF ต่อ (ไม่ปนตัวคั่น)', () => {
    writeFileSync(file, 'A=1\r\nB=2\r\n')
    appendEnvLine(file, KEY, VALUE)
    const text = readFileSync(file, 'utf8')
    expect(text).toBe(`A=1\r\nB=2\r\n${KEY}=${VALUE}\r\n`)
    expect(text.replaceAll('\r\n', '')).not.toContain('\n')
  })

  it('ไฟล์ UTF-8 มี BOM: BOM และไบต์เดิมไม่ถูกแตะ', () => {
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('A=1\n')])
    writeFileSync(file, original)
    appendEnvLine(file, KEY, VALUE)
    const after = readFileSync(file)
    expect(after.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(after.subarray(0, original.length).equals(original)).toBe(true)
  })

  it('ไม่มีไฟล์: สร้างบรรทัดเดียว', () => {
    appendEnvLine(file, KEY, VALUE)
    expect(readFileSync(file, 'utf8')).toBe(`${KEY}=${VALUE}\n`)
  })

  it('ปฏิเสธไฟล์ UTF-16 (ต่อท้ายด้วย UTF-8 จะทำให้ไฟล์เสีย) และไม่แก้ไฟล์', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('A=1\n', 'utf16le')])
    writeFileSync(file, utf16)
    expect(() => appendEnvLine(file, KEY, VALUE)).toThrow(/UTF-16/)
    expect(readFileSync(file).equals(utf16)).toBe(true)
  })

  it('ถ้ามีคีย์อยู่แล้ว (แม้ค่าว่าง) ไม่เขียนทับและไม่ต่อซ้ำ', () => {
    const original = `A=1\n${KEY}=\n`
    writeFileSync(file, original)
    expect(() => appendEnvLine(file, KEY, VALUE)).toThrow(/ลบบรรทัดนั้นเอง/)
    expect(readFileSync(file, 'utf8')).toBe(original)
  })

  it('error ไม่มีค่าที่กำลังเขียน', () => {
    writeFileSync(file, `${KEY}=old\n`)
    let message = ''
    try {
      appendEnvLine(file, KEY, VALUE)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).not.toBe('')
    expect(message).not.toContain('abcDEF123')
  })

  it('planEnvAppend ไม่แก้ buffer ที่ส่งเข้ามา', () => {
    const b = Buffer.from('A=1')
    const copy = Buffer.from(b)
    planEnvAppend(b, 'X=1')
    expect(b.equals(copy)).toBe(true)
  })
})
