// สถานะของหน้าที่เก็บใน URL — เปิดลิงก์ที่แชร์มาแล้วเห็นมุมมองเดียวกัน (ช่วงปี ตำแหน่งกล้อง ช่องที่เลือก 2D/3D)
//
// หลักการ: URL มาจากใครก็ได้ จึงตรวจทุกค่าและทิ้งค่าที่ไม่ถูกต้องไปใช้ค่าเริ่มต้นเงียบ ๆ (ไม่ throw ไม่แสดง error)
// ปีใน URL เป็น ค.ศ. ชื่อเดียวกับพารามิเตอร์ของ /api/h3 ตามกฎ "ค.ศ. ทั้งระบบ แปลง พ.ศ. ที่หน้าจอจุดเดียว"
// ค่าใน URL ไม่เคยถูกส่งต่อไปที่ API ตรง ๆ: ปีผ่าน parseYear ที่นี่ก่อน แล้ว fetchH3 สร้าง URL ใหม่จากตัวเลข
import { getResolution, isValidCell } from 'h3-js'

import { DATA_YEAR_MAX_COMPLETE, DATA_YEAR_MIN } from './years'

export interface CameraView {
  latitude: number
  longitude: number
  zoom: number
  pitch: number
  bearing: number
}

export interface ViewState {
  yearFrom: number
  yearTo: number
  camera: CameraView | null
  /** ช่อง H3 ที่ผู้ใช้คลิกเลือก (res8 หรือ res9) */
  cell: string | null
  mode: '2d' | '3d'
}

export const DEFAULT_VIEW_STATE: ViewState = {
  yearFrom: DATA_YEAR_MIN,
  yearTo: DATA_YEAR_MAX_COMPLETE,
  camera: null,
  cell: null,
  mode: '3d',
}

// กรอบกว้าง ๆ รอบกรุงเทพฯ และปริมณฑล — ลิงก์ที่ชี้ไปที่อื่นไม่มีประโยชน์ ใช้มุมเริ่มต้นแทน
const BOUNDS = { latMin: 13.3, latMax: 14.3, lngMin: 100.0, lngMax: 101.1 }

function parseYear(raw: string | null): number | null {
  if (raw === null || !/^\d{4}$/.test(raw)) return null
  const y = Number(raw)
  return y >= DATA_YEAR_MIN && y <= DATA_YEAR_MAX_COMPLETE ? y : null
}

const NUM = /^-?\d{1,3}(\.\d{1,7})?$/

function parseCamera(raw: string | null): CameraView | null {
  if (raw === null) return null
  const parts = raw.split(',')
  if (parts.length < 3 || parts.length > 5 || !parts.every((p) => NUM.test(p))) return null
  const [latitude, longitude, zoom, pitch = 0, bearing = 0] = parts.map(Number) as [number, number, number, number?, number?]
  if (latitude < BOUNDS.latMin || latitude > BOUNDS.latMax) return null
  if (longitude < BOUNDS.lngMin || longitude > BOUNDS.lngMax) return null
  if (zoom < 8 || zoom > 20) return null
  if (pitch < 0 || pitch > 75) return null
  if (bearing < -180 || bearing > 180) return null
  return { latitude, longitude, zoom, pitch, bearing }
}

function parseCell(raw: string | null): string | null {
  if (raw === null || !/^[0-9a-f]{15}$/.test(raw) || !isValidCell(raw)) return null
  const res = getResolution(raw)
  return res === 8 || res === 9 ? raw : null
}

export function parseViewState(search: string): ViewState {
  const p = new URLSearchParams(search)
  let from = parseYear(p.get('year_from')) ?? DEFAULT_VIEW_STATE.yearFrom
  let to = parseYear(p.get('year_to')) ?? DEFAULT_VIEW_STATE.yearTo
  // ช่วงกลับหัวจากลิงก์ที่แก้มือ: สลับให้ ไม่ใช่ทิ้งทั้งคู่ (ผู้ส่งลิงก์ตั้งใจดูช่วงนี้แน่)
  if (from > to) [from, to] = [to, from]
  return {
    yearFrom: from,
    yearTo: to,
    camera: parseCamera(p.get('at')),
    cell: parseCell(p.get('cell')),
    mode: p.get('view') === '2d' ? '2d' : '3d',
  }
}

const round = (n: number, digits: number) => Number(n.toFixed(digits))

/** query string ของสถานะ ค่าที่เท่าค่าเริ่มต้นไม่ใส่ เพื่อให้ลิงก์สั้นที่สุด ("" = มุมมองเริ่มต้น) */
export function serializeViewState(s: ViewState): string {
  const p = new URLSearchParams()
  if (s.yearFrom !== DEFAULT_VIEW_STATE.yearFrom) p.set('year_from', String(s.yearFrom))
  if (s.yearTo !== DEFAULT_VIEW_STATE.yearTo) p.set('year_to', String(s.yearTo))
  if (s.camera) {
    const c = s.camera
    const parts = [round(c.latitude, 5), round(c.longitude, 5), round(c.zoom, 2)]
    if (round(c.pitch, 0) !== 0 || round(c.bearing, 0) !== 0) parts.push(round(c.pitch, 0), round(c.bearing, 0))
    p.set('at', parts.join(','))
  }
  if (s.cell) p.set('cell', s.cell)
  if (s.mode === '2d') p.set('view', '2d')
  const q = p.toString()
  // URLSearchParams เข้ารหัส "," เป็น %2C ซึ่งอ่านยากในลิงก์ที่แชร์ — "," ปลอดภัยใน query string
  return q ? `?${q.replace(/%2C/g, ',')}` : ''
}
