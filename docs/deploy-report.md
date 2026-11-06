# รายงาน deploy: Vercel + Neon (เตรียมความพร้อม)

วันที่: 2026-11-06 · branch `deploy-neon-vercel` · **ยังไม่ได้ push** · **ยังไม่ได้ deploy ขึ้น Vercel**
เอกสารที่ควรอ่านคู่กัน: [deploy.md](deploy.md) (ขั้นตอนและเหตุผล), [privacy.md](privacy.md), [decisions-web.md](decisions-web.md)

> เอาต์พุตทุกชิ้นด้านล่างเป็นของจริงที่จับไว้ตอนรัน ไม่ได้เขียนขึ้นใหม่ (ตัดเฉพาะบรรทัดว่างและโค้ดสีของเทอร์มินัล) ไม่มีรหัสผ่าน connection string
> หรือ host ปรากฏในรายงานนี้ (สแกนไฟล์ดิบทั้งหมดด้วย regex ของ URL/`neon.tech`/`npg_` แล้ว ไม่พบ) ค่าใน `.env` ไม่เคยถูกเปิดอ่านหรือพิมพ์

## 1. สรุปว่าอะไรรันจริงกับ Neon และอะไรยังไม่ได้รัน

| ข้อ | งาน | สถานะ | รันจริงกับ Neon? |
| --- | --- | --- | --- |
| 1 | แยก `web/` เป็นโปรเจกต์อิสระ | ✅ ลบ `workspaces` แล้ว ติดตั้งสะอาดจาก lockfile ของ `web/` + typecheck + build ผ่าน (พบบั๊กหนึ่งและแก้แล้ว — ข้อ 4.1) | ไม่เกี่ยว |
| 2 | `web/vercel.json` `regions: ["sin1"]` | ✅ เขียนแล้ว ตรวจกับเอกสาร Vercel แล้วว่ารูปแบบและ region ถูกต้อง · ⬜ **ยังไม่เคย deploy** จึงยังไม่เห็นการทำงานจริงบน Vercel | ไม่ใช่ |
| 3 | `npm run neon:sync` | ✅ รันจริง 2 รอบ (รอบสองพิสูจน์ว่ารันซ้ำได้) | **ใช่** |
| 4 | `npm run neon:check` | ✅ รันจริง ผ่านทุกข้อ 56 ข้อ (รอบแรกล้ม 1 ข้อ ต้องแก้ตัวตรวจ — ข้อ 4.3) | **ใช่** |
| 5 | ปิดช่องหลบ cache ของ `/api/h3` | ✅ แก้และทดสอบด้วย HTTP จริง (ต้องเพิ่ม `proxy.ts` — ข้อ 4.2) · ⬜ พฤติกรรมบน Vercel ยังไม่ได้พิสูจน์ | ใช่ (เซิร์ฟเวอร์ในเครื่องต่อ Neon) |
| 6 | เว็บทดสอบกับ Neon ในเครื่อง | ✅ build + start + curl: 200 ทั้งสอง endpoint, 211 URL ตรงกับฐานข้อมูลในเครื่องทุกไบต์ · `WEB_DATABASE_URL` ที่ไม่ใช่ `web_reader` ทำให้ทุกคำขอ 500 | **ใช่** |
| 7 | เอกสาร | ✅ `deploy.md`, README (ตารางสถานะ + Live demo + แผนภาพ), `.env.example`, `web/README.md`, `decisions-web.md`, `privacy.md` ไม่ได้แตะ | ไม่เกี่ยว |
| 8 | รายงานนี้ | ✅ | — |
| — | deploy ขึ้น Vercel / ตรวจ cache, proxy, region บน Vercel | ⬜ **ยังไม่ได้ทำ** | ไม่ใช่ |

## 2. สิ่งที่เปลี่ยนบน Neon จริง

- **เปลี่ยน:** สร้าง schema `app`, ตาราง `app.h3_deaths_monthly` (4 index), role `web_reader` (สร้างด้วย SQL จาก `db/04_web_security.sql`), คัดลอก 7,194 แถว
- **ไม่ได้ทำ:** ไม่รัน `db/01`–`03`, ไม่มี `app.deaths`/`deaths_raw`/`ai_reader`/`app_admin` บน Neon (`neon:check` ข้อ 6 ยืนยัน), ไม่ใช้ `neon` CLI เลย
  (ไม่มี `init/link/checkout/env pull/deploy`), ไม่ใช้ Neon Functions/Auth/Storage/Realtime/AI Gateway
- **`.env` ของคุณ:** ต่อท้าย 1 บรรทัด (`NEON_WEB_DATABASE_URL`) ขนาดไฟล์ 590 → 759 ไบต์ สคริปต์ตรวจแล้วว่าไบต์เดิมครบทุกไบต์ รอบที่สองไม่เปลี่ยนไฟล์ (759 → 759)
  ไม่ได้อ่านหรือพิมพ์ค่าใด ๆ ออกมา
- `.claude/skills/` และ `skills-lock.json` ถูกเพิ่มใน `.gitignore` ไม่ได้ commit

## 3. เอาต์พุตดิบ

### 3.1 ข้อ 1 — ติดตั้งสะอาดจาก lockfile ของ `web/` (ในโฟลเดอร์ว่างนอก repo เพื่อไม่ลบ `node_modules` ที่ dev server ของคุณกำลังใช้)

`git archive HEAD web` → `npm ci` → `typecheck` → `build` รอบแรก (ก่อนแก้ typecheck) **รันจริง, ไม่เกี่ยวกับ Neon**

```text
AGENTS.md
README.md
app
components
instrumentation.ts
lib
next.config.ts
package-lock.json
package.json
tsconfig.json
added 212 packages in 4m
--- typecheck
app/layout.tsx(24,50): error TS2304: Cannot find name 'LayoutProps'.
tsc-exit=0
--- build
✓ Generating static pages using 7 workers (6/6) in 4.2s
  Finalizing page optimization ...
Route (app)
┌ ○ /
├ ○ /_not-found
├ ƒ /api/h3
└ ƒ /api/years
○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
[exited with code 0]
```

บรรทัด `error TS2304: Cannot find name 'LayoutProps'` คือบั๊กที่พบ (ข้อ 4.1) — **ระวังอ่านผิด:** `tsc-exit=0` ในเอาต์พุตนี้เป็น exit code ของ `tail` ที่ผมต่อท่อไว้ ไม่ใช่ของ `tsc` ซึ่งล้มจริงตามบรรทัด error ข้างบน (รอบที่แก้แล้วด้านล่างวัด exit ของ npm ตรง ๆ) หลังแก้ script เป็น `next typegen && tsc --noEmit` รันซ้ำบนสำเนาเดิมที่ลบ `.next/` ทิ้ง:

```text
> web@0.1.0 typecheck
> next typegen && tsc --noEmit

Generating route types...
✓ Types generated successfully
exit=0
```

lockfile ที่รากไม่เปลี่ยน: `npm install --package-lock-only` หลังลบ `workspaces` แล้ว `git diff package-lock.json` ว่างเปล่า (lockfile ไม่เคยรู้จัก `web`)

### 3.2 `npm test` (ราก) — ไม่เกี่ยวกับ Neon

```text
> bangkok-road-deaths-chat@0.1.0 test
> vitest run
 RUN  v5.1.0 D:/bangkok-road-deaths-chat
 Test Files  12 passed (12)
      Tests  325 passed (325)
   Start at  17:27:10
   Duration  9.98s (import 62%, transform 24%, tests 13%, worker 1%)
exit=0
```

### 3.3 `npm run typecheck` (ราก)

```text
> bangkok-road-deaths-chat@0.1.0 typecheck
> tsc --noEmit
exit=0
```

### 3.4 `npm --prefix web run typecheck`

```text
> web@0.1.0 typecheck
> next typegen && tsc --noEmit
Generating route types...
✓ Types generated successfully
exit=0
```

### 3.5 `npm --prefix web run build`

```text
Route (app)
┌ ○ /
├ ○ /_not-found
├ ƒ /api/h3
└ ƒ /api/years
ƒ Proxy (Middleware)
○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
exit=0
```

(exit code ของ build: ดูบรรทัด `exit=` ในไฟล์ดิบ = 0)

### 3.6 `npm run neon:sync` — **รันจริงกับ Neon** รอบที่ 1

```text
> bangkok-road-deaths-chat@0.1.0 neon:sync
> tsx src/scripts/sync-neon.ts
neon:sync — คัดลอกตารางสรุปขึ้น Neon
  ok  NEON_ADMIN_URL: มี และผ่านการตรวจ (ไม่ใช่เครื่องตัวเอง ไม่ใช่ web_reader ไม่ใช่ pooled)
  ok  ต้นทางในเครื่อง: 7,194 แถว · ผลรวม death_count 7,529 · ปีที่ครบ 7,337
(node:48884) Warning: SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.
In the next major version (pg-connection-string v3.0.0 and pg v9.0.0), these modes will adopt standard libpq semantics, which have weaker security guarantees.
To prepare for this change:
- If you want the current behavior, explicitly use 'sslmode=verify-full'
- If you want libpq compatibility now, use 'uselibpqcompat=true&sslmode=require'
See https://www.postgresql.org/docs/current/libpq-ssl.html for libpq SSL mode definitions.
(Use `node --trace-warnings ...` to show where the warning was created)
  ok  ต่อ Neon (direct) ได้ · Postgres 18.6 (ac70818)
  ok  NEON_WEB_DATABASE_URL: สุ่มรหัสผ่านใหม่ แล้วต่อท้าย .env (ไม่แตะบรรทัดเดิม ไม่พิมพ์ค่า)
  ok  คัดลอกแล้ว 7,194 แถว · ผลรวม death_count 7,529 · ตรงกับต้นทางทุกแถว (เทียบ digest md5)
  ok  อ่านซ้ำหลัง COMMIT จาก session ใหม่ ตรงกับต้นทาง
เสร็จ — รัน npm run neon:check เพื่อตรวจสิทธิ์ของ web_reader และเนื้อหาบน Neon
exit=0
```

### 3.7 `npm run neon:sync` — รอบที่ 2 (พิสูจน์ว่ารันซ้ำได้: `.env` ไม่ถูกแตะ ข้อมูลตรงกันอีกครั้ง)

```text
> bangkok-road-deaths-chat@0.1.0 neon:sync
> tsx src/scripts/sync-neon.ts
neon:sync — คัดลอกตารางสรุปขึ้น Neon
  ok  NEON_ADMIN_URL: มี และผ่านการตรวจ (ไม่ใช่เครื่องตัวเอง ไม่ใช่ web_reader ไม่ใช่ pooled)
  ok  ต้นทางในเครื่อง: 7,194 แถว · ผลรวม death_count 7,529 · ปีที่ครบ 7,337
(node:25408) Warning: SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.
In the next major version (pg-connection-string v3.0.0 and pg v9.0.0), these modes will adopt standard libpq semantics, which have weaker security guarantees.
To prepare for this change:
- If you want the current behavior, explicitly use 'sslmode=verify-full'
- If you want libpq compatibility now, use 'uselibpqcompat=true&sslmode=require'
See https://www.postgresql.org/docs/current/libpq-ssl.html for libpq SSL mode definitions.
(Use `node --trace-warnings ...` to show where the warning was created)
  ok  ต่อ Neon (direct) ได้ · Postgres 18.6 (ac70818)
  ok  NEON_WEB_DATABASE_URL: มีอยู่แล้ว ใช้ค่าเดิม
  ok  คัดลอกแล้ว 7,194 แถว · ผลรวม death_count 7,529 · ตรงกับต้นทางทุกแถว (เทียบ digest md5)
  ok  อ่านซ้ำหลัง COMMIT จาก session ใหม่ ตรงกับต้นทาง
เสร็จ — รัน npm run neon:check เพื่อตรวจสิทธิ์ของ web_reader และเนื้อหาบน Neon
exit=0
```

### 3.8 `npm run neon:check` — **รันจริงกับ Neon** รอบแรก (ล้ม 1 ข้อ ก่อนแก้ตัวตรวจ)

บรรทัดที่เกี่ยวข้องและสรุปท้าย (ฉบับเต็มดูข้อ 3.9):

```text
  ok   ผลรวมแบบ API (h3_res9, ทุกปีที่ครบ) = 7,337  (ได้ 7,337 ใน 3,527 ช่อง)
──────────────────────────────────────────────────────────────────────────────
ล้ม 1 ข้อ — ห้ามเปิดเว็บ production จนกว่าจะแก้
exit=1
```

### 3.9 `npm run neon:check` — รันจริงกับ Neon รอบสุดท้าย (หลังแก้)

```text
> bangkok-road-deaths-chat@0.1.0 neon:check
> tsx src/scripts/check-neon.ts
neon:check — ตรวจ Neon (production)
ค่าตั้ง (ไม่พิมพ์ค่า)
──────────────────────────────────────────────────────────────────────────────
  ok   NEON_ADMIN_URL มีใน .env
  ok   NEON_WEB_DATABASE_URL มีใน .env (รัน npm run neon:sync เพื่อสร้าง)
  ok   NEON_ADMIN_URL: ไม่ใช่เครื่องตัวเอง ไม่ใช่ web_reader เป็น direct
  ok   NEON_WEB_DATABASE_URL: ผู้ใช้ = web_reader และมีรหัสผ่าน
  ok   NEON_WEB_DATABASE_URL ใช้ host แบบ pooled (-pooler) สำหรับเว็บ
  ok   NEON_ADMIN_URL ใช้ host แบบ direct (ไม่มี -pooler)
  ok   NEON_WEB_DATABASE_URL ใช้ sslmode=verify-full  (ได้ verify-full)
  ok   เว็บกับแอดมินใช้ host คนละแบบ (pooled กับ direct)
(node:35844) Warning: SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.
In the next major version (pg-connection-string v3.0.0 and pg v9.0.0), these modes will adopt standard libpq semantics, which have weaker security guarantees.
To prepare for this change:
- If you want the current behavior, explicitly use 'sslmode=verify-full'
- If you want libpq compatibility now, use 'uselibpqcompat=true&sslmode=require'
See https://www.postgresql.org/docs/current/libpq-ssl.html for libpq SSL mode definitions.
(Use `node --trace-warnings ...` to show where the warning was created)
  ––   Postgres 18.6 (ac70818)
1) web_reader: ตัวตนและสิทธิ์พิเศษ (เชื่อมต่อผ่าน pooler)
──────────────────────────────────────────────────────────────────────────────
  ok   current_user = web_reader  (ได้ web_reader)
  ok   ไม่ใช่ superuser
  ok   ไม่มี CREATEROLE
  ok   ไม่มี CREATEDB
  ok   ไม่มี REPLICATION
  ok   ไม่มี BYPASSRLS
  ok   web_reader ไม่ได้เป็นสมาชิกของ role อื่นเลย (ทั้งตรงและผ่านการสืบทอด รวม neon_superuser)
  ok   ไม่มีแถวใน pg_auth_members ที่ web_reader เป็นสมาชิก  (พบ 0)
2) ค่าที่ติดมากับ role (ตั้งที่ตัว role จึงใช้ได้แม้ผ่าน pooler)
──────────────────────────────────────────────────────────────────────────────
  ok   statement_timeout = 5s  (ได้ 5s)
  ok   default_transaction_read_only = on  (ได้ on)
  ––   search_path                            = app
  ––   idle_in_transaction_session_timeout    = 10s
  ––   lock_timeout                           = 2s
3) อ่านได้ (SELECT)
──────────────────────────────────────────────────────────────────────────────
  ok   SELECT app.h3_deaths_monthly ได้  (7,194 แถว)
4) เขียน / แก้โครงสร้างไม่ได้ (ลองจริง แล้ว ROLLBACK ทุกครั้ง)
──────────────────────────────────────────────────────────────────────────────
  ค่าเริ่มต้นของ role (read-only เปิดอยู่): ทุกข้อต้องถูกปฏิเสธ
  ok   INSERT  ← 25006 cannot execute INSERT in a read-only transaction [25006]
  ok   UPDATE  ← 25006 cannot execute UPDATE in a read-only transaction [25006]
  ok   DELETE  ← 25006 cannot execute DELETE in a read-only transaction [25006]
  ok   TRUNCATE  ← 25006 cannot execute TRUNCATE TABLE in a read-only transaction [25006]
  ok   CREATE TABLE ใน app  ← 25006 cannot execute CREATE TABLE in a read-only transaction [25006]
  ok   CREATE TABLE ใน public  ← 25006 cannot execute CREATE TABLE in a read-only transaction [25006]
  ok   DROP TABLE  ← 25006 cannot execute DROP TABLE in a read-only transaction [25006]
  ok   เปลี่ยนรหัสผ่านตัวเอง  ← 25006 cannot execute ALTER ROLE in a read-only transaction [25006]
  ปิด read-only เอง (BEGIN READ WRITE): ต้องถูกกันด้วยสิทธิ์ (42501) ไม่ใช่แค่ read-only
  ok   INSERT
  ok   UPDATE
  ok   DELETE
  ok   TRUNCATE
  ok   CREATE TABLE ใน app
  ok   CREATE TABLE ใน public
  ok   CREATE SCHEMA
  ok   CREATE FUNCTION
  ok   ALTER TABLE
  ok   DROP TABLE
  ok   ให้สิทธิ์ตัวเองบน role แอดมิน
  ok   สลับไปเป็น role แอดมิน
  ok   สลับไปเป็น neon_superuser  (ถูกปฏิเสธโดยข้อจำกัดของ Neon เอง)
  ok   สลับไปเป็น pg_read_server_files  (ถูกปฏิเสธโดยข้อจำกัดของ Neon เอง)
  ok   อ่านไฟล์จากเครื่อง
  ok   COPY ... TO PROGRAM
5) สิทธิ์ตาม catalog (อ่านด้วยแอดมิน ไม่เชื่อแค่ผลลองเขียน)
──────────────────────────────────────────────────────────────────────────────
  ok   สิทธิ์บนตารางทุกตารางในทุก schema = SELECT บน app.h3_deaths_monthly อย่างเดียว  (พบ: app.h3_deaths_monthly:SELECT)
  ok   CREATE ใน schema app ไม่ได้ (catalog)
  ok   CREATE ใน schema public ไม่ได้ (catalog)
  ok   CREATE schema ในฐานข้อมูลไม่ได้ (catalog)
6) Neon มีเฉพาะตารางสรุป ไม่มีข้อมูลรายคนหรือ role อื่นของโปรเจกต์
──────────────────────────────────────────────────────────────────────────────
  ok   ตาราง/view ที่ไม่ใช่ของระบบหรือ extension มีแค่ app.h3_deaths_monthly  (พบ 1: app.h3_deaths_monthly)
  ––   ความสัมพันธ์ที่เป็นของ extension (ไม่นับ): 0
  ok   ไม่มี app.deaths บน Neon
  ok   ไม่มี app.deaths_raw บน Neon
  ok   ไม่มี role ai_reader / app_admin บน Neon
  ok   web_reader มีอยู่และ login ได้
  ok   ตารางมีเฉพาะคอลัมน์ที่ตั้งใจ (ไม่มี id / วันที่ / อายุ / เพศ — ไม่มีข้อมูลรายคน)
7) ตัวเลขที่เว็บเห็น (web_reader ผ่าน pooler, query แบบเดียวกับ /api/h3)
──────────────────────────────────────────────────────────────────────────────
  ok   ผลรวม death_count ทุกปี = 7,529  (ได้ 7,529)
  ok   ผลรวมแบบ API (h3_res8, ทุกปีที่ครบ) = 7,337  (ได้ 7,337 ใน 1,450 ช่อง)
  ok   ผลรวมแบบ API (h3_res9, ทุกปีที่ครบ) = 7,337  (ได้ 7,337 ใน 3,527 ช่อง)
──────────────────────────────────────────────────────────────────────────────
ผ่านทุกข้อ — Neon ตรงตามที่ออกแบบไว้
exit=0
```

### 3.10 `curl` กับเว็บ production build ที่ต่อ Neon (พอร์ต 3011) — **รันจริงกับ Neon**

```text
# เว็บ production build ต่อ Neon (พอร์ต 3011, WEB_DATABASE_URL = NEON_WEB_DATABASE_URL ผ่าน env ของ process)
$ curl -s -w "\n%{http_code}\n" "http://localhost:3011/api/h3?res=8&year_from=2011&year_to=2024"   (ตัดแสดง 300 ไบต์แรก)
{"resolution":8,"year_from":2011,"year_to":2024,"k":3,"cells":[{"h3_index":"8864a4121bfffff","suppressed":true},{"h3_index":"8864a41243fffff","suppressed":true},{"h3_index":"8864a41289fffff","suppressed":true},{"h3_index":"8864a41291fffff","suppressed":true},{"h3_index":"8864a4129dfffff","suppressed
status/ขนาด: 200 64607B

$ curl -s -w "\n%{http_code}\n" "http://localhost:3011/api/h3?res=8&year_from=abc&year_to=2024"
{"error":"invalid_parameter","message":"year_from must be a 4-digit integer year in the Common Era (CE), e.g. 2011"}
400

$ curl -s -w "\n%{http_code}\n" http://localhost:3011/api/years
{"year_from":2011,"year_to":2024,"k":3,"years":[{"year":2011,"deaths":354},{"year":2012,"deaths":525},{"year":2013,"deaths":557},{"year":2014,"deaths":535},{"year":2015,"deaths":456},{"year":2016,"deaths":545},{"year":2017,"deaths":615},{"year":2018,"deaths":606},{"year":2019,"deaths":593},{"year":2020,"deaths":545},{"year":2021,"deaths":538},{"year":2022,"deaths":597},{"year":2023,"deaths":585},{"year":2024,"deaths":286}]}
200

# ตัวเลขสรุปของ /api/h3 ทั้ง res8 และ res9 (ทุกปีที่ครบ) เทียบ Neon (3011) กับฐานข้อมูลในเครื่อง (3012)
res8 port 3011: {"cells":1450,"total_deaths":7337,"visible_deaths":6542,"suppressed_cells":596,"suppressed_deaths":795}
res8 port 3012: {"cells":1450,"total_deaths":7337,"visible_deaths":6542,"suppressed_cells":596,"suppressed_deaths":795}
res9 port 3011: {"cells":3527,"total_deaths":7337,"visible_deaths":3971,"suppressed_cells":2614,"suppressed_deaths":3366}
res9 port 3012: {"cells":3527,"total_deaths":7337,"visible_deaths":3971,"suppressed_cells":2614,"suppressed_deaths":3366}

```

### 3.11 เทียบ 211 URL ระหว่าง Neon (3011) กับฐานข้อมูลในเครื่อง (3012) และ URL ที่ต้องถูกปฏิเสธ

```text
URL ที่เทียบ: 211 (210 h3 + 1 years) · เหมือนกันทุกไบต์: 211 · ต่างกัน: 0 · ไม่ใช่ 200: 0 · ใช้เวลา 6.3 วินาที
  400  /api/h3?res=8&year_from=%32011&year_to=2024
  400  /api/h3?r%65s=8&year_from=2011&year_to=2024
  400  /api/h3?res=8&year_from=2011&year_to=2024&
  400  /api/h3?&res=8&year_from=2011&year_to=2024
  400  /api/h3
  400  /api/years?&
  400  /api/years?%20=
```

### 3.12 `WEB_DATABASE_URL` ที่ผู้ใช้ไม่ใช่ `web_reader` — **รันจริงกับ Neon** (เปลี่ยนแค่ชื่อผู้ใช้ ไม่ได้ส่งรหัสผ่านของแอดมิน)

```text
# WEB_DATABASE_URL ที่ผู้ใช้ไม่ใช่ web_reader (เปลี่ยนแค่ชื่อผู้ใช้เป็นเจ้าของฐานข้อมูล รหัสผ่านยังเป็นของ web_reader)
✓ Ready in 309ms
Failed to prepare server Error [WebConfigError]: An error occurred while loading instrumentation hook: WEB_DATABASE_URL must connect as web_reader
⨯ Failed to preload entries: Error [WebConfigError]: An error occurred while loading instrumentation hook: WEB_DATABASE_URL must connect as web_reader
GET /api/h3?res=8&year_from=2011&year_to=2024 -> 500  body: Internal Server Error
GET /api/years -> 500  body: Internal Server Error
GET / -> 500  body: Internal Server Error
```

### 3.13 `npm run db:check` (ฐานข้อมูลในเครื่อง ไม่ใช่ Neon) หลังเพิ่มค่าคงที่ใหม่

```text
  ok   ผู้เสียชีวิตที่มีพิกัดในปีที่ครบ = 7,337 (ค่าคงที่ที่ neon:check ใช้เทียบกับ Neon)  (ได้ 7337)
  ok   ผู้เสียชีวิตทั้งหมดรายปี = TOTAL_DEATHS_BY_YEAR ในเว็บ (ใช้วาดแท่งเต็มของไทม์ไลน์)
  ok   query แบบ /api/years (web_reader) = ผู้เสียชีวิตที่มีพิกัดรายปีใน view ทุกปี
──────────────────────────────────────────────────────────────────────────────
ผ่านทุกข้อ — ชั้นฐานข้อมูลทำงานตามที่ออกแบบไว้
exit=0
```

## 4. สิ่งที่พบนอกเหนือจากที่ prompt สั่ง (ทุกข้อมีหลักฐานข้างบน)

1. **`npm run typecheck` ใน `web/` ล้มบน repo ที่เพิ่ง clone** (ข้อ 3.1) เพราะ `LayoutProps` เป็นชนิดที่ Next สร้างตอน build/typegen รอบก่อน ๆ ไม่เห็นเพราะมี `.next/` ค้างอยู่
   แก้: script เป็น `next typegen && tsc --noEmit` และมี test ตรวจ ถ้าไม่แก้ CI หรือ Vercel ที่รัน typecheck จะล้ม
2. **การตรวจ query string ใน route handler อย่างเดียวไม่ปิดช่องหลบ cache** prompt บอกว่า "พารามิเตอร์ที่ไม่รู้จักต้องได้ 400" ซึ่ง `/api/h3` ทำอยู่แล้ว
   ผมเพิ่มการบังคับ query รูปเดียว (ทำให้เหลือ URL ที่ถูกต้อง 210 เส้น) แล้วทดสอบกับเซิร์ฟเวอร์จริง พบว่า `%32011`, `&` เกิน และ `/api/years?&` **ยังได้ 200**
   เพราะ Next เขียน query ใหม่ก่อนถึง route แก้โดยเพิ่ม `web/proxy.ts` + เปิด `skipProxyUrlNormalize` (ข้อ 3.11: 7 URL ทดสอบได้ 400 หมด)
   **การตัดสินใจที่ prompt ไม่ได้ระบุ:** `/api/h3` เปล่า ๆ และ `?res=8` (ตัดค่าเริ่มต้น) ได้ 400 แล้ว ผมถือว่าสอดคล้องกับ "ชุด URL จำกัด" และลูกค้าเดียวคือหน้าเว็บของเราซึ่งส่งรูปเต็มเสมอ
   ถ้าต้องการให้ `/api/h3` เปล่า ๆ ใช้ได้ ต้องเพิ่มเป็น URL มาตรฐานอีกเส้น (บอกได้)
3. **`neon:check` รอบแรกล้ม 1 ข้อ** (ข้อ 3.8): ลอง `SET LOCAL ROLE neon_superuser` ได้ SQLSTATE `XX000` ไม่ใช่ `42501` ที่ตัวตรวจคาด
   สืบแล้ว (ตรวจแบบปิดข้อความที่มี host) Neon แก้ Postgres ให้ปฏิเสธการ `SET ROLE` ไปเป็น role ที่จำกัดไว้ด้วยข้อความ
   `It is not allowed to change role to ...` ซึ่ง **เข้มกว่า** ไม่ใช่การรั่ว ผมปรับตัวตรวจให้ยอมรับเฉพาะข้อความนี้ (ไม่ใช่ `XX000` ทุกกรณี) สำหรับสอง role นี้เท่านั้น
   และเพิ่มการลอง `pg_read_server_files` ด้วย ข้ออื่นทั้งหมดยังต้องได้ `42501`
4. **Next เตือนเรื่อง lockfile สองไฟล์** (รากกับ `web/`) และเดารากโปรเจกต์ไปที่ราก repo จึงกำหนด `turbopack.root` และ `outputFileTracingRoot` เป็น `web/` เอง (build รอบหลังไม่เตือนแล้ว)
5. **`NEON_ADMIN_URL` ของคุณมี `sslmode=require`** ทำให้ pg พิมพ์คำเตือนความปลอดภัยทุกครั้ง (เห็นในข้อ 3.6 และ 3.9) ไม่ได้แก้ไฟล์ของคุณ แก้เองได้โดยเปลี่ยนเป็น `sslmode=verify-full`
6. **เว็บที่ได้ URL ผิด role "ไม่เริ่ม" ในความหมายว่าทุกคำขอ 500** (ข้อ 3.12) โปรเซส `next start` ยังรันอยู่แต่ไม่เชื่อมต่อฐานข้อมูลเลย (ตรวจ URL ก่อนต่อ) ไม่ได้ปิดตัวเอง
   ถ้าต้องการให้โปรเซสปิดตัวจริง ต้องเปลี่ยน `instrumentation.ts` ซึ่งไม่เหมาะกับ serverless (บน Vercel ไม่มีโปรเซสให้ปิด)
7. **ตัวตรวจ `neon:check` ปลอดภัยผ่าน pooler:** ทุกคำสั่งเขียนอยู่ใน transaction ที่ ROLLBACK เสมอ และใช้ `BEGIN READ WRITE` แทน `SET` ระดับ session
   (ค่า session ที่ตั้งทิ้งไว้ผ่าน PgBouncer อาจค้างไปถึงผู้ใช้คนอื่น)

## 5. สิ่งที่ยังไม่ได้ทำหรือยังไม่ได้พิสูจน์

- **ไม่ได้ deploy ขึ้น Vercel** ดังนั้นยังไม่ได้ตรวจบน Vercel จริง: region `sin1` ทำงานหรือไม่, `proxy.ts` เห็น URL ดิบหรือไม่ (ถ้าไม่ ช่องหลบ cache ยังเปิดบน production),
  `s-maxage` ทำให้ cache HIT หรือไม่, ค่า latency ไป Neon ชุดคำสั่งตรวจอยู่ใน [deploy.md](deploy.md) ข้อ 3
- ไม่ได้ตั้ง rate limit (Vercel Firewall), ไม่ได้ใช้ `attachDatabasePool` ของ `@vercel/functions` (ต้องเพิ่ม dependency ที่ prompt ไม่ได้ขอ)
- ไม่ได้ตรวจโควตาจริงของ Neon แผนฟรี (ชั่วโมงประมวลผล, จำนวน connection) — บันทึกเหตุผลของการจำกัด URL ไว้แล้ว แต่ไม่ได้อ้างตัวเลขโควตาที่ไม่ได้ตรวจ
- กฎซ่อน <3 ราย ยังถูกอ้อมได้ด้วยการลบผลหลายคำขอ (801 ช่อง-ปีที่ res9) เมื่อเปิดสาธารณะ ช่องนี้เข้าถึงได้ทุกคน การจำกัดเหลือ 210 URL ไม่ได้ปิดมัน ดู [privacy.md](privacy.md)
- ไม่ได้ commit/push อะไรไปที่ remote

## 6. ไฟล์ที่สร้างหรือแก้

**สร้างใหม่:** `src/lib/neon.ts`, `src/scripts/sync-neon.ts`, `src/scripts/check-neon.ts`, `src/scripts/run-web-with-neon.ts`, `web/proxy.ts`, `web/lib/api-guard.ts`, `web/vercel.json`,
`docs/deploy.md`, `docs/deploy-report.md`, `tests/neon.test.ts`, `tests/api-guard.test.ts`, `tests/deploy-config.test.ts`

**แก้:** `package.json` (ลบ `workspaces`, เพิ่ม `neon:sync`/`neon:check`/`web:neon`), `.gitignore`, `.env.example`, `README.md`, `web/package.json` (typecheck), `web/next.config.ts`,
`web/lib/h3-api.ts` (`canonicalQuery`, `parseH3Request`, `handleH3` รับ query ดิบ), `web/lib/years-api.ts`, `web/lib/h3-client.ts`, `web/lib/dataset-facts.ts` (เพิ่ม `LOCATED_DEATHS_COMPLETE_YEARS`,
`H3_TABLE_COLUMNS`), `web/app/api/h3/route.ts`, `web/app/api/years/route.ts`, `web/README.md`, `docs/decisions-web.md`, `src/scripts/check-db-security.ts`, `src/scripts/measure-suppression.ts`,
`tests/h3-api.test.ts`, `tests/years-api.test.ts`, `tests/h3-client.test.ts`, `tests/web-db-config.test.ts`

**ไม่ได้แตะ:** `evals/questions.jsonl`, `evals/crosscheck.py`, `src/grading.ts`, `src/sql-guard.ts`, `db/*.sql`, `.env`/`web/.env*` (ยกเว้นบรรทัดที่ `neon:sync` ต่อท้ายให้), container อื่นนอกจาก `roaddeaths-db`,
ฐานข้อมูลในเครื่อง (ไม่มี `db:reset`)
