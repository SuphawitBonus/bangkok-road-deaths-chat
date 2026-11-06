// การเชื่อมต่อฐานข้อมูลสองแบบที่แยกกันเด็ดขาด
//
//   adminPool()  — เจ้าของ schema ใช้ตอน migrate / โหลดข้อมูล / รัน eval
//   aiPool()     — role ที่อ่านได้อย่างเดียว ใช้รัน SQL ที่ AI เขียนเท่านั้น
//
// ที่ต้องแยกเพราะถ้าใช้ connection เดียวกันทั้งระบบ ความปลอดภัยทั้งหมดจะเหลือแค่
// ตัวตรวจในโค้ด ซึ่งผิดหลักที่ตั้งไว้ว่าชั้นฐานข้อมูลต้องยืนอยู่ได้เองแม้โค้ดพัง
import pg from 'pg'

import { optional, required } from './env.js'

const { Pool } = pg

let admin: pg.Pool | undefined
let ai: pg.Pool | undefined
let web: pg.Pool | undefined

function baseConfig(): pg.PoolConfig {
  // ตอน deploy จะมี DATABASE_URL มาแทน (Neon)
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL }
  return {
    host: required('POSTGRES_HOST'),
    port: Number(required('POSTGRES_PORT')),
    database: required('POSTGRES_DB'),
  }
}

/** connection ของเจ้าของ schema — ห้ามใช้รัน SQL ที่มาจาก AI */
export function adminPool(): pg.Pool {
  admin ??= new Pool({
    ...baseConfig(),
    user: required('POSTGRES_USER'),
    password: required('POSTGRES_PASSWORD'),
    max: 4,
  })
  return admin
}

/**
 * connection ของ role ที่อ่านได้อย่างเดียว
 *
 * ข้อจำกัด (read-only, statement_timeout, search_path) ตั้งไว้ที่ตัว role ใน
 * db/03_security.sql ไม่ได้ตั้งตรงนี้ โค้ดจึงลืมตั้งไม่ได้
 */
export function aiPool(): pg.Pool {
  if (process.env.AI_DATABASE_URL) {
    ai ??= new Pool({ connectionString: process.env.AI_DATABASE_URL, max: 4 })
    return ai
  }
  ai ??= new Pool({
    ...baseConfig(),
    user: required('AI_DB_USER'),
    password: required('AI_DB_PASSWORD'),
    max: 4,
  })
  return ai
}

/**
 * connection ของ role สำหรับ web API
 *
 * อ่านได้เฉพาะตารางสรุป app.h3_deaths_monthly เท่านั้น
 * ห้ามอ่าน app.deaths หรือ app.deaths_raw เพื่อความเป็นส่วนตัว
 */
export function webPool(): pg.Pool {
  if (process.env.WEB_DATABASE_URL) {
    web ??= new Pool({ connectionString: process.env.WEB_DATABASE_URL, max: 4 })
    return web
  }
  web ??= new Pool({
    ...baseConfig(),
    // ชื่อ role ของเว็บคือ web_reader เสมอ (db/04_web_security.sql) ไม่ตั้งใน .env ก็ได้
    user: optional('WEB_DB_USER', 'web_reader'),
    password: required('WEB_DB_PASSWORD'),
    max: 4,
  })
  return web
}

export async function closePools(): Promise<void> {
  await Promise.all([admin?.end(), ai?.end(), web?.end()])
  admin = undefined
  ai = undefined
  web = undefined
}
