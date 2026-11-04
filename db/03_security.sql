-- ชั้นที่ 1 ของการป้องกัน: สิทธิ์ในฐานข้อมูล
--
-- ชั้นนี้คือชั้นหลัก เพราะมันบังคับใช้โดย Postgres เอง ต่อให้ตัวตรวจ SQL ในโค้ด
-- มีบั๊กหรือถูกข้ามไปทั้งชั้น คำสั่งที่เป็นอันตรายก็ยังรันไม่ได้อยู่ดี
--
-- รหัสผ่านไม่ได้อยู่ในไฟล์นี้ — สคริปต์ migrate จะส่งเข้ามาทาง current_setting()
-- เพื่อไม่ให้ความลับหลุดเข้า git

DO $$
DECLARE
    ai_password text := current_setting('app.ai_password', true);
BEGIN
    IF ai_password IS NULL OR ai_password = '' THEN
        RAISE EXCEPTION 'ไม่ได้ส่งรหัสผ่านของ ai_reader เข้ามา (ตั้ง AI_DB_PASSWORD ใน .env)';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_reader') THEN
        EXECUTE format('CREATE ROLE ai_reader LOGIN PASSWORD %L', ai_password);
    ELSE
        -- รันซ้ำได้: ตั้งรหัสผ่านใหม่ตามค่าที่ส่งมาเสมอ
        EXECUTE format('ALTER ROLE ai_reader PASSWORD %L', ai_password);
    END IF;
END
$$;

-- ── ข้อจำกัดที่ติดมากับ role เอง ────────────────────────────────────────────
-- ตั้งที่ระดับ role แทนที่จะตั้งตอนเปิด connection เพราะถ้าตั้งในโค้ดแล้วโค้ดลืมตั้ง
-- ข้อจำกัดก็หายไปเงียบ ๆ ตั้งที่ role แปลว่าทุก session ของ role นี้ได้ค่านี้เสมอ
-- ไม่ว่าใครจะเปิด connection ด้วยวิธีไหน

-- ทุก transaction เป็น read-only: INSERT / UPDATE / DELETE / DDL ถูกปฏิเสธโดย Postgres
ALTER ROLE ai_reader SET default_transaction_read_only = on;

-- คำสั่งที่รันเกิน 5 วินาทีถูกยกเลิก กัน query ที่กินทรัพยากรและ pg_sleep ยาว ๆ
ALTER ROLE ai_reader SET statement_timeout = '5s';

-- กัน transaction ที่เปิดค้างแล้วถือ resource ไว้
ALTER ROLE ai_reader SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE ai_reader SET lock_timeout = '2s';

-- เห็นแค่ schema app เขียน `FROM deaths` เฉย ๆ ได้ และไม่เผลอไปโดนตารางใน public
ALTER ROLE ai_reader SET search_path = app;

-- ── สิทธิ์: ให้เท่าที่จำเป็น ────────────────────────────────────────────────
-- เริ่มจากไม่ให้อะไรเลย แล้วค่อยให้ทีละอย่าง

REVOKE ALL ON SCHEMA public FROM ai_reader;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM ai_reader;

GRANT USAGE ON SCHEMA app TO ai_reader;

-- สิทธิ์เดียวที่ได้: อ่าน view เท่านั้น
GRANT SELECT ON app.deaths TO ai_reader;

-- ไม่มีบรรทัด GRANT สำหรับ app.deaths_raw โดยตั้งใจ
--
-- view ใน Postgres รันด้วยสิทธิ์ของเจ้าของ view ไม่ใช่สิทธิ์ของคนเรียก
-- (security_invoker ปิดอยู่เป็นค่าเริ่มต้น) ai_reader จึงอ่านข้อมูลผ่าน view ได้
-- ทั้งที่ไม่มีสิทธิ์แตะตารางดิบเลย ลอง `SELECT * FROM deaths_raw` จะโดนปฏิเสธ

-- ตารางที่สร้างใหม่ในอนาคตจะไม่ถูกเปิดให้ ai_reader โดยอัตโนมัติ
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON TABLES FROM ai_reader;

-- ── hardening เพิ่มเติม (ถ้าทำได้) ─────────────────────────────────────────
-- pg_sleep เปิดให้ทุกคนเรียกได้ตามค่าเริ่มต้นของ Postgres ถึงจะมี statement_timeout
-- คุมไว้แล้ว การถอนสิทธิ์ออกก็ตัดช่องทางนี้ทิ้งไปเลย
-- บนบริการที่จัดการให้ (เช่น Neon) อาจไม่มีสิทธิ์ทำ จึงไม่ให้ migration ล้มถ้าทำไม่ได้
DO $$
BEGIN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION pg_catalog.pg_sleep(double precision) FROM PUBLIC';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION pg_catalog.pg_sleep_for(interval) FROM PUBLIC';
EXCEPTION WHEN insufficient_privilege OR undefined_function THEN
    RAISE NOTICE 'ข้ามการถอนสิทธิ์ pg_sleep (ไม่มีสิทธิ์) — statement_timeout ยังคุมอยู่';
END
$$;
