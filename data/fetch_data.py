"""ดึงข้อมูลผู้เสียชีวิตจากอุบัติเหตุทางถนนในกรุงเทพฯ จาก data.go.th มาเก็บเป็น CSV

แหล่งข้อมูล: ระบบบูรณาการข้อมูลการตายจากอุบัติเหตุทางถนน (3 ฐาน) กรมควบคุมโรค
เผยแพร่ผ่าน data.go.th (CKAN) แยกไฟล์ตามปี พ.ศ.

    python analysis/fetch_data.py

ต้องรันจากเครือข่ายที่ data.go.th ตอบ (ทดสอบแล้วว่าจากในไทยได้ปกติ แต่จาก
IP ของ AWS ถูกปฏิเสธภายในเสี้ยววินาที) ผลลัพธ์ถูก commit ไว้ใน repo แล้ว
notebook จึงรันได้โดยไม่ต้องต่อเน็ต
"""

import csv
import json
import ssl
import sys
import urllib.parse
import urllib.request
from pathlib import Path

CKAN = "https://data.go.th/api/3/action"
PACKAGE_ID = "rtddi"
PROVINCE = "กรุงเทพมหานคร"
OUT = Path(__file__).parent / "data" / "bangkok-road-deaths.csv"

# ชื่อคอลัมน์จังหวัดต่างกันในแต่ละปี จึงต้องไล่ลอง
PROVINCE_COLUMNS = ["Dead_Prov", "จ.ที่เสียชีวิต"]

# ใช้เมื่อ package_show ล่ม (เกิดบ่อย)
KNOWN_RESOURCES = {
    2568: "98c51d89-816b-4ce3-8b7f-648d5723e093",
    2569: "580c0ba5-bc98-46fc-bb8d-961b1bde8f76",
}

UA = "Mozilla/5.0 (compatible; NextTraffic/1.0; +http://localhost)"


def get_json(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as res:
        return json.load(res)


def resource_ids():
    """คืน {ปี พ.ศ.: resource_id} จาก CKAN ถ้าเรียกไม่ได้ใช้ค่าที่รู้ล่วงหน้า"""
    try:
        pkg = get_json(f"{CKAN}/package_show?id={PACKAGE_ID}")
        found = {}
        for r in pkg["result"]["resources"]:
            name = r.get("name") or ""
            year = "".join(ch for ch in name[-4:] if ch.isdigit())
            if len(year) == 4 and year.startswith("25") and r.get("datastore_active"):
                found[int(year)] = r["id"]
        if found:
            return found
    except Exception as err:  # noqa: BLE001 — ปลายทางล่มบ่อย ไม่ควรทำให้สคริปต์ตาย
        print(f"  (package_show ใช้ไม่ได้: {err} — ใช้ resource id ที่รู้ล่วงหน้าแทน)")
    return KNOWN_RESOURCES


def fetch_year(resource_id, limit=32000):
    """ดึงเฉพาะแถวที่เสียชีวิตในกรุงเทพฯ ของ resource หนึ่งปี"""
    last_error = None
    for column in PROVINCE_COLUMNS:
        filters = urllib.parse.quote(json.dumps({column: PROVINCE}, ensure_ascii=False))
        url = f"{CKAN}/datastore_search?resource_id={resource_id}&limit={limit}&filters={filters}"
        try:
            return get_json(url)["result"]["records"]
        except Exception as err:  # noqa: BLE001
            last_error = err
    raise RuntimeError(f"ดึงข้อมูลไม่สำเร็จ: {last_error}")


# ชื่อคอลัมน์ในไฟล์ CSV ที่เราคุมเอง -> ชื่อที่เป็นไปได้ในข้อมูลต้นทาง
COLUMNS = {
    "year_th": ["DEAD_YEAR_TH"],
    "dead_date": ["DeadDate_EN", "Dead Date Final", "Dead Date"],
    "age": ["Age"],
    "sex": ["Sex"],
    "nationality": ["Nationality"],
    "home_district": ["District"],
    "acc_district": ["Acc_District", "acc_district_name"],
    "acc_subdistrict": ["Acc_Sub_Dist"],
    "vehicle": ["Vehicle", "Vehicle Merge Final"],
    "helmet": ["RiskHelmet"],
    "seatbelt": ["RiskSafetyBelt"],
    "icd10": ["ICD_10"],
    "lat": ["Acc_Lat", "Acc La"],
    "lng": ["Acc_long", "Acclong"],
    "rec_date": ["Date Rec"],
    "rec_time": ["Time Rec"],
}


def pick(row, names):
    for name in names:
        value = row.get(name)
        if value not in (None, ""):
            return value
    return ""


def main():
    print("กำลังหา resource id ของแต่ละปี…")
    ids = resource_ids()
    years = sorted(ids, reverse=True)
    print(f"  เจอปี: {', '.join(str(y) for y in years)}")

    rows = []
    for year in years:
        print(f"ดึงข้อมูลปี {year}…", end=" ", flush=True)
        try:
            records = fetch_year(ids[year])
        except Exception as err:  # noqa: BLE001
            print(f"ไม่สำเร็จ ({err})")
            continue
        print(f"{len(records)} แถว")
        for rec in records:
            row = {key: pick(rec, names) for key, names in COLUMNS.items()}
            row["year_th"] = row["year_th"] or year
            rows.append(row)

    if not rows:
        print("\nไม่ได้ข้อมูลเลย — ถ้าอยู่นอกไทยหรือบนคลาวด์ data.go.th มักปฏิเสธคำขอ")
        sys.exit(1)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    # utf-8-sig เพื่อให้ Excel บน Windows เปิดภาษาไทยได้ถูกต้อง
    with OUT.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(COLUMNS))
        writer.writeheader()
        writer.writerows(rows)

    print(f"\nเขียนไฟล์แล้ว: {OUT.relative_to(Path(__file__).parent.parent)} ({len(rows)} แถว)")


if __name__ == "__main__":
    main()
