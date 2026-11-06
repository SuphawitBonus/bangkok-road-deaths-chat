// รวมผู้เสียชีวิตที่มีพิกัดเป็นช่อง H3 รายเดือน — ฟังก์ชันล้วน ไม่แตะฐานข้อมูล
//
// แยกออกมาจาก src/scripts/load-h3.ts เพื่อให้ทดสอบได้โดยไม่ต้องมีฐานข้อมูล
// กฎข้อเดียวที่ต้องไม่เคยพัง: ผลรวม death_count ของทุกแถวที่ได้ ต้องเท่ากับจำนวนจุดที่ส่งเข้ามา
// ถ้าไม่เท่ากัน แปลว่ามีผู้เสียชีวิตหายไปหรือถูกนับซ้ำ แผนที่จะโกหก
//
// หนึ่งแถวผลลัพธ์ = (ช่อง res8, ช่อง res9, ปี ค.ศ., เดือน) โดยช่องทั้งสองความละเอียดคำนวณจาก "จุดของผู้เสียชีวิต"
// โดยตรง ไม่ได้หาช่องหนึ่งจากอีกช่องหนึ่ง
//
// ทำไมต้องเก็บ res8 ของแต่ละจุดเอง (บั๊กที่เคยมีในรอบก่อน): H3 ไม่ซ้อนกันสนิท ช่อง res9 หนึ่งช่องอาจคร่อมขอบของ
// res8 สองช่อง จุดสองจุดในช่อง res9 เดียวกันจึงอาจอยู่คนละช่อง res8 โค้ดรอบก่อนรวมกลุ่มด้วย res9 แล้วหยิบ res8
// ของจุดแรกมาใช้กับทั้งกลุ่ม ผู้เสียชีวิตที่อยู่ติดขอบจึงถูกนับผิดช่อง res8 โดยที่ผลรวมทั้งหมดยังถูกเป๊ะ
// (ตรวจด้วยผลรวมอย่างเดียวไม่เจอ) ผลของการแก้: แต่ละความละเอียดเป็นฮิสโตแกรมที่ถูกต้องของตัวเอง
// ส่วนข้อแลกเปลี่ยนคือ res9 ช่องเดียวกันอาจปรากฏคู่กับ res8 สองค่าในตาราง ซึ่งไม่เป็นปัญหา
// เพราะ API รวมแต่ละความละเอียดแยกกัน (GROUP BY คอลัมน์เดียว)
import { cellToLatLng, latLngToCell } from 'h3-js'

export const H3_COARSE = 8
export const H3_FINE = 9

export interface LocatedDeath {
  latitude: number
  longitude: number
  /** ปี ค.ศ. (ตรงกับ died_year ใน view) */
  died_year: number
  died_month: number
  is_complete_year: boolean
}

export interface H3AggregateRow {
  h3_res8: string
  h3_res9: string
  died_year: number
  died_month: number
  is_complete_year: boolean
  death_count: number
  /** จุดกึ่งกลางของช่อง res9 (ไม่ใช่พิกัดของผู้เสียชีวิตคนใด) */
  centroid_lat: number
  centroid_lng: number
}

export function aggregateH3(rows: readonly LocatedDeath[]): H3AggregateRow[] {
  const groups = new Map<string, H3AggregateRow>()

  for (const row of rows) {
    const h3_res8 = latLngToCell(row.latitude, row.longitude, H3_COARSE)
    const h3_res9 = latLngToCell(row.latitude, row.longitude, H3_FINE)

    // h3_res8 อยู่ใน key เพราะเหตุผลด้านบน
    // is_complete_year อยู่ใน key แม้ตอนนี้ปีเดียวกันได้ค่าเดียวกันเสมอ เพราะค่านี้มาจาก "ปีของไฟล์ต้นทาง"
    // ไม่ใช่วันที่เสียชีวิต ถ้าวันหนึ่งมีคนที่เสียชีวิตปลายปีแต่ถูกบันทึกในไฟล์ปีถัดไป สองแถวนั้นต้องไม่ถูกรวมกัน
    const key = `${h3_res8}|${h3_res9}|${row.died_year}|${row.died_month}|${row.is_complete_year}`
    const existing = groups.get(key)
    if (existing) {
      existing.death_count++
      continue
    }
    const [centroid_lat, centroid_lng] = cellToLatLng(h3_res9)
    groups.set(key, {
      h3_res8,
      h3_res9,
      died_year: row.died_year,
      died_month: row.died_month,
      is_complete_year: row.is_complete_year,
      death_count: 1,
      centroid_lat,
      centroid_lng,
    })
  }

  const result = [...groups.values()]

  const total = result.reduce((sum, r) => sum + r.death_count, 0)
  if (total !== rows.length) {
    // ไม่ควรเกิดขึ้นเลย ถ้าเกิดแปลว่ามีบั๊กในฟังก์ชันนี้ — หยุดทันทีดีกว่าโหลดข้อมูลผิดเข้าฐานข้อมูล
    throw new Error(`aggregateH3: ผลรวม ${total} ไม่เท่ากับจำนวนจุดที่ส่งเข้ามา ${rows.length}`)
  }
  return result
}
