// การตั้งค่าที่การ deploy พึ่งพา — ตรวจจากไฟล์ เพราะถ้าพลาดจะรู้ตอน deploy จริง (ช้าและเสียโควตา)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repo = fileURLToPath(new URL('..', import.meta.url))
const read = (p: string) => readFileSync(join(repo, p), 'utf8')
const json = (p: string) => JSON.parse(read(p)) as Record<string, unknown>

describe('web/ เป็นโปรเจกต์อิสระ (Vercel: Root Directory = web)', () => {
  it('package.json ที่รากไม่มี workspaces', () => {
    expect(json('package.json')).not.toHaveProperty('workspaces')
  })

  it('web/ มี lockfile ของตัวเอง และ lockfile ที่รากไม่มีแพ็กเกจของ web (next, react, deck.gl, maplibre-gl)', () => {
    expect(existsSync(join(repo, 'web/package-lock.json'))).toBe(true)
    const rootLock = json('package-lock.json') as { packages: Record<string, unknown> }
    const names = Object.keys(rootLock.packages)
    expect(names).not.toContain('web')
    expect(names).not.toContain('node_modules/web')
    for (const dep of ['next', 'react', 'maplibre-gl', '@deck.gl/core']) {
      expect(names).not.toContain(`node_modules/${dep}`)
    }
  })

  it('โค้ดใน web/ ไม่ import อะไรจากนอก web/ (ไม่งั้น build บน Vercel ที่เห็นแค่ web/ จะพัง)', () => {
    const root = join(repo, 'web')
    const SKIP = new Set(['node_modules', '.next', 'public'])
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        if (SKIP.has(n)) return []
        const p = join(dir, n)
        return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mjs|js)$/.test(n) && !n.endsWith('.d.ts') ? [p] : []
      })
    const escaping: string[] = []
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]*)['"]/g)) {
        const target = resolve(dirname(file), m[1]!)
        if (relative(root, target).startsWith('..')) escaping.push(`${relative(root, file)} → ${m[1]}`)
      }
    }
    expect(escaping).toEqual([])
  })

  it('typecheck ของ web สร้างชนิดของ Next ก่อน (ไม่งั้น LayoutProps หาไม่เจอในเครื่องที่เพิ่ง clone)', () => {
    const scripts = (json('web/package.json') as { scripts: Record<string, string> }).scripts
    expect(scripts.typecheck).toMatch(/^next typegen && tsc --noEmit$/)
  })
})

describe('vercel.json', () => {
  it('ใช้ภูมิภาค sin1 (สิงคโปร์) เพียงภูมิภาคเดียว ให้ใกล้ Neon ap-southeast-1 (แผน Hobby ใช้ได้ภูมิภาคเดียว)', () => {
    const cfg = json('web/vercel.json') as { regions?: string[] }
    expect(cfg.regions).toEqual(['sin1'])
  })

  it('ไม่มี vercel.json ที่รากที่ตั้งค่าซ้ำซ้อน', () => {
    expect(existsSync(join(repo, 'vercel.json'))).toBe(false)
  })
})

describe('ความลับและเครื่องมือของ agent ไม่ถูก commit', () => {
  const ignore = read('.gitignore').split(/\r?\n/)

  it.each(['.env', '.env.*', '.claude/skills/', 'skills-lock.json'])('.gitignore มี %s', (line) => {
    expect(ignore).toContain(line)
  })

  it('.env.example มีแค่ตัวอย่าง — ไม่มี connection string จริงของ Neon', () => {
    const text = read('.env.example')
    expect(text).toMatch(/NEON_ADMIN_URL=/)
    expect(text).not.toMatch(/npg_[A-Za-z0-9]+/)
    // ทุกบรรทัด NEON_*= ต้องมีค่าเป็น placeholder ในเครื่องหมาย <...> เท่านั้น (ไม่ใช่ URL จริง)
    const lines = text.split(/\r?\n/).filter((l) => /^(# )?NEON_[A-Z_]+=/.test(l))
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line).toMatch(/^(# )?NEON_[A-Z_]+=<[^>]+>\s*$/)
  })
})
