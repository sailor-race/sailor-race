import { useEffect, useState, useMemo, useRef } from "react";
import { ISLAND_IMAGES, ISLAND_NAMES } from "./islandData.ts";
import { AdminPanelEmbed } from "./AdminPanelEmbed.tsx";
import { LOGO_B64 } from "../utils/logo.ts";
import * as wsClient from "../websocket/websocketClient.ts";

// ── Types ──────────────────────────────────────────────────────────────
type Position = { x: number; y: number };
type DisplayVersion = 1 | 2 | 3;
type TeamId = string;

interface Team {
  id: TeamId;
  points: number;
  roundPoints?: number;
  /**
   * Canonical board position received from the server.
   * New values written by this screen are stored in square-index units:
   * 0 = start, 1 = 50 points, 4 = 200 points.
   */
  position?: number;
  name?: string;
  color?: string;
  sheetId?: number;
  slot?: number;
  version?: DisplayVersion;
  displayVersion?: DisplayVersion;
}

interface QueuedMove extends Team {
  prevPosition: number;
  position: number;
}

interface AnnouncementData {
  id?: string;
  studentName: string;
  /** Actual delta carried by the server event. */
  points: number;
  /** Points that should be shown in the announcement card. */
  displayPoints?: number;
  displayOnly?: boolean;
  teamColor: string;
  teamName: string;
  /** نسخة العرض (1/2/3) — الإعلان يظهر فقط على جهاز يعرض نفس النسخة. */
  version?: number;
}

interface PendingPositions {
  [teamId: string]: number;
}

interface TodayEntry {
  studentName: string;
  points: number;
  hudur?: string;
  hifzScore?: string | number;
  muraScore?: string | number;
  haqiba?: string;
  istima?: string;
}

// ── Constants ──────────────────────────────────────────────────────────
interface SchoolClass {
  id: string;
  classId: string;
  name: string;
  className: string;
  sheetId: number;
  slot: number;
  version: DisplayVersion;
  displayVersion: DisplayVersion;
  students?: string[];
}

const CLASS_COLOR_PALETTE = [
  "#3B82F6", // أزرق
  "#EF4444", // أحمر
  "#22C55E", // أخضر
  "#8B5CF6", // بنفسجي
  "#F97316", // برتقالي
  "#06B6D4", // سماوي
  "#14B8A6", // تركوازي
  "#D97706", // ذهبي غامق
] as const;

function classColorBySlot(slot?: number, version?: number): string {
  const safeSlot = Number(slot || 0);
  const safeVersion = Number(version || 0);
  const startSlot = safeVersion === 2 ? 9 : safeVersion === 3 ? 15 : 1;
  const localIndex = Math.max(0, safeSlot - startSlot);
  return CLASS_COLOR_PALETTE[localIndex % CLASS_COLOR_PALETTE.length];
}

function compareTeamsBySlot(a: Team, b: Team): number {
  const aSlot = Number.isFinite(Number(a.slot)) ? Number(a.slot) : Number.MAX_SAFE_INTEGER;
  const bSlot = Number.isFinite(Number(b.slot)) ? Number(b.slot) : Number.MAX_SAFE_INTEGER;
  return aSlot - bSlot;
}

function getTeamColor(team?: Team | null): string {
  if (!team) return CLASS_COLOR_PALETTE[0];
  return classColorBySlot(team.slot, team.version ?? team.displayVersion);
}

// ألوان أزرار اختيار النسخة — لمسة ممتعة لكل نسخة.
const VERSION_ACCENTS: Record<number, string> = {
  1: "#38bdf8",
  2: "#a78bfa",
  3: "#fbbf24",
};

// أيقونات مرحة لكل نسخة في محدد الشاشة.
const VERSION_ICONS: Record<number, string> = {
  1: "🌊",
  2: "⛵",
  3: "🏝️",
};

const DISPLAY_VERSION_STORAGE_KEY = "sailor-race:display-version";

function getInitialVersion(): DisplayVersion {
  if (typeof window === "undefined") return 1;

  // الرابط المباشر ?version=2 له الأولوية (مفيد عند ربط كل جهاز بنسخة محددة).
  // مع HashRouter يكون الرابط /#/display?version=2 فنجمع المعامل من الجزأين.
  const hashQuery = window.location.hash.split("?")[1] || "";
  const params = new URLSearchParams(window.location.search);
  if (hashQuery) {
    new URLSearchParams(hashQuery).forEach((v, k) => {
      if (!params.has(k)) params.set(k, v);
    });
  }
  const raw = Number(params.get("version"));
  if (raw === 2 || raw === 3) return raw;

  // خلاف ذلك نستخدم النسخة المحفوظة على هذا الجهاز،
  // حتى تفتح كل الأجهزة نفس الرابط وكل جهاز يبقى على نسخته.
  try {
    const saved = Number(window.localStorage.getItem(DISPLAY_VERSION_STORAGE_KEY));
    if (saved === 2 || saved === 3) return saved;
  } catch {}

  return 1;
}
const DISPLAY_EVENT_STORAGE_KEY = "sailor-race:display-event";
const DISPLAY_EVENT_CHANNEL = "sailor-race-display-events";
const APPS_SCRIPT_URL = String(import.meta.env.VITE_APPS_URL || "");

function getRiyadhDateISO(offsetDays = 0): string {
  const shifted = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);

  const year = parts.find((p) => p.type === "year")?.value || "";
  const month = parts.find((p) => p.type === "month")?.value || "";
  const day = parts.find((p) => p.type === "day")?.value || "";
  return `${year}-${month}-${day}`;
}

function formatHistoryDateLabel(dateValue: string): string {
  if (!dateValue) return "";
  const [year, month, day] = dateValue.split("-").map(Number);
  if (!year || !month || !day) return dateValue;
  return new Intl.DateTimeFormat("ar-SA", {
    timeZone: "Asia/Riyadh",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

const TOTAL_POSITIONS = 22;
const ISLAND_INDICES = [0, 7, 14, 21];
const ISLAND_SIZES = [150, 140, 140, 170];

const ISLANDS_POS: Position[] = [
  { x: 10, y: 18 },
  { x: 95, y: 39 },
  { x: 5, y: 71 },
  { x: 94, y: 82 },
];

const SEGMENTS: Record<string, Position>[] = [
  { cp1: { x: 52, y: 2 }, cp2: { x: 58, y: 18 } },
  { cp1: { x: 80, y: 46 }, cp2: { x: 20, y: 52 } },
  { cp1: { x: 42, y: 72 }, cp2: { x: 52, y: 78 } },
];

// ── Helper Functions ───────────────────────────────────────────────────
function cubicBezier(
  t: number,
  p0: Position,
  p1: Position,
  p2: Position,
  p3: Position,
): Position {
  const mt = 1 - t;
  return {
    x:
      mt * mt * mt * p0.x +
      3 * mt * mt * t * p1.x +
      3 * mt * t * t * p2.x +
      t * t * t * p3.x,
    y:
      mt * mt * mt * p0.y +
      3 * mt * mt * t * p1.y +
      3 * mt * t * t * p2.y +
      t * t * t * p3.y,
  };
}

function getPathPositions(): Position[] {
  const pos: Position[] = [];
  for (let seg = 0; seg < 3; seg++) {
    if (seg === 0) pos.push(ISLANDS_POS[0]);
    for (let j = 1; j <= 7; j++)
      pos.push(
        cubicBezier(
          j / 7,
          ISLANDS_POS[seg],
          SEGMENTS[seg].cp1,
          SEGMENTS[seg].cp2,
          ISLANDS_POS[seg + 1],
        ),
      );
  }
  return pos;
}

function getSvgPath(): string {
  return SEGMENTS.map((seg, i) => {
    const s = ISLANDS_POS[i],
      e = ISLANDS_POS[i + 1],
      pre = i === 0 ? `M ${s.x} ${s.y}` : "";
    return `${pre} C ${seg.cp1.x} ${seg.cp1.y}, ${seg.cp2.x} ${seg.cp2.y}, ${e.x} ${e.y}`;
  }).join(" ");
}

// Each "square" on the path is worth POINTS_PER_SQUARE points:
// 0 pts => square 0, 50 pts => square 1, 200 pts => square 4.
const POINTS_PER_SQUARE = 50;
const POSITION_EPSILON = 0.0001;
const MOVE_STEP_INDEX = 0.25; // ربع مربع لكل خطوة: حركة أدق على المنحنى
const MOVE_STEP_MS = 300; // تقريباً 1.2 ثانية لكل مربع كامل: أبطأ قليلاً بدون مبالغة
const IDLE_TRANSITION_MS = 140;
const DEBUG_SHIP_POSITIONS = true;

const round3 = (value: number) => Math.round(value * 1000) / 1000;

function formatPoints(value: number): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  return Math.ceil(safeValue).toLocaleString();
}

// Continuous (possibly fractional) index along the path for a given points
// value, clamped to the available squares. This is the exact mapping the
// board uses: 30 => 0.6, 50 => 1, 200 => 4, 720 => 14.4.
function pointsToIndex(pts: number): number {
  const maxIndex = TOTAL_POSITIONS - 1;
  const safePts = Number.isFinite(pts) ? pts : 0;
  return Math.max(0, Math.min(safePts / POINTS_PER_SQUARE, maxIndex));
}

function indexToPoints(index: number): number {
  return index * POINTS_PER_SQUARE;
}

// Converts a value that may have been saved by an older version as raw points
// into the canonical square-index value used by the renderer.
// Examples:
//   4   => 4   (already square-index, meaning 200 pts)
//   0.6 => 0.6 (already square-index, meaning 30 pts)
//   200 => 4   (legacy/raw points)
//   30  => 0.6 (legacy/raw points)
function storedPositionToIndex(
  rawPosition: number | undefined,
  fallbackPoints?: number,
): number {
  const raw = Number(rawPosition ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;

  const maxIndex = TOTAL_POSITIONS - 1;
  const safeFallbackPoints = Number(fallbackPoints ?? NaN);

  // القيم الأكبر من 21 لا يمكن أن تكون رقم مربع، إذن هي نقاط خام:
  // 30 => 0.6 ، 200 => 4 ، 300 => 6 ، 700 => 14.
  if (raw > maxIndex) return pointsToIndex(raw);

  // مهم جداً للقيم الأقل من 50:
  // إذا كان السيرفر خزّن position=10 أو 20 كنقاط، والـ points لنفس الفريق
  // تساوي نفس الرقم، لا نعامل 10 كمربع 10؛ بل كنقاط = 0.2 مربع.
  if (
    Number.isFinite(safeFallbackPoints) &&
    Math.abs(raw - safeFallbackPoints) <= POSITION_EPSILON &&
    Math.abs(raw - pointsToIndex(safeFallbackPoints)) > POSITION_EPSILON
  ) {
    return pointsToIndex(raw);
  }

  // غير ذلك نعتبرها قيمة حديثة بصيغة رقم مربع كسري:
  // 0.6 => بين 0 و1، 4 => مربع 4، 14.4 => بين 14 و15.
  return Math.max(0, Math.min(raw, maxIndex));
}

// Computes the exact {x, y} location on the path for a given points value,
// using the same Bézier curve as the visible dashed path.
function pointsToExactPos(pts: number, pathPositions: Position[]): Position {
  const index = pointsToIndex(pts);
  return indexToExactPos(index, pathPositions);
}

// Computes the exact {x, y} location on the path for a square-index value.
function indexToExactPos(index: number, pathPositions: Position[]): Position {
  const maxIndex = pathPositions.length - 1;
  const clampedIndex = Math.max(0, Math.min(index, maxIndex));

  // المسار مكوّن من 3 منحنيات، وكل منحنى فيه 7 خطوات بين جزيرة وجزيرة.
  // بدلاً من خط مستقيم بين علامتين، نحسب موقع السفينة على نفس cubicBezier
  // المستخدم لرسم الخط الأصفر، لذلك 300 يقف فوق علامة 300 تماماً،
  // و700 يتبع المنحنى ولا يهبط تحته.
  const squaresPerSegment = 7;
  const seg = Math.min(
    Math.floor(clampedIndex / squaresPerSegment),
    SEGMENTS.length - 1,
  );
  const localT = (clampedIndex - seg * squaresPerSegment) / squaresPerSegment;

  return cubicBezier(
    localT,
    ISLANDS_POS[seg],
    SEGMENTS[seg].cp1,
    SEGMENTS[seg].cp2,
    ISLANDS_POS[seg + 1],
  );
}

// No visual offset is applied: the rendered ship center is exactly the
// mathematical location of its points on the path.
function calcShipOffset(
  team: Team,
  allTeams: Team[],
  posOf: (t: Team) => number,
): { ox: number; oy: number; ptsNudge: number } {
  void team;
  void allTeams;
  void posOf;

  // لا نضيف أي إزاحة بصرية. موقع السفينة يجب أن يكون هو موقع نقاطها 100%.
  // إذا فريقان عند 300 نقطة فسيكونان فوق بعض بالضبط على مربع 300.
  // وإذا الفرق 10 نقاط فقط، فالفرق الطبيعي سيكون 10/50 = 0.2 مربع
  // بدون تفريق صناعي يبعد السفينة عن المسار.
  return { ox: 0, oy: 0, ptsNudge: 0 };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function callAppsScriptJsonp(
  url: string,
  action: string,
  params: Record<string, string> = {},
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!url.includes("script.google.com")) {
      reject(new Error("رابط Apps Script غير مضبوط في VITE_APPS_URL"));
      return;
    }
    if (typeof window === "undefined" || typeof document === "undefined") {
      reject(new Error("لا يمكن تنفيذ العملية من هذا المتصفح"));
      return;
    }

    const callbackName = `__sailorDisplay_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    let done = false;
    let timer: number | undefined;

    const cleanup = () => {
      if (done) return;
      done = true;
      if (timer !== undefined) window.clearTimeout(timer);
      delete (window as any)[callbackName];
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("انتهت مهلة تحميل التسجيلات"));
    }, 15000);

    (window as any)[callbackName] = (payload: any) => {
      cleanup();
      resolve(payload);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("تعذر الاتصال بـ Google Sheets"));
    };

    const query = new URLSearchParams({
      action,
      callback: callbackName,
      _: String(Date.now()),
      ...params,
    });

    const separator = url.includes("?") ? "&" : "?";
    script.src = `${url}${separator}${query.toString()}`;
    document.body.appendChild(script);
  });
}

// ── Sub-components ─────────────────────────────────────────────────────
function RealisticShip({ color }: { color: string }) {
  const dark = color + "cc",
    darker = color + "99",
    gid = color.replace("#", "");
  return (
    <div style={{ position: "relative", width: 64, height: 48 }}>
      <div
        style={{
          position: "absolute",
          bottom: -6,
          left: "50%",
          transform: "translateX(-50%)",
          width: 56,
          height: 12,
          borderRadius: "50%",
          opacity: 0.4,
          background:
            "radial-gradient(ellipse,rgba(255,255,255,0.9),transparent 70%)",
          filter: "blur(3px)",
        }}
      />
      <svg
        viewBox="0 0 86 64"
        width={64}
        height={48}
        style={{
          position: "absolute",
          inset: 0,
          overflow: "visible",
          filter: "drop-shadow(0 5px 7px rgba(0,0,0,0.5))",
        }}
      >
        <defs>
          <linearGradient id={`hull-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} />
            <stop offset="55%" stopColor={dark} />
            <stop offset="100%" stopColor={darker} />
          </linearGradient>
          <linearGradient id={`upper-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fff" />
            <stop offset="100%" stopColor="#cbd5e1" />
          </linearGradient>
          <linearGradient id={`win-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0ea5e9" />
            <stop offset="100%" stopColor="#0c4a6e" />
          </linearGradient>
        </defs>
        <line
          x1="43"
          y1="6"
          x2="43"
          y2="22"
          stroke="#1e293b"
          strokeWidth="1"
          strokeLinecap="round"
        />
        <circle cx="43" cy="6" r="1.5" fill={color} />
        <ellipse cx="43" cy="22" rx="5" ry="1.6" fill="#475569" />
        <path
          d="M 22 36 L 26 22 L 60 22 L 64 36 Z"
          fill={`url(#upper-${gid})`}
          stroke="rgba(0,0,0,0.35)"
          strokeWidth="0.5"
        />
        <path
          d="M 28 26 L 58 26 L 60 33 L 26 33 Z"
          fill={`url(#win-${gid})`}
          stroke="rgba(0,0,0,0.4)"
          strokeWidth="0.4"
        />
        <line
          x1="36"
          y1="26"
          x2="35"
          y2="33"
          stroke="rgba(255,255,255,0.5)"
          strokeWidth="0.5"
        />
        <line
          x1="43"
          y1="26"
          x2="43"
          y2="33"
          stroke="rgba(255,255,255,0.5)"
          strokeWidth="0.5"
        />
        <line
          x1="50"
          y1="26"
          x2="51"
          y2="33"
          stroke="rgba(255,255,255,0.5)"
          strokeWidth="0.5"
        />
        <rect
          x="20"
          y="36"
          width="46"
          height="3"
          fill={color}
          stroke="rgba(0,0,0,0.4)"
          strokeWidth="0.4"
        />
        <path
          d="M 8 39 L 78 39 Q 82 39 80 44 Q 76 54 64 56 L 22 56 Q 12 56 8 49 Z"
          fill={`url(#hull-${gid})`}
          stroke="rgba(0,0,0,0.5)"
          strokeWidth="0.6"
        />
        <path
          d="M 12 44 L 76 44"
          stroke="rgba(255,255,255,0.5)"
          strokeWidth="0.7"
          fill="none"
        />
        <circle cx="22" cy="46" r="1.3" fill="#fde047" />
        <circle cx="32" cy="46" r="1.3" fill="#fde047" />
        <circle cx="54" cy="46" r="1.3" fill="#fde047" />
        <circle cx="64" cy="46" r="1.3" fill="#fde047" />
        <path d="M 78 39 Q 84 41 80 44" fill={darker} />
        <line
          x1="10"
          y1="39"
          x2="10"
          y2="30"
          stroke="#1e293b"
          strokeWidth="0.7"
        />
        <path d="M 10 30 L 16 32 L 10 34 Z" fill={color} />
        <path
          d="M 80 50 Q 84 48 86 51"
          stroke="rgba(255,255,255,0.8)"
          strokeWidth="0.7"
          fill="none"
        />
        <path
          d="M 4 48 Q 6 46 9 49"
          stroke="rgba(255,255,255,0.7)"
          strokeWidth="0.6"
          fill="none"
        />
      </svg>
    </div>
  );
}

function Announcement({ ann }: { ann: AnnouncementData }) {
  const particles = useMemo(
    () =>
      Array.from({ length: 16 }, (_, i) => ({
        id: i,
        angle: (i / 16) * 360,
        dist: 80 + Math.random() * 60,
        size: 6 + Math.random() * 10,
        color: [
          "#fde047",
          "#f59e0b",
          "#22c55e",
          "#3b82f6",
          "#a855f7",
          "#ef4444",
        ][i % 6],
        delay: Math.random() * 0.3,
      })),
    [],
  );
  if (!ann) return null;
  const pointsNumber = Number((ann as any).displayPoints ?? ann.points ?? 0);
  // displayOnly مع displayPoints أكبر من صفر يجب أن يعرض النقاط السابقة مثل +100،
  // ولا يتحول إلى عبارة "إعادة عرض" إلا إذا لم تُرسل نقاط للعرض.
  const isDisplayOnly = Boolean((ann as any).displayOnly) && pointsNumber === 0;
  const pointsLabel = pointsNumber > 0 ? `+${formatPoints(pointsNumber)}` : formatPoints(pointsNumber);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 300,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        animation: "ann-bg-in 0.4s ease-out forwards",
      }}
    >
      <div
        style={{
          position: "relative",
          textAlign: "center",
          background: `radial-gradient(ellipse at top,${ann.teamColor}33,transparent 70%),linear-gradient(160deg,#1e293b,#0f172a)`,
          border: `4px solid ${ann.teamColor}`,
          borderRadius: 34,
          padding: "clamp(28px,8vw,48px) clamp(22px,8vw,64px)",
          boxShadow: `0 0 0 2px rgba(0,0,0,0.35), 0 14px 0 -3px ${ann.teamColor}77, 0 38px 80px rgba(0,0,0,0.8), 0 0 60px ${ann.teamColor}22`,
          width: "min(360px,92vw)",
          boxSizing: "border-box",
          fontFamily: "'Tajawal',sans-serif",
          direction: "rtl",
          animation: "ann-card-in 0.7s cubic-bezier(0.2,1.3,0.4,1) 0.05s both",
        }}
      >
        {particles.map((p) => (
          <div
            key={p.id}
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              width: p.size,
              height: p.size,
              borderRadius: "50%",
              background: p.color,
              animation: `ann-particle 1.2s ease-out ${p.delay + 0.3}s both`,
              pointerEvents: "none",
              marginLeft: -p.size / 2,
              marginTop: -p.size / 2,
            }}
          />
        ))}
        {["-140px,0", "-70px,-100px", "70px,-100px", "140px,0"].map(
          (pos, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                top: "30%",
                left: "50%",
                transform: `translate(${pos})`,
                fontSize: 20,
                animation: `ann-stars 2s ease-in-out ${i * 0.2 + 0.5}s infinite`,
                pointerEvents: "none",
              }}
            >
              ✨
            </div>
          ),
        )}
        <div
          style={{
            fontSize: "clamp(28px,9vw,42px)",
            fontWeight: 900,
            color: "#fff",
            marginBottom: 12,
            animation: "ann-name-in 0.5s cubic-bezier(0.2,1.2,0.4,1) 0.3s both",
            lineHeight: 1.1,
          }}
        >
          {ann.studentName}
        </div>
        <div
          style={{
            fontSize: "clamp(13px,3.5vw,15px)",
            color: ann.teamColor,
            fontWeight: 700,
            marginBottom: 16,
            animation: "ann-glow 2s ease-in-out 0.8s infinite",
          }}
        >
          {ann.teamName} 🚢
        </div>
        <div
          style={{
            fontSize: "clamp(40px,13vw,58px)",
            fontWeight: 900,
            color: "#fde047",
            lineHeight: 1,
            animation: "ann-pts-in 0.6s cubic-bezier(0.2,1.5,0.4,1) 0.55s both",
            textShadow: "0 0 30px rgba(253,224,71,0.8)",
          }}
        >
          {isDisplayOnly ? "إعادة عرض" : pointsLabel}
        </div>
        <div
          style={{
            fontSize: "clamp(13px,4vw,16px)",
            color: "rgba(255,255,255,0.5)",
            marginTop: 6,
            animation: "ann-name-in 0.5s ease-out 0.8s both",
          }}
        >
          {isDisplayOnly ? "بدون إضافة نقاط 🏆" : "نقطة 🏆"}
        </div>
      </div>
    </div>
  );
}

function SettingsPanel({
  teams,
  onClose,
  currentPositions,
  onMovePending,
  onAdjustPoints,
  onResetAll,
}: {
  teams: Team[];
  onClose: () => void;
  currentPositions: Record<string, number>;
  onMovePending: (
    pending: PendingPositions,
    divisors: Record<string, number>,
  ) => void;
  onAdjustPoints: (teamId: TeamId, amount: number) => void;
  onResetAll: () => void;
}) {
  const [tab, setTab] = useState<"move" | "adjust" | "today" | "admin">("move");
  const [divisors, setDiv] = useState<Record<string, string>>(() => {
    const d: Record<string, string> = {};
    teams.forEach((t) => (d[t.id] = ""));
    return d;
  });
  const [adjusts, setAdj] = useState<Record<string, string>>(() => {
    const d: Record<string, string> = {};
    teams.forEach((t) => (d[t.id] = ""));
    return d;
  });
  const [calcDone, setCalcDone] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [todayTeam, setTodayTeam] = useState<TeamId>(teams[0]?.id || "");
  const [selectedEntriesDate, setSelectedEntriesDate] = useState(() => getRiyadhDateISO(0));
  const [todayEntries, setTodayEntries] = useState<TodayEntry[]>([]);
  const [todayDate, setTodayDate] = useState("");
  const [todayLoading, setTodayLoading] = useState(false);
  const [todayError, setTodayError] = useState("");

  useEffect(() => {
    if (teams.length === 0) {
      if (todayTeam) setTodayTeam("");
      return;
    }
    if (!todayTeam || !teams.some((team) => team.id === todayTeam)) {
      setTodayTeam([...teams].sort(compareTeamsBySlot)[0].id);
    }
  }, [teams, todayTeam]);

  const loadTodayEntries = async (
    teamId: TeamId = todayTeam,
    dateValue: string = selectedEntriesDate,
  ) => {
    setTodayLoading(true);
    setTodayError("");
    try {
      const result = await callAppsScriptJsonp(APPS_SCRIPT_URL, "getTodayEntries", {
        teamId,
        date: dateValue,
      });
      if (result?.status === "error") throw new Error(result.message || "تعذر تحميل التسجيلات");
      setTodayEntries(Array.isArray(result?.entries) ? result.entries : []);
      setTodayDate(String(result?.date || dateValue));
    } catch (err: any) {
      setTodayEntries([]);
      setTodayError(err?.message || "تعذر تحميل التسجيلات");
    } finally {
      setTodayLoading(false);
    }
  };

  useEffect(() => {
    if (tab !== "today") return;
    loadTodayEntries(todayTeam, selectedEntriesDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, todayTeam, selectedEntriesDate]);

  const handleDone = () => {
    const pending: PendingPositions = {};
    const divisorValues: Record<string, number> = {};

    teams.forEach((t) => {
      const rawRoundPoints = Number(t.roundPoints ?? 0);
      // القاسم الذي أدخله المعلم — إذا تُرك فارغاً يُستخدم 1 (بلا قسمة)
      const divisor = Math.max(1, Number(divisors[t.id]) || 1);
      // النقاط بعد المتوسط: نقرّب أي كسر للأعلى دائماً (مثال: 111.11 => 112)
      const effectivePts = Math.ceil(rawRoundPoints / divisor);
      // نستخدم الموضع الظاهر الحالي أولاً حتى لا تضيع القيم الكسرية مثل 0.6
      const currentIndex =
        currentPositions[t.id] ?? storedPositionToIndex(t.position, t.points);
      const deltaIndex = pointsToIndex(effectivePts);
      const nextIndex = Math.max(
        0,
        Math.min(currentIndex + deltaIndex, TOTAL_POSITIONS - 1),
      );

      pending[t.id] = nextIndex;
      divisorValues[t.id] = divisor;

      console.log("[MoveCalc]", {
        team: t.id,
        rawRoundPoints,
        divisor,
        effectivePts,
        currentIndex: round3(currentIndex),
        deltaIndex: round3(deltaIndex),
        nextIndex: round3(nextIndex),
        expectedSquareFromEffectivePts: round3(
          effectivePts / POINTS_PER_SQUARE,
        ),
        targetPointLabel: round3(indexToPoints(nextIndex)),
      });
    });

    onMovePending(pending, divisorValues);
    setCalcDone(true);
  };

  const handleAdjust = (teamId: TeamId, sign: 1 | -1) => {
    const val = parseInt(adjusts[teamId]) || 0;
    if (val <= 0) return;
    onAdjustPoints(teamId, val * sign);
  };

  const displayName = (t: Team) => t.name || `فصل ${t.slot || ""}`;

  const TAB = (active: boolean) => ({
    flex: "1 1 30%",
    minWidth: 90,
    padding: "10px 4px",
    borderRadius: 12,
    border: "none",
    cursor: "pointer",
    fontSize: "clamp(11px,3vw,13px)",
    fontFamily: "'Tajawal',sans-serif",
    fontWeight: active ? 800 : 400,
    background: active
      ? "linear-gradient(180deg,rgba(255,255,255,0.26),rgba(255,255,255,0.12))"
      : "rgba(255,255,255,0.06)",
    color: active ? "#fff" : "rgba(255,255,255,0.45)",
    boxShadow: active
      ? "0 3px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.24)"
      : "none",
    whiteSpace: "nowrap",
  });

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(2,6,23,0.94)",
        backdropFilter: "blur(14px)",
        animation: "fadeIn 0.2s ease-out",
        padding: "10px",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          background: "linear-gradient(135deg,#1e293b,#0f172a)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 26,
          padding: "22px 16px",
          width: "100%",
          maxWidth: 430,
          maxHeight: "94vh",
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          direction: "rtl",
          fontFamily: "'Tajawal',sans-serif",
          boxShadow: "0 30px 70px rgba(0,0,0,0.8)",
          position: "relative",
          boxSizing: "border-box",
        }}
      >
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: 14,
            left: 14,
            background: "rgba(255,255,255,0.07)",
            border: "none",
            color: "rgba(255,255,255,0.4)",
            borderRadius: "50%",
            width: 30,
            height: 30,
            cursor: "pointer",
            fontSize: 14,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ✕
        </button>
        <h3
          style={{
            color: "#fff",
            fontSize: 17,
            fontWeight: 800,
            marginBottom: 14,
            textAlign: "center",
          }}
        >
          ⚙️ الإعدادات
        </h3>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginBottom: 18,
            background: "rgba(255,255,255,0.05)",
            borderRadius: 14,
            padding: 4,
          }}
        >
          <button className="smooth-btn" style={TAB(tab === "move")} onClick={() => setTab("move")}>
            🚢 تحريك السفن
          </button>
          <button
            className="smooth-btn"
            style={TAB(tab === "adjust")}
            onClick={() => setTab("adjust")}
          >
            ✏️ تعديل النقاط
          </button>
          <button className="smooth-btn" style={TAB(tab === "today")} onClick={() => setTab("today")}>
            📅 التسجيلات حسب التاريخ
          </button>
          <button className="smooth-btn" style={TAB(tab === "admin")} onClick={() => setTab("admin")}>
            📋 لوحة التحكم
          </button>
        </div>

        {tab === "move" && (
          <div>
            <p
              style={{
                color: "rgba(255,255,255,0.4)",
                fontSize: 12,
                marginBottom: 14,
                textAlign: "center",
              }}
            >
              اكتب الرقم الذي تريد قسمة نقاط كل فريق عليه
            </p>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
                marginBottom: 16,
              }}
            >
              {teams.map((t) => (
                <div
                  key={t.id}
                  style={{
                    background: "rgba(255,255,255,0.05)",
                    border: `1px solid ${getTeamColor(t)}33`,
                    borderRadius: 14,
                    padding: "12px 14px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        marginBottom: 3,
                      }}
                    >
                      <div
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: "50%",
                          background: getTeamColor(t),
                          boxShadow: `0 0 6px ${getTeamColor(t)}`,
                        }}
                      />
                      <span
                        style={{ color: "#fff", fontWeight: 700, fontSize: 14 }}
                      >
                        {displayName(t)}
                      </span>
                    </div>
                    <div
                      style={{
                        color: "#fde047",
                        fontSize: 12,
                        fontWeight: 600,
                        paddingRight: 17,
                      }}
                    >
                      {(t.roundPoints ?? 0).toLocaleString()} نقطة
                    </div>
                  </div>
                  <input
                    type="number"
                    min="1"
                    value={divisors[t.id]}
                    onChange={(e) =>
                      setDiv((p) => ({ ...p, [t.id]: e.target.value }))
                    }
                    placeholder="÷"
                    style={{
                      width: 68,
                      background: "rgba(255,255,255,0.08)",
                      border: `1.5px solid ${getTeamColor(t)}66`,
                      borderRadius: 10,
                      color: "#fff",
                      fontSize: 18,
                      fontWeight: 700,
                      padding: "8px",
                      outline: "none",
                      fontFamily: "'Tajawal',sans-serif",
                      textAlign: "center",
                    }}
                  />
                </div>
              ))}
            </div>
            {!calcDone ? (
              <button
                onClick={handleDone}
                className="smooth-btn btn-shine"
                style={{
                  width: "100%",
                  padding: "14px",
                  borderRadius: 16,
                  border: "none",
                  position: "relative",
                  overflow: "hidden",
                  background: "linear-gradient(180deg,#6366f1,#4f46e5)",
                  color: "#fff",
                  fontSize: 15,
                  fontWeight: 900,
                  cursor: "pointer",
                  fontFamily: "'Tajawal',sans-serif",
                  boxShadow:
                    "0 6px 22px rgba(99,102,241,0.45), inset 0 1px 0 rgba(255,255,255,0.3)",
                }}
              >
                ✔ احسب المواضع الجديدة
              </button>
            ) : (
              <div
                style={{
                  padding: "12px",
                  borderRadius: 12,
                  background: "rgba(34,197,94,0.12)",
                  border: "1px solid rgba(34,197,94,0.3)",
                  color: "#4ade80",
                  textAlign: "center",
                  fontSize: 14,
                  fontWeight: 700,
                }}
              >
                ✅ اضغط زر "تحريك السفن" على الشاشة
              </div>
            )}
          </div>
        )}

        {tab === "adjust" && (
          <div>
            <p
              style={{
                color: "rgba(255,255,255,0.4)",
                fontSize: 12,
                marginBottom: 14,
                textAlign: "center",
              }}
            >
              اكتب عدد النقاط ثم اضغط + أو −
            </p>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
                marginBottom: 16,
              }}
            >
              {teams.map((t) => (
                <div
                  key={t.id}
                  style={{
                    background: "rgba(255,255,255,0.05)",
                    border: `1px solid ${getTeamColor(t)}33`,
                    borderRadius: 14,
                    padding: "12px 14px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        marginBottom: 2,
                      }}
                    >
                      <div
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: "50%",
                          background: getTeamColor(t),
                          boxShadow: `0 0 6px ${getTeamColor(t)}`,
                        }}
                      />
                      <span
                        style={{ color: "#fff", fontWeight: 700, fontSize: 13 }}
                      >
                        {displayName(t)}
                      </span>
                    </div>
                    <div
                      style={{
                        color: "#fde047",
                        fontSize: 11,
                        paddingRight: 17,
                      }}
                    >
                      {t.points.toLocaleString()} نقطة
                    </div>
                  </div>
                  <input
                    type="number"
                    min="0"
                    value={adjusts[t.id]}
                    onChange={(e) =>
                      setAdj((p) => ({ ...p, [t.id]: e.target.value }))
                    }
                    placeholder="0"
                    style={{
                      width: 70,
                      background: "rgba(255,255,255,0.08)",
                      border: "1.5px solid rgba(255,255,255,0.15)",
                      borderRadius: 10,
                      color: "#fff",
                      fontSize: 16,
                      fontWeight: 700,
                      padding: "7px",
                      outline: "none",
                      fontFamily: "'Tajawal',sans-serif",
                      textAlign: "center",
                    }}
                  />
                  <div style={{ display: "flex", gap: 5 }}>
                    <button
                      onClick={() => handleAdjust(t.id, 1)}
                      className="smooth-btn"
                      style={{
                        width: 38,
                        height: 38,
                        borderRadius: 12,
                        border: "none",
                        background:
                          "linear-gradient(180deg,rgba(34,197,94,0.45),rgba(21,128,61,0.35))",
                        color: "#4ade80",
                        fontSize: 18,
                        fontWeight: 900,
                        cursor: "pointer",
                        boxShadow:
                          "0 3px 10px rgba(34,197,94,0.25), inset 0 1px 0 rgba(255,255,255,0.15)",
                      }}
                    >
                      +
                    </button>
                    <button
                      onClick={() => handleAdjust(t.id, -1)}
                      className="smooth-btn"
                      style={{
                        width: 38,
                        height: 38,
                        borderRadius: 12,
                        border: "none",
                        background:
                          "linear-gradient(180deg,rgba(239,68,68,0.45),rgba(185,28,28,0.35))",
                        color: "#f87171",
                        fontSize: 18,
                        fontWeight: 900,
                        cursor: "pointer",
                        boxShadow:
                          "0 3px 10px rgba(239,68,68,0.25), inset 0 1px 0 rgba(255,255,255,0.15)",
                      }}
                    >
                      −
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "today" && (
          <div>
            <p
              style={{
                color: "rgba(255,255,255,0.45)",
                fontSize: 12,
                marginBottom: 12,
                textAlign: "center",
                lineHeight: 1.7,
              }}
            >
              اختر التاريخ والحلقة لعرض النقاط التي سُجلت للطلاب في ذلك اليوم
            </p>

            <div
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.10)",
                borderRadius: 14,
                padding: 10,
                marginBottom: 12,
              }}
            >
              <label
                style={{
                  display: "block",
                  color: "rgba(255,255,255,0.72)",
                  fontSize: 12,
                  fontWeight: 800,
                  marginBottom: 7,
                }}
              >
                📆 اختر التاريخ
              </label>
              <input
                type="date"
                value={selectedEntriesDate}
                max={getRiyadhDateISO(0)}
                onChange={(event) => setSelectedEntriesDate(event.target.value || getRiyadhDateISO(0))}
                style={{
                  width: "100%",
                  borderRadius: 11,
                  border: "1px solid rgba(255,255,255,0.16)",
                  background: "rgba(15,23,42,0.78)",
                  color: "#fff",
                  padding: "10px 12px",
                  fontFamily: "'Tajawal',sans-serif",
                  fontSize: 13,
                  fontWeight: 700,
                  colorScheme: "dark",
                  marginBottom: 8,
                }}
              />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6 }}>
                {[
                  { label: "اليوم", date: getRiyadhDateISO(0) },
                  { label: "أمس", date: getRiyadhDateISO(-1) },
                  { label: "قبل أمس", date: getRiyadhDateISO(-2) },
                ].map((item) => (
                  <button
                    key={item.label}
                    onClick={() => setSelectedEntriesDate(item.date)}
                    className="smooth-btn"
                    style={{
                      padding: "8px 4px",
                      borderRadius: 11,
                      border: `1px solid ${selectedEntriesDate === item.date ? "#38bdf8" : "rgba(255,255,255,0.12)"}`,
                      background: selectedEntriesDate === item.date
                        ? "linear-gradient(180deg,rgba(56,189,248,0.5),rgba(2,132,199,0.4))"
                        : "rgba(255,255,255,0.05)",
                      color: selectedEntriesDate === item.date ? "#fff" : "rgba(255,255,255,0.62)",
                      fontFamily: "'Tajawal',sans-serif",
                      fontSize: 11,
                      fontWeight: 800,
                      cursor: "pointer",
                      boxShadow: selectedEntriesDate === item.date
                        ? "0 3px 10px rgba(56,189,248,0.3), inset 0 1px 0 rgba(255,255,255,0.2)"
                        : "none",
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: 8,
                marginBottom: 12,
              }}
            >
              {[...teams].sort(compareTeamsBySlot).map((team) => {
                const teamColor = getTeamColor(team);
                return (
                  <button
                    key={team.id}
                    onClick={() => setTodayTeam(team.id)}
                    className="smooth-btn"
                    style={{
                      padding: "11px 8px",
                      borderRadius: 12,
                      border: `1.5px solid ${todayTeam === team.id ? teamColor : "rgba(255,255,255,0.12)"}`,
                      background: todayTeam === team.id
                        ? `linear-gradient(180deg, ${teamColor}66, ${teamColor}33)`
                        : "rgba(255,255,255,0.06)",
                      color: todayTeam === team.id ? "#fff" : "rgba(255,255,255,0.6)",
                      fontFamily: "'Tajawal',sans-serif",
                      fontSize: 13,
                      fontWeight: 800,
                      cursor: "pointer",
                      boxShadow: todayTeam === team.id
                        ? `0 3px 12px ${teamColor}44, inset 0 1px 0 rgba(255,255,255,0.2)`
                        : "none",
                    }}
                  >
                    {displayName(team)}
                  </button>
                );
              })}
            </div>

            <button
              onClick={() => loadTodayEntries(todayTeam, selectedEntriesDate)}
              disabled={todayLoading}
              className="smooth-btn"
              style={{
                width: "100%",
                padding: "11px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.12)",
                background: todayLoading
                  ? "rgba(255,255,255,0.07)"
                  : "linear-gradient(180deg,rgba(56,189,248,0.45),rgba(2,132,199,0.35))",
                color: todayLoading ? "rgba(255,255,255,0.35)" : "#fff",
                fontFamily: "'Tajawal',sans-serif",
                fontSize: 13,
                fontWeight: 800,
                cursor: todayLoading ? "not-allowed" : "pointer",
                marginBottom: 12,
                boxShadow: todayLoading
                  ? "none"
                  : "0 3px 12px rgba(56,189,248,0.25), inset 0 1px 0 rgba(255,255,255,0.2)",
              }}
            >
              {todayLoading ? "⏳ جارٍ التحميل..." : "🔄 تحديث تسجيلات التاريخ"}
            </button>

            <div
              style={{
                background: "rgba(255,255,255,0.05)",
                border: `1px solid ${getTeamColor(teams.find((team) => team.id === todayTeam))}33`,
                borderRadius: 16,
                padding: 12,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 10,
                  gap: 10,
                }}
              >
                <span style={{ color: "#fff", fontWeight: 900, fontSize: 14 }}>
                  {displayName(teams.find((team) => team.id === todayTeam) || teams[0] || { id: todayTeam, points: 0 })}
                </span>
                <span style={{ color: "rgba(255,255,255,0.45)", fontSize: 11 }}>
                  {formatHistoryDateLabel(todayDate || selectedEntriesDate)}
                </span>
              </div>

              {todayError && (
                <div
                  style={{
                    color: "#fca5a5",
                    background: "rgba(239,68,68,0.1)",
                    border: "1px solid rgba(239,68,68,0.25)",
                    borderRadius: 12,
                    padding: 12,
                    textAlign: "center",
                    fontSize: 12,
                    lineHeight: 1.7,
                  }}
                >
                  ⚠️ {todayError}
                </div>
              )}

              {!todayLoading && !todayError && todayEntries.length === 0 && (
                <div
                  style={{
                    color: "rgba(255,255,255,0.42)",
                    textAlign: "center",
                    fontSize: 13,
                    padding: "18px 8px",
                    lineHeight: 1.7,
                  }}
                >
                  لا توجد تسجيلات لهذه الحلقة في التاريخ المختار
                </div>
              )}

              {!todayError && todayEntries.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {todayEntries.map((entry, idx) => (
                    <div
                      key={`${entry.studentName}-${idx}`}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 12,
                        borderRadius: 12,
                        padding: "10px 12px",
                        background: "rgba(15,23,42,0.55)",
                        border: "1px solid rgba(255,255,255,0.08)",
                      }}
                    >
                      <span
                        style={{
                          color: "rgba(255,255,255,0.86)",
                          fontWeight: 800,
                          fontSize: 13,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {entry.studentName}
                      </span>
                      <span
                        style={{
                          color: "#fde047",
                          fontWeight: 900,
                          fontSize: 13,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {formatPoints(Number(entry.points || 0))} نقطة
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "admin" && (
          <div style={{ marginTop: 8 }}>
            <AdminPanelEmbed />
          </div>
        )}

        <div
          style={{
            height: 1,
            background: "rgba(255,255,255,0.07)",
            margin: "14px 0 12px",
          }}
        />
        {!showReset ? (
          <button
            onClick={() => setShowReset(true)}
            className="smooth-btn"
            style={{
              width: "100%",
              padding: "10px",
              borderRadius: 12,
              border: "1px solid rgba(239,68,68,0.3)",
              background: "linear-gradient(180deg,rgba(239,68,68,0.2),rgba(127,29,29,0.18))",
              color: "#f87171",
              fontSize: 13,
              fontWeight: 800,
              cursor: "pointer",
              fontFamily: "'Tajawal',sans-serif",
              boxShadow: "0 3px 12px rgba(239,68,68,0.15), inset 0 1px 0 rgba(255,255,255,0.08)",
            }}
          >
            🔄 إعادة المسابقة من البداية
          </button>
        ) : (
          <div
            style={{
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 14,
              padding: "14px",
              textAlign: "center",
            }}
          >
            <p style={{ color: "#f87171", fontSize: 13, marginBottom: 10 }}>
              ستعود جميع السفن للبداية وتُصفَّر النقاط. متأكد؟
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={onResetAll}
                className="smooth-btn"
                style={{
                  flex: 1,
                  padding: "9px",
                  borderRadius: 12,
                  border: "none",
                  background: "linear-gradient(180deg,#ef4444,#b91c1c)",
                  color: "#fff",
                  fontWeight: 800,
                  cursor: "pointer",
                  fontFamily: "'Tajawal',sans-serif",
                  boxShadow: "0 3px 12px rgba(239,68,68,0.35), inset 0 1px 0 rgba(255,255,255,0.2)",
                }}
              >
                نعم، إعادة
              </button>
              <button
                onClick={() => setShowReset(false)}
                className="smooth-btn"
                style={{
                  flex: 1,
                  padding: "9px",
                  borderRadius: 12,
                  border: "none",
                  background: "rgba(255,255,255,0.1)",
                  color: "#fff",
                  fontWeight: 800,
                  cursor: "pointer",
                  fontFamily: "'Tajawal',sans-serif",
                }}
              >
                إلغاء
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────
export default function DisplayPage() {
  const [allTeams, setAllTeams] = useState<Team[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<DisplayVersion>(() => getInitialVersion());
  // آخر نسخة معروضة في مرجع ثابت حتى يفلتر الإعلان بإغلاق محدث دائماً.
  const selectedVersionRef = useRef<DisplayVersion>(selectedVersion);
  // خريطة الفصول (teamId → الفصل) لاستنتاج نسخة أي إعلان قديم لا يحمل النسخة.
  const teamsByIdRef = useRef<Record<string, Team>>({});
  const teams = useMemo(
    () => allTeams.filter((team) => Number(team.version ?? team.displayVersion) === selectedVersion).sort(compareTeamsBySlot),
    [allTeams, selectedVersion],
  );
  const [announcement, setAnn] = useState<AnnouncementData | null>(null);
  const localQueueRef = useRef<AnnouncementData[]>([]);
  const isShowingRef = useRef(false);
  const lastActionSeenRef = useRef<string>("");
  const externalDisplayEventSeenRef = useRef<string>("");
  const recentAnnouncementKeysRef = useRef<Record<string, number>>({});
  const [showSettings, setShowSettings] = useState(false);
  const [pendingPos, setPendingPos] = useState<PendingPositions | null>(null);
  const [movingId, setMovingId] = useState<TeamId | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // The position actually rendered for each ship. Kept separate from
  // `team.position` (the authoritative value from the server) so that when
  // several ships' positions change at once, we can reveal the moves one
  // ship at a time instead of animating all of them simultaneously.
  const [displayPositions, setDisplayPositions] = useState<
    Record<string, number>
  >({});
  const displayPositionsRef = useRef<Record<string, number>>({});
  // مدة الانتقال (CSS transition) لكل سفينة بالمللي ثانية — قيمة ثابتة
  // صغيرة بشكل افتراضي (لتعديلات بسيطة)، وتُرفع مؤقتاً أثناء حركة فعلية
  // طويلة عشان تكون الحركة سلسة ومتصلة بدل "نط" من مربع لمربع.
  const [transitionDurations, setTransitionDurations] = useState<
    Record<string, number>
  >({});
  const transitionDurationsRef = useRef<Record<string, number>>({});
  const moveQueueRef = useRef<QueuedMove[]>([]);
  const isAnimatingRef = useRef(false);
  const initializedPositionsRef = useRef(false);

  const positions = useMemo(() => getPathPositions(), []);
  const svgPath = useMemo(() => getSvgPath(), []);
  const bubbles = useMemo(
    () =>
      Array.from({ length: 8 }, (_, i) => ({
        key: i,
        w: 4 + Math.random() * 6,
        left: 5 + Math.random() * 90,
        bottom: Math.random() * 100,
        dur: 6 + Math.random() * 8,
        delay: Math.random() * 5,
      })),
    [],
  );

  useEffect(() => {
    document.body.className = "display-page";
    return () => {
      document.body.className = "";
    };
  }, []);

  // نواكب آخر نسخة معروضة.
  useEffect(() => {
    selectedVersionRef.current = selectedVersion;
  }, [selectedVersion]);

  useEffect(() => {
    // نحفظ النسخة على هذا الجهاز حتى تفتح كل الأجهزة نفس الرابط
    // ويبقى كل جهاز على نسخته بعد أول اختيار.
    try {
      window.localStorage.setItem(DISPLAY_VERSION_STORAGE_KEY, String(selectedVersion));
    } catch {}

    const url = new URL(window.location.href);
    url.searchParams.set("version", String(selectedVersion));
    window.history.replaceState({}, "", url);

    // عند تغيير النسخة نظهر سفنها في مواقعها الحالية فوراً بدون تحريك من الصفر.
    initializedPositionsRef.current = false;
    moveQueueRef.current = [];
    setMovingId(null);
    setPendingPos(null);
  }, [selectedVersion]);

  useEffect(() => {
    let active = true;

    const loadAndSyncClasses = async () => {
      try {
        const result = await callAppsScriptJsonp(APPS_SCRIPT_URL, "getClasses");
        if (!active || result?.status === "error") return;

        const classes: SchoolClass[] = (Array.isArray(result?.classes) ? result.classes : [])
          .map((item: any) => ({
            id: String(item?.classId || item?.id || ""),
            classId: String(item?.classId || item?.id || ""),
            name: String(item?.className || item?.name || ""),
            className: String(item?.className || item?.name || ""),
            sheetId: Number(item?.sheetId || 0),
            slot: Number(item?.slot || 0),
            version: Number(item?.version ?? item?.displayVersion) as DisplayVersion,
            displayVersion: Number(item?.displayVersion ?? item?.version) as DisplayVersion,
            students: Array.isArray(item?.students) ? item.students : [],
          }))
          .filter((item: SchoolClass) =>
            item.classId.startsWith("class-") &&
            item.slot >= 1 &&
            item.slot <= 19 &&
            [1, 2, 3].includes(item.version),
          )
          .sort((a: SchoolClass, b: SchoolClass) => a.slot - b.slot);

        if (classes.length === 0) return;

        wsClient.syncClasses(
          classes.map((item) => ({
            ...item,
            color: classColorBySlot(item.slot, item.version),
          })),
        );
      } catch (err) {
        console.warn("[DisplayPage] getClasses sync failed:", err);
      }
    };

    loadAndSyncClasses();
    const onFocus = () => loadAndSyncClasses();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(loadAndSyncClasses, 60000);

    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, []);

  const enqueueAnnouncement = (msg: AnnouncementData) => {
    // قاعدة النسخ (صارمة): الإعلان يظهر فقط على جهاز DisplayPage الذي يعرض نفس نسخة فصل الطالب.
    // جهاز نسخة 1 لا يرى تسجيلات فصول نسخة 2، والعكس.
    // لو الإعلان وصل بدون نسخة (من سيرفر قديم) نستنتجها من قائمة الفصول المعروفة،
    // وإن تعذر استنتاجها نتجاهل الإعلان حتى لا يتسرب بين النسخ.
    const rawVersion = Number((msg as any)?.version ?? 0);
    const teamLookup = teamsByIdRef.current[String((msg as any)?.teamId || "")];
    const teamVersion = Number(teamLookup?.version ?? teamLookup?.displayVersion ?? 0);
    const msgVersion = rawVersion || teamVersion;
    if (msgVersion !== selectedVersionRef.current) return;

    const studentName = String(msg?.studentName || "").trim();
    const normalizedName = studentName.replace(/\s+/g, " ").toLowerCase();
    const points = Number((msg as any)?.displayPoints ?? (msg as any)?.points ?? 0);

    // لا نعرض أي إشعار ناتج عن تصحيح صامت أو خصم داخلي.
    // بعض النسخ القديمة ترسل الاسم الفارغ من السيرفر كـ "غير معروف"؛ هذا يجب تجاهله.
    if (!studentName) return;
    if (["غير معروف", "unknown", "undefined", "null"].includes(normalizedName)) return;
    if (!Number.isFinite(points)) return;
    if (points < 0) return;
    if (points === 0 && !(msg as any)?.displayOnly) return;

    const now = Date.now();

    const key = `${studentName}|${msg.teamName}|${points}|${(msg as any).displayOnly ? "display" : "score"}`;

    // منع التكرار لو وصل نفس الإعلان من onAnnouncement ومن lastAction معاً.
    Object.keys(recentAnnouncementKeysRef.current).forEach((oldKey) => {
      if (now - recentAnnouncementKeysRef.current[oldKey] > 2500) {
        delete recentAnnouncementKeysRef.current[oldKey];
      }
    });

    if (recentAnnouncementKeysRef.current[key] && now - recentAnnouncementKeysRef.current[key] < 2500) {
      return;
    }

    recentAnnouncementKeysRef.current[key] = now;
    localQueueRef.current = [
      ...localQueueRef.current,
      {
        ...msg,
        studentName,
        id: msg.id || `${key}|${now}`,
        points,
        displayPoints: points,
        displayOnly: Boolean((msg as any).displayOnly),
      },
    ];
    processQueue();
  };

  const handleExternalDisplayEvent = (raw: unknown) => {
    try {
      const event: any = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!event || typeof event !== "object") return;

      const shownPoints = Number(event.displayPoints ?? event.points ?? 0);
      const eventKey = String(
        event.eventId ||
          event.id ||
          `${event.createdAt || ""}|${event.teamId || ""}|${event.studentName || ""}|${shownPoints}`,
      );

      if (!eventKey || eventKey === externalDisplayEventSeenRef.current) return;
      externalDisplayEventSeenRef.current = eventKey;

      enqueueAnnouncement({
        id: eventKey,
        studentName: String(event.studentName || ""),
        points: Number(event.points || 0),
        displayPoints: shownPoints,
        displayOnly: Boolean(event.displayOnly),
        teamColor: String(event.teamColor || "#6366f1"),
        teamName: String(event.teamName || ""),
        version: Number(event.version || 0),
      });
    } catch (err) {
      console.warn("Display local event ignored:", err);
    }
  };

  // WebSocket connection & subscriptions
  useEffect(() => {
    wsClient.connect();
    const unsubState = wsClient.subscribe((state: any) => {
      const fixedTeams = (state.teams || []).map((t: any) => ({
        ...t,
        roundPoints: typeof t.roundPoints === "number" ? t.roundPoints : 0,
      }));
      setAllTeams(fixedTeams);
      teamsByIdRef.current = Object.fromEntries(fixedTeams.map((t: any) => [t.id, t]));

      // احتياط مهم: بعض النسخ لا ترسل onAnnouncement بشكل ثابت،
      // لكن AdminPage يرسل lastAction مع كل تسجيل. إذا وصل lastAction جديد
      // نعرض اسم الطالب في DisplayPage مثل النسخة القديمة تماماً.
      const action = state?.lastAction;
      if (action?.studentName) {
        const shownPoints = Number(action.displayPoints ?? action.points ?? 0);
        const actionKey = `${action.createdAt || ""}|${action.teamId || ""}|${action.studentName}|${shownPoints}`;
        if (actionKey !== lastActionSeenRef.current) {
          lastActionSeenRef.current = actionKey;
          enqueueAnnouncement({
            id: actionKey,
            studentName: String(action.studentName || ""),
            points: Number(action.points || 0),
            displayPoints: shownPoints,
            displayOnly: Boolean(action.displayOnly),
            teamColor: String(action.teamColor || "#6366f1"),
            teamName: String(action.teamName || ""),
            version: Number(action.version || 0),
          });
        }
      }
    });
    const unsubAnn = wsClient.onAnnouncement((msg: AnnouncementData) => {
      enqueueAnnouncement(msg);
    });

    const readStoredDisplayEvent = () => {
      try {
        const raw = window.localStorage.getItem(DISPLAY_EVENT_STORAGE_KEY);
        if (raw) handleExternalDisplayEvent(raw);
      } catch (err) {}
    };

    readStoredDisplayEvent();

    const onStorage = (event: StorageEvent) => {
      if (event.key === DISPLAY_EVENT_STORAGE_KEY && event.newValue) {
        handleExternalDisplayEvent(event.newValue);
      }
    };
    window.addEventListener("storage", onStorage);

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(DISPLAY_EVENT_CHANNEL);
      channel.onmessage = (event) => handleExternalDisplayEvent(event.data);
    } catch (err) {
      channel = null;
    }

    const pollTimer = window.setInterval(readStoredDisplayEvent, 700);

    return () => {
      unsubState();
      unsubAnn();
      window.removeEventListener("storage", onStorage);
      window.clearInterval(pollTimer);
      if (channel) channel.close();
    };
  }, []);

  const processQueue = () => {
    if (isShowingRef.current || localQueueRef.current.length === 0) return;
    isShowingRef.current = true;
    const item = localQueueRef.current[0];
    setAnn(item);
    setTimeout(() => {
      setAnn(null);
      localQueueRef.current = localQueueRef.current.slice(1);
      isShowingRef.current = false;
      setTimeout(() => processQueue(), 400);
    }, 5500);
  };

  /* fullscreen */
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = () => {
    if (!document.fullscreenElement)
      document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  };

  /* تحريك السفن سفينة واحدة في كل مرة، ربع مربع/ربع مربع على المسار */
  const drainMoveQueue = async () => {
    if (isAnimatingRef.current || moveQueueRef.current.length === 0) return;

    isAnimatingRef.current = true;
    setIsMoving(true);

    while (moveQueueRef.current.length > 0) {
      const ordered = [...moveQueueRef.current].sort(
        (a, b) => compareTeamsBySlot(a, b),
      );
      const next = ordered[0];
      moveQueueRef.current = moveQueueRef.current.filter(
        (t) => t.id !== next.id,
      );
      setMovingId(next.id);

      const startPos =
        displayPositionsRef.current[next.id] ?? next.prevPosition ?? 0;
      const endPos = storedPositionToIndex(next.position);
      const direction = endPos >= startPos ? 1 : -1;
      const distance = Math.abs(endPos - startPos);

      console.log("[DrainMoveQueue:start]", {
        team: next.id,
        startPos: round3(startPos),
        endPos: round3(endPos),
        startPoints: round3(indexToPoints(startPos)),
        endPoints: round3(indexToPoints(endPos)),
        distance: round3(distance),
      });

      // ثبّت السفينة أولاً على نقطة البداية بدون transition حتى لا يحدث وميض.
      transitionDurationsRef.current = {
        ...transitionDurationsRef.current,
        [next.id]: 0,
      };
      setTransitionDurations({ ...transitionDurationsRef.current });
      displayPositionsRef.current = {
        ...displayPositionsRef.current,
        [next.id]: startPos,
      };
      setDisplayPositions({ ...displayPositionsRef.current });

      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );

      if (distance <= POSITION_EPSILON) {
        transitionDurationsRef.current = {
          ...transitionDurationsRef.current,
          [next.id]: IDLE_TRANSITION_MS,
        };
        setTransitionDurations({ ...transitionDurationsRef.current });
        displayPositionsRef.current = {
          ...displayPositionsRef.current,
          [next.id]: endPos,
        };
        setDisplayPositions({ ...displayPositionsRef.current });
        await sleep(250);
        continue;
      }

      // حركة تدريجية على المسار: كل خطوة تغيّر الموضع الكسري فقط، وReact
      // يعيد حساب left/top من pointsToExactPos على نفس منحنى SVG، فتتحرك السفينة فوق المنحنى
      // بدل خط مستقيم طويل يقطع أسفل/أعلى المسار.
      let current = startPos;
      while (Math.abs(endPos - current) > POSITION_EPSILON) {
        const remaining = Math.abs(endPos - current);
        const step = Math.min(MOVE_STEP_INDEX, remaining);
        const nextStep = current + direction * step;

        transitionDurationsRef.current = {
          ...transitionDurationsRef.current,
          [next.id]: MOVE_STEP_MS,
        };
        setTransitionDurations({ ...transitionDurationsRef.current });

        displayPositionsRef.current = {
          ...displayPositionsRef.current,
          [next.id]: nextStep,
        };
        setDisplayPositions({ ...displayPositionsRef.current });

        console.log("[DrainMoveQueue:step]", {
          team: next.id,
          index: nextStep,
          points: round3(indexToPoints(nextStep)),
        });

        current = nextStep;
        await sleep(MOVE_STEP_MS + 30);
      }

      transitionDurationsRef.current = {
        ...transitionDurationsRef.current,
        [next.id]: IDLE_TRANSITION_MS,
      };
      setTransitionDurations({ ...transitionDurationsRef.current });

      // تأكيد نهائي للقيمة بالضبط، بدون تقريب.
      displayPositionsRef.current = {
        ...displayPositionsRef.current,
        [next.id]: endPos,
      };
      setDisplayPositions({ ...displayPositionsRef.current });

      console.log("[DrainMoveQueue:done]", {
        team: next.id,
        finalIndex: round3(endPos),
        finalPoints: round3(indexToPoints(endPos)),
      });

      await sleep(250);
    }

    setMovingId(null);
    setIsMoving(false);
    setPendingPos(null);
    isAnimatingRef.current = false;
  };

  // Whenever the authoritative `teams` state changes, queue up any ships
  // whose position actually moved and animate them one at a time. This is
  // what makes the ships move individually instead of all at once — the CSS
  // transition only fires when a ship's *own* entry in displayPositions
  // changes, and we only change one entry every 3.4s.
  useEffect(() => {
    if (teams.length === 0) return;

    if (!initializedPositionsRef.current) {
      // First load: show every ship at its real position immediately, no animation.
      const initial: Record<string, number> = {};
      teams.forEach((t) => {
        initial[t.id] = storedPositionToIndex(t.position, t.points);
      });
      displayPositionsRef.current = initial;
      setDisplayPositions(initial);
      initializedPositionsRef.current = true;
      return;
    }

    teams.forEach((t) => {
      const target = storedPositionToIndex(t.position, t.points);
      const currentDisplay = displayPositionsRef.current[t.id] ?? 0;

      if (Math.abs(target - currentDisplay) > POSITION_EPSILON) {
        const queued = moveQueueRef.current.find((q) => q.id === t.id);
        if (queued) {
          queued.position = target;
        } else {
          // احفظ الموضع الكسري الحقيقي كنقطة بداية؛ لا نُقرِّب أبداً.
          // هذا ضروري للقيم مثل 0.6 = 30 نقطة بين مربع 0 و 1.
          moveQueueRef.current.push({
            ...t,
            position: target,
            prevPosition: currentDisplay,
          });
        }
      }
    });
    drainMoveQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teams]);

  const handleMoveShips = () => {
    if (!pendingPos || isMoving) return;
    const orderedTeams = [...teams].sort(
      (a, b) => compareTeamsBySlot(a, b),
    );
    const positionsToSend: Record<string, number> = {};
    orderedTeams.forEach((t) => {
      positionsToSend[t.id] =
        pendingPos[t.id] ?? storedPositionToIndex(t.position, t.points);
    });
    console.log("[MoveShips:send]", positionsToSend);
    setIsMoving(true); // instant button feedback; drainMoveQueue() takes over
    // once the server broadcasts the new positions back to this client.
    wsClient.moveShips(positionsToSend);
  };

  const handleAdjustPoints = async (teamId: TeamId, amount: number) => {
    wsClient.adjustPoints(teamId, amount);
  };

  const handleResetAll = () => {
    wsClient.resetGame();
    setPendingPos(null);
    setShowSettings(false);
  };

  const posOf = (t: Team) =>
    displayPositions[t.id] ?? storedPositionToIndex(t.position, t.points);

  const getShipPos = (
    team: Team,
  ): {
    x: number;
    y: number;
    ptsNudge: number;
    boardIndex: number;
    effectivePts: number;
  } => {
    const boardIndex = posOf(team);
    const { ox, oy, ptsNudge } = calcShipOffset(team, teams, posOf);
    const exactIndex = boardIndex + ptsNudge;
    const effectivePts = indexToPoints(exactIndex);
    const exact = pointsToExactPos(effectivePts, positions);
    return {
      x: exact.x + ox,
      y: exact.y + oy,
      ptsNudge,
      boardIndex,
      effectivePts,
    };
  };

  const leaderPosition = Math.max(0, ...teams.map((t) => posOf(t)));

  // التاج يظهر لكل السفن المتصدرة بنفس الموضع — حتى لو متعادلة
  const isLeader = (team: Team) =>
    leaderPosition > POSITION_EPSILON &&
    Math.abs(posOf(team) - leaderPosition) <= POSITION_EPSILON;

  useEffect(() => {
    if (!DEBUG_SHIP_POSITIONS || teams.length === 0) return;

    console.table(
      teams.map((t) => {
        const boardIndex = posOf(t);
        const effectivePts = indexToPoints(boardIndex);
        const exact = pointsToExactPos(effectivePts, positions);
        return {
          team: t.id,
          storedPosition: t.position ?? 0,
          boardIndex: round3(boardIndex),
          effectivePts: round3(effectivePts),
          expectedSquare: round3(effectivePts / POINTS_PER_SQUARE),
          x: round3(exact.x),
          y: round3(exact.y),
          shipLocationPoints: round3(indexToPoints(boardIndex)),
          isLeader: isLeader(t),
        };
      }),
    );
  }, [teams, displayPositions, positions, leaderPosition]);

  const displayName = (t: Team) => t.name || `فصل ${t.slot || ""}`;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700;800;900&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        body{overflow:hidden;background:#0f172a;}
        @keyframes ship-wave{0%,100%{transform:translateY(0) rotate(0deg)}20%{transform:translateY(-4px) rotate(1deg)}50%{transform:translateY(3px) rotate(-1deg)}80%{transform:translateY(-2px) rotate(0.5deg)}}
        @keyframes wave-ring{0%{transform:scale(0.8);opacity:0.5}100%{transform:scale(1.6);opacity:0}}
        @keyframes wave-sweep{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
        @keyframes float-bubble{0%{transform:translateY(0) scale(1);opacity:0.25}100%{transform:translateY(-70px) scale(0.4);opacity:0}}
        @keyframes shimmer-move{0%{opacity:0.12;transform:translateX(-5%)}50%{opacity:0.35;transform:translateX(5%)}100%{opacity:0.12;transform:translateX(-5%)}}
        @keyframes palm-sway{0%,100%{transform:rotate(0deg)}25%{transform:rotate(5deg)}75%{transform:rotate(-4deg)}}
        @keyframes island-glow{0%,100%{opacity:0.3}50%{opacity:0.8}}
        @keyframes fadeIn{from{opacity:0}to{opacity:1}}
        @keyframes move-ready{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,0.7)}50%{box-shadow:0 0 0 14px rgba(34,197,94,0)}}
        @keyframes ann-bg-in{to{background:rgba(0,0,0,0.72);backdrop-filter:blur(8px)}}
        @keyframes ann-card-in{0%{opacity:0;transform:scale(0.5) rotate(-4deg)}60%{transform:scale(1.06) rotate(1deg)}100%{opacity:1;transform:scale(1) rotate(0deg)}}
        @keyframes ann-name-in{0%{opacity:0;transform:translateY(30px)}100%{opacity:1;transform:translateY(0)}}
        @keyframes ann-pts-in{0%{opacity:0;transform:scale(0.3)}60%{transform:scale(1.2)}100%{opacity:1;transform:scale(1)}}
        @keyframes ann-particle{0%{opacity:1;transform:translate(0,0) scale(1)}100%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(0)}}
        @keyframes ann-glow{0%,100%{text-shadow:0 0 20px currentColor,0 0 40px currentColor}50%{text-shadow:0 0 40px currentColor,0 0 80px currentColor}}
        @keyframes ann-stars{0%{opacity:0;transform:scale(0) rotate(0deg)}50%{opacity:1;transform:scale(1.2) rotate(180deg)}100%{opacity:0;transform:scale(0) rotate(360deg)}}
        @keyframes logo-float{0%,100%{transform:translateY(0) rotate(-1deg)}50%{transform:translateY(-8px) rotate(1deg)}}
        @keyframes logo-glow{0%,100%{filter:drop-shadow(0 4px 12px rgba(0,150,130,0.4))}50%{filter:drop-shadow(0 8px 24px rgba(0,200,180,0.7))}}
        /* زر كرتوني: حدود سميكة + ظل صلب سفلي (تأثير 3D) + ضغطة نازلة واضحة */
        .smooth-btn {
          transition: transform 0.14s ease, box-shadow 0.14s ease, filter 0.16s ease, background 0.2s ease, border-color 0.2s ease, color 0.2s ease !important;
          will-change: transform;
          border: 3px solid rgba(0,0,0,0.30) !important;
          box-shadow: 0 5px 0 rgba(0,0,0,0.38), inset 0 2px 0 rgba(255,255,255,0.35), inset 0 -3px 0 rgba(0,0,0,0.15) !important;
        }
        .smooth-btn:hover:not(:disabled):not(.btn-float) {
          transform: translateY(-2px) !important;
          filter: brightness(1.08);
          box-shadow: 0 7px 0 rgba(0,0,0,0.38), inset 0 2px 0 rgba(255,255,255,0.40), inset 0 -3px 0 rgba(0,0,0,0.15) !important;
        }
        .smooth-btn:active:not(:disabled):not(.btn-float) {
          transform: translateY(4px) !important;
          filter: brightness(0.96);
          box-shadow: 0 1px 0 rgba(0,0,0,0.38), inset 0 2px 0 rgba(255,255,255,0.28), inset 0 -2px 0 rgba(0,0,0,0.15) !important;
        }
        /* زر عائم (مثبّت بالمنتصف): يحافظ على توسيطه عند الحركة + حدود كرتونية */
        .btn-float {
          transition: transform 0.14s ease, box-shadow 0.14s ease, filter 0.16s ease !important;
          will-change: transform;
          border: 3px solid rgba(0,0,0,0.30) !important;
        }
        .btn-float:hover:not(:disabled) {
          transform: translateX(-50%) translateY(-3px) !important;
          filter: brightness(1.08);
        }
        .btn-float:active:not(:disabled) {
          transform: translateX(-50%) translateY(3px) !important;
          filter: brightness(0.96);
        }
        /* لمعان يمر على الزر الرئيسي */
        .btn-shine {
          position: relative;
          overflow: hidden;
        }
        .btn-shine::after {
          content: "";
          position: absolute;
          top: 0;
          left: -60%;
          width: 40%;
          height: 100%;
          background: linear-gradient(105deg, transparent, rgba(255,255,255,0.35), transparent);
          transform: skewX(-20deg);
          animation: btn-shine 3.4s ease-in-out infinite;
          pointer-events: none;
        }
        @keyframes btn-shine {
          0%, 60% { left: -60%; }
          85%, 100% { left: 140%; }
        }
      `}</style>

      <div
        style={{
          position: "relative",
          width: "100vw",
          height: "100vh",
          overflow: "hidden",
          fontFamily: "'Tajawal',sans-serif",
          direction: "rtl",
          background:
            "linear-gradient(180deg,hsl(195,55%,48%) 0%,hsl(200,60%,38%) 30%,hsl(205,65%,28%) 60%,hsl(210,70%,20%) 100%)",
        }}
      >
        {/* Water effects */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 0,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              width: "60%",
              background:
                "radial-gradient(ellipse 100% 100% at 50% 50%,rgba(255,255,255,0.18) 0%,transparent 60%)",
              animation: "wave-sweep 5s ease-in-out infinite",
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "radial-gradient(ellipse at 40% 30%,rgba(255,255,255,0.13),transparent 60%)",
              animation: "shimmer-move 8s ease-in-out infinite",
            }}
          />
          {bubbles.map((b) => (
            <div
              key={b.key}
              style={{
                position: "absolute",
                borderRadius: "50%",
                background: "rgba(255,255,255,0.12)",
                width: b.w,
                height: b.w,
                left: `${b.left}%`,
                bottom: `${b.bottom}%`,
                animation: `float-bubble ${b.dur}s ease-in-out ${b.delay}s infinite`,
              }}
            />
          ))}
        </div>

        {/* Version selector — نفس الصفحة لثلاث شاشات العرض */}
        {/* يختفي في وضع ملء الشاشة ويعود عند الخروج */}
        <div
          style={{
            position: "absolute",
            top: 14,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 140,
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: 6,
            borderRadius: 19,
            background: "rgba(15,23,42,0.58)",
            border: "2px solid rgba(255,255,255,0.28)",
            backdropFilter: "blur(14px)",
            boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
            opacity: isFullscreen ? 0 : 1,
            pointerEvents: isFullscreen ? "none" : "auto",
            visibility: isFullscreen ? "hidden" : "visible",
            transition: "opacity 0.35s ease, visibility 0.35s ease",
          }}
        >
          {([1, 2, 3] as const).map((version) => {
            const active = selectedVersion === version;
            const count = version === 1 ? 8 : version === 2 ? 6 : 5;
            return (
              <button
                key={version}
                onClick={() => setSelectedVersion(version)}
                className="smooth-btn"
                style={{
                  minWidth: 96,
                  padding: "9px 14px",
                  borderRadius: 15,
                  border: "1px solid transparent",
                  background: active
                    ? `linear-gradient(180deg, ${VERSION_ACCENTS[version]}, ${VERSION_ACCENTS[version]}bb)`
                    : "rgba(255,255,255,0.12)",
                  color: active ? "#fff" : "rgba(255,255,255,0.85)",
                  fontFamily: "'Tajawal',sans-serif",
                  fontWeight: 900,
                  fontSize: 13,
                  cursor: "pointer",
                  transform: active ? "translateY(-2px)" : "translateY(0)",
                  boxShadow: active
                    ? `0 6px 0 ${VERSION_ACCENTS[version]}77, inset 0 2px 0 rgba(255,255,255,0.35), inset 0 -3px 0 rgba(0,0,0,0.12)`
                    : "none",
                  whiteSpace: "nowrap",
                  textShadow: active ? "0 2px 4px rgba(0,0,0,0.25)" : "none",
                }}
              >
                {VERSION_ICONS[version]} نسخة {version}
                <span
                  style={{
                    marginRight: 6,
                    fontSize: 10,
                    fontWeight: 900,
                    background: active
                      ? "rgba(255,255,255,0.22)"
                      : "rgba(255,255,255,0.08)",
                    borderRadius: 999,
                    padding: "2px 7px",
                    color: active
                      ? "rgba(255,255,255,0.92)"
                      : "rgba(255,255,255,0.5)",
                  }}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* SVG Path */}
        <svg
          viewBox="0 0 100 100"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            zIndex: 1,
          }}
          preserveAspectRatio="none"
        >
          <path
            d={svgPath}
            fill="none"
            stroke="rgba(0,0,0,0.12)"
            strokeWidth="1.0"
            strokeLinecap="round"
          />
          <path
            d={svgPath}
            fill="none"
            stroke="hsl(45,85%,62%)"
            strokeWidth="0.45"
            strokeDasharray="1.5 1.8"
            strokeLinecap="round"
          />
        </svg>

        {/* Islands & Squares */}
        {positions.map((pos, i) => {
          const isIsland = ISLAND_INDICES.includes(i);
          const islandIdx = ISLAND_INDICES.indexOf(i);
          const cost = POINTS_PER_SQUARE * i;
          return (
            <div
              key={`node-${i}`}
              style={{
                position: "absolute",
                left: `${pos.x}%`,
                top: `${pos.y}%`,
                transform: "translate(-50%,-50%)",
                zIndex: isIsland ? 10 : 5,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
              }}
            >
              {isIsland ? (
                <>
                  {[0, 1, 2].map((r) => (
                    <div
                      key={r}
                      style={{
                        position: "absolute",
                        borderRadius: "50%",
                        border: "1px solid rgba(103,232,249,0.12)",
                        inset: -12 - r * 8,
                        animation: `wave-ring 4s ease-out ${r * 0.8}s infinite`,
                      }}
                    />
                  ))}
                  <img
                    src={ISLAND_IMAGES[islandIdx]}
                    alt="island"
                    style={{
                      width: ISLAND_SIZES[islandIdx],
                      filter: "drop-shadow(0 10px 15px rgba(0,0,0,0.45))",
                      zIndex: 2,
                      position: "relative",
                    }}
                  />
                  {(islandIdx === 0 || islandIdx === 1) && (
                    <div
                      style={{
                        position: "absolute",
                        top: "-5%",
                        left: islandIdx === 0 ? "20%" : "70%",
                        transformOrigin: "bottom center",
                        animation: "palm-sway 4s ease-in-out infinite",
                        zIndex: 3,
                      }}
                    >
                      <span style={{ fontSize: 22 }}>🌴</span>
                    </div>
                  )}
                  <div
                    style={{
                      color: "#fde047",
                      fontWeight: 900,
                      fontSize: 12,
                      marginTop: 5,
                      textShadow:
                        "0 2px 4px rgba(0,0,0,1),-1px -1px 0 #000,1px 1px 0 #000",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {ISLAND_NAMES[islandIdx]}
                  </div>
                  {i !== 0 && (
                    <div
                      style={{
                        color: "#fde047",
                        fontSize: 10,
                        marginTop: 2,
                        fontWeight: 800,
                        textShadow: "0 1px 3px rgba(0,0,0,1)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      🪙{formatPoints(cost)}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      transform: "rotate(45deg)",
                      display: "flex",
                      justifyContent: "center",
                      alignItems: "center",
                      background:
                        "linear-gradient(135deg,rgba(255,255,255,0.25),rgba(255,255,255,0.08))",
                      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                      border: "1.5px solid rgba(255,255,255,0.25)",
                    }}
                  >
                    <span
                      style={{
                        transform: "rotate(-45deg)",
                        fontSize: 11,
                        fontWeight: "bold",
                        color: "#fff",
                        opacity: 0.85,
                      }}
                    >
                      {i}
                    </span>
                  </div>
                  <div
                    style={{
                      color: "#fde047",
                      fontSize: 9,
                      marginTop: 4,
                      fontWeight: 700,
                      textShadow: "0 1px 3px rgba(0,0,0,1)",
                    }}
                  >
                    🪙{formatPoints(cost)}
                  </div>
                </>
              )}
            </div>
          );
        })}

        {/* Ships */}
        {[...teams]
          .sort((a, b) => compareTeamsBySlot(a, b))
          .map((team, myIdx) => {
            const target = getShipPos(team);
            const leading = isLeader(team);
            const shipTransitionMs = transitionDurations[team.id] ?? 140;
            const shipLocationPoints = target.effectivePts;
            return (
              <div
                key={team.id}
                style={{
                  position: "absolute",
                  left: `${target.x}%`,
                  top: `${target.y}%`,
                  transition:
                    shipTransitionMs === 0
                      ? `opacity 180ms ease, filter 180ms ease`
                      : `left ${shipTransitionMs}ms cubic-bezier(0.25,0.46,0.45,0.94),top ${shipTransitionMs}ms cubic-bezier(0.25,0.46,0.45,0.94),opacity 180ms ease,filter 180ms ease`,
                  transform: "translate(-50%,-50%)",
                  // عند فتح الإعدادات تبقى السفن خلف النافذة ولا تبرز من خلال الخلفية.
                  opacity: showSettings ? 0.06 : 1,
                  filter: showSettings ? "blur(2px)" : "none",
                  pointerEvents: showSettings ? "none" : "auto",
                  zIndex: showSettings
                    ? 0
                    : 20 +
                      Math.round(target.boardIndex) +
                      (team.slot || myIdx),
                }}
              >
                <div
                  style={{
                    position: "relative",
                    width: 64,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    animation: `ship-wave 5s ease-in-out ${myIdx * 0.3}s infinite`,
                    filter:
                      movingId === team.id
                        ? `drop-shadow(0 0 16px ${getTeamColor(team)})`
                        : "none",
                    transition: "filter 0.5s",
                  }}
                >
                  {leading && (
                    <div
                      style={{
                        position: "absolute",
                        top: "-52px",
                        left: "50%",
                        transform: "translateX(-50%)",
                        zIndex: 99999,
                        pointerEvents: "none",
                        fontSize: "38px",
                        lineHeight: 1,
                        filter:
                          "drop-shadow(0 0 8px #ffd34d) drop-shadow(0 0 20px #ffae00)",
                        textShadow: "0 0 10px rgba(0,0,0,0.9)",
                        animation: "crownBob 1.6s ease-in-out infinite",
                      }}
                    >
                      👑
                    </div>
                  )}
                  <RealisticShip color={getTeamColor(team)} />
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 800,
                      textAlign: "center",
                      marginTop: 4,
                      whiteSpace: "nowrap",
                      color: "#fff",
                      textShadow:
                        "0 2px 4px rgba(0,0,0,1),-1px -1px 0 #000,1px 1px 0 #000",
                    }}
                  >
                    {displayName(team)}
                  </div>

                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      textAlign: "center",
                      color: "#fde047",
                      textShadow: "0 1px 3px rgba(0,0,0,1)",
                      marginTop: 2,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {formatPoints(shipLocationPoints)} نقطة
                  </div>

                  {movingId === team.id && (
                    <div
                      style={{
                        position: "absolute",
                        top: -16,
                        left: "50%",
                        transform: "translateX(-50%)",
                        fontSize: 11,
                        fontWeight: 700,
                        color: "#fde047",
                        whiteSpace: "nowrap",
                        textShadow: "0 0 8px rgba(253,224,71,0.8)",
                        animation: "island-glow 0.6s ease-in-out infinite",
                      }}
                    >
                      ⛵ يتحرك...
                    </div>
                  )}
                </div>
              </div>
            );
          })}

        {/* Logo */}
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            zIndex: 100,
            animation:
              "logo-float 4s ease-in-out infinite, logo-glow 4s ease-in-out infinite",
            cursor: "default",
            userSelect: "none",
          }}
        >
          <img
            src={`data:image/png;base64,${LOGO_B64}`}
            alt="ربيع القلوب"
            style={{
              width: "clamp(48px,11vw,90px)",
              height: "clamp(48px,11vw,90px)",
              objectFit: "contain",
            }}
          />
        </div>

        {/* Fullscreen & Settings buttons */}
        <div
          style={{
            position: "fixed",
            bottom: 18,
            right: 18,
            zIndex: 130,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <button
            onClick={toggleFullscreen}
            title={isFullscreen ? "تصغير" : "ملء الشاشة"}
            className="smooth-btn"
            style={{
              width: 42,
              height: 42,
              borderRadius: "50%",
              border: "1px solid rgba(255,255,255,0.22)",
              background:
                "linear-gradient(180deg,rgba(56,189,248,0.32),rgba(15,23,42,0.7))",
              backdropFilter: "blur(10px)",
              color: "rgba(255,255,255,0.92)",
              fontSize: 17,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow:
                "0 4px 16px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.18)",
            }}
          >
            {isFullscreen ? "⊡" : "⛶"}
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="smooth-btn"
            style={{
              width: 42,
              height: 42,
              borderRadius: "50%",
              border: "1px solid rgba(255,255,255,0.22)",
              background:
                "linear-gradient(180deg,rgba(167,139,250,0.32),rgba(15,23,42,0.7))",
              backdropFilter: "blur(10px)",
              color: "rgba(255,255,255,0.92)",
              fontSize: 17,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow:
                "0 4px 16px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.18)",
            }}
          >
            ⚙️
          </button>
        </div>

        {/* Move ships button */}
        {pendingPos && (
          <button
            onClick={handleMoveShips}
            disabled={isMoving}
            className={isMoving ? "btn-float" : "btn-float btn-shine"}
            style={{
              position: "fixed",
              bottom: 24,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 150,
              padding: "16px 44px",
              borderRadius: 26,
              border: "none",
              background: isMoving
                ? "#475569"
                : "linear-gradient(180deg,#22c55e,#15803d)",
              color: "#fff",
              fontSize: 18,
              fontWeight: 900,
              fontFamily: "'Tajawal',sans-serif",
              cursor: isMoving ? "not-allowed" : "pointer",
              animation: isMoving
                ? "none"
                : "move-ready 1.5s ease-in-out infinite",
              boxShadow: isMoving
                ? "0 6px 30px rgba(0,0,0,0.5)"
                : "0 8px 34px rgba(34,197,94,0.45), inset 0 1px 0 rgba(255,255,255,0.3)",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            {isMoving ? "⏳ تتحرك سفينة..." : "🚢 تحريك السفن"}
          </button>
        )}

        <Announcement ann={announcement!} />

        {showSettings && (
          <SettingsPanel
            teams={teams}
            onClose={() => setShowSettings(false)}
            currentPositions={displayPositions}
            onMovePending={(pending) => {
              setPendingPos(pending);
              setShowSettings(false);
            }}
            onAdjustPoints={handleAdjustPoints}
            onResetAll={handleResetAll}
          />
        )}
      </div>
      <style>{`
        @keyframes crownBob {
          0%, 100% { transform: translateX(-50%) translateY(0) rotate(-3deg); }
          50% { transform: translateX(-50%) translateY(-6px) rotate(3deg); }
        }

        @keyframes sparkle {
          0%, 100% { opacity: 0; transform: scale(0.4) rotate(0deg); }
          50% { opacity: 1; transform: scale(1.2) rotate(180deg); }
        }
      `}</style>
    </>
  );
}