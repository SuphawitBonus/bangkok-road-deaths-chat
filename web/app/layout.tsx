import type { Metadata, Viewport } from "next";
import { Noto_Sans_Thai } from "next/font/google";
import "./globals.css";

// Noto Sans Thai: อ่านภาษาไทยชัดทั้งตัวหนังสือและตัวเลข และมีตัวละติน จึงไม่ต้องใช้สองฟอนต์ผสมกัน
// next/font ดาวน์โหลดไฟล์ตอน build แล้วให้บริการจากโดเมนเดียวกัน ผู้ใช้ไม่ต้องติดต่อ Google ตอนเปิดหน้า
const notoThai = Noto_Sans_Thai({
  subsets: ["thai", "latin"],
  variable: "--font-noto-thai",
  display: "swap",
});

export const metadata: Metadata = {
  title: "กรุงเทพฯ 3 มิติ — ผู้เสียชีวิตจากอุบัติเหตุทางถนน",
  description:
    "แผนที่ 3 มิติแสดงจำนวนผู้เสียชีวิตจากอุบัติเหตุทางถนนในกรุงเทพมหานคร พ.ศ. 2554–2567 แยกเป็นช่องหกเหลี่ยม จากข้อมูลเปิดของกรมควบคุมโรค",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="th" className={`${notoThai.variable} h-full antialiased`}>
      <body className="h-full">{children}</body>
    </html>
  );
}
