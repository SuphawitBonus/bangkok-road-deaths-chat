// GET /api/h3 — จำนวนผู้เสียชีวิตต่อช่อง H3 สำหรับแผนที่ 3 มิติ
//
// ตรรกะทั้งหมดอยู่ใน lib/h3-api.ts (ทดสอบแล้ว) ไฟล์นี้แค่ต่อ pool จริงและกำหนด header
//
// ไม่มี `export const dynamic` เพราะ next.config เปิด cacheComponents ซึ่งไม่อนุญาตให้ใช้ค่านี้
// และไม่จำเป็นด้วย: route handler เป็น dynamic โดยปริยายเมื่ออ่าน request.nextUrl
import { NextRequest, NextResponse } from 'next/server'

import { handleH3 } from '@/lib/h3-api'
import { queryH3Rows } from '@/lib/h3-queries'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const result = await handleH3(request.nextUrl.searchParams, {
    queryRows: queryH3Rows,
    logError: (context, err) => console.error(`[api/h3] ${context}`, err),
  })

  return NextResponse.json(result.body, {
    status: result.status,
    headers: {
      // ข้อมูลเปลี่ยนเฉพาะตอนโหลดใหม่ (ไม่บ่อย) cache ได้ แต่ห้าม cache คำตอบที่เป็น error
      'Cache-Control':
        result.status === 200
          ? 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'
          : 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
