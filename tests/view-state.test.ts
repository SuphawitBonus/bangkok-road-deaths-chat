// สถานะใน URL ของหน้าแผนที่ (ลิงก์แชร์) — URL มาจากใครก็ได้ ต้องไม่มีค่าแปลก ๆ หลุดเข้าไปถึงแผนที่หรือ API
import { describe, expect, it } from 'vitest'

import { DEFAULT_VIEW_STATE, parseViewState, serializeViewState, type ViewState } from '../web/lib/view-state.js'
import { DATA_YEAR_MAX_COMPLETE, DATA_YEAR_MIN } from '../web/lib/years.js'

// ช่องจริงในกรุงเทพฯ (สร้างด้วย h3-js latLngToCell(13.7563, 100.5018, r))
const RES8 = '8864a4b139fffff'
const RES9 = '8964a4b138fffff'

describe('parseViewState', () => {
  it('ว่าง → ค่าเริ่มต้น', () => {
    expect(parseViewState('')).toEqual(DEFAULT_VIEW_STATE)
  })

  it('อ่านค่าที่ถูกต้องครบทุกช่อง', () => {
    const v = parseViewState(`?year_from=2015&year_to=2019&at=13.75,100.52,13.2,40,-10&cell=${RES9}&view=2d`)
    expect(v).toEqual({
      yearFrom: 2015,
      yearTo: 2019,
      camera: { latitude: 13.75, longitude: 100.52, zoom: 13.2, pitch: 40, bearing: -10 },
      cell: RES9,
      mode: '2d',
    })
  })

  it.each(['abc', '2567', '2010', '2025', '20.5', '<script>'])('ปีไม่ถูกต้อง (%s) → ใช้ค่าเริ่มต้น', (y) => {
    const v = parseViewState(`?year_from=${encodeURIComponent(y)}&year_to=${encodeURIComponent(y)}`)
    expect(v.yearFrom).toBe(DATA_YEAR_MIN)
    expect(v.yearTo).toBe(DATA_YEAR_MAX_COMPLETE)
  })

  it('ช่วงปีกลับหัว → สลับให้', () => {
    const v = parseViewState('?year_from=2020&year_to=2013')
    expect([v.yearFrom, v.yearTo]).toEqual([2013, 2020])
  })

  it.each([
    'x,y,z',
    '13.75,100.52',
    '51.5,-0.12,10', // ลอนดอน — นอกกรุงเทพฯ
    '13.75,100.52,25',
    '13.75,100.52,12,80',
    '13.75,100.52,12,0,400',
    '13.75,100.52,12,0,0,9',
    '1e1,100,12',
  ])('ตำแหน่งกล้องไม่ถูกต้อง (%s) → ไม่ใช้', (at) => {
    expect(parseViewState(`?at=${at}`).camera).toBeNull()
  })

  it('ช่อง H3 ที่ไม่ถูกต้องหรือคนละความละเอียด → ไม่ใช้', () => {
    expect(parseViewState(`?cell=${RES8}`).cell).toBe(RES8)
    expect(parseViewState('?cell=8864a4b139ffffg').cell).toBeNull()
    expect(parseViewState('?cell=ffffffffffffff').cell).toBeNull()
    expect(parseViewState('?cell=8764a4b13ffffff').cell).toBeNull() // res7
    expect(parseViewState(`?cell=${RES8.toUpperCase()}`).cell).toBeNull()
  })

  it('view อื่นที่ไม่ใช่ 2d → 3d', () => {
    expect(parseViewState('?view=4d').mode).toBe('3d')
  })
})

describe('serializeViewState', () => {
  it('ค่าเริ่มต้น → สตริงว่าง (ลิงก์สั้นสุด)', () => {
    expect(serializeViewState(DEFAULT_VIEW_STATE)).toBe('')
  })

  it('เขียนแล้วอ่านกลับได้ค่าเดิม และ "," ไม่ถูกเข้ารหัส', () => {
    const s: ViewState = {
      yearFrom: 2020,
      yearTo: 2020,
      camera: { latitude: 13.756331, longitude: 100.501765, zoom: 12.345, pitch: 55.4, bearing: -12.2 },
      cell: RES8,
      mode: '2d',
    }
    const q = serializeViewState(s)
    expect(q).toContain('at=13.75633,100.50177,12.35,55,-12')
    expect(q).not.toContain('%2C')
    const back = parseViewState(q)
    expect(back.yearFrom).toBe(2020)
    expect(back.cell).toBe(RES8)
    expect(back.mode).toBe('2d')
    expect(back.camera?.zoom).toBeCloseTo(12.35)
  })

  it('กล้องมองตรงลงไม่ใส่ pitch/bearing', () => {
    const q = serializeViewState({ ...DEFAULT_VIEW_STATE, camera: { latitude: 13.7, longitude: 100.5, zoom: 11, pitch: 0, bearing: 0 } })
    expect(q).toBe('?at=13.7,100.5,11')
  })
})
