// ด่านหน้าของ /api (proxy.ts): ตัดคำขอที่ไม่ใช่ URL มาตรฐานก่อนถึง cache และฐานข้อมูล
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { guardApiRequest } from '../web/lib/api-guard.js'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

describe('guardApiRequest — /api/h3', () => {
  it('URL มาตรฐานผ่าน', () => {
    expect(guardApiRequest('/api/h3', '?res=8&year_from=2011&year_to=2024')).toBeNull()
    expect(guardApiRequest('/api/h3', '?res=9&year_from=2020&year_to=2020')).toBeNull()
  })

  // เจอจริงตอนทดสอบกับเซิร์ฟเวอร์: route handler ไม่เห็นความต่างของรูปเหล่านี้เลย (Next เขียน query ใหม่ก่อนถึง route)
  it.each([
    '',
    '?res=8',
    '?year_from=2011&year_to=2024&res=8',
    '?res=8&year_from=%32011&year_to=2024',
    '?r%65s=8&year_from=2011&year_to=2024',
    '?res=8&year_from=2011&year_to=2024&',
    '?&res=8&year_from=2011&year_to=2024',
    '?res=8&year_from=2011&year_to=2024&cb=1',
    '?res=8&year_from=abc&year_to=2024',
  ])('ปฏิเสธ 400: %j', (search) => {
    const r = guardApiRequest('/api/h3', search)
    expect(r?.status).toBe(400)
    expect(r?.body.error).toBe('invalid_parameter')
  })

  it('ข้อความ 400 ไม่สะท้อนสิ่งที่ส่งมา', () => {
    const r = guardApiRequest('/api/h3', '?res=8&year_from=2011&year_to=2024&x=<script>')
    expect(JSON.stringify(r)).not.toMatch(/script|x=/)
  })
})

describe('guardApiRequest — /api/years และเส้นทางอื่น', () => {
  it('/api/years ผ่านเมื่อไม่มี query เท่านั้น', () => {
    expect(guardApiRequest('/api/years', '')).toBeNull()
    // "?&" และ "?%20=" ถอดรหัสแล้วไม่มีพารามิเตอร์ แต่เป็นคนละ URL ที่ cache ไม่เคยเห็น จึงต้องปฏิเสธที่สตริงดิบ
    for (const s of ['?&', '?a=1', '?%20=', '?year_from=2011']) {
      expect(guardApiRequest('/api/years', s)?.status).toBe(400)
    }
  })

  it('เส้นทางอื่นไม่ถูกยุ่ง (proxy ผูกกับ /api/h3 และ /api/years เท่านั้นด้วย matcher)', () => {
    expect(guardApiRequest('/', '?anything=1')).toBeNull()
    expect(guardApiRequest('/api/other', '?x=1')).toBeNull()
  })
})

describe('การต่อสายของ proxy (ตรวจจากไฟล์ เพราะตัวป้องกันขึ้นกับสองอย่างนี้)', () => {
  it('next.config เปิด skipProxyUrlNormalize — ไม่เช่นนั้น proxy เห็นแต่ query ที่ Next เขียนใหม่แล้ว และรูปที่เข้ารหัสแปลก ๆ รอดไปถึงฐานข้อมูล', () => {
    expect(read('../web/next.config.ts')).toMatch(/^\s*skipProxyUrlNormalize:\s*true,/m)
  })

  it('proxy.ts อ่านจาก request.url (ดิบ) และใช้ matcher แค่สองเส้นทาง', () => {
    const src = read('../web/proxy.ts')
    expect(src).toContain('request.url')
    expect(src).toContain('guardApiRequest')
    expect(src).toMatch(/matcher:\s*\['\/api\/h3',\s*'\/api\/years'\]/)
    expect(src).toMatch(/'Cache-Control':\s*'no-store'/)
  })
})
