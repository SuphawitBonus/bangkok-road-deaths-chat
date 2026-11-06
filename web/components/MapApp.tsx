"use client";

import { cellToLatLng, getResolution } from "h3-js";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TOTAL_DEATHS_BY_YEAR } from "@/lib/dataset-facts";
import type { H3Body } from "@/lib/h3-api";
import {
  describeError,
  fetchH3,
  fetchYears,
  rankCells,
  resolutionForZoom,
  splitCells,
  yearInsight,
  ZOOM_SWITCH,
} from "@/lib/h3-client";
import { DEFAULT_VIEW_STATE, parseViewState, serializeViewState, type CameraView } from "@/lib/view-state";
import type { YearsBody } from "@/lib/years-api";
import { DATA_YEAR_MAX_COMPLETE, DATA_YEAR_MIN } from "@/lib/years";

import InfoPanel, { type SelectedCell, type YearRange } from "./InfoPanel";
import type { FlyRequest } from "./MapCanvas";
import { INITIAL_VIEW } from "./mapConfig";

// maplibre-gl ต้องใช้ window/WebGL จึงโหลดเฉพาะฝั่งเบราว์เซอร์
const MapCanvas = dynamic(() => import("./MapCanvas"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-slate-200" aria-hidden="true" />,
});

type State =
  | { status: "loading"; body: H3Body | null }
  | { status: "ready"; body: H3Body }
  | { status: "error"; body: null; error: string };

/** เวลาที่ค้างแต่ละปีตอนกดเล่น (นับหลังข้อมูลปีนั้นขึ้นแผนที่แล้ว ไม่ใช่นับจากตอนเริ่มโหลด) */
const PLAY_STEP_MS = 1600;

/** ซูมที่ใช้ตอนบินไปหาช่อง: ช่อง res8 ต้องอยู่ต่ำกว่าจุดสลับ ไม่อย่างนั้นไปถึงแล้วกลายเป็น res9 ช่องที่เลือกหายไป */
const FLY_ZOOM = { 8: ZOOM_SWITCH - 0.8, 9: 14.2 } as const;

export default function MapApp() {
  // อ่าน URL หลัง hydrate เท่านั้น (ฝั่ง server ไม่รู้ query string) — ก่อนอ่านเสร็จไม่ยิง API และไม่สร้างแผนที่
  // เพื่อไม่ให้โหลดมุมมองเริ่มต้นทิ้งไปหนึ่งรอบแล้วกระโดดไปมุมมองในลิงก์
  const [ready, setReady] = useState(false);
  const [years, setYears] = useState<YearRange>({ from: DEFAULT_VIEW_STATE.yearFrom, to: DEFAULT_VIEW_STATE.yearTo });
  const [camera, setCamera] = useState<CameraView | null>(null);
  const initialCamera = useRef<CameraView | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"2d" | "3d">("3d");
  const [fly, setFly] = useState<FlyRequest | null>(null);
  const [playing, setPlaying] = useState(false);

  const [state, setState] = useState<State>({ status: "loading", body: null });
  const [yearsBody, setYearsBody] = useState<YearsBody | null>(null);
  const [yearsError, setYearsError] = useState<string | undefined>();
  const [mapError, setMapError] = useState<string | undefined>();
  const [attempt, setAttempt] = useState(0);
  const cache = useRef(new Map<string, H3Body>());

  useEffect(() => {
    const v = parseViewState(window.location.search);
    setYears({ from: v.yearFrom, to: v.yearTo });
    initialCamera.current = v.camera;
    setCamera(v.camera);
    setSelected(v.cell);
    setMode(v.mode);
    setReady(true);
  }, []);

  const zoom = camera?.zoom ?? INITIAL_VIEW.zoom;
  const resolution = resolutionForZoom(zoom);

  useEffect(() => {
    if (!ready) return;
    const key = `${resolution}|${years.from}|${years.to}`;
    const hit = cache.current.get(key);
    if (hit) {
      setState({ status: "ready", body: hit });
      return;
    }

    const ac = new AbortController();
    // ระหว่างโหลดชุดใหม่ ยังแสดงชุดเดิมไว้ก่อน (ป้ายบอกว่ากำลังโหลด) แผนที่จะไม่กระพริบว่าง
    setState((s) => ({ status: "loading", body: s.body }));

    fetchH3(resolution, years.from, years.to, ac.signal)
      .then((body) => {
        cache.current.set(key, body);
        setState({ status: "ready", body });
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        // ล้มเหลวแล้วต้องล้างแผนที่ ไม่เก็บข้อมูลเดิมไว้: ข้อมูลของช่วงปีเก่าที่ติดป้ายช่วงปีใหม่คือข้อมูลที่ผิด
        setPlaying(false);
        setState({ status: "error", body: null, error: describeError(err) });
      });

    return () => ac.abort();
  }, [ready, resolution, years, attempt]);

  // ไทม์ไลน์รายปีไม่ขึ้นกับตัวกรอง โหลดครั้งเดียว (และโหลดใหม่เมื่อกด "ลองอีกครั้ง")
  useEffect(() => {
    const ac = new AbortController();
    setYearsError(undefined);
    fetchYears(ac.signal)
      .then(setYearsBody)
      .catch((err: unknown) => {
        if (!ac.signal.aborted) setYearsError(`ไทม์ไลน์รายปี: ${describeError(err)}`);
      });
    return () => ac.abort();
  }, [attempt]);

  // เล่นทีละปี: เลื่อนไปปีถัดไปหลังปีปัจจุบันขึ้นแผนที่ครบแล้วเท่านั้น เน็ตช้าก็ไม่ข้ามปี
  useEffect(() => {
    if (!playing || state.status !== "ready") return;
    const t = setTimeout(() => {
      if (years.to >= DATA_YEAR_MAX_COMPLETE) {
        setPlaying(false);
        return;
      }
      const next = years.from === years.to ? years.from + 1 : DATA_YEAR_MIN;
      setYears({ from: next, to: next });
    }, PLAY_STEP_MS);
    return () => clearTimeout(t);
  }, [playing, state.status, years]);

  // เก็บมุมมองไว้ใน URL (แทนที่ ไม่เพิ่มประวัติ ปุ่มย้อนกลับของเบราว์เซอร์จึงไม่ต้องกดหลายสิบครั้ง)
  useEffect(() => {
    if (!ready) return;
    // กล้องที่ยังอยู่มุมเริ่มต้น (ยังไม่ได้ขยับ) ไม่ใส่ใน URL ลิงก์ของหน้าแรกจึงยังเป็น "/" เปล่า
    const atDefault =
      camera !== null &&
      Math.abs(camera.longitude - INITIAL_VIEW.center[0]) < 1e-5 &&
      Math.abs(camera.latitude - INITIAL_VIEW.center[1]) < 1e-5 &&
      Math.abs(camera.zoom - INITIAL_VIEW.zoom) < 1e-3 &&
      Math.abs(camera.bearing - INITIAL_VIEW.bearing) < 0.5 &&
      (Math.abs(camera.pitch - INITIAL_VIEW.pitch) < 0.5 || (mode === "2d" && camera.pitch < 0.5));
    const q = serializeViewState({
      yearFrom: years.from,
      yearTo: years.to,
      camera: atDefault ? null : camera,
      cell: selected,
      mode,
    });
    window.history.replaceState(null, "", `${window.location.pathname}${q}`);
  }, [ready, years, camera, selected, mode]);

  const body = state.body;
  const view = useMemo(
    () => (body ? splitCells(body.cells) : { visible: [], hidden: [], maxCount: 0 }),
    [body],
  );
  const ranking = useMemo(() => rankCells(view.visible), [view.visible]);
  const insight = useMemo(
    () => (yearsBody ? yearInsight(yearsBody.years, TOTAL_DEATHS_BY_YEAR, years.from, years.to) : null),
    [yearsBody, years],
  );

  // ช่องที่เลือกไว้คนละความละเอียดกับที่แสดงอยู่ (ซูมข้ามจุดสลับ) ไม่แสดง แต่ยังจำไว้ ซูมกลับมาก็เห็นอีก
  const activeCell = selected && body && getResolution(selected) === body.resolution ? selected : null;
  const selectedInfo: SelectedCell | null = useMemo(() => {
    if (!activeCell || !body) return null;
    const cell = body.cells.find((c) => c.h3_index === activeCell);
    if (!cell) return { h3: activeCell, kind: "none" };
    if ("suppressed" in cell) return { h3: activeCell, kind: "hidden" };
    return {
      h3: activeCell,
      kind: "count",
      count: cell.count,
      rank: ranking.rankOf.get(activeCell) ?? 0,
      ranked: ranking.ordered.length,
      share: body.summary.total_deaths > 0 ? cell.count / body.summary.total_deaths : 0,
    };
  }, [activeCell, body, ranking]);

  const top = useMemo(() => ranking.ordered.slice(0, 10), [ranking]);

  const changeYears = useCallback((next: YearRange) => {
    setPlaying(false);
    setYears(next);
  }, []);

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    // เริ่มจากปีถัดจากปีที่ดูอยู่ (ถ้าดูปีเดียวและยังไม่ใช่ปีสุดท้าย) ไม่อย่างนั้นเริ่มจากปีแรก
    setYears((y) =>
      y.from === y.to && y.to < DATA_YEAR_MAX_COMPLETE
        ? { from: y.from + 1, to: y.from + 1 }
        : { from: DATA_YEAR_MIN, to: DATA_YEAR_MIN },
    );
    setPlaying(true);
  };

  const flyToCell = useCallback((h3: string) => {
    const [latitude, longitude] = cellToLatLng(h3);
    const res = getResolution(h3) === 9 ? 9 : 8;
    setSelected(h3);
    setFly((f) => ({ seq: (f?.seq ?? 0) + 1, latitude, longitude, zoom: FLY_ZOOM[res] }));
  }, []);

  return (
    <main className="relative h-dvh w-full overflow-hidden">
      {ready ? (
        <MapCanvas
          visible={view.visible}
          hidden={view.hidden}
          // ใช้ความละเอียดของข้อมูลที่กำลังแสดงจริง (ไม่ใช่ที่ซูมอยู่) เพราะความสูงแท่งคำนวณจากชุดข้อมูลนั้น
          resolution={body?.resolution ?? resolution}
          maxCount={view.maxCount}
          initialCamera={initialCamera.current}
          mode={mode}
          selected={activeCell}
          fly={fly}
          onCellClick={setSelected}
          onMoveEnd={setCamera}
          onFatal={setMapError}
        />
      ) : (
        <div className="absolute inset-0 bg-slate-200" aria-hidden="true" />
      )}
      <InfoPanel
        years={years}
        onYears={changeYears}
        status={state.status}
        error={state.status === "error" ? state.error : undefined}
        onRetry={() => setAttempt((n) => n + 1)}
        body={body}
        resolution={resolution}
        maxCount={view.maxCount}
        mapError={mapError}
        yearTotals={yearsBody?.years ?? null}
        yearsError={yearsError}
        insight={insight}
        playing={playing}
        onTogglePlay={togglePlay}
        selected={selectedInfo}
        onClearSelected={() => setSelected(null)}
        top={top}
        onPickTop={flyToCell}
        mode={mode}
        onMode={setMode}
      />
    </main>
  );
}
