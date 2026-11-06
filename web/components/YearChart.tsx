"use client";

// ไทม์ไลน์รายปี: แท่งละหนึ่งปี กดแท่ง = ดูปีนั้นปีเดียวบนแผนที่ ปุ่มเล่น = ไล่ดูทีละปี
//
// แท่งเต็ม = ผู้เสียชีวิตทั้งหมดปีนั้น (ค่าคงที่ที่ db:check ตรวจกับฐานข้อมูล) ส่วนทึบ = ที่มีพิกัด (/api/years)
// ต้องวาดสองส่วนคู่กัน เพราะสัดส่วนที่มีพิกัดไม่เท่ากันทุกปี (2554 และ 2567 ราว 40% ปีอื่น 63–73%)
// วาดแค่ส่วนที่มีพิกัดจะดูเหมือนปี 2567 ผู้เสียชีวิตลดลงครึ่งหนึ่ง ซึ่งไม่จริง
//
// ตัวเลขเป็นยอดทั้งกรุงเทพฯ ไม่ใช่ของช่องที่เลือก — เหตุผลที่ไม่ทำกราฟรายช่องอยู่ใน docs/decisions-web.md
// (ยอดรายปีของช่องเดียวส่วนใหญ่คือ 1–2 ราย ซึ่งเป็นตัวเลขที่ซ่อนอยู่)
import { TOTAL_DEATHS_BY_YEAR } from "@/lib/dataset-facts";
import type { YearInsight } from "@/lib/h3-client";
import type { YearTotal } from "@/lib/years-api";
import { toBuddhistYear } from "@/lib/years";

interface Props {
  years: YearTotal[] | null;
  from: number;
  to: number;
  insight: YearInsight | null;
  playing: boolean;
  onPickYear: (year: number) => void;
  onTogglePlay: () => void;
  error?: string;
}

const fmt = (n: number) => Math.round(n).toLocaleString("th-TH");
const pct = (x: number) => `${Math.round(x * 100)}%`;
const be = toBuddhistYear;

function InsightLine({ insight, from, to }: { insight: YearInsight; from: number; to: number }) {
  const diff = insight.diffPercent;
  const vs = diff === 0 ? "เท่าค่าเฉลี่ย" : `${diff > 0 ? "มากกว่า" : "น้อยกว่า"}ค่าเฉลี่ยทุกปี ${Math.abs(diff)}%`;
  const low = insight.lowCoverageYears;
  return (
    <div className="space-y-1 text-sm">
      {from === to ? (
        <p>
          <strong>
            พ.ศ. {be(from)}: เสียชีวิต {fmt(insight.total)} ราย
          </strong>{" "}
          — {vs} (ปีละ {fmt(insight.overallPerYear)})
        </p>
      ) : (
        <p>
          <strong>
            พ.ศ. {be(from)}–{be(to)}: เฉลี่ยปีละ {fmt(insight.perYear)} ราย
          </strong>
          {insight.peak && insight.low ? (
            <>
              {" "}
              · มากสุด {be(insight.peak.year)} ({fmt(insight.peak.deaths)}) · น้อยสุด {be(insight.low.year)} (
              {fmt(insight.low.deaths)})
            </>
          ) : null}
        </p>
      )}
      <p className="text-slate-700">
        อยู่บนแผนที่ (มีพิกัด) {fmt(insight.located)} ราย = {pct(insight.coverage)}
      </p>
      {low.length > 0 ? (
        <p className="rounded-md bg-amber-50 px-2 py-1 text-amber-950">
          <span aria-hidden="true">⚠ </span>
          {low.length === 1 && from === to ? "ปีนี้" : `พ.ศ. ${low.map(be).join(", ")} `}มีพิกัดไม่ถึงครึ่ง
          (ปีอื่นราว 2 ใน 3) แผนที่จึงดูเบากว่าความจริง อย่าใช้เทียบกับปีอื่น
        </p>
      ) : null}
    </div>
  );
}

export default function YearChart({ years, from, to, insight, playing, onPickYear, onTogglePlay, error }: Props) {
  if (error) {
    return <p className="text-sm text-slate-600">{error}</p>;
  }
  if (!years) {
    return <div className="h-24 animate-pulse rounded-lg bg-slate-100" aria-hidden="true" />;
  }
  const max = Math.max(1, ...years.map((y) => TOTAL_DEATHS_BY_YEAR[y.year] ?? 0));

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="tap flex shrink-0 items-center justify-center rounded-full border border-slate-300 px-3 text-sm font-medium"
          onClick={onTogglePlay}
          aria-pressed={playing}
        >
          <span aria-hidden="true" className="mr-1">
            {playing ? "❚❚" : "▶"}
          </span>
          {playing ? "หยุด" : "เล่นทีละปี"}
        </button>
        <span className="text-xs text-slate-600">กดแท่งเพื่อดูปีนั้นบนแผนที่</span>
      </div>

      <div className="flex h-24 items-end gap-[3px]" role="group" aria-label="จำนวนผู้เสียชีวิตรายปี">
        {years.map((y) => {
          const total = TOTAL_DEATHS_BY_YEAR[y.year] ?? 0;
          const located = "deaths" in y ? y.deaths : 0;
          const inRange = y.year >= from && y.year <= to;
          const label =
            `พ.ศ. ${be(y.year)}: เสียชีวิต ${fmt(total)} ราย มีพิกัด ` +
            ("deaths" in y ? `${fmt(located)} ราย (${pct(total ? located / total : 0)})` : "น้อยกว่า 3 ราย");
          return (
            <button
              key={y.year}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={from === to && from === y.year}
              onClick={() => onPickYear(y.year)}
              // ทั้งคอลัมน์เป็นปุ่ม (สูง 96px) ไม่ใช่แค่ตัวแท่ง ปีที่มีน้อยก็ยังกดง่าย
              className="group flex h-full min-w-0 flex-1 flex-col justify-end"
            >
              <span
                className={`flex w-full flex-col justify-end overflow-hidden rounded-t-sm ${
                  inRange ? "bg-[#f3c2cc]" : "bg-slate-200 group-hover:bg-slate-300"
                }`}
                style={{ height: `${Math.max(4, (total / max) * 100)}%` }}
              >
                <span
                  className={`block w-full ${inRange ? "bg-[var(--accent)]" : "bg-slate-400 group-hover:bg-slate-500"}`}
                  style={{ height: `${total ? (located / total) * 100 : 0}%` }}
                />
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex gap-[3px] text-center text-[10px] leading-none text-slate-600" aria-hidden="true">
        {years.map((y) => (
          // แสดงแค่สองหลักท้ายของ พ.ศ. ให้ 14 ปีพอดีความกว้างจอ 375px ตัวเต็มอยู่ใน aria-label ของแท่ง
          <span
            key={y.year}
            className={`min-w-0 flex-1 ${y.year >= from && y.year <= to ? "font-semibold text-slate-900" : ""}`}
          >
            {String(be(y.year)).slice(2)}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600" aria-hidden="true">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[var(--accent)]" /> มีพิกัด (อยู่บนแผนที่)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#f3c2cc]" /> ไม่มีพิกัด
        </span>
      </div>

      {insight ? <InsightLine insight={insight} from={from} to={to} /> : null}
    </div>
  );
}
