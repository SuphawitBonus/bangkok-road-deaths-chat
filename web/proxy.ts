// Proxy (ชื่อใหม่ของ middleware ใน Next 16) — รันก่อน cache และก่อน route handler
// ใช้ตัดคำขอ /api ที่ไม่ใช่ URL มาตรฐานด้วย 400 โดยไม่ให้ถึงฐานข้อมูล ตรรกะอยู่ใน lib/api-guard.ts (ทดสอบแล้ว)
import { NextResponse, type NextRequest } from 'next/server'

import { guardApiRequest } from '@/lib/api-guard'

export function proxy(request: NextRequest): NextResponse {
  const rejection = guardApiRequest(new URL(request.url).pathname, new URL(request.url).search)
  if (!rejection) return NextResponse.next()
  return NextResponse.json(rejection.body, {
    status: rejection.status,
    // ห้าม cache คำตอบ 400: ถ้า cache ได้ ผู้โจมตีใช้มันดัน URL ขยะเข้า cache ของเราเอง
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}

export const config = { matcher: ['/api/h3', '/api/years'] }
