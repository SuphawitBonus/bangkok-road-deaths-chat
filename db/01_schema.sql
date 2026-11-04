-- ตารางดิบ: เก็บสิ่งที่ data.go.th ให้มาตามจริง แปลงแค่ชนิดข้อมูล ไม่แก้ค่าใด ๆ
--
-- เหตุผลที่แยกตารางดิบกับ view ออกจากกัน:
--   1. กฎทำความสะอาดอยู่ใน SQL ของ view ที่เดียว อ่านตรวจสอบได้ ไม่ซ่อนอยู่ในสคริปต์โหลด
--   2. โหลดใหม่ได้ตลอดโดยไม่ต้องกลัวว่าจะทำความสะอาดคนละแบบกับรอบก่อน
--   3. AI ได้สิทธิ์อ่านเฉพาะ view เท่านั้น จึงไม่มีทางเห็นค่าดิบที่ยังผิดอยู่

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.deaths_raw (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- ปีของไฟล์ต้นทาง เป็น พ.ศ. (ต้นทางแยกไฟล์ตามปี)
    year_be            integer     NOT NULL,

    -- วันที่เสียชีวิต (ค.ศ.) ไม่ใช่วันที่เกิดเหตุ
    died_on            date        NOT NULL,

    age                integer,
    sex                text,
    nationality        text,

    -- เขตที่พักอาศัยของผู้เสียชีวิต คนละเรื่องกับเขตที่เกิดเหตุ
    residence_district text,
    -- เขตที่เกิดเหตุ ต้นทางกรอกไว้น้อยมาก
    crash_district     text,
    crash_subdistrict  text,

    vehicle            text,

    -- สองคอลัมน์นี้ว่างทั้ง 12,146 แถว เก็บไว้ในตารางดิบเพื่อความซื่อตรงต่อต้นทาง
    -- แต่ไม่ส่งต่อเข้า view เพราะไม่มีข้อมูลให้ใช้
    helmet             text,
    seatbelt           text,

    icd10_code         text,

    -- พิกัดดิบ ยังไม่แก้ที่กรอกสลับคอลัมน์ ดู 02_view.sql
    latitude           numeric,
    longitude          numeric,

    -- วันที่บันทึก ต้นทางปนกันหลายรูปแบบและบางส่วนเป็น พ.ศ. จึงเก็บเป็น text
    -- และไม่ส่งต่อเข้า view
    record_date_raw    text,
    -- เวลาที่บันทึก ต้นทางเก็บเป็น timestamp ปลอมปี 1900 เอาเฉพาะส่วนเวลามา
    record_time        time
);

COMMENT ON TABLE app.deaths_raw IS
    'ข้อมูลดิบจาก data.go.th ชุด RTDDI เฉพาะผู้ที่เสียชีวิตในกรุงเทพฯ '
    'แปลงชนิดข้อมูลแล้วแต่ยังไม่ได้ทำความสะอาด ห้ามให้ role ของ AI อ่านตารางนี้';

CREATE INDEX IF NOT EXISTS deaths_raw_died_on_idx ON app.deaths_raw (died_on);
CREATE INDEX IF NOT EXISTS deaths_raw_year_be_idx ON app.deaths_raw (year_be);
CREATE INDEX IF NOT EXISTS deaths_raw_vehicle_idx ON app.deaths_raw (vehicle);
