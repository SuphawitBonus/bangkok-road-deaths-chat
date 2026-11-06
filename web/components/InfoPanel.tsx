"use client";

import { useEffect, useState } from "react";

import { K_MIN, type H3Body, type H3Resolution } from "@/lib/h3-api";
import { LOCATED_DEATHS, LOCATED_PERCENT, SOURCE_URL, TOTAL_DEATHS, TOTAL_DEATHS_BY_YEAR } from "@/lib/dataset-facts";
import { COLOR_RAMP, type VisibleCell, type YearInsight } from "@/lib/h3-client";
import type { YearTotal } from "@/lib/years-api";
import { DATA_YEAR_MAX_COMPLETE, DATA_YEAR_MIN, toBuddhistYear } from "@/lib/years";

import YearChart from "./YearChart";

export interface YearRange {
  from: number;
  to: number;
}

/** ช่องที่ผู้ใช้คลิก: มีตัวเลข / ถูกซ่อน (<3) / ไม่มีผู้เสียชีวิตเลยในช่วงปีนี้ */
export type SelectedCell =
  | { h3: string; kind: "count"; count: number; rank: number; ranked: number; share: number }
  | { h3: string; kind: "hidden" }
  | { h3: string; kind: "none" };

interface Props {
  years: YearRange;
  onYears: (next: YearRange) => void;
  status: "loading" | "ready" | "error";
  error?: string;
  onRetry: () => void;
  body: H3Body | null;
  /** ความละเอียดที่ผู้ใช้กำลังดูตามระดับซูม (อาจต่างจาก body ชั่วขณะที่กำลังโหลดชุดใหม่) */
  resolution: H3Resolution;
  maxCount: number;
  mapError?: string;
  yearTotals: YearTotal[] | null;
  yearsError?: string;
  insight: YearInsight | null;
  playing: boolean;
  onTogglePlay: () => void;
  selected: SelectedCell | null;
  onClearSelected: () => void;
  top: VisibleCell[];
  onPickTop: (h3: string) => void;
  mode: "2d" | "3d";
  onMode: (mode: "2d" | "3d") => void;
}

const YEARS = Array.from({ length: DATA_YEAR_MAX_COMPLETE - DATA_YEAR_MIN + 1 }, (_, i) => DATA_YEAR_MIN + i);
const fmt = (n: number) => n.toLocaleString("th-TH");
const be = toBuddhistYear;

const CELL_AREA: Record<H3Resolution, string> = {
  8: "ช่องใหญ่ ราว 0.74 ตร.กม.",
  9: "ช่องละเอียด ราว 0.11 ตร.กม.",
};

function coveragePercent(body: H3Body): number {
  let total = 0;
  for (let y = body.year_from; y <= body.year_to; y++) total += TOTAL_DEATHS_BY_YEAR[y] ?? 0;
  return total > 0 ? Math.round((body.summary.total_deaths / total) * 100) : 0;
}

const periodLabel = (from: number, to: number) => (from === to ? `พ.ศ. ${be(from)}` : `พ.ศ. ${be(from)}–${be(to)}`);

function Legend({ maxCount }: { maxCount: number }) {
  const gradient = `linear-gradient(to right, ${COLOR_RAMP.map((c) => `rgb(${c[0]},${c[1]},${c[2]})`).join(", ")})`;
  return (
    <section aria-labelledby="legend-title" className="space-y-2">
      <h2 id="legend-title" className="text-sm font-semibold">
        สัญลักษณ์
      </h2>
      <p className="text-sm text-slate-600">สีและความสูงของแท่งบอกจำนวนผู้เสียชีวิตในช่องนั้น (ราย)</p>
      <div>
        <div className="h-3 w-full rounded" style={{ background: gradient }} aria-hidden="true" />
        <div className="mt-1 flex justify-between text-xs text-slate-600">
          <span>{K_MIN} ราย</span>
          <span>{maxCount > 0 ? `${fmt(maxCount)} ราย` : "—"}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <span
          className="inline-block h-4 w-4 shrink-0 rounded-sm border border-slate-600"
          style={{ background: "rgba(100,116,139,0.47)" }}
          aria-hidden="true"
        />
        <span>
          <strong>&lt;{K_MIN}</strong> ราย — ซ่อนตัวเลขเพื่อความเป็นส่วนตัว (แบนราบ สีเทา)
        </span>
      </div>
    </section>
  );
}

/** การ์ดช่องที่เลือก — อยู่ในส่วนที่เห็นตลอด (มือถือพับแผงไว้ก็ยังเห็นว่าคลิกโดนอะไร) */
function SelectedCard({ cell, body, onClear }: { cell: SelectedCell; body: H3Body; onClear: () => void }) {
  const period = periodLabel(body.year_from, body.year_to);
  return (
    <div className="mt-2 flex items-start gap-3 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <p className="text-xs text-slate-600">
          ช่องที่เลือก · {CELL_AREA[body.resolution]} · {period}
        </p>
        {cell.kind === "count" ? (
          <>
            <p>
              <strong className="text-base">{fmt(cell.count)} ราย</strong>{" "}
              <span className="text-slate-600">({(cell.share * 100).toFixed(1)}% ของที่แสดง)</span>
            </p>
            <p className="text-slate-700">
              อันดับ {fmt(cell.rank)} จาก {fmt(cell.ranked)} ช่องที่แสดงตัวเลข
            </p>
          </>
        ) : cell.kind === "hidden" ? (
          <p>
            <strong>&lt;{K_MIN} ราย</strong> — ซ่อนตัวเลขและไม่จัดอันดับ เพื่อไม่ให้ระบุผู้เสียชีวิตรายบุคคลได้
          </p>
        ) : (
          <p>ไม่มีผู้เสียชีวิตที่มีพิกัดในช่องนี้ในช่วงปีที่เลือก</p>
        )}
      </div>
      <button
        type="button"
        className="tap -my-1 shrink-0 rounded-lg px-2 text-slate-600 hover:bg-slate-200"
        onClick={onClear}
        aria-label="ยกเลิกการเลือกช่อง"
      >
        ✕
      </button>
    </div>
  );
}

function ViewControls({ mode, onMode }: { mode: "2d" | "3d"; onMode: (m: "2d" | "3d") => void }) {
  const [shared, setShared] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (shared === "idle") return;
    const t = setTimeout(() => setShared("idle"), 2500);
    return () => clearTimeout(t);
  }, [shared]);

  // URL ของหน้าเก็บช่วงปี ตำแหน่งกล้อง ช่องที่เลือก และ 2D/3D อยู่แล้ว (MapApp อัปเดตตลอด) แชร์ URL ก็พอ
  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: document.title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setShared("copied");
    } catch (err) {
      // ผู้ใช้กดยกเลิกหน้าต่างแชร์ ไม่ใช่ความผิดพลาด
      if (err instanceof DOMException && err.name === "AbortError") return;
      setShared("failed");
    }
  };

  const seg = (m: "2d" | "3d", label: string) => (
    <button
      type="button"
      aria-pressed={mode === m}
      onClick={() => onMode(m)}
      className={`tap flex-1 px-3 text-sm font-medium ${mode === m ? "bg-slate-900 text-white" : "bg-white text-slate-800"}`}
    >
      {label}
    </button>
  );

  return (
    <section aria-labelledby="view-title" className="space-y-2">
      <h2 id="view-title" className="text-sm font-semibold">
        มุมมอง
      </h2>
      <div className="flex gap-2">
        <div className="flex flex-1 overflow-hidden rounded-lg border border-slate-300" role="group" aria-label="มุมมองแผนที่">
          {seg("2d", "2 มิติ")}
          {seg("3d", "3 มิติ")}
        </div>
        <button type="button" className="tap shrink-0 rounded-lg border border-slate-300 px-3 text-sm font-medium" onClick={share}>
          แชร์มุมมองนี้
        </button>
      </div>
      <p className="text-xs text-slate-600" aria-live="polite">
        {shared === "copied"
          ? "คัดลอกลิงก์แล้ว — เปิดลิงก์นี้จะเห็นช่วงปี ตำแหน่ง และช่องที่เลือกเหมือนตอนนี้"
          : shared === "failed"
            ? "คัดลอกไม่สำเร็จ คัดลอกจากแถบที่อยู่ของเบราว์เซอร์แทนได้"
            : "2 มิติอ่านสีเทียบกันง่ายกว่า เพราะไม่มีแท่งบังกัน"}
      </p>
    </section>
  );
}

function TopCells({ top, onPick, period }: { top: VisibleCell[]; onPick: (h3: string) => void; period: string }) {
  if (top.length === 0) return null;
  return (
    <details className="group rounded-lg border border-slate-200">
      <summary className="tap flex cursor-pointer items-center justify-between px-3 text-sm font-semibold">
        {top.length} ช่องที่มีผู้เสียชีวิตมากที่สุด
        <span className="text-slate-500 group-open:rotate-180" aria-hidden="true">
          ▾
        </span>
      </summary>
      <ol className="space-y-1 px-2 pb-2">
        {top.map((c, i) => (
          <li key={c.h3_index}>
            <button
              type="button"
              className="tap flex w-full items-center gap-3 rounded-md px-2 text-left text-sm hover:bg-slate-100"
              onClick={() => onPick(c.h3_index)}
            >
              <span className="w-6 shrink-0 text-slate-500">#{i + 1}</span>
              <span className="flex-1">{fmt(c.count)} ราย</span>
              <span className="text-xs text-slate-500">บินไปดู →</span>
            </button>
          </li>
        ))}
      </ol>
      <p className="px-3 pb-2 text-xs text-slate-600">
        {period} · นับเฉพาะช่องที่แสดงตัวเลข ช่องใหญ่มีจำนวนมากกว่าช่องเล็กโดยธรรมชาติ อย่าเทียบอันดับข้ามความละเอียด
      </p>
    </details>
  );
}

/** "ก่อนใช้ข้อมูลนี้" เป็นคำถาม–คำตอบ ให้ผู้อ่านหาคำตอบที่ต้องการได้เร็ว (เดิมเป็นรายการหัวข้อยาว) */
function BeforeYouUse({ body }: { body: H3Body | null }) {
  const s = body?.summary;
  const qa: [string, React.ReactNode][] = [
    [
      "ข้อมูลนี้ช่วยตอบอะไร",
      "บริเวณไหนของกรุงเทพฯ มีผู้เสียชีวิตจากอุบัติเหตุทางถนนสะสมมาก และยอดทั้งเมืองเปลี่ยนไปอย่างไรในแต่ละปี",
    ],
    [
      "ดูได้ละเอียดแค่ไหน",
      <>
        ช่องหกเหลี่ยมราว 0.74 ตร.กม. (ซูมออก) หรือ 0.11 ตร.กม. (ซูมเข้า) และรายปี ไม่มีรายเดือนหรือรายบุคคล ช่องที่มีน้อยกว่า{" "}
        {K_MIN} รายถูกซ่อนตัวเลข
        {s ? (
          <>
            {" "}
            — มุมมองนี้มี <strong>{fmt(s.suppressed_cells)} ช่อง รวม {fmt(s.suppressed_deaths)} ราย</strong> (
            {s.total_deaths > 0 ? Math.round((s.suppressed_deaths / s.total_deaths) * 100) : 0}% ของที่แสดง) อยู่ในช่องที่ซ่อน
          </>
        ) : null}
      </>,
    ],
    [
      "ข้อมูลมาจากไหน",
      <>
        กรมควบคุมโรค ผ่าน{" "}
        <a className="underline" href={SOURCE_URL} target="_blank" rel="noreferrer">
          data.go.th
        </a>{" "}
        — มีพิกัดจุดเกิดเหตุเพียง{" "}
        <strong>
          {fmt(LOCATED_DEATHS)} จาก {fmt(TOTAL_DEATHS)} ราย ({LOCATED_PERCENT}%)
        </strong>{" "}
        อีก {100 - LOCATED_PERCENT}% ไม่อยู่บนแผนที่ และอาจไม่กระจายเท่ากันทุกพื้นที่
      </>,
    ],
    [
      "ครอบคลุมช่วงไหน",
      <>
        นับตาม<strong>วันที่เสียชีวิต</strong> (ไม่ใช่วันเกิดเหตุ) พ.ศ. {be(DATA_YEAR_MIN)}–{be(DATA_YEAR_MAX_COMPLETE)}{" "}
        ปี 2568–2569 ยังทยอยเข้า จึงไม่นับ
      </>,
    ],
    [
      "ไม่ใช่อะไร",
      "จำนวนรายไม่ใช่อัตราความเสี่ยง (ไม่ได้หารด้วยปริมาณรถหรือประชากร) ย่านที่รถผ่านมากย่อมมีตัวเลขสูง และตำแหน่งบนแผนที่ไม่ได้บอกสาเหตุของอุบัติเหตุ ตึก 3 มิติจาก OpenStreetMap ในชานเมืองยังไม่ครบ",
    ],
  ];
  return (
    <section aria-labelledby="limits-title" className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
      <h2 id="limits-title" className="text-sm font-semibold text-amber-950">
        ก่อนใช้ข้อมูลนี้
      </h2>
      <dl className="space-y-2 text-sm text-amber-950">
        {qa.map(([q, a]) => (
          <div key={q}>
            <dt className="font-semibold">{q}</dt>
            <dd>{a}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default function InfoPanel(props: Props) {
  const { years, onYears, status, error, onRetry, body, resolution, maxCount, mapError } = props;
  // มือถือเริ่มแบบพับ (เห็นแผนที่เต็ม) จอใหญ่แสดงเต็มเสมอ ตัวสลับนี้ซ่อนเฉพาะบนจอเล็ก
  const [open, setOpen] = useState(false);
  const isDefaultRange = years.from === DATA_YEAR_MIN && years.to === DATA_YEAR_MAX_COMPLETE;

  const setFrom = (from: number) => onYears({ from, to: Math.max(from, years.to) });
  const setTo = (to: number) => onYears({ from: Math.min(years.from, to), to });

  return (
    <aside
      className="absolute inset-x-0 bottom-0 z-10 flex max-h-[62dvh] flex-col rounded-t-2xl bg-white/95 shadow-2xl backdrop-blur md:inset-x-auto md:bottom-auto md:left-4 md:top-4 md:max-h-[calc(100dvh-2rem)] md:w-[24rem] md:rounded-2xl"
      aria-label="ข้อมูลและตัวกรอง"
    >
      <header className="flex items-start justify-between gap-3 px-4 pb-2 pt-3">
        <div className="min-w-0">
          <h1 className="text-lg font-bold leading-snug">กรุงเทพฯ 3 มิติ</h1>
          <p className="text-sm text-slate-600">ผู้เสียชีวิตจากอุบัติเหตุทางถนน ย้อนดู 14 ปี</p>
        </div>
        <button
          type="button"
          className="tap shrink-0 rounded-lg border border-slate-300 px-3 text-sm font-medium md:hidden"
          aria-expanded={open}
          aria-controls="panel-body"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "ซ่อน" : "ข้อมูล"}
        </button>
      </header>

      {/* สรุปบรรทัดเดียวที่เห็นตลอดแม้พับแผงบนมือถือ — ข้อจำกัดสำคัญที่สุดต้องไม่ถูกซ่อน */}
      <div className="px-4 pb-2" aria-live="polite">
        {status === "error" || mapError ? (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-900">
            {mapError ?? error}{" "}
            {!mapError && (
              <button type="button" className="font-semibold underline" onClick={onRetry}>
                ลองอีกครั้ง
              </button>
            )}
          </p>
        ) : (
          <p className="text-sm">
            {body ? (
              <>
                แสดง <strong>{fmt(body.summary.total_deaths)} ราย</strong> ที่มีพิกัด · {periodLabel(body.year_from, body.year_to)}
                {status === "loading" ? " · กำลังโหลด…" : ""}
                {/* สัดส่วนของช่วงที่แสดงอยู่ ไม่ใช่ 62% ของทั้งชุด: ปีละไม่เท่ากัน (2567 เหลือ 42%) */}
                <span className="text-slate-600">
                  {" "}
                  · เป็นเพียง {coveragePercent(body)}% ของผู้เสียชีวิตทั้งหมดในช่วงนี้
                </span>
              </>
            ) : (
              <>
                กำลังโหลดข้อมูล…<span className="text-slate-600"> · มีพิกัดเพียง {LOCATED_PERCENT}% ของทั้งหมด</span>
              </>
            )}
          </p>
        )}
        {props.selected && body && status !== "error" ? (
          <SelectedCard cell={props.selected} body={body} onClear={props.onClearSelected} />
        ) : null}
      </div>

      <div
        id="panel-body"
        className={`${open ? "block" : "hidden"} min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-3 md:block`}
      >
        <section aria-labelledby="timeline-title" className="space-y-2">
          <h2 id="timeline-title" className="text-sm font-semibold">
            ผู้เสียชีวิตรายปี (ทั้งกรุงเทพฯ)
          </h2>
          <YearChart
            years={props.yearTotals}
            from={years.from}
            to={years.to}
            insight={props.insight}
            playing={props.playing}
            onPickYear={(y) => onYears({ from: y, to: y })}
            onTogglePlay={props.onTogglePlay}
            error={props.yearsError}
          />
          {props.playing ? (
            <p className="text-xs text-slate-600">
              ปีเดียวช่องส่วนใหญ่มีไม่ถึง {K_MIN} ราย แผนที่จึงเป็นสีเทามากกว่าตอนดูทุกปี
            </p>
          ) : null}
        </section>

        <section aria-labelledby="filter-title" className="space-y-2">
          <h2 id="filter-title" className="text-sm font-semibold">
            ช่วงปี (พ.ศ.)
          </h2>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <label className="sr-only" htmlFor="year-from">
              ตั้งแต่ปี
            </label>
            <select
              id="year-from"
              className="tap min-w-0 rounded-lg border border-slate-300 bg-white px-2"
              value={years.from}
              onChange={(e) => setFrom(Number(e.target.value))}
            >
              {YEARS.map((y) => (
                <option key={y} value={y}>
                  {be(y)}
                </option>
              ))}
            </select>
            <span aria-hidden="true">–</span>
            <label className="sr-only" htmlFor="year-to">
              ถึงปี
            </label>
            <select
              id="year-to"
              className="tap min-w-0 rounded-lg border border-slate-300 bg-white px-2"
              value={years.to}
              onChange={(e) => setTo(Number(e.target.value))}
            >
              {YEARS.map((y) => (
                <option key={y} value={y}>
                  {be(y)}
                </option>
              ))}
            </select>
          </div>
          <p className="text-sm text-slate-600">ความละเอียดตอนนี้: {CELL_AREA[resolution]} (ซูมเข้า/ออกเพื่อเปลี่ยน)</p>
          {!isDefaultRange && (
            <button
              type="button"
              className="tap rounded-lg border border-slate-300 px-3 text-sm"
              onClick={() => onYears({ from: DATA_YEAR_MIN, to: DATA_YEAR_MAX_COMPLETE })}
            >
              ดูทุกปีที่ข้อมูลครบ (พ.ศ. {be(DATA_YEAR_MIN)}–{be(DATA_YEAR_MAX_COMPLETE)})
            </button>
          )}
        </section>

        <ViewControls mode={props.mode} onMode={props.onMode} />

        {/* ตัวอธิบายสีสั้นและต้องใช้อ่านแผนที่ทันที จึงอยู่ก่อนรายการอันดับและข้อจำกัด */}
        <Legend maxCount={maxCount} />
        <TopCells
          top={props.top}
          onPick={props.onPickTop}
          period={body ? periodLabel(body.year_from, body.year_to) : ""}
        />
        <BeforeYouUse body={body} />
      </div>

      {/* เงื่อนไขการอ้างอิงต้องเห็นได้เสมอ ไม่ซ่อนตอนพับแผง */}
      <footer className="border-t border-slate-200 px-4 py-2 text-xs leading-relaxed text-slate-600">
        ข้อมูล:{" "}
        <a className="underline" href={SOURCE_URL} target="_blank" rel="noreferrer">
          กรมควบคุมโรค (data.go.th)
        </a>
        <br />
        แผนที่:{" "}
        <a className="underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          © OpenStreetMap contributors
        </a>{" "}
        ·{" "}
        <a className="underline" href="https://openfreemap.org" target="_blank" rel="noreferrer">
          OpenFreeMap
        </a>{" "}
        ·{" "}
        <a className="underline" href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">
          © OpenMapTiles
        </a>
      </footer>
    </aside>
  );
}
