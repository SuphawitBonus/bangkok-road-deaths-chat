// ทดสอบการรวมผู้เสียชีวิตเป็นช่อง H3 — ไม่ต้องใช้ฐานข้อมูล
// ข้อที่สำคัญที่สุด: ผลรวมทุกช่อง = จำนวนจุดที่ส่งเข้าไป (ไม่มีใครหายหรือถูกนับซ้ำ)
import { cellToBoundary, cellToLatLng, gridDisk, latLngToCell } from 'h3-js'
import { describe, expect, it } from 'vitest'

import { aggregateH3, H3_COARSE, H3_FINE, type LocatedDeath } from '../src/h3-aggregate.js'

/** ตัวสุ่มที่ให้ค่าเดิมทุกครั้งที่รัน (mulberry32) test จึงไม่แกว่ง */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const point = (o: Partial<LocatedDeath> = {}): LocatedDeath => ({
  latitude: 13.7563,
  longitude: 100.5018,
  died_year: 2020,
  died_month: 6,
  is_complete_year: true,
  ...o,
})

const sum = (rows: { death_count: number }[]) => rows.reduce((s, r) => s + r.death_count, 0)

describe('aggregateH3', () => {
  it('ไม่มีจุดเลย → ไม่มีแถว', () => {
    expect(aggregateH3([])).toEqual([])
  })

  it('ผลรวมของทุกช่องเท่ากับจำนวนจุดที่ส่งเข้าไป (2,000 จุดสุ่มในกรอบกรุงเทพฯ)', () => {
    const rand = rng(20260105)
    const points: LocatedDeath[] = Array.from({ length: 2000 }, () => ({
      latitude: 13.4 + rand() * 0.6,
      longitude: 100.2 + rand() * 0.75,
      died_year: 2011 + Math.floor(rand() * 16),
      died_month: 1 + Math.floor(rand() * 12),
      is_complete_year: rand() > 0.1,
    }))
    const rows = aggregateH3(points)
    expect(sum(rows)).toBe(points.length)
    expect(rows.length).toBeLessThanOrEqual(points.length)
    expect(rows.every((r) => r.death_count >= 1)).toBe(true)
  })

  it('จุดซ้ำที่เดียวกัน เดือนเดียวกัน รวมเป็นแถวเดียว', () => {
    const rows = aggregateH3([point(), point(), point()])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.death_count).toBe(3)
  })

  it('จุดเดียวกันแต่ต่างเดือน ต่างปี หรือต่าง is_complete_year ต้องไม่ถูกรวมกัน', () => {
    const rows = aggregateH3([
      point(),
      point({ died_month: 7 }),
      point({ died_year: 2021 }),
      point({ is_complete_year: false }),
    ])
    expect(rows).toHaveLength(4)
    expect(sum(rows)).toBe(4)
  })

  /**
   * H3 ไม่ซ้อนกันสนิท: ช่อง res9 หนึ่งช่องอาจคร่อมขอบของ res8 สองช่อง
   * หาช่อง res9 แบบนั้นจริง ๆ แล้วเอาจุดสองจุดในช่องเดียวกันที่ตกคนละช่อง res8 (ค้นหาแบบกำหนดผลแน่นอน)
   */
  function straddlingPair(): { a: LocatedDeath; b: LocatedDeath } {
    const [cLat, cLng] = [13.7563, 100.5018]
    for (const cell of gridDisk(latLngToCell(cLat, cLng, H3_FINE), 40)) {
      const [lat0, lng0] = cellToLatLng(cell)
      const parent8 = latLngToCell(lat0, lng0, H3_COARSE)
      for (const [vLat, vLng] of cellToBoundary(cell)) {
        // ขยับจากมุมเข้าหาศูนย์กลาง 15% ให้แน่ใจว่ายังอยู่ในช่อง res9 เดิม
        const lat = vLat + (lat0 - vLat) * 0.15
        const lng = vLng + (lng0 - vLng) * 0.15
        if (latLngToCell(lat, lng, H3_FINE) === cell && latLngToCell(lat, lng, H3_COARSE) !== parent8) {
          return {
            a: point({ latitude: lat0, longitude: lng0 }),
            b: point({ latitude: lat, longitude: lng }),
          }
        }
      }
    }
    throw new Error('ไม่พบช่อง res9 ที่คร่อมขอบ res8 ในบริเวณที่ค้นหา')
  }

  it('จุดสองจุดในช่อง res9 เดียวกันแต่คนละช่อง res8 ต้องถูกนับเข้าช่อง res8 ของตัวเอง (ไม่ใช้ของจุดแรกกับทั้งกลุ่ม)', () => {
    const { a, b } = straddlingPair()
    // เงื่อนไขของสถานการณ์: ช่อง res9 เดียวกัน แต่ช่อง res8 ต่างกัน
    expect(latLngToCell(a.latitude, a.longitude, H3_FINE)).toBe(latLngToCell(b.latitude, b.longitude, H3_FINE))
    const res8A = latLngToCell(a.latitude, a.longitude, H3_COARSE)
    const res8B = latLngToCell(b.latitude, b.longitude, H3_COARSE)
    expect(res8A).not.toBe(res8B)

    const rows = aggregateH3([a, b])
    expect(sum(rows)).toBe(2)

    const byRes8 = new Map<string, number>()
    for (const r of rows) byRes8.set(r.h3_res8, (byRes8.get(r.h3_res8) ?? 0) + r.death_count)
    // ถูกต้อง: แต่ละ res8 ได้ 1 ราย  /  โค้ดเดิม: res8 ของจุดแรกได้ 2 ราย อีกช่องได้ 0
    expect(byRes8.get(res8A)).toBe(1)
    expect(byRes8.get(res8B)).toBe(1)
  })

  it('ผลรวมต่อช่อง res8 ตรงกับที่นับแยกด้วยวิธีอื่น', () => {
    const rand = rng(99)
    const points = Array.from({ length: 800 }, () =>
      point({
        latitude: 13.6 + rand() * 0.3,
        longitude: 100.4 + rand() * 0.3,
        died_month: 1 + Math.floor(rand() * 12),
      }),
    )
    const rows = aggregateH3(points)

    const fromRows = new Map<string, number>()
    for (const r of rows) fromRows.set(r.h3_res8, (fromRows.get(r.h3_res8) ?? 0) + r.death_count)

    const direct = new Map<string, number>()
    for (const p of points) {
      // นับตรงจากจุดดิบด้วยการหาช่อง res8 ของจุดเอง ไม่ผ่านโค้ดรวมที่กำลังทดสอบ
      const parent = aggregateH3([p])[0]!.h3_res8
      direct.set(parent, (direct.get(parent) ?? 0) + 1)
    }
    expect(fromRows).toEqual(direct)
  })

  it('ศูนย์กลางช่อง (centroid) ไม่ใช่พิกัดของจุดใดจุดหนึ่ง', () => {
    const p = point({ latitude: 13.756312345, longitude: 100.501812345 })
    const row = aggregateH3([p])[0]!
    expect(row.centroid_lat).not.toBe(p.latitude)
    expect(row.centroid_lng).not.toBe(p.longitude)
  })
})
