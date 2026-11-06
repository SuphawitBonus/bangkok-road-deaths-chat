"use client";

// แผนที่ฐาน (MapLibre GL + OpenFreeMap) พร้อมชั้นหกเหลี่ยม H3 ของ deck.gl วาดซ้อนใน WebGL context เดียวกัน
// (interleaved) เพื่อให้แท่งหกเหลี่ยมกับตึก 3 มิติของแผนที่ฐานบังกันถูกต้องตามความลึก
import type { PickingInfo } from "@deck.gl/core";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { AttributionControl, Map as MapLibreMap, NavigationControl } from "maplibre-gl";
import { useEffect, useRef } from "react";

import type { H3Resolution } from "@/lib/h3-api";
import { colorFor, MAX_BAR_HEIGHT_M, type HiddenCell, type VisibleCell } from "@/lib/h3-client";
import type { CameraView } from "@/lib/view-state";

import { INITIAL_VIEW, BASE_STYLE } from "./mapConfig";

/** คำสั่งให้กล้องบินไปที่จุดหนึ่ง — seq เพิ่มทุกครั้ง เพื่อให้กดซ้ำที่เดิมแล้วบินซ้ำได้ */
export interface FlyRequest {
  seq: number;
  longitude: number;
  latitude: number;
  zoom: number;
}

interface Props {
  visible: VisibleCell[];
  hidden: HiddenCell[];
  resolution: H3Resolution;
  maxCount: number;
  initialCamera: CameraView | null;
  mode: "2d" | "3d";
  selected: string | null;
  fly: FlyRequest | null;
  onCellClick: (h3: string | null) => void;
  onMoveEnd: (camera: CameraView) => void;
  onFatal: (message: string) => void;
}

/** มุมกล้องเมื่อสลับกลับเป็น 3 มิติ (ถ้าผู้ใช้ไม่ได้เอียงเอง) */
const PITCH_3D = INITIAL_VIEW.pitch;

function getTooltip({ object }: PickingInfo) {
  if (!object) return null;
  const count = (object as { count?: number }).count;
  return {
    text:
      typeof count === "number"
        ? `${count.toLocaleString("th-TH")} ราย · คลิกดูรายละเอียด`
        : "<3 ราย (ซ่อนตัวเลขเพื่อความเป็นส่วนตัว)",
    style: {
      backgroundColor: "rgba(15,23,42,0.92)",
      color: "#fff",
      fontSize: "14px",
      padding: "6px 10px",
      borderRadius: "6px",
    },
  };
}

function cameraOf(map: MapLibreMap): CameraView {
  const c = map.getCenter();
  return { latitude: c.lat, longitude: c.lng, zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
}

export default function MapCanvas({
  visible,
  hidden,
  resolution,
  maxCount,
  initialCamera,
  mode,
  selected,
  fly,
  onCellClick,
  onMoveEnd,
  onFatal,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const callbacks = useRef({ onCellClick, onMoveEnd, onFatal });
  // ค่าเริ่มต้นใช้ครั้งเดียวตอนสร้างแผนที่ เก็บใน ref เพื่อไม่ให้ effect สร้างแผนที่ใหม่เมื่อค่าเปลี่ยน
  const initial = useRef({ camera: initialCamera, mode });

  useEffect(() => {
    callbacks.current = { onCellClick, onMoveEnd, onFatal };
  });

  // สร้างแผนที่ครั้งเดียว (ลำดับ effect: อันนี้มาก่อนอันที่วางชั้นข้อมูล จึงมี overlay พร้อมเสมอ)
  useEffect(() => {
    const el = container.current;
    if (!el) return;

    const cam = initial.current.camera;
    const flat = initial.current.mode === "2d";
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container: el,
        style: BASE_STYLE,
        center: cam ? [cam.longitude, cam.latitude] : INITIAL_VIEW.center,
        zoom: cam?.zoom ?? INITIAL_VIEW.zoom,
        pitch: flat ? 0 : (cam?.pitch ?? INITIAL_VIEW.pitch),
        bearing: cam?.bearing ?? INITIAL_VIEW.bearing,
        minZoom: 8,
        maxPitch: flat ? 0 : 75,
        // ใช้ตัวควบคุมของเราเองด้านล่าง เพื่อกำหนดตำแหน่ง/แบบย่อเอง
        attributionControl: false,
      });
    } catch {
      callbacks.current.onFatal("เบราว์เซอร์นี้แสดงแผนที่ 3 มิติไม่ได้ (ต้องรองรับ WebGL)");
      return;
    }
    mapRef.current = map;

    // เว้นที่ให้แผงข้อมูลที่ลอยทับอยู่ (ซ้ายบนจอใหญ่ ล่างบนมือถือ) จุดกึ่งกลางแผนที่จะอยู่กลางพื้นที่ที่มองเห็น
    // ไม่ใช่กลางจอเต็ม ตัวเมืองจึงไม่ไปซ่อนอยู่หลังแผง ตัวเลขตรงกับความกว้างแผง (24rem) และความสูงแผงที่พับ
    map.setPadding(
      window.matchMedia("(min-width: 768px)").matches
        ? { left: 400, top: 0, right: 0, bottom: 0 }
        : { left: 0, top: 0, right: 0, bottom: 190 },
    );

    map.addControl(new NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new AttributionControl({ compact: true }), "bottom-right");

    // คลิกช่อง = เลือก คลิกที่ว่าง = ยกเลิก (deck.gl เรียก onClick ทั้งสองกรณี object ว่างเมื่อไม่โดนอะไร)
    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      getTooltip,
      onClick: (info) => {
        const obj = info.object as { h3_index?: string } | undefined;
        callbacks.current.onCellClick(obj?.h3_index ?? null);
      },
    });
    map.addControl(overlay);
    overlayRef.current = overlay;

    map.on("moveend", () => callbacks.current.onMoveEnd(cameraOf(map)));

    // แผนที่ฐานโหลดไม่ขึ้นภายใน 20 วินาที (เน็ตหลุด / OpenFreeMap ล่ม) แจ้งผู้ใช้ แทนที่จะปล่อยให้เห็นจอว่าง
    let loaded = false;
    const timer = setTimeout(() => {
      if (!loaded) callbacks.current.onFatal("โหลดแผนที่พื้นหลังไม่สำเร็จ ตรวจสอบการเชื่อมต่อแล้วลองโหลดหน้าใหม่");
    }, 20_000);
    map.once("load", () => {
      loaded = true;
      clearTimeout(timer);
      callbacks.current.onMoveEnd(cameraOf(map));
    });

    return () => {
      clearTimeout(timer);
      overlayRef.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, []);

  // 2 มิติ: ล็อกกล้องให้มองตรงลง (เอียงไม่ได้) แท่งแบนราบ อ่านสีเทียบกันได้ไม่มีแท่งบังกัน
  // 3 มิติ: ปลดล็อก และเอียงกล้องกลับให้ ถ้าตอนนี้มองตรงลงอยู่
  const modeApplied = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // รอบแรกตอนสร้างแผนที่ ค่าเริ่มต้นตั้งไว้ถูกแล้ว (รวมมุมเอียงจากลิงก์ที่แชร์มา) ไม่ต้องขยับกล้อง
    if (!modeApplied.current) {
      modeApplied.current = true;
      return;
    }
    if (mode === "2d") {
      map.easeTo({ pitch: 0, duration: 600 });
      map.once("moveend", () => map.setMaxPitch(0));
    } else {
      map.setMaxPitch(75);
      if (map.getPitch() < 5) map.easeTo({ pitch: PITCH_3D, duration: 600 });
    }
  }, [mode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fly) return;
    map.flyTo({ center: [fly.longitude, fly.latitude], zoom: fly.zoom, duration: 1400, essential: true });
  }, [fly]);

  // วางชั้นข้อมูลใหม่ทุกครั้งที่ข้อมูลเปลี่ยน
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const extruded = mode === "3d";

    // ใส่ resolution ใน id: ข้อมูลคนละความละเอียดต้องสร้างชั้นใหม่ ไม่ใช้ buffer เดิมร่วมกัน
    const bars = new H3HexagonLayer<VisibleCell>({
      id: `h3-visible-${resolution}`,
      data: visible,
      getHexagon: (d) => d.h3_index,
      extruded,
      getFillColor: (d) => colorFor(d.count, maxCount),
      getElevation: (d) => d.count,
      // ความสูงเป็นสัดส่วนตรงกับจำนวน (ต่างจากสีที่ใช้รากที่สอง) แท่งสูงสุดสูง MAX_BAR_HEIGHT_M เมตร
      elevationScale: maxCount > 0 ? MAX_BAR_HEIGHT_M[resolution] / maxCount : 0,
      coverage: 0.9,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 110],
      material: { ambient: 0.65, diffuse: 0.6, shininess: 24, specularColor: [70, 70, 70] },
      updateTriggers: { getFillColor: [maxCount] },
    });

    // ช่องที่ถูกซ่อน (<3 ราย): แบนราบ สีเทา ไม่มีความสูง เพราะความสูงคือจำนวน และจำนวนจริงถูกซ่อนไว้
    const suppressed = new H3HexagonLayer<HiddenCell>({
      id: `h3-hidden-${resolution}`,
      data: hidden,
      getHexagon: (d) => d.h3_index,
      extruded: false,
      filled: true,
      stroked: true,
      getFillColor: [100, 116, 139, 120],
      getLineColor: [51, 65, 85, 210],
      lineWidthMinPixels: 1,
      coverage: 0.9,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 90],
    });

    // กรอบของช่องที่เลือก วาดเต็มขนาดช่อง (coverage 1) ที่พื้น จึงเห็นเป็นขอบรอบฐานแท่ง (แท่งกว้าง 0.9)
    const outline = new H3HexagonLayer<{ h3_index: string }>({
      id: "h3-selected",
      data: selected ? [{ h3_index: selected }] : [],
      getHexagon: (d) => d.h3_index,
      extruded: false,
      filled: false,
      stroked: true,
      getLineColor: [15, 23, 42, 255],
      lineWidthMinPixels: 3,
      coverage: 1,
      pickable: false,
    });

    overlay.setProps({ layers: [suppressed, bars, outline] });
  }, [visible, hidden, resolution, maxCount, mode, selected]);

  // ครอบสองชั้นโดยตั้งใจ: CSS ของ maplibre-gl ตั้ง .maplibregl-map { position: relative } แบบไม่อยู่ใน @layer
  // ซึ่งชนะ utility `absolute` ของ Tailwind v4 (อยู่ใน layer) ถ้าใส่ absolute inset-0 ที่ตัว container ตรง ๆ
  // มันจะกลายเป็น relative สูง 0px แล้วแผนที่ไม่ขึ้นเลย (เจอจริง วัดได้ 1280x0) ชั้นนอกจึงเป็นตัวกำหนดขนาด
  return (
    <div className="absolute inset-0">
      <div
        ref={container}
        className="h-full w-full"
        role="application"
        aria-label="แผนที่แสดงจำนวนผู้เสียชีวิตจากอุบัติเหตุทางถนนในกรุงเทพมหานครแยกเป็นช่องหกเหลี่ยม คลิกช่องเพื่อดูรายละเอียด"
      />
    </div>
  );
}
