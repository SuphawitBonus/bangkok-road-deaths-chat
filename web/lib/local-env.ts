// อ่านค่าสำหรับเว็บจากไฟล์ .env ตอนพัฒนาในเครื่อง — เฉพาะตัวแปรที่เว็บมีสิทธิ์ใช้เท่านั้น
//
// ทำไมไม่โหลดทั้งไฟล์เข้า process.env (วิธีง่าย ๆ ที่โค้ดรอบก่อนใช้): .env ของโปรเจกต์รวมรหัสผ่านของ role แอดมิน
// และของ AI ไว้ด้วย การโหลดทั้งไฟล์ทำให้รหัสผ่านเหล่านั้นไปอยู่ใน process.env ของเว็บเซิร์ฟเวอร์
// ต่อให้โค้ดไม่เรียกใช้ ก็อยู่ในหน่วยความจำและหลุดได้ง่ายกว่าที่ควร (เช่น ผ่านหน้า error หรือ log ที่ dump env)
// ที่นี่ parse ไฟล์แล้วหยิบเฉพาะชื่อที่อยู่ในรายการอนุญาต ที่เหลือทิ้งทันที

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'

/** ตัวแปรเดียวที่เว็บอ่านจากไฟล์ได้ — ห้ามเพิ่มรหัสผ่านของ role อื่นเข้ามาในรายการนี้ */
export const WEB_ENV_KEYS = [
  'WEB_DB_USER',
  'WEB_DB_PASSWORD',
  'WEB_DATABASE_URL',
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_DB',
] as const

const isSet = (v: string | undefined) => v !== undefined && v.trim() !== ''

/** แปลงข้อความ .env แล้วคืนเฉพาะตัวแปรที่อนุญาต (ฟังก์ชันล้วน ใช้ทดสอบได้) */
export function pickAllowedEnv(fileText: string): Record<string, string> {
  const parsed = parseEnv(fileText)
  const out: Record<string, string> = {}
  for (const key of WEB_ENV_KEYS) {
    const value = parsed[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * เติมตัวแปรที่อนุญาตจาก web/.env แล้วจาก .env ที่ราก repo เข้า env — ค่าที่มีอยู่แล้วใน env ชนะเสมอ
 * (บน Vercel ไม่มีไฟล์ ค่ามาจากตัวแปรสภาพแวดล้อมของแพลตฟอร์ม)
 */
export function loadLocalWebEnv(
  cwd: string = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): void {
  for (const dir of [cwd, resolve(cwd, '..')]) {
    const file = resolve(dir, '.env')
    if (!existsSync(file)) continue
    try {
      for (const [key, value] of Object.entries(pickAllowedEnv(readFileSync(file, 'utf8')))) {
        if (!isSet(env[key])) env[key] = value
      }
    } catch {
      // อ่านไม่ได้ก็ข้าม — ถ้าค่าจำเป็นขาด resolveWebDbConfig จะ throw เองอย่างชัดเจน
    }
  }
}
