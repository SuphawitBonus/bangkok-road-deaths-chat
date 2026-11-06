// รันครั้งเดียวตอนเซิร์ฟเวอร์เริ่มทำงาน (ต้องเสร็จก่อนรับคำขอแรก)
//
// ใช้บังคับ fail closed: ถ้าไม่มีรหัสผ่านของ web_reader เซิร์ฟเวอร์ต้องไม่ขึ้น
// ไม่ปล่อยให้ขึ้นมาแล้วไปล้มตอนผู้ใช้คนแรกเข้า (หรือแย่กว่านั้น คือไปเลือก role อื่นมาใช้แทน)
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  // ตอน `next build` ไม่ต้องมีรหัสผ่านฐานข้อมูล (เว็บไม่ query ตอน build) เช่นบน CI ที่ build ก่อน deploy
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  const { assertWebConfig } = await import('./lib/db')
  assertWebConfig()
}
