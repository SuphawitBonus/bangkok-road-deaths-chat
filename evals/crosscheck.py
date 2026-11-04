"""ตรวจเฉลยของชุดทดสอบด้วยวิธีที่สอง — Python อ่าน CSV ดิบ ไม่ผ่าน SQL เลย

evals:verify ยืนยันว่า gold_sql ให้ผลตรงกับเฉลย แต่ถ้าเฉลยมาจากการรัน gold_sql
ตั้งแต่แรก การตรวจนั้นวนกลับมาที่ตัวเอง ไฟล์นี้จึงทำความสะอาดข้อมูลตามกฎเดียวกับ
db/02_view.sql แต่เขียนใหม่ทั้งหมดใน Python แล้วคำนวณคำตอบแต่ละข้ออิสระจาก SQL
ถ้าสองทางได้เลขไม่ตรงกัน แปลว่ามีฝั่งหนึ่งผิด — ไม่ว่าจะเป็นกฎใน view, gold_sql หรือเฉลย

ใช้แค่ไลบรารีมาตรฐาน ไม่ต้องติดตั้งอะไรเพิ่ม

    python evals/crosscheck.py          เทียบกับ evals/questions.jsonl
    python evals/crosscheck.py --json   พิมพ์คำตอบที่คำนวณได้ทั้งหมดเป็น JSON
"""
from __future__ import annotations

import csv
import json
import re
import statistics
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, localcontext
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / 'data' / 'bangkok-road-deaths.csv'
QUESTIONS_PATH = ROOT / 'evals' / 'questions.jsonl'

MOTORCYCLE = 'รถจักรยานยนต์'
PEDESTRIAN = 'คนเดินเท้า'
BICYCLE = 'รถจักรยาน'
MALE, FEMALE, SEX_UNKNOWN = 'ชาย', 'หญิง', 'ไม่ระบุ'
VEHICLE_UNKNOWN = 'ไม่ระบุพาหนะ'
INCOMPLETE_YEARS = {2568, 2569}


@dataclass(frozen=True)
class Death:
    year_be: int
    is_complete_year: bool
    died_on: date
    record_hour: int | None
    age: int | None
    sex: str | None
    vehicle: str | None
    residence_district: str | None
    crash_district: str | None
    has_location: bool
    has_record_time: bool

    @property
    def sex_known(self) -> bool:
        return self.sex != SEX_UNKNOWN

    @property
    def vehicle_known(self) -> bool:
        return self.vehicle != VEHICLE_UNKNOWN


def _text(v: str | None) -> str | None:
    t = (v or '').strip()
    return t or None


def _num(v: str | None) -> float | None:
    t = _text(v)
    try:
        return float(t) if t is not None else None
    except ValueError:
        return None


def _clean(r: dict[str, str]) -> Death:
    age = _num(r['age'])
    age_i = int(age) if age is not None else None

    lat, lng = _num(r['lat']), _num(r['lng'])
    if lat is not None and lng is not None and lat > 90 and lng < 90:
        lat, lng = lng, lat
    has_location = (
        lat is not None and lng is not None
        and 13.4 <= lat <= 14.0 and 100.2 <= lng <= 100.95
    )

    m = re.search(r'(\d{2}):\d{2}:\d{2}', r['rec_time'] or '')

    crash = _text(r['acc_district'])
    if crash is not None and not crash.startswith('เขต'):
        crash = 'เขต' + crash

    year_be = int(r['year_th'])
    return Death(
        year_be=year_be,
        is_complete_year=year_be not in INCOMPLETE_YEARS,
        died_on=date.fromisoformat(r['dead_date'][:10]),
        record_hour=int(m.group(1)) if m else None,
        age=age_i if age_i is not None and 0 <= age_i <= 110 else None,
        sex=_text(r['sex']),
        vehicle=_text(r['vehicle']),
        residence_district=_text(r['home_district']),
        crash_district=crash,
        has_location=has_location,
        has_record_time=m is not None,
    )


def load() -> list[Death]:
    with CSV_PATH.open(encoding='utf-8-sig', newline='') as f:
        return [_clean(r) for r in csv.DictReader(f)]


def rnd(numerator: float | int, denominator: float | int, places: int) -> float:
    """ปัดแบบ half away from zero ให้ตรงกับ round() ของ numeric ใน Postgres"""
    with localcontext() as ctx:
        ctx.prec = 40
        q = Decimal(numerator) / Decimal(denominator)
        return float(q.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP))


def pct(rows: list[Death], hit) -> dict[str, float | int]:
    """สัดส่วนเป็นร้อยละ 2 ตำแหน่ง พร้อมตัวหาร — รูปแบบเดียวกับ gold_sql ทุกข้อประเภท ratio"""
    n = len(rows)
    return {'pct': rnd(100 * sum(1 for d in rows if hit(d)), n, 2), 'n': n}


def counts_by(rows: list[Death], key) -> list[tuple[object, int]]:
    c = Counter(key(d) for d in rows)
    return sorted(c.items())


def top(rows: list[Death], key, k: int, label: str) -> list[dict[str, object]]:
    c = Counter(key(d) for d in rows)
    ranked = sorted(c.items(), key=lambda kv: (-kv[1], str(kv[0])))
    return [{label: v, 'n': n} for v, n in ranked[:k]]


def _between_8pm_5am(d: Death) -> bool:
    return d.record_hour is not None and (d.record_hour >= 20 or d.record_hour < 5)


def answers(D: list[Death]) -> dict[str, list[dict[str, object]]]:
    complete = [d for d in D if d.is_complete_year]
    vk = [d for d in D if d.vehicle_known]
    aged = [d for d in D if d.age is not None]

    def n(pred) -> list[dict[str, object]]:
        return [{'n': sum(1 for d in D if pred(d))}]

    def per_year(rows: list[Death], value) -> list[dict[str, object]]:
        out = []
        for y in sorted({d.year_be for d in rows}):
            out.append({'year_be': y, **value([d for d in rows if d.year_be == y])})
        return out

    before = [d for d in D if 2554 <= d.year_be <= 2562]
    covid = [d for d in D if 2563 <= d.year_be <= 2565]

    return {
        # count
        'q001': n(lambda d: d.year_be == 2567),
        'q004': [{'n': len(D)}],
        'q005': n(lambda d: d.died_on.year == 2023 and d.sex == FEMALE),
        'q006': n(lambda d: d.year_be == 2565 and d.vehicle == PEDESTRIAN),
        'q007': n(lambda d: d.age is not None and 15 <= d.age <= 24),
        'q008': n(lambda d: not d.vehicle_known),
        'q009': n(lambda d: d.died_on.year == 2019 and d.died_on.month == 12),
        'q010': n(lambda d: d.age is not None and d.age >= 60),
        'q011': n(lambda d: d.has_location),
        'q012': n(lambda d: d.vehicle == BICYCLE),
        'q013': n(lambda d: date(2023, 4, 11) <= d.died_on <= date(2023, 4, 17)),
        'q014': n(_between_8pm_5am),
        # ratio
        'q002': [pct(vk, lambda d: d.vehicle == MOTORCYCLE)],
        'q015': [pct([d for d in D if d.sex_known], lambda d: d.sex == MALE)],
        'q016': [pct(aged, lambda d: d.age < 25)],
        'q017': [pct(vk, lambda d: d.vehicle == PEDESTRIAN)],
        'q018': [pct(D, lambda d: d.died_on.isoweekday() in (6, 7))],
        'q019': [pct(D, lambda d: d.has_record_time)],
        'q020': [pct([d for d in vk if d.sex == FEMALE], lambda d: d.vehicle == MOTORCYCLE)],
        'q021': [pct([d for d in vk if d.year_be == 2567], lambda d: d.vehicle == MOTORCYCLE)],
        'q022': [pct([d for d in D if d.record_hour is not None], _between_8pm_5am)],
        'q023': [pct(aged, lambda d: d.age >= 60)],
        'q024': [pct(D, lambda d: not d.vehicle_known)],
        'q025': [pct([d for d in D if d.vehicle == PEDESTRIAN and d.sex_known], lambda d: d.sex == FEMALE)],
        # trend
        'q026': per_year(complete, lambda rs: {'n': len(rs)}),
        'q027': [{'died_year': y, 'n': c} for y, c in counts_by(
            [d for d in D if 2019 <= d.died_on.year <= 2021], lambda d: d.died_on.year)],
        'q028': [
            {'period': 'before', 'avg_per_year': rnd(len(before), len({d.year_be for d in before}), 1)},
            {'period': 'covid', 'avg_per_year': rnd(len(covid), len({d.year_be for d in covid}), 1)},
        ],
        'q029': [{'avg_per_year': rnd(len(complete), len({d.year_be for d in complete}), 1),
                  'years': len({d.year_be for d in complete})}],
        'q030': [{'died_month': m, 'n': c} for m, c in counts_by(complete, lambda d: d.died_on.month)],
        'q031': per_year(complete, lambda rs: {
            'pct_known': rnd(100 * sum(1 for d in rs if d.vehicle_known), len(rs), 2)}),
        'q032': per_year([d for d in complete if d.age is not None],
                         lambda rs: {'median_age': float(statistics.median(d.age for d in rs))}),
        'q033': [{'year_be': y, 'n': c} for y, c in counts_by(
            [d for d in D if d.vehicle == MOTORCYCLE and d.year_be in (2556, 2566)], lambda d: d.year_be)],
        # top-n
        'q034': top(complete, lambda d: d.year_be, 1, 'year_be'),
        'q035': top([d for d in D if d.crash_district], lambda d: d.crash_district, 5, 'crash_district'),
        'q036': top(vk, lambda d: d.vehicle, 3, 'vehicle'),
        'q037': top(complete, lambda d: d.died_on.month, 1, 'died_month'),
        'q038': top([d for d in D if d.record_hour is not None], lambda d: d.record_hour, 1, 'record_hour'),
        'q039': top([d for d in D if d.residence_district], lambda d: d.residence_district, 3, 'residence_district'),
        'q040': top(D, lambda d: d.died_on.isoweekday(), 1, 'died_isodow'),
        'q041': [{'year_be': y, 'n': c} for y, c in sorted(
            Counter(d.year_be for d in complete).items(), key=lambda kv: (kv[1], kv[0]))[:1]],
    }


def _same(a: object, b: object, tol: float) -> bool:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(float(a) - float(b)) <= tol
    return a == b


def main() -> int:
    sys.stdout.reconfigure(encoding='utf-8')
    computed = answers(load())
    if '--json' in sys.argv:
        print(json.dumps(computed, ensure_ascii=False, indent=1))
        return 0

    failures = 0
    for line in QUESTIONS_PATH.read_text(encoding='utf-8').splitlines():
        if not line.strip() or line.lstrip().startswith('//'):
            continue
        q = json.loads(line)
        if q['type'] == 'unanswerable':
            print(f"  --   {q['id']}  unanswerable  (พิสูจน์ด้วย proof_sql ใน evals:verify)")
            continue
        got = computed.get(q['id'])
        want = q['expected']['rows']
        tol = q.get('tolerance', 0)
        if got is None:
            failures += 1
            print(f"  FAIL {q['id']}  ไม่มีการคำนวณฝั่ง Python สำหรับข้อนี้")
            continue
        ok = len(got) == len(want) and all(
            set(g) == set(w) and all(_same(g[k], w[k], tol) for k in w) for g, w in zip(got, want))
        if not ok:
            failures += 1
            print(f"  FAIL {q['id']}  Python ได้ {got} แต่เฉลยคือ {want}")
        else:
            print(f"  ok   {q['id']}  {q['type']}")
    print(f"\nไม่ตรงกัน {failures} ข้อ" if failures else '\nPython กับเฉลยตรงกันทุกข้อ')
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
