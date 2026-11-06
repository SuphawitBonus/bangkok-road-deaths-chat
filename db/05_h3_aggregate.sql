-- ตาราง app.h3_deaths_monthly: ข้อมูลรวมจำนวนผู้เสียชีวิตรายเดือนตาม H3 hexagon (res 8 และ res 9)
-- ใช้สำหรับแสดงผลบนแผนที่ 3D ในเว็บ และให้ web_reader อ่านได้โดยปลอดภัย ไม่เปิดเผยพิกัดรายบุคคล

CREATE TABLE IF NOT EXISTS app.h3_deaths_monthly (
    h3_res8   text NOT NULL,   -- ดัชนี H3 resolution 8
    h3_res9   text NOT NULL,   -- ดัชนี H3 resolution 9
    died_year integer NOT NULL,
    died_month integer NOT NULL,
    is_complete_year boolean NOT NULL,
    death_count integer NOT NULL,
    -- lat/lng ของ centroid ของ h3 cell เก็บไว้สำหรับ deck.gl ไม่ต้องคำนวณซ้ำ
    -- (คำนวณตอน load ด้วย h3-js cellToLatLng)
    centroid_lat double precision NOT NULL,
    centroid_lng double precision NOT NULL
);

CREATE INDEX IF NOT EXISTS h3_deaths_monthly_res8_idx ON app.h3_deaths_monthly (h3_res8);
CREATE INDEX IF NOT EXISTS h3_deaths_monthly_res9_idx ON app.h3_deaths_monthly (h3_res9);
CREATE INDEX IF NOT EXISTS h3_deaths_monthly_year_idx ON app.h3_deaths_monthly (died_year);
CREATE INDEX IF NOT EXISTS h3_deaths_monthly_complete_idx ON app.h3_deaths_monthly (is_complete_year);

-- ให้สิทธิ์ web_reader ถ้ามี role นี้แล้ว
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'web_reader') THEN
        EXECUTE 'GRANT SELECT ON app.h3_deaths_monthly TO web_reader';
    END IF;
END
$$;
