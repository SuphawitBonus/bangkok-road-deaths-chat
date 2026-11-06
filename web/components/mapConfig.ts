// ค่าคงที่ของแผนที่ แยกไฟล์ไว้เพื่อให้ MapApp (ที่ render ฝั่ง server ด้วย) อ่านได้โดยไม่ดึง maplibre-gl
// เข้ามาใน bundle ฝั่ง server — maplibre ต้องใช้ window จึงต้องถูกโหลดผ่าน dynamic import ใน MapCanvas เท่านั้น

/**
 * Liberty ของ OpenFreeMap: เลือกตัวนี้เพราะตรวจแล้วว่ามีชั้นตึก 3 มิติ (building-3d, fill-extrusion ใช้ render_height)
 * ส่วน Positron ที่เคยเลือกไว้ไม่มีชั้นตึก 3 มิติเลย ไม่ต้องใช้ token (ดู docs/decisions-web.md ข้อ 3)
 */
export const BASE_STYLE = "https://tiles.openfreemap.org/styles/liberty";

export const INITIAL_VIEW = {
  center: [100.58, 13.76] as [number, number],
  zoom: 10.4,
  pitch: 55,
  bearing: -12,
};
