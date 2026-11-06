// GET /api/years — ยอดผู้เสียชีวิตที่มีพิกัดทั้งกรุงเทพฯ รายปี สำหรับไทม์ไลน์
// ตรรกะอยู่ใน lib/years-api.ts (ทดสอบแล้ว) ไฟล์นี้แค่ต่อ pool จริงและกำหนด header เหมือน /api/h3
import { NextRequest, NextResponse } from 'next/server'

import { queryYearRows } from '@/lib/h3-queries'
import { handleYears } from '@/lib/years-api'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const result = await handleYears(request.nextUrl.searchParams, {
    queryYears: queryYearRows,
    logError: (context, err) => console.error(`[api/years] ${context}`, err),
  })

  return NextResponse.json(result.body, {
    status: result.status,
    headers: {
      'Cache-Control':
        result.status === 200
          ? 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'
          : 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
