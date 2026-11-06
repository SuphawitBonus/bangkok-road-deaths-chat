import path from "node:path";

import type { NextConfig } from "next";

// web/ เป็นโปรเจกต์อิสระ (lockfile ของตัวเอง ไม่ import อะไรจากนอก web/) บน Vercel ตั้ง Root Directory = web
// ระบุรากเองเพื่อไม่ให้ Next เดาจาก package-lock.json ที่ราก repo ซึ่งเป็นของโปรเจกต์ scripts คนละตัว (ถ้าเดาผิดจะเตือนทุกครั้งที่ build)
const projectRoot = path.resolve(process.cwd());

const nextConfig: NextConfig = {
  /* config options here */
  // ให้ proxy.ts เห็น URL ตามที่ผู้ใช้ส่งมาจริง (ไม่ผ่านการถอดรหัส/เขียน query ใหม่ของ Next) — ใช้ตรวจ query string ดิบ
  // ของ /api เพื่อปิดช่องหลบ cache ด้วยการเข้ารหัสอักขระ ดู lib/api-guard.ts และ docs/deploy.md
  skipProxyUrlNormalize: true,
  cacheComponents: true,
  partialPrefetching: true,
  outputFileTracingRoot: projectRoot,
  turbopack: {
    root: projectRoot,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
