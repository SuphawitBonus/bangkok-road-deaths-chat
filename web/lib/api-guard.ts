// ด่านหน้าของ /api/h3 และ /api/years ที่ proxy.ts ใช้ — ตัดสินจาก "query string ดิบ" ก่อนถึง route handler
//
// ทำไมต้องมีที่ proxy ไม่ใช่แค่ใน route: เมื่อคำขอถึง route handler แล้ว Next ได้ถอดรหัสและเขียน query ขึ้นใหม่ไปแล้ว
// (วัดได้จริง: `year_from=%32011` และ `&res=8&...` ถึง route ในรูปมาตรฐาน) ตัวตรวจใน route จึงเห็นแค่รูปมาตรฐานเสมอ
// ขณะที่ CDN ใช้ URL ดิบเป็นกุญแจ cache ใครเปลี่ยนการเข้ารหัสได้ URL ใหม่ไม่จำกัด แต่ละอันทะลุถึงฐานข้อมูล
// proxy ทำงานก่อน cache และก่อน route จึงตอบ 400 ได้โดยไม่แตะฐานข้อมูล (ดู docs/deploy.md หัวข้อ "ปิดช่องหลบ cache")
import { parseH3Request } from './h3-api'

export interface GuardRejection {
  status: 400
  body: { error: 'invalid_parameter'; message: string }
}

const reject = (message: string): GuardRejection => ({ status: 400, body: { error: 'invalid_parameter', message } })

/**
 * @param pathname เส้นทางของคำขอ
 * @param search query string ดิบ (มี "?" นำหน้าหรือว่าง)
 * @returns null = ผ่านไปที่ route ได้ / ไม่ใช่ null = ตอบ 400 ทันที
 */
export function guardApiRequest(pathname: string, search: string): GuardRejection | null {
  if (pathname === '/api/h3') {
    const parsed = parseH3Request(search)
    return parsed.ok ? null : reject(parsed.message)
  }
  if (pathname === '/api/years') {
    return search === '' ? null : reject('this endpoint takes no parameters')
  }
  return null
}
