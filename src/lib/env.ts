// อ่านค่าตั้งต้นจาก .env (ไฟล์นี้ถูก gitignore ไว้) ใช้ของที่ Node มีให้อยู่แล้ว
// ไม่ต้องลง dotenv เพิ่ม
import { existsSync } from 'node:fs'

let loaded = false

function loadOnce(): void {
  if (loaded) return
  loaded = true
  if (existsSync('.env')) process.loadEnvFile('.env')
}

/** อ่าน env ที่จำเป็น ถ้าไม่มีให้ล้มทันทีพร้อมบอกว่าต้องตั้งตัวไหน */
export function required(name: string): string {
  loadOnce()
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `ไม่พบค่า ${name} — คัดลอก .env.example เป็น .env แล้วเติมค่าให้ครบก่อน`,
    )
  }
  return value
}

export function optionalNumber(name: string, fallback: number): number {
  loadOnce()
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`ค่า ${name} ต้องเป็นตัวเลข แต่ได้ "${raw}"`)
  return n
}

/** เพดานแถวที่ยอมให้ SQL หนึ่งคำสั่งคืนกลับมา */
export const SQL_MAX_ROWS = () => optionalNumber('SQL_MAX_ROWS', 1000)

/** เวลาสูงสุดต่อหนึ่งคำสั่ง ต้องไม่เกินที่ตั้งไว้ที่ role (5 วินาที) */
export const SQL_TIMEOUT_MS = () => Math.min(optionalNumber('SQL_TIMEOUT_MS', 5000), 5000)
