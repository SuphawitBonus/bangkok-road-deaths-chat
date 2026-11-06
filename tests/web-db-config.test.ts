// ทดสอบว่าเว็บ "ไม่มีทางสลับไปใช้ role อื่น" — ไม่ต้องใช้ฐานข้อมูล
//
// ช่องโหว่เดิม: เมื่อไม่มีรหัสผ่านของ web_reader โค้ดสลับไปใช้ adminPool() (superuser) เงียบ ๆ
// test ชุดนี้ล็อกพฤติกรรมที่ถูกต้อง: ไม่มีค่า → error ไม่ใช่สลับ
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { pickAllowedEnv, WEB_ENV_KEYS } from '../web/lib/local-env.js'
import {
  assertUnprivilegedWebRole,
  resolveWebDbConfig,
  WEB_ROLE,
  WebConfigError,
} from '../web/lib/web-config.js'

describe('resolveWebDbConfig — fail closed', () => {
  it('ไม่มี WEB_DB_PASSWORD และไม่มี WEB_DATABASE_URL → error', () => {
    expect(() => resolveWebDbConfig({})).toThrow(WebConfigError)
    expect(() => resolveWebDbConfig({ WEB_DB_PASSWORD: '' })).toThrow(WebConfigError)
    expect(() => resolveWebDbConfig({ WEB_DB_PASSWORD: '   ' })).toThrow(WebConfigError)
  })

  it('ข้อความ error บอกชัดว่าไม่สลับ role', () => {
    expect(() => resolveWebDbConfig({})).toThrow(/never falls back/)
  })

  it('แม้มีรหัสผ่านของ role อื่นอยู่ใน env ครบ ก็ยัง error ไม่ใช้มันแทน', () => {
    const env = {
      POSTGRES_USER: 'app_admin',
      POSTGRES_PASSWORD: 'admin-secret',
      DATABASE_URL: 'postgresql://app_admin:admin-secret@localhost:5435/roaddeaths',
      AI_DB_USER: 'ai_reader',
      AI_DB_PASSWORD: 'ai-secret',
    }
    expect(() => resolveWebDbConfig(env)).toThrow(WebConfigError)
  })

  it('มีรหัสผ่านครบ → ใช้ web_reader พร้อมค่าเริ่มต้นสำหรับเครื่อง dev', () => {
    expect(resolveWebDbConfig({ WEB_DB_PASSWORD: 'pw' })).toEqual({
      kind: 'params',
      host: 'localhost',
      port: 5435,
      database: 'roaddeaths',
      user: WEB_ROLE,
      password: 'pw',
    })
  })

  it('ใส่ชื่อ role อื่นใน WEB_DB_USER ไม่ได้ แม้มีรหัสผ่าน', () => {
    expect(() => resolveWebDbConfig({ WEB_DB_USER: 'app_admin', WEB_DB_PASSWORD: 'pw' })).toThrow(
      /must be web_reader/,
    )
  })

  it('WEB_DATABASE_URL ต้องเป็น web_reader และมีรหัสผ่าน', () => {
    const ok = 'postgresql://web_reader:pw@db.example.com/roaddeaths?sslmode=require'
    expect(resolveWebDbConfig({ WEB_DATABASE_URL: ok })).toEqual({ kind: 'url', connectionString: ok })
    expect(() =>
      resolveWebDbConfig({ WEB_DATABASE_URL: 'postgresql://app_admin:pw@db.example.com/roaddeaths' }),
    ).toThrow(/must connect as web_reader/)
    expect(() =>
      resolveWebDbConfig({ WEB_DATABASE_URL: 'postgresql://web_reader@db.example.com/roaddeaths' }),
    ).toThrow(/no password/)
    expect(() => resolveWebDbConfig({ WEB_DATABASE_URL: 'not a url' })).toThrow(/not a valid URL/)
  })

  it('error ไม่เปิดเผยรหัสผ่านหรือ URL', () => {
    const url = 'postgresql://app_admin:super-secret@db.example.com/roaddeaths'
    try {
      resolveWebDbConfig({ WEB_DATABASE_URL: url })
      expect.unreachable()
    } catch (err) {
      expect(String(err)).not.toContain('super-secret')
      expect(String(err)).not.toContain(url)
    }
  })

  it('พอร์ตที่ไม่ใช่ตัวเลขถูกปฏิเสธ', () => {
    expect(() => resolveWebDbConfig({ WEB_DB_PASSWORD: 'pw', POSTGRES_PORT: 'abc' })).toThrow(/port/)
    expect(() => resolveWebDbConfig({ WEB_DB_PASSWORD: 'pw', POSTGRES_PORT: '99999' })).toThrow(/port/)
  })
})

describe('assertUnprivilegedWebRole', () => {
  it('web_reader ที่ไม่มีสิทธิ์พิเศษผ่าน', () => {
    expect(() => assertUnprivilegedWebRole({ role: 'web_reader', privileged: false })).not.toThrow()
  })

  it.each([
    ['role อื่น (แอดมิน)', { role: 'app_admin', privileged: true }],
    ['role อื่นที่ไม่มีสิทธิ์พิเศษ', { role: 'ai_reader', privileged: false }],
    ['web_reader ที่ถูกให้สิทธิ์พิเศษ', { role: 'web_reader', privileged: true }],
    ['ไม่มีผลตรวจ', undefined],
  ])('ปฏิเสธ: %s', (_name, probe) => {
    expect(() => assertUnprivilegedWebRole(probe)).toThrow(WebConfigError)
  })
})

describe('getWebPool (web/lib/db.ts) ไม่สลับไปใช้ admin', () => {
  const saved = { ...process.env }
  const restoreEnv = () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }

  beforeEach(() => {
    vi.resetModules()
    // ไม่ให้ไปอ่านไฟล์ .env จริงของเครื่องที่รัน test — ต้องควบคุมค่าเองทั้งหมด
    vi.doMock('../web/lib/local-env.js', () => ({ loadLocalWebEnv: () => undefined, WEB_ENV_KEYS: [] }))
    for (const k of ['WEB_DB_PASSWORD', 'WEB_DB_USER', 'WEB_DATABASE_URL']) delete process.env[k]
    // วางค่าของ role แอดมินไว้ให้ครบ เหมือนเครื่องที่ .env มีทุกอย่าง
    process.env.POSTGRES_USER = 'app_admin'
    process.env.POSTGRES_PASSWORD = 'admin-secret'
    process.env.DATABASE_URL = 'postgresql://app_admin:admin-secret@127.0.0.1:1/roaddeaths'
  })

  afterEach(() => {
    restoreEnv()
    vi.doUnmock('../web/lib/local-env.js')
  })

  it('ไม่มี WEB_DB_PASSWORD → getWebPool() throw WebConfigError (ไม่ใช่ error เชื่อมต่อของ admin)', async () => {
    const { getWebPool } = await import('../web/lib/db.js')
    // ถ้ายังมีการสลับไปใช้ admin จะได้ error การเชื่อมต่อ (ECONNREFUSED) ไม่ใช่ WebConfigError
    await expect(getWebPool()).rejects.toMatchObject({ name: 'WebConfigError' })
  })

  it('assertWebConfig() (ที่ instrumentation เรียกตอนเริ่ม) throw เมื่อไม่มีรหัสผ่าน', async () => {
    const { assertWebConfig } = await import('../web/lib/db.js')
    // คลาส WebConfigError ถูกโหลดใหม่หลัง resetModules จึงเทียบด้วยชื่อ ไม่ใช่ instanceof
    expect(() => assertWebConfig()).toThrow(/never falls back/)
  })

  it('module ไม่ export สิ่งที่ใช้สลับ role', async () => {
    const mod = await import('../web/lib/db.js')
    expect(Object.keys(mod).sort()).toEqual(['assertWebConfig', 'getWebPool'])
  })
})

describe('pickAllowedEnv — เว็บอ่านจาก .env ได้เฉพาะตัวแปรที่อนุญาต', () => {
  const file = [
    'POSTGRES_HOST=localhost',
    'POSTGRES_PORT=5435',
    'POSTGRES_DB=roaddeaths',
    'POSTGRES_USER=app_admin',
    'POSTGRES_PASSWORD=admin-secret',
    'AI_DB_PASSWORD=ai-secret',
    'ANTHROPIC_API_KEY=fake-key-for-test',
    'WEB_DB_USER=web_reader',
    'WEB_DB_PASSWORD=web-secret',
  ].join('\n')

  it('ได้ครบเฉพาะที่อยู่ในรายการอนุญาต', () => {
    expect(pickAllowedEnv(file)).toEqual({
      POSTGRES_HOST: 'localhost',
      POSTGRES_PORT: '5435',
      POSTGRES_DB: 'roaddeaths',
      WEB_DB_USER: 'web_reader',
      WEB_DB_PASSWORD: 'web-secret',
    })
  })

  it('รหัสผ่านของ admin / AI และ API key ไม่หลุดเข้ามา', () => {
    const keys = Object.keys(pickAllowedEnv(file))
    for (const forbidden of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'AI_DB_PASSWORD', 'ANTHROPIC_API_KEY']) {
      expect(keys).not.toContain(forbidden)
    }
  })

  it('รายการอนุญาตไม่มีตัวแปรของ role อื่น', () => {
    expect(WEB_ENV_KEYS.some((k) => /ADMIN|AI_|ANTHROPIC|POSTGRES_(USER|PASSWORD)/.test(k))).toBe(false)
  })
})

describe('โค้ดใน web/ ต้องไม่แตะข้อมูลเข้าสู่ระบบของ role อื่นเลย', () => {
  const root = fileURLToPath(new URL('../web', import.meta.url))
  const SKIP = new Set(['node_modules', '.next', 'public'])
  const EXT = /\.(ts|tsx|js|jsx|mjs|cjs|css)$/

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      if (SKIP.has(name)) return []
      const p = join(dir, name)
      return statSync(p).isDirectory() ? walk(p) : EXT.test(name) ? [p] : []
    })
  }

  // ห้ามมีแม้แต่ในคอมเมนต์ เพื่อให้ grep ตรวจง่าย และไม่มีใครเผลอ "ปิดคอมเมนต์ออก" แล้วใช้ได้ทันที
  const FORBIDDEN: [string, RegExp][] = [
    ['POSTGRES_USER', /POSTGRES_USER/],
    ['POSTGRES_PASSWORD', /POSTGRES_PASSWORD/],
    ['adminPool', /adminPool/],
    ['DATABASE_URL ที่ไม่ใช่ WEB_DATABASE_URL', /(?<!WEB_)DATABASE_URL/],
    ['ชื่อ role แอดมิน app_admin', /app_admin/],
    ['โหลด .env ทั้งไฟล์', /loadEnvFile/],
  ]

  it('มีไฟล์ให้ตรวจจริง (ไม่ใช่ผ่านเพราะหาไม่เจอ)', () => {
    expect(existsSync(root)).toBe(true)
    expect(walk(root).length).toBeGreaterThan(5)
  })

  it.each(FORBIDDEN)('ไม่พบ %s', (_label, pattern) => {
    const hits = walk(root).filter((f) => pattern.test(readFileSync(f, 'utf8')))
    expect(hits.map((f) => relative(root, f))).toEqual([])
  })
})
