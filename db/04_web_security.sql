-- ชั้นการป้องกันสำหรับ web_reader: สิทธิ์ในฐานข้อมูล
--
-- role web_reader มีไว้สำหรับเว็บ API ที่ต้องการแสดงผลภาพรวมระดับ H3 hexagon เท่านั้น
-- ห้ามเข้าถึงข้อมูลรายคน (app.deaths และ app.deaths_raw) เด็ดขาด เพื่อป้องกัน linkage attack
--
-- รหัสผ่านส่งมาจาก migrate.ts ผ่าน session variable app.web_password

DO $$
DECLARE
    web_password text := current_setting('app.web_password', true);
BEGIN
    IF web_password IS NULL OR web_password = '' THEN
        RAISE NOTICE 'ข้ามการสร้าง web_reader (ไม่ได้ส่ง app.web_password เข้ามา)';
        RETURN;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'web_reader') THEN
        EXECUTE format('CREATE ROLE web_reader LOGIN PASSWORD %L', web_password);
    ELSE
        EXECUTE format('ALTER ROLE web_reader PASSWORD %L', web_password);
    END IF;
END
$$;

-- ── ข้อจำกัดที่ติดมากับ role เอง ────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'web_reader') THEN
        RETURN;
    END IF;

    -- ทุก transaction เป็น read-only: INSERT / UPDATE / DELETE / DDL ถูกปฏิเสธ
    EXECUTE 'ALTER ROLE web_reader SET default_transaction_read_only = on';

    -- คำสั่งที่รันเกิน 5 วินาทีถูกยกเลิก
    EXECUTE 'ALTER ROLE web_reader SET statement_timeout = ''5s''';

    -- กัน transaction ที่เปิดค้าง
    EXECUTE 'ALTER ROLE web_reader SET idle_in_transaction_session_timeout = ''10s''';
    EXECUTE 'ALTER ROLE web_reader SET lock_timeout = ''2s''';

    -- search_path ชี้ไปที่ app
    EXECUTE 'ALTER ROLE web_reader SET search_path = app';

    -- ── สิทธิ์: ให้เฉพาะตารางรวม H3 ──────────────────────────────────────────
    EXECUTE 'REVOKE ALL ON SCHEMA public FROM web_reader';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA app FROM web_reader';

    EXECUTE 'GRANT USAGE ON SCHEMA app TO web_reader';

    -- ให้สิทธิ์เฉพาะตาราง h3_deaths_monthly (ถ้าสร้างแล้ว)
    -- ห้ามให้สิทธิ์บน app.deaths หรือ app.deaths_raw เด็ดขาด!
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'app' AND tablename = 'h3_deaths_monthly') THEN
        EXECUTE 'GRANT SELECT ON app.h3_deaths_monthly TO web_reader';
    END IF;

    -- ตารางใหม่ในอนาคตจะไม่เปิดให้ web_reader โดยอัตโนมัติ
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON TABLES FROM web_reader';
END
$$;
