import { useState, useEffect, useRef } from "react";
import * as wsClient from "../websocket/websocketClient";

// ── Types ──────────────────────────────────────────────────────────────
interface Team {
  id: string;
  points: number;
  color: string;
  name?: string;
  slot?: number;
  version?: number;
  /**
   * Canonical board position received from the server.
   * New values are stored in square-index units:
   * 0 = start, 1 = 50 points, 4 = 200 points.
   */
  position?: number;
  roundPoints?: number;
}

interface ToastData {
  msg: string;
  ok: boolean;
}

interface LastAction {
  teamId: string;
  teamName: string;
  teamColor: string;
  /**
   * Delta actually applied to the race total. In normal registration this is
   * the same as the displayed points. In replacement it can be negative.
   */
  points: number;
  /** Points to show in DisplayPage announcement without changing race totals. */
  displayPoints?: number;
  /** Actual race delta, used by undo when displayPoints differs from points. */
  deltaPoints?: number;
  /** True when this is only a re-show of an old registration. */
  displayOnly?: boolean;
  /** نسخة العرض (1/2/3) حتى يظهر الإعلان على جهاز DisplayPage المطابق فقط. */
  version?: number;
  studentName: string;
  createdAt: number;
}

interface RegistrationPayload {
  studentName: string;
  teamId: string;
  teamName: string;
  date: string;
  hudur: boolean | null;
  hifzFrom: string | null;
  hifzTo: string | null;
  hifzScore: number | string | null;
  muraFrom: string | null;
  muraTo: string | null;
  muraScore: number | string | null;
  haqiba: boolean | null;
  istima: boolean | null;
  totalPoints: number;
  notes: string;
  /** بنود التسجيل الديناميكية: تعريف البنود وقيمها يرسل مع كل حفظ. */
  regItems?: RegItem[];
  itemValues?: Record<string, any>;
}

type RegItemType = "points" | "yesno" | "range";

// بند تسجيل يحدده المعلم من الإعدادات ويتزامن على كل الأجهزة.
interface RegItem {
  id: string;
  label: string;
  type: RegItemType;
  points: number;
}

// قيمة بند داخل نموذج التسجيل — كل نوع يستخدم الحقول المناسبة له.
interface RegItemValue {
  on: boolean;           // type=points: مفعّل؟
  value: boolean | null; // type=yesno: نعم/لا
  range: SurahRange;     // type=range: من/إلى
  absent: boolean;       // type=range: لم يسمع
  score: number | null;  // type=range: النقاط المختارة لهذا الطالب (30/25/20) — null = نقاط البند الافتراضية
}


interface StudentProfile {
  name: string;
  track: Exclude<FirstCircleTrack, null> | null;
  trackLabel: string;
}

interface SchoolClass {
  id: string;
  classId: string;
  name: string;
  className: string;
  sheetId: number;
  slot: number;
  version: 1 | 2 | 3;
  displayVersion: 1 | 2 | 3;
  students: string[];
}

type ClassFilter = "all" | 1 | 2 | 3;

type FirstCircleTrack = "nurania" | "tilawa" | "hifz-review" | null;
type FirstCircleScore = number | "absent" | null;

// ── Constants ──────────────────────────────────────────────────────────
// مسارات حلقة أولى مؤجلة حاليًا. غيّر القيمة إلى true مستقبلًا لإعادتها.
const ENABLE_FIRST_CIRCLE_TRACKS = false;

const FIRST_CIRCLE_TRACKS: { id: Exclude<FirstCircleTrack, null>; label: string; icon: string }[] = [
  { id: "nurania", label: "القاعدة النورانية", icon: "🔤" },
  { id: "tilawa", label: "التلاوة", icon: "📖" },
  { id: "hifz-review", label: "الحفظ والمراجعة", icon: "🕌" },
];

function normalizeFirstCircleTrack(value: unknown): Exclude<FirstCircleTrack, null> {
  const text = String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

  if (text === "nurania" || text.includes("نوراني")) return "nurania";
  if (text === "tilawa" || text.includes("تلاو")) return "tilawa";
  return "hifz-review";
}

function getFirstCircleTrackMeta(track: FirstCircleTrack) {
  return FIRST_CIRCLE_TRACKS.find((item) => item.id === track) || FIRST_CIRCLE_TRACKS[2];
}

const NURANIA_LESSONS = [
  "الدرس الأول", "الدرس الثاني", "الدرس الثالث", "الدرس الرابع", "الدرس الخامس",
  "الدرس السادس", "الدرس السابع", "الدرس الثامن", "الدرس التاسع", "الدرس العاشر",
  "الدرس الحادي عشر", "الدرس الثاني عشر", "الدرس الثالث عشر", "الدرس الرابع عشر",
  "الدرس الخامس عشر", "الدرس السادس عشر", "الدرس السابع عشر",
];

const LEGACY_TEAM_NAMES: Record<string, string> = {
  blue:   "حلقة أولى",
  red:    "حلقة ثاني",
  green:  "حلقة ثالث",
  purple: "حلقة رابع",
};

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

// ألوان الفلاتر والتبويبات حسب النسخة — للمسات الجمالية فقط.
const VERSION_ACCENT: Record<string, string> = {
  all: "#38bdf8",
  "1": "#38bdf8",
  "2": "#a78bfa",
  "3": "#fbbf24",
};
const DISPLAY_EVENT_STORAGE_KEY = "sailor-race:display-event";
const DISPLAY_EVENT_CHANNEL = "sailor-race-display-events";

function publishLocalDisplayEvent(action: LastAction) {
  if (typeof window === "undefined") return;

  const event = {
    ...action,
    eventId: `${action.createdAt || Date.now()}-${Math.random().toString(36).slice(2)}`,
    createdAt: action.createdAt || Date.now(),
  };

  try {
    window.localStorage.setItem(DISPLAY_EVENT_STORAGE_KEY, JSON.stringify(event));
  } catch (err) {
    console.warn("Display localStorage event skipped:", err);
  }

  try {
    const channel = new BroadcastChannel(DISPLAY_EVENT_CHANNEL);
    channel.postMessage(event);
    channel.close();
  } catch (err) {
    // BroadcastChannel غير مدعوم في بعض المتصفحات؛ localStorage يكفي كاحتياط.
  }
}


const SCORE_STORAGE_KEY = "sailor-race:persistent-team-points";
const RESET_STORAGE_KEY = "sailor-race:last-reset-at";
const RESET_GRACE_MS = 12000;

function storageAvailable(): boolean {
  return typeof window !== "undefined" && !!window.localStorage;
}

function safeNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}


const POINTS_PER_SQUARE = 50;
const TOTAL_POSITIONS = 22;
const POSITION_EPSILON = 0.0001;

function formatPoints(value: number): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  return Math.ceil(safeValue).toLocaleString();
}

function pointsToIndex(pts: number): number {
  const maxIndex = TOTAL_POSITIONS - 1;
  const safePts = Number.isFinite(pts) ? pts : 0;
  return Math.max(0, Math.min(safePts / POINTS_PER_SQUARE, maxIndex));
}

function indexToPoints(index: number): number {
  return index * POINTS_PER_SQUARE;
}

function storedPositionToIndex(
  rawPosition: number | undefined,
  fallbackPoints?: number,
): number {
  const raw = Number(rawPosition ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;

  const maxIndex = TOTAL_POSITIONS - 1;
  const safeFallbackPoints = Number(fallbackPoints ?? NaN);

  if (raw > maxIndex) return pointsToIndex(raw);

  if (
    Number.isFinite(safeFallbackPoints) &&
    Math.abs(raw - safeFallbackPoints) <= POSITION_EPSILON &&
    Math.abs(raw - pointsToIndex(safeFallbackPoints)) > POSITION_EPSILON
  ) {
    return pointsToIndex(raw);
  }

  return Math.max(0, Math.min(raw, maxIndex));
}

function getTeamLocationPoints(team: Team): number {
  return indexToPoints(storedPositionToIndex(team.position, team.points));
}

function readStoredScores(): Record<string, number> {
  if (!storageAvailable()) return {};
  try {
    const raw = window.localStorage.getItem(SCORE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeStoredScoresFromTeams(teams: Team[]) {
  if (!storageAvailable()) return;
  const scores: Record<string, number> = {};
  teams.forEach((team) => {
    scores[team.id] = Math.max(0, safeNumber(team.points));
  });
  window.localStorage.setItem(SCORE_STORAGE_KEY, JSON.stringify(scores));
}

function markScoreReset() {
  if (!storageAvailable()) return;
  window.localStorage.removeItem(SCORE_STORAGE_KEY);
  window.localStorage.setItem(RESET_STORAGE_KEY, String(Date.now()));
}

function isRecentScoreReset(): boolean {
  if (!storageAvailable()) return false;
  const resetAt = safeNumber(window.localStorage.getItem(RESET_STORAGE_KEY));
  return resetAt > 0 && Date.now() - resetAt < RESET_GRACE_MS;
}

function isFullZeroResetState(teams: Team[]): boolean {
  return (
    teams.length > 0 &&
    teams.every(
      (team) =>
        safeNumber(team.points) === 0 &&
        safeNumber((team as Team & { position?: number }).position) === 0,
    )
  );
}

function mergeTeamsWithPersistentScores(incomingTeams: Team[], previousTeams: Team[]): Team[] {
  if (incomingTeams.length === 0) return incomingTeams;

  if (isFullZeroResetState(incomingTeams) || isRecentScoreReset()) {
    if (storageAvailable()) window.localStorage.removeItem(SCORE_STORAGE_KEY);
    return incomingTeams.map((team) => ({ ...team, points: safeNumber(team.points) }));
  }

  const storedScores = readStoredScores();
  const previousById = new Map(previousTeams.map((team) => [team.id, team]));

  const merged = incomingTeams.map((team) => {
    const incomingPoints = safeNumber(team.points);
    const previousPoints = safeNumber(previousById.get(team.id)?.points);
    const storedPoints = safeNumber(storedScores[team.id]);

    // نحافظ على النقاط إذا أرسل السيرفر صفر بالغلط بعد تحريك السفن.
    // التصفير الحقيقي يتم فقط من زر إعادة/تصفير اللعبة.
    const preservedPoints = Math.max(previousPoints, storedPoints);
    const points = incomingPoints === 0 && preservedPoints > 0 ? preservedPoints : incomingPoints;

    return { ...team, points };
  });

  writeStoredScoresFromTeams(merged);
  return merged;
}
const MEDALS = ["🥇", "🥈", "🥉", "🏅"];

type TeamStudents = Record<string, StudentProfile[]>;

function normalizeSchoolClasses(payload: any): SchoolClass[] {
  const rawClasses = Array.isArray(payload?.classes) ? payload.classes : [];
  const seen = new Set<string>();

  return rawClasses
    .map((item: any): SchoolClass | null => {
      const classId = String(item?.classId || item?.id || "").trim();
      const className = String(item?.className || item?.name || "").trim();
      const sheetId = Number(item?.sheetId);
      const slot = Number(item?.slot);
      const version = Number(item?.version ?? item?.displayVersion);
      if (!classId || !className || !Number.isFinite(sheetId) || !Number.isFinite(slot)) return null;
      if (![1, 2, 3].includes(version)) return null;
      if (seen.has(classId)) return null;
      seen.add(classId);

      const students: string[] = Array.isArray(item?.students)
        ? Array.from(new Set<string>(
            item.students
              .map((name: unknown) => String(name || "").trim())
              .filter((name: string) => name.length > 0),
          ))
        : [];

      return {
        id: classId,
        classId,
        name: className,
        className,
        sheetId,
        slot,
        version: version as 1 | 2 | 3,
        displayVersion: version as 1 | 2 | 3,
        students,
      };
    })
    .filter((item: SchoolClass | null): item is SchoolClass => item !== null)
    .sort((a: SchoolClass, b: SchoolClass) => a.slot - b.slot);
}

// ── كاش الفصول ──────────────────────────────────────────────────────────
// نحفظ آخر نسخة ناجحة من getClasses في المتصفح حتى تفتح صفحة الأدمن فوراً
// بآخر البيانات بدل انتظار Google Sheets، ويتم التحديث في الخلفية.
const CLASSES_CACHE_KEY = "sailor-race:classes-cache-v1";

function readCachedClasses(): SchoolClass[] {
  if (!storageAvailable()) return [];
  try {
    const raw = window.localStorage.getItem(CLASSES_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return normalizeSchoolClasses(Array.isArray(parsed) ? { classes: parsed } : parsed);
  } catch {
    return [];
  }
}

function writeCachedClasses(classes: SchoolClass[]) {
  if (!storageAvailable()) return;
  try {
    window.localStorage.setItem(CLASSES_CACHE_KEY, JSON.stringify(classes));
  } catch {
    // تجاهل أخطاء التخزين (مثل وضع التصفح الخاص)
  }
}

function loadClassesFromSheets(url: string): Promise<SchoolClass[]> {
  return new Promise((resolve, reject) => {
    if (!url.includes("script.google.com")) {
      resolve([]);
      return;
    }
    if (typeof window === "undefined" || typeof document === "undefined") {
      resolve([]);
      return;
    }

    const callbackName = `__sailorClasses_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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
      reject(new Error("انتهت مهلة تحميل الفصول؛ تأكد من نشر Apps Script الجديد"));
    }, 30000);

    (window as any)[callbackName] = (payload: any) => {
      const classes = normalizeSchoolClasses(payload);
      cleanup();
      if (payload?.status === "error") {
        reject(new Error(payload?.message || "تعذر تحميل الفصول من Google Sheets"));
        return;
      }
      resolve(classes);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("تعذر تحميل الفصول من Google Sheets"));
    };

    const separator = url.includes("?") ? "&" : "?";
    script.src = `${url}${separator}action=getClasses&callback=${encodeURIComponent(callbackName)}&_=${Date.now()}`;
    document.body.appendChild(script);
  });
}


function callAppsScriptJsonp(
  url: string,
  action: string,
  params: Record<string, string> = {},
  timeoutMs = 25000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!url.includes("script.google.com")) {
      reject(new Error("رابط Apps Script غير مضبوط"));
      return;
    }
    if (typeof window === "undefined" || typeof document === "undefined") {
      reject(new Error("لا يمكن تنفيذ العملية من هذا المتصفح"));
      return;
    }

    const callbackName = `__sailorAction_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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
      reject(new Error("انتهت مهلة تنفيذ أمر Google Sheets؛ تأكد من نشر Apps Script الجديد ثم جرّب مرة أخرى"));
    }, timeoutMs);

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


// null = لم يسمع (تُستخدم لمسارات حلقة أولى الخاصة فقط)
const MEM_OPTIONS: (number | null)[] = [30, 25, 20, null];

// ── Quran Data ─────────────────────────────────────────────────────────
const SURAHS: { name: string; ayahs: number }[] = [
  { name: "الفاتحة", ayahs: 7 }, { name: "البقرة", ayahs: 286 }, { name: "آل عمران", ayahs: 200 },
  { name: "النساء", ayahs: 176 }, { name: "المائدة", ayahs: 120 }, { name: "الأنعام", ayahs: 165 },
  { name: "الأعراف", ayahs: 206 }, { name: "الأنفال", ayahs: 75 }, { name: "التوبة", ayahs: 129 },
  { name: "يونس", ayahs: 109 }, { name: "هود", ayahs: 123 }, { name: "يوسف", ayahs: 111 },
  { name: "الرعد", ayahs: 43 }, { name: "إبراهيم", ayahs: 52 }, { name: "الحجر", ayahs: 99 },
  { name: "النحل", ayahs: 128 }, { name: "الإسراء", ayahs: 111 }, { name: "الكهف", ayahs: 110 },
  { name: "مريم", ayahs: 98 }, { name: "طه", ayahs: 135 }, { name: "الأنبياء", ayahs: 112 },
  { name: "الحج", ayahs: 78 }, { name: "المؤمنون", ayahs: 118 }, { name: "النور", ayahs: 64 },
  { name: "الفرقان", ayahs: 77 }, { name: "الشعراء", ayahs: 227 }, { name: "النمل", ayahs: 93 },
  { name: "القصص", ayahs: 88 }, { name: "العنكبوت", ayahs: 69 }, { name: "الروم", ayahs: 60 },
  { name: "لقمان", ayahs: 34 }, { name: "السجدة", ayahs: 30 }, { name: "الأحزاب", ayahs: 73 },
  { name: "سبأ", ayahs: 54 }, { name: "فاطر", ayahs: 45 }, { name: "يس", ayahs: 83 },
  { name: "الصافات", ayahs: 182 }, { name: "ص", ayahs: 88 }, { name: "الزمر", ayahs: 75 },
  { name: "غافر", ayahs: 85 }, { name: "فصلت", ayahs: 54 }, { name: "الشورى", ayahs: 53 },
  { name: "الزخرف", ayahs: 89 }, { name: "الدخان", ayahs: 59 }, { name: "الجاثية", ayahs: 37 },
  { name: "الأحقاف", ayahs: 35 }, { name: "محمد", ayahs: 38 }, { name: "الفتح", ayahs: 29 },
  { name: "الحجرات", ayahs: 18 }, { name: "ق", ayahs: 45 }, { name: "الذاريات", ayahs: 60 },
  { name: "الطور", ayahs: 49 }, { name: "النجم", ayahs: 62 }, { name: "القمر", ayahs: 55 },
  { name: "الرحمن", ayahs: 78 }, { name: "الواقعة", ayahs: 96 }, { name: "الحديد", ayahs: 29 },
  { name: "المجادلة", ayahs: 22 }, { name: "الحشر", ayahs: 24 }, { name: "الممتحنة", ayahs: 13 },
  { name: "الصف", ayahs: 14 }, { name: "الجمعة", ayahs: 11 }, { name: "المنافقون", ayahs: 11 },
  { name: "التغابن", ayahs: 18 }, { name: "الطلاق", ayahs: 12 }, { name: "التحريم", ayahs: 12 },
  { name: "الملك", ayahs: 30 }, { name: "القلم", ayahs: 52 }, { name: "الحاقة", ayahs: 52 },
  { name: "المعارج", ayahs: 44 }, { name: "نوح", ayahs: 28 }, { name: "الجن", ayahs: 28 },
  { name: "المزمل", ayahs: 20 }, { name: "المدثر", ayahs: 56 }, { name: "القيامة", ayahs: 40 },
  { name: "الإنسان", ayahs: 31 }, { name: "المرسلات", ayahs: 50 }, { name: "النبأ", ayahs: 40 },
  { name: "النازعات", ayahs: 46 }, { name: "عبس", ayahs: 42 }, { name: "التكوير", ayahs: 29 },
  { name: "الانفطار", ayahs: 19 }, { name: "المطففين", ayahs: 36 }, { name: "الانشقاق", ayahs: 25 },
  { name: "البروج", ayahs: 22 }, { name: "الطارق", ayahs: 17 }, { name: "الأعلى", ayahs: 19 },
  { name: "الغاشية", ayahs: 26 }, { name: "الفجر", ayahs: 30 }, { name: "البلد", ayahs: 20 },
  { name: "الشمس", ayahs: 15 }, { name: "الليل", ayahs: 21 }, { name: "الضحى", ayahs: 11 },
  { name: "الشرح", ayahs: 8 }, { name: "التين", ayahs: 8 }, { name: "العلق", ayahs: 19 },
  { name: "القدر", ayahs: 5 }, { name: "البينة", ayahs: 8 }, { name: "الزلزلة", ayahs: 8 },
  { name: "العاديات", ayahs: 11 }, { name: "القارعة", ayahs: 11 }, { name: "التكاثر", ayahs: 8 },
  { name: "العصر", ayahs: 3 }, { name: "الهمزة", ayahs: 9 }, { name: "الفيل", ayahs: 5 },
  { name: "قريش", ayahs: 4 }, { name: "الماعون", ayahs: 7 }, { name: "الكوثر", ayahs: 3 },
  { name: "الكافرون", ayahs: 6 }, { name: "النصر", ayahs: 3 }, { name: "المسد", ayahs: 5 },
  { name: "الإخلاص", ayahs: 4 }, { name: "الفلق", ayahs: 5 }, { name: "الناس", ayahs: 6 },
];

// قائمة عرض السور داخل الاختيار: من الناس في الأعلى إلى البقرة في الأسفل.
// نحتفظ بترتيب SURAHS الأصلي للتخزين والتقارير، ونستخدم هذه القائمة للعرض فقط.
const PICKER_SURAHS = SURAHS
  .map((surah, index) => ({ ...surah, index }))
  .filter((surah) => surah.name !== "الفاتحة")
  .reverse();

// ── بنود التسجيل الديناميكية ────────────────────────────────────────
// الإدارة تحدد البنود (الاسم + النقاط + النوع) من إعدادات الصفحة،
// وتتزامن على كل أجهزة المعلمين عبر Script Properties في Google Sheets.
const DEFAULT_REG_ITEMS: RegItem[] = [
  { id: "hudur", label: "الحضور", type: "points", points: 10 },
  { id: "hifz", label: "الحفظ", type: "range", points: 30 },
  { id: "murajaa", label: "المراجعة", type: "range", points: 30 },
  { id: "haqiba", label: "إحضار الحقيبة", type: "yesno", points: 10 },
  { id: "istima", label: "الاستماع", type: "yesno", points: 20 },
];
const REG_ITEMS_CACHE_KEY = "sailor-race:reg-items-cache-v1";
const REG_ITEMS_TYPE_LABELS: Record<RegItemType, string> = {
  points: "➕ إضافة نقاط",
  yesno: "✅ نعم / لا",
  range: "📖 سورة من وإلى",
};
// بند «سورة من وإلى» نقاطه من خيارات محددة فقط (مثل الحفظ والمراجعة).
const REG_ITEMS_RANGE_POINTS_OPTIONS = [30, 25, 20];

function normalizeRegItem(item: any): RegItem {
  return {
    id: String(item?.id || "").trim(),
    label: String(item?.label || "").trim(),
    type: item?.type === "yesno" || item?.type === "range" ? item.type : "points",
    points: Math.max(0, safeNumber(item?.points)),
  };
}

function readCachedRegItems(): RegItem[] {
  if (!storageAvailable()) return [];
  try {
    const raw = window.localStorage.getItem(REG_ITEMS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map(normalizeRegItem)
        .filter((item: RegItem) => item.label.trim() !== "");
    }
    return [];
  } catch {
    return [];
  }
}

function writeCachedRegItems(items: RegItem[]) {
  if (!storageAvailable()) return;
  try {
    window.localStorage.setItem(REG_ITEMS_CACHE_KEY, JSON.stringify(items));
  } catch {
    // تجاهل أخطاء التخزين (مثل وضع التصفح الخاص)
  }
}

const APPS_SCRIPT_URL = String(import.meta.env.VITE_APPS_URL || "");

// ── Helpers ────────────────────────────────────────────────────────────
function firstCircleTrackScore(value: FirstCircleScore): number {
  if (value === "absent" || value === null) return 0;
  return (Number(value) || 0) * 2;
}

// قيمة فارغة لبند — كل نوع يستخدم الحقول المناسبة له.
const emptyRegItemValue = (): RegItemValue => ({
  on: false,
  value: null,
  range: emptySurahRange(),
  absent: false,
  score: null,
});

// النقاط الفعلية لبند «سورة من وإلى»: إن اختار المعلم 30/25/20 نستخدمها،
// وإلا نقاط البند الافتراضية (ولو كانت خارج الخيارات نرجع لأول خيار).
function regItemRangeScore(item: RegItem, value?: RegItemValue): number {
  const chosen = value?.score;
  if (typeof chosen === "number" && Number.isFinite(chosen) && chosen > 0) return chosen;
  if (REG_ITEMS_RANGE_POINTS_OPTIONS.includes(item.points)) return item.points;
  return REG_ITEMS_RANGE_POINTS_OPTIONS[0];
}

// نقاط البند حسب قيمته الحالية.
function regItemPoints(item: RegItem, value?: RegItemValue): number {
  if (!value) return 0;
  if (item.type === "points") return value.on ? item.points : 0;
  if (item.type === "yesno") return value.value === true ? item.points : 0;
  if (item.type === "range")
    return value.absent ? 0 : isSurahRangeComplete(value.range) ? regItemRangeScore(item, value) : 0;
  return 0;
}

// هل للبند قيمة مختارة (حتى لو صفر نقطة)؟
function regItemHasData(item: RegItem, value?: RegItemValue): boolean {
  if (!value) return false;
  if (item.type === "points") return value.on;
  if (item.type === "yesno") return value.value !== null;
  if (item.type === "range")
    return value.absent || value.range.from.surahIndex !== null || value.range.to.surahIndex !== null;
  return false;
}

// هل اختار المعلم طرفاً واحداً فقط (من بلا إلى أو العكس)؟ يمنع التسجيل حتى يكتمل.
function regItemHasPartialRange(value?: RegItemValue): boolean {
  if (!value || value.absent) return false;
  const from = value.range.from.surahIndex !== null;
  const to = value.range.to.surahIndex !== null;
  return from !== to;
}

// سطر ملخص البند لبطاقة «يُضاف الآن».
function regItemSummaryText(
  item: RegItem,
  value?: RegItemValue,
): { label: string; value: string } | null {
  if (!regItemHasData(item, value)) return null;
  if (item.type === "points")
    return value!.on ? { label: item.label, value: `+${item.points}` } : { label: item.label, value: "0" };
  if (item.type === "yesno")
    return value!.value === true
      ? { label: item.label, value: `+${item.points}` }
      : { label: item.label, value: "0" };
  if (value!.absent) return { label: item.label, value: "لم يسمع" };
  const label = surahRangeLabel(value!.range);
  return {
    label: item.label,
    value: isSurahRangeComplete(value!.range) ? `+${regItemRangeScore(item, value)}` : label || "0",
  };
}

function getRiyadhDateISO(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find((p) => p.type === "year")?.value || "";
  const month = parts.find((p) => p.type === "month")?.value || "";
  const day = parts.find((p) => p.type === "day")?.value || "";

  return `${year}-${month}-${day}`;
}

// ── Sub-components ─────────────────────────────────────────────────────
const OptionBtn: React.FC<{
  active: boolean;
  onClick: () => void;
  accentColor?: string;
  danger?: boolean;
  children: React.ReactNode;
}> = ({ active, onClick, accentColor = "#6366f1", danger = false, children }) => {
  const activeColor = danger ? "#7f1d1d" : accentColor;
  const activeBorder = danger ? "#ef4444" : accentColor;
  return (
    <button
      onClick={onClick}
      className="smooth-btn"
      style={{
        flex: 1,
        padding: "13px 4px",
        borderRadius: 14,
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 800,
        fontFamily: "'Tajawal',sans-serif",
        background: active
          ? `linear-gradient(180deg, ${activeColor}, ${activeColor}cc)`
          : "rgba(255,255,255,0.06)",
        color: active ? "#fff" : "rgba(255,255,255,0.5)",
        boxShadow: active
          ? `0 4px 16px ${activeBorder}55, inset 0 1px 0 rgba(255,255,255,0.25)`
          : "inset 0 1px 0 rgba(255,255,255,0.04)",
        border: `1.5px solid ${active ? activeBorder : "rgba(255,255,255,0.1)"}`,
      }}
    >
      {children}
    </button>
  );
};

// نقطة واحدة = سورة + آية
interface SurahPoint {
  surahIndex: number | null;
  ayah: number | null;
}

// نطاق: من سورة+آية → إلى سورة+آية
interface SurahRange {
  from: SurahPoint;
  to: SurahPoint;
}

const emptySurahPoint = (): SurahPoint => ({ surahIndex: null, ayah: null });
const emptySurahRange = (): SurahRange => ({ from: emptySurahPoint(), to: emptySurahPoint() });

function surahRangeLabel(r: SurahRange): string {
  const fromName = r.from.surahIndex !== null ? SURAHS[r.from.surahIndex].name : null;
  const toName   = r.to.surahIndex   !== null ? SURAHS[r.to.surahIndex].name   : null;
  if (!fromName && !toName) return "";
  if (fromName && toName) {
    if (r.from.surahIndex === r.to.surahIndex)
      return `${fromName} (${r.from.ayah ?? "?"} - ${r.to.ayah ?? "?"})`;
    return `${fromName} آية ${r.from.ayah ?? "?"} → ${toName} آية ${r.to.ayah ?? "?"}`;
  }
  return fromName ? `من ${fromName} آية ${r.from.ayah ?? "?"}` : `إلى ${toName} آية ${r.to.ayah ?? "?"}`;
}

function formatSurahPoint(point: SurahPoint): string {
  if (point.surahIndex === null) return "";

  const surah = SURAHS[point.surahIndex];
  if (!surah) return "";

  // إذا اختار السورة فقط بدون رقم آية، نكتب اسم السورة فقط.
  if (point.ayah === null || point.ayah === undefined || String(point.ayah).trim() === "") {
    return surah.name;
  }

  // إذا اختار السورة والآية، نكتب: اسم السورة آية رقم.
  return `${surah.name} آية ${point.ayah}`;
}

function isSurahRangeComplete(range: SurahRange): boolean {
  return (
    range.from.surahIndex !== null &&
    range.to.surahIndex !== null
  );
}

// نوع الـ picker المفتوح: أي بند من نوع «سورة من وإلى» وأي طرف نختار له
type PickerTarget = { itemId: string; side: "from" | "to" } | null;

// ── Main Component ─────────────────────────────────────────────────────
export default function AdminPage() {
  // ── WebSocket state ──────────────────────────────────────────────────
  const [teams, setTeams] = useState<Team[]>([]);
  const [schoolClasses, setSchoolClasses] = useState<SchoolClass[]>([]);
  const rawServerPointsRef = useRef<Record<string, number>>({});
  // يحفظ عمليات الحفظ الجارية في الخلفية لكل (فصل|تاريخ|طالب)
  // حتى تصل كتابات قوقل شيت بالترتيب ولا تتخطى بعضها عند التسجيل المتوازي.
  const pendingSheetSavesRef = useRef<Record<string, Promise<any>>>({});
  const [lastAction, setLastAction] = useState<LastAction | null>(null);

  // ── Form state ───────────────────────────────────────────────────────
  const [studentName, setStudent] = useState<string>("");
  const [selectedTeam, setSelected] = useState<string>("");
  // بنود التسجيل الديناميكية وقيمها في النموذج الحالي.
  const [regItems, setRegItems] = useState<RegItem[]>(DEFAULT_REG_ITEMS);
  const [itemValues, setItemValues] = useState<Record<string, RegItemValue>>({});

  // ── مسارات حلقة أولى ───────────────────────────────────────────────
  const [firstCircleTrack, setFirstCircleTrack] = useState<FirstCircleTrack>(null);
  const [firstCircleScoreValue, setFirstCircleScoreValue] = useState<FirstCircleScore>(null);
  const [nuraniaLesson, setNuraniaLesson] = useState<number | null>(null);
  const [lessonPickerOpen, setLessonPickerOpen] = useState(false);
  const [lessonSearch, setLessonSearch] = useState("");
  const [nuraniaFromText, setNuraniaFromText] = useState("");
  const [nuraniaToText, setNuraniaToText] = useState("");
  const [tilawaSurah, setTilawaSurah] = useState<number | null>(null);
  const [tilawaPickerOpen, setTilawaPickerOpen] = useState(false);
  const [tilawaFromAyah, setTilawaFromAyah] = useState("");
  const [tilawaToAyah, setTilawaToAyah] = useState("");

  // ── Surah state ──────────────────────────────────────────────────────
  const [pickerTarget, setPickerTarget] = useState<PickerTarget>(null);
  const [surahSearch, setSurahSearch] = useState("");

  // ── UI state ─────────────────────────────────────────────────────────
  const [sending, setSending] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [toast, setToast] = useState<ToastData | null>(null);
  // عدّاد جلسة التسجيل: عدد المحفوظ في الشيت وعدد ما زال قيد الحفظ بالخلفية.
  const [sheetStats, setSheetStats] = useState<{ saved: number; pending: number }>({ saved: 0, pending: 0 });
  const [quickMode, setQuickMode] = useState(false);
  const [quickPts, setQuickPts] = useState("");
  const [syncSheet, setSyncSheet] = useState(true);
  const [showReset, setShowReset] = useState(false);
  const [resetScope, setResetScope] = useState<"today" | "all">("today");
  const [resetPassword, setResetPassword] = useState("");
  const [resetting, setResetting] = useState(false);
  const [teamStudents, setTeamStudents] = useState<TeamStudents>({});
  const [studentsLoading, setStudentsLoading] = useState(false);
  const [studentsError, setStudentsError] = useState("");
  const [studentsReloadKey, setStudentsReloadKey] = useState(0);
  const [classFilter, setClassFilter] = useState<ClassFilter>("all");
  // ── إعدادات بنود التسجيل ───────────────────────────────────────────
  const [showItemsSettings, setShowItemsSettings] = useState(false);
  const [itemsDraft, setItemsDraft] = useState<RegItem[]>([]);
  const [itemsSaving, setItemsSaving] = useState(false);
  const [itemsPassword, setItemsPassword] = useState("");

  // ── Derived values ───────────────────────────────────────────────────
  const isFirstCircle = selectedTeam === "blue";
  const usesFirstCircleSpecialTrack = ENABLE_FIRST_CIRCLE_TRACKS && isFirstCircle && (firstCircleTrack === "nurania" || firstCircleTrack === "tilawa");
  const specialTrackPoints = firstCircleTrackScore(firstCircleScoreValue);

  const liveTeamById = new Map(teams.map((team) => [team.id, team]));
  const classTeams: Team[] = schoolClasses.map((schoolClass) => {
    const live = liveTeamById.get(schoolClass.classId);
    return {
      id: schoolClass.classId,
      name: schoolClass.className,
      slot: schoolClass.slot,
      version: schoolClass.version,
      color: classColorBySlot(schoolClass.slot, schoolClass.version),
      points: safeNumber(live?.points),
      position: live?.position,
      roundPoints: live?.roundPoints,
    };
  });
  const classById = new Map(schoolClasses.map((schoolClass) => [schoolClass.classId, schoolClass]));
  const getTeamName = (teamId: string, fallback = "") =>
    classById.get(teamId)?.className || LEGACY_TEAM_NAMES[teamId] || fallback || teamId;
  const visibleClassTeams = classTeams.filter((team) =>
    classFilter === "all" ? true : team.version === classFilter,
  );
  const accentColor = classTeams.find((t) => t.id === selectedTeam)?.color || "#6366f1";
  // الترتيب الحالي في AdminPage يعرض متصدرًا واحدًا فقط من كل نسخة (3 فصول إجمالاً).
  const ranked = ([1, 2, 3] as const)
    .map((version) =>
      [...classTeams]
        .filter((team) => team.version === version)
        .sort((a, b) => getTeamLocationPoints(b) - getTeamLocationPoints(a))[0],
    )
    .filter((team): team is Team => Boolean(team))
    .sort((a, b) => getTeamLocationPoints(b) - getTeamLocationPoints(a));

  // بنود «سورة من وإلى»: يمنع التسجيل إذا اختار طرفاً واحداً فقط.
  const incompleteRangeItems = regItems.filter(
    (item) => item.type === "range" && regItemHasPartialRange(itemValues[item.id]),
  );
  const requiredRangesComplete = incompleteRangeItems.length === 0;

  const firstTrackDetailsComplete =
    !ENABLE_FIRST_CIRCLE_TRACKS ||
    !isFirstCircle ||
    firstCircleTrack === "hifz-review" ||
    firstCircleScoreValue === "absent" ||
    (firstCircleTrack === "nurania" &&
      nuraniaLesson !== null &&
      nuraniaFromText.trim() !== "" &&
      nuraniaToText.trim() !== "") ||
    (firstCircleTrack === "tilawa" &&
      tilawaSurah !== null &&
      tilawaFromAyah.trim() !== "" &&
      tilawaToAyah.trim() !== "");

  const dynamicPreview = regItems.reduce(
    (sum, item) => sum + regItemPoints(item, itemValues[item.id]),
    0,
  );
  // للمسارات الخاصة (نورانية/تلاوة) تُحسب نقاط البند من التقييم،
  // وبقية البنود (نقاط/نعم-لا) تُضاف من النموذج الديناميكي.
  const preview = usesFirstCircleSpecialTrack
    ? specialTrackPoints +
      regItems
        .filter((item) => item.type !== "range")
        .reduce((sum, item) => sum + regItemPoints(item, itemValues[item.id]), 0)
    : dynamicPreview;

  const hasRegistrationData = usesFirstCircleSpecialTrack
    ? firstCircleScoreValue !== null || regItems.some((item) => regItemHasData(item, itemValues[item.id]))
    : regItems.some((item) => regItemHasData(item, itemValues[item.id]));

  const canSubmit =
    !!studentName &&
    !!selectedTeam &&
    (!ENABLE_FIRST_CIRCLE_TRACKS || !isFirstCircle || firstCircleTrack !== null) &&
    hasRegistrationData &&
    firstTrackDetailsComplete &&
    requiredRangesComplete &&
    !sending;
  const canQuick = !!studentName && !!selectedTeam && selectedTeam !== "blue" && !!quickPts && !sending;

  // ── Effects ──────────────────────────────────────────────────────────
  useEffect(() => {
    document.body.className = "admin-page";
    return () => { document.body.className = ""; };
  }, []);

  // ملاحظة مهمة:
  // أوقفنا استدعاء dailyMaintenance عند فتح الصفحة لأنه كان يلمس أوراق الأسماء
  // وقد يسبب اختفاء/تأخر انتقال أسماء الطلاب من Google Sheets إلى AdminPage.

  useEffect(() => {
    let active = true;
    let retryTimer: number | undefined;

    if (!APPS_SCRIPT_URL.includes("script.google.com")) {
      setTeamStudents({});
      setStudentsError("رابط Apps Script غير مضبوط في VITE_APPS_URL");
      return () => { active = false; };
    }

    // نعرض فوراً آخر نسخة ناجحة من الفصول (من الكاش) حتى لا ينتظر المعلم،
    // ثم نحدّث من Google Sheets في الخلفية.
    const cachedClasses = readCachedClasses();
    if (cachedClasses.length) {
      setSchoolClasses(cachedClasses);
      const cachedStudents: TeamStudents = {};
      cachedClasses.forEach((schoolClass) => {
        cachedStudents[schoolClass.classId] = schoolClass.students.map((name) => ({
          name,
          track: null,
          trackLabel: "",
        }));
      });
      setTeamStudents(cachedStudents);
    }

    // بنود التسجيل: نعرض المحفوظة فوراً ثم نحدّث من Script Properties في الخلفية،
    // حتى تظهر البنود الجديدة التي عدّلها أي معلم على جميع الأجهزة.
    const cachedRegItems = readCachedRegItems();
    if (cachedRegItems.length) setRegItems(cachedRegItems);
    const applyRegItems = (res: any) => {
      if (!active) return;
      if (res?.status === "ok" && Array.isArray(res.items) && res.items.length) {
        const items = res.items
          .map(normalizeRegItem)
          .filter((item: RegItem) => item.label.trim() !== "");
        setRegItems(items);
        writeCachedRegItems(items);
      }
    };
    callAppsScriptJsonp(APPS_SCRIPT_URL, "getRegItems", {}, 20000)
      .then(applyRegItems)
      .catch(() => {
        // يبقى الكاش المحلي معروضاً حتى ينجح الاتصال.
      });

    // تحديث دوري خفيف للبنود حتى تصل التغييرات إلى كل الأجهزة
    // حتى لو لم تُعد فتح الصفحة أو لم يعد التركيز للنافذة.
    const itemsTimer = window.setInterval(() => {
      callAppsScriptJsonp(APPS_SCRIPT_URL, "getRegItems", {}, 20000)
        .then(applyRegItems)
        .catch(() => {});
    }, 90000);

    const applyClasses = (classes: SchoolClass[]) => {
      setSchoolClasses(classes);
      writeCachedClasses(classes);
      wsClient.syncClasses(
        classes.map((schoolClass) => ({
          ...schoolClass,
          color: classColorBySlot(schoolClass.slot, schoolClass.version),
        })),
      );
      const studentsByClass: TeamStudents = {};
      classes.forEach((schoolClass) => {
        studentsByClass[schoolClass.classId] = schoolClass.students.map((name) => ({
          name,
          track: null,
          trackLabel: "",
        }));
      });
      setTeamStudents(studentsByClass);
      setStudentsError("");
    };

    const tryLoad = (): Promise<boolean> =>
      loadClassesFromSheets(APPS_SCRIPT_URL)
        .then((classes) => {
          applyClasses(classes);
          return true;
        })
        .catch((err: Error) => {
          if (active) {
            setStudentsError(err.message || "تعذر تحميل الفصول والطلاب");
          }
          return false;
        });

    setStudentsLoading(true);
    setStudentsError("");

    tryLoad().then((ok) => {
      if (!active) return;
      if (ok) {
        setStudentsLoading(false);
        return;
      }
      // فشلت المحاولة الأولى → محاولة ثانية تلقائية بعد ثانيتين
      // حتى لا يضطر المعلم للضغط على زر 🔄 الفصول يدوياً.
      retryTimer = window.setTimeout(() => {
        if (!active) return;
        setStudentsLoading(true);
        tryLoad().finally(() => {
          if (!active) return;
          setStudentsLoading(false);
        });
      }, 2000);
    });

    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      window.clearInterval(itemsTimer);
    };
  }, [studentsReloadKey]);

  useEffect(() => {
    const refreshOnFocus = () => setStudentsReloadKey((value) => value + 1);
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, []);


  // @ts-ignore
  useEffect(() => {
    const unsub = wsClient.subscribe((state: any) => {
      const incomingTeams = (state.teams || []) as Team[];
      rawServerPointsRef.current = Object.fromEntries(
        incomingTeams.map((team) => [team.id, safeNumber(team.points)]),
      );
      setTeams((previousTeams) =>
        mergeTeamsWithPersistentScores(incomingTeams, previousTeams),
      );
      setLastAction(state.lastAction || null);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  // Reset student name and the special First Circle path when team changes.
  useEffect(() => {
    setStudent("");
    setFirstCircleTrack(null);
    setFirstCircleScoreValue(null);
    setNuraniaLesson(null);
    setLessonPickerOpen(false);
    setLessonSearch("");
    setNuraniaFromText("");
    setNuraniaToText("");
    setTilawaSurah(null);
    setTilawaPickerOpen(false);
    setTilawaFromAyah("");
    setTilawaToAyah("");
    setItemValues({});
  }, [selectedTeam]);

  // ── Helpers ──────────────────────────────────────────────────────────
  const showToast = (msg: string, ok = true) => setToast({ msg, ok });

  // ── إعدادات بنود التسجيل (تتزامن على كل أجهزة المعلمين) ────────────
  const addItemDraft = () =>
    setItemsDraft((prev) => [
      ...prev,
      { id: `reg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, label: "", type: "points", points: 10 },
    ]);
  const updateItemDraft = (index: number, patch: Partial<RegItem>) =>
    setItemsDraft((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  const moveItemDraft = (index: number, delta: number) =>
    setItemsDraft((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      const tmp = next[index];
      next[index] = next[target];
      next[target] = tmp;
      return next;
    });
  const removeItemDraft = (index: number) =>
    setItemsDraft((prev) => prev.filter((_, i) => i !== index));
  const resetItemsDraft = () =>
    setItemsDraft(DEFAULT_REG_ITEMS.map((item) => ({ ...item })));

  const saveItemsDraft = async () => {
    if (itemsSaving) return;
    const clean = itemsDraft.filter((item) => item.label.trim() !== "");
    if (clean.length === 0) {
      showToast("❌ أضف بنداً واحداً على الأقل واكتب اسمه", false);
      return;
    }
    if (new Set(clean.map((item) => item.id)).size !== clean.length) {
      showToast("❌ يوجد بندان بنفس المعرف — أزل أحدهما", false);
      return;
    }
    // الحفظ محمي بكلمة مرور الإدارة حتى لا يغيّر أي معلم البنود عن غير قصد.
    if (!itemsPassword.trim()) {
      showToast("🔒 أدخل كلمة مرور الإدارة لحفظ البنود", false);
      return;
    }
    setItemsSaving(true);
    try {
      const result = await callAppsScriptJsonp(APPS_SCRIPT_URL, "saveRegItems", {
        payload: JSON.stringify(clean),
        password: itemsPassword.trim(),
      }, 30000);
      if (result?.status === "error") {
        throw new Error(result.message || "تعذر حفظ البنود");
      }
      const saved: RegItem[] = Array.isArray(result?.items)
        ? result.items.map(normalizeRegItem).filter((item: RegItem) => item.label.trim() !== "")
        : clean;
      setRegItems(saved);
      writeCachedRegItems(saved);
      setItemsDraft(saved.map((item) => ({ ...item })));
      setShowItemsSettings(false);
      setItemsPassword("");
      setItemValues({});
      showToast("✅ تم حفظ البنود وتحديثها عند الجميع");
    } catch (err: any) {
      showToast("❌ " + (err?.message ?? "تعذر حفظ البنود"), false);
    } finally {
      setItemsSaving(false);
    }
  };


  // ⚠️ تمت إزالة دالة "ensureServerPointsSynced" التي كانت موجودة هنا سابقاً.
  // كانت تستدعي wsClient.adjustPoints(teamId, difference) قبل كل إرسال نقاط،
  // وهذا كان يسبب تصفير roundPoints بالخطأ: لو اختلفت نقاط العميل المحلية
  // (teams) عن آخر نقطة معروفة من السيرفر — حتى بسبب تأخر طبيعي بالشبكة —
  // كانت ترسل فرق سالب كبير إلى adjustPoints، والذي يُعدّل roundPoints أيضاً
  // (انظر server.ts: case "adjustPoints")، فيصفّر تقدم الجولة قبل تحريك السفن.
  // السيرفر يضيف النقاط تراكمياً بشكل صحيح من نفسه عبر applyAddPoints، فلا
  // حاجة لأي "مزامنة" يدوية من العميل.

  const resetForm = () => {
    // بعد التسجيل نرجع الشاشة لاختيار الفصل من جديد
    // ونمسح الطالب والبيانات المختارة حتى يبدأ المعلم تسجيلاً جديداً بسرعة.
    setSelected("");
    setStudent("");
    setItemValues({});
    setFirstCircleTrack(null);
    setFirstCircleScoreValue(null);
    setNuraniaLesson(null);
    setLessonPickerOpen(false);
    setLessonSearch("");
    setNuraniaFromText("");
    setNuraniaToText("");
    setTilawaSurah(null);
    setTilawaPickerOpen(false);
    setTilawaFromAyah("");
    setTilawaToAyah("");
    setSurahSearch("");
    setQuickPts("");
  };

  // ── Google Sheets sync ───────────────────────────────────────────────
  const buildRegistrationPayload = (): RegistrationPayload => {
    const totalPoints = preview;

    if (isFirstCircle && firstCircleTrack === "nurania") {
      const lessonLabel = nuraniaLesson !== null ? NURANIA_LESSONS[nuraniaLesson] : "";
      const fromText = nuraniaFromText.trim();
      const toText = nuraniaToText.trim();
      return {
        studentName: studentName.trim(),
        teamId: selectedTeam,
        teamName: getTeamName(selectedTeam),
        date: getRiyadhDateISO(),
        hudur: true,
        hifzFrom: firstCircleScoreValue === "absent"
          ? null
          : `${lessonLabel} — من: ${fromText}`,
        hifzTo: firstCircleScoreValue === "absent" ? null : `إلى: ${toText}`,
        hifzScore: firstCircleScoreValue === "absent" ? "لم يسمع" : specialTrackPoints,
        muraFrom: null,
        muraTo: null,
        muraScore: null,
        haqiba: null,
        istima: null,
        totalPoints,
        notes: "مسار: القاعدة النورانية",
      };
    }

    if (isFirstCircle && firstCircleTrack === "tilawa") {
      const surahName = tilawaSurah !== null ? SURAHS[tilawaSurah]?.name || "" : "";
      return {
        studentName: studentName.trim(),
        teamId: selectedTeam,
        teamName: getTeamName(selectedTeam),
        date: getRiyadhDateISO(),
        hudur: true,
        hifzFrom: firstCircleScoreValue === "absent"
          ? null
          : `${surahName} — من آية ${tilawaFromAyah.trim()}`,
        hifzTo: firstCircleScoreValue === "absent"
          ? null
          : `${surahName} — إلى آية ${tilawaToAyah.trim()}`,
        hifzScore: firstCircleScoreValue === "absent" ? "لم يسمع" : specialTrackPoints,
        muraFrom: null,
        muraTo: null,
        muraScore: null,
        haqiba: null,
        istima: null,
        totalPoints,
        notes: "مسار: التلاوة",
      };
    }

    // المسار القياسي: البنود الديناميكية التي تحددها الإدارة.
    // نرسل تعريف البنود وقيمها، والخادم يحسب المجموع منها ليتطابق
    // مع كل الأجهزة حتى لو تغيّرت البنود لاحقاً.
    const itemValuesPayload: Record<string, any> = {};
    regItems.forEach((item) => {
      const v = itemValues[item.id];
      if (!v) return;
      if (item.type === "points") {
        itemValuesPayload[item.id] = v.on;
      } else if (item.type === "yesno") {
        itemValuesPayload[item.id] = v.value;
      } else {
        itemValuesPayload[item.id] = v.absent
          ? "absent"
          : {
              from: formatSurahPoint(v.range.from),
              to: formatSurahPoint(v.range.to),
              score: regItemRangeScore(item, v),
            };
      }
    });

    return {
      studentName: studentName.trim(),
      teamId: selectedTeam,
      teamName: getTeamName(selectedTeam),
      date: getRiyadhDateISO(),
      hudur: true,
      hifzFrom: null,
      hifzTo: null,
      hifzScore: null,
      muraFrom: null,
      muraTo: null,
      muraScore: null,
      haqiba: null,
      istima: null,
      regItems: regItems.map((item) => ({ ...item })),
      itemValues: itemValuesPayload,
      totalPoints,
      notes: "",
    };
  };

  const saveRegistrationToSheets = async (
    payload: RegistrationPayload,
    mode: "create" | "merge" | "replace" = "merge",
  ): Promise<any> => {
    if (!syncSheet || !APPS_SCRIPT_URL.includes("script.google.com")) {
      return {
        status: "local-only",
        existed: false,
        oldTotal: 0,
        newTotal: payload.totalPoints,
        delta: payload.totalPoints,
      };
    }

    // محاولة واحدة إضافية تلقائية عند أي فشل (شبكة أو مهلة أو خطأ عابر)
    // قبل إرجاع نقاط السباق، حتى لا يخسر المعلم التسجيل بسبب خطأ مؤقت.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await callAppsScriptJsonp(APPS_SCRIPT_URL, "saveEntry", {
          mode,
          payload: JSON.stringify(payload),
        }, 30000);

        if (result?.status === "error") {
          throw new Error(result.message || "تعذر حفظ التسجيل في Google Sheets");
        }

        // Code.gs الآن يزامن تقرير الحلقة فوراً داخل saveEntry،
        // لذلك لا نرسل طلبات تحديث طابور إضافية حتى لا تتراكم وتسبب تأخيراً.
        return result;
      } catch (err) {
        if (attempt === 1) {
          await new Promise((resolve) => setTimeout(resolve, 800));
          continue;
        }
        throw err;
      }
    }
  };


  // ── WebSocket helpers ────────────────────────────────────────────────
  const recordLastAction = (
    team: Team,
    pts: number,
    name: string,
  ) => {
    // Store last action via wsClient so it persists to the server state
    const action: LastAction = {
      teamId:      team.id,
      teamName:    getTeamName(team.id, team.name || team.id),
      teamColor:   team.color,
      points:      pts,
      version:     team.version,
      studentName: name,
      createdAt:   Date.now(),
    };
    // نرسل نسخة محلية أيضاً حتى تظهر في DisplayPage حتى لو لم يبث السيرفر lastAction.
    publishLocalDisplayEvent(action);

    // wsClient.setLastAction is called if the method exists; otherwise we
    // keep local state as fallback (server may broadcast it back via subscribe)
    if (typeof (wsClient as any).setLastAction === "function") {
      (wsClient as any).setLastAction(action);
    } else {
      setLastAction(action);
    }
  };


  // ── Submit (full system) ─────────────────────────────────────────────
  const handleSubmit = async () => {
    if (ENABLE_FIRST_CIRCLE_TRACKS && isFirstCircle && !firstCircleTrack) {
      showToast("❌ مسار الطالب غير محدد. حدده من العمود B في شيت حلقة أولى ثم حدّث قائمة الطلاب.", false);
      return;
    }

    if (
      isFirstCircle &&
      firstCircleTrack === "nurania" &&
      firstCircleScoreValue !== "absent" &&
      (nuraniaLesson === null || nuraniaFromText.trim() === "" || nuraniaToText.trim() === "")
    ) {
      showToast("❌ اختر درس القاعدة النورانية واكتب من وإلى، أو اختر «لم يسمع».", false);
      return;
    }

    if (isFirstCircle && firstCircleTrack === "tilawa" && firstCircleScoreValue !== "absent") {
      const fromAyah = Number(tilawaFromAyah);
      const toAyah = Number(tilawaToAyah);
      const maxAyahs = tilawaSurah !== null ? SURAHS[tilawaSurah]?.ayahs || 0 : 0;

      if (tilawaSurah === null || !Number.isInteger(fromAyah) || !Number.isInteger(toAyah)) {
        showToast("❌ اختر سورة التلاوة واكتب رقم آية من وإلى، أو اختر «لم يسمع».", false);
        return;
      }
      if (fromAyah < 1 || toAyah < 1 || fromAyah > maxAyahs || toAyah > maxAyahs) {
        showToast(`❌ أرقام الآيات يجب أن تكون بين 1 و${maxAyahs}.`, false);
        return;
      }
      if (fromAyah > toAyah) {
        showToast("❌ رقم آية «من» يجب ألا يكون أكبر من رقم آية «إلى».", false);
        return;
      }
    }

    if (incompleteRangeItems.length > 0) {
      const names = incompleteRangeItems.map((item) => item.label).join(" و");
      showToast(`❌ أكمل «من» و«إلى» في ${names}، أو اختر «لم يسمع».`, false);
      return;
    }

    if (!canSubmit) return;

    setSending(true);
    const team = classTeams.find((t) => t.id === selectedTeam)!;
    let payload: RegistrationPayload | null = null;
    let teamName = "";

    try {
      payload = buildRegistrationPayload();
      const savedPayload = payload;
      teamName = getTeamName(savedPayload.teamId, savedPayload.teamName || savedPayload.teamId);
      const registrationPoints = Math.max(0, safeNumber(savedPayload.totalPoints));

      // 1) السباق فوراً: السفينة تتحرك لحظياً بدون انتظار قوقل شيت.
      //    التسجيل المتكرر مسموح: كل تسجيل يضيف كامل نقاطه للسباق،
      //    بينما يحتفظ قوقل شيت بأحدث حالة للطالب في اليوم.
      wsClient.addPointsToTeam(
        savedPayload.teamId,
        registrationPoints,
        savedPayload.studentName,
        teamName,
        team.version,
      );
      recordLastAction(team, registrationPoints, savedPayload.studentName);

      // 2) رسالة النجاح فوراً وإعادة فتح النموذج — المعلم لا ينتظر قوقل شيت إطلاقاً.
      const parts: string[] = [];
      if (usesFirstCircleSpecialTrack) {
        parts.push(firstCircleTrack === "nurania" ? "نورانية" : "تلاوة");
      } else {
        regItems.forEach((item) => {
          const v = itemValues[item.id];
          if (!v) return;
          if (item.type === "points" && v.on) parts.push(`${item.label} +${item.points}`);
          else if (item.type === "yesno" && v.value === true) parts.push(`${item.label} ✔`);
          else if (item.type === "range" && v.absent) parts.push(`${item.label}: لم يسمع`);
          else if (item.type === "range" && isSurahRangeComplete(v.range)) parts.push(`${item.label} +${regItemRangeScore(item, v)}`);
        });
      }

      showToast(`✅ ${savedPayload.studentName} — ${parts.join(" | ")} (+${registrationPoints})`);
      resetForm();
      setSending(false);

      // 3) حفظ قوقل شيت في الخلفية: يبدأ فوراً ولا يعلّق الزر.
      //    لو فشل الحفظ نهائياً (بعد إعادة المحاولة داخل saveRegistrationToSheets)
      //    نرجع نقاط هذا التسجيل فقط من السباق تلقائياً.
      const saveKey = `${savedPayload.teamId}|${savedPayload.date}|${savedPayload.studentName}`;
      const previousSave = pendingSheetSavesRef.current[saveKey];
      const thisSave = (async () => {
        // ننتظر أي حفظ سابق لنفس الطالب/اليوم حتى تصل الكتابات بالترتيب.
        if (previousSave) {
          try { await previousSave; } catch { /* فشل سابق تمت معالجته */ }
        }
        return saveRegistrationToSheets(savedPayload, "replace");
      })();
      pendingSheetSavesRef.current[saveKey] = thisSave;

      setSheetStats((s) => ({ ...s, pending: s.pending + 1 }));

      thisSave
        .then((result: any) => {
          const savedToSheet = result?.status !== "local-only";
          setSheetStats((s) => ({
            saved: s.saved + (savedToSheet ? 1 : 0),
            pending: Math.max(0, s.pending - 1),
          }));
        })
        .catch((err: any) => {
          setSheetStats((s) => ({ ...s, pending: Math.max(0, s.pending - 1) }));
          wsClient.addPointsToTeam(
            savedPayload.teamId,
            -Math.max(0, safeNumber(savedPayload.totalPoints)),
            "",
            teamName,
            team.version,
          );
          if (typeof (wsClient as any).setLastAction === "function") {
            (wsClient as any).setLastAction(null);
          } else {
            setLastAction(null);
          }
          showToast("❌ " + (err?.message ?? "خطأ") + " — تم إرجاع نقاط السباق", false);
        })
        .finally(() => {
          if (pendingSheetSavesRef.current[saveKey] === thisSave) {
            delete pendingSheetSavesRef.current[saveKey];
          }
        });

      return;
    } catch (e: any) {
      // خطأ قبل بدء أي إجراء (مثل بناء البيانات) — لم تُضف أي نقاط بعد.
      showToast("❌ " + (e?.message ?? "خطأ"), false);
      setSending(false);
    }
  };

  // ── Quick add ────────────────────────────────────────────────────────
  const handleQuick = async () => {
    if (!canQuick) return;
    setSending(true);
    const pts = parseInt(quickPts, 10);
    const team = classTeams.find((t) => t.id === selectedTeam)!;
    try {
      wsClient.addPointsToTeam(
        selectedTeam,
        pts,
        studentName.trim(),
        getTeamName(selectedTeam),
        team.version,
      );
      recordLastAction(team, pts, studentName.trim());
      showToast(`✅ تمت إضافة ${pts} نقطة`);
      setSelected("");
      setStudent("");
      setQuickPts("");
    } catch (e: any) {
      showToast("❌ " + (e?.message ?? "خطأ"), false);
    }
    setSending(false);
  };

  // ── Undo ─────────────────────────────────────────────────────────────
  const handleUndo = async () => {
    if (!lastAction || undoing) return;
    setUndoing(true);
    try {
      const undoDelta = Number((lastAction as any).deltaPoints ?? lastAction.points) || 0;
      wsClient.addPointsToTeam(
        lastAction.teamId,
        -undoDelta,
        "",
        lastAction.teamName,
        lastAction.version,
      );

      if (typeof (wsClient as any).setLastAction === "function") {
        (wsClient as any).setLastAction(null);
      } else {
        setLastAction(null);
      }

      showToast(`↩️ تم التراجع: ${lastAction.points > 0 ? "−" + lastAction.points : "+" + Math.abs(lastAction.points)} من ${lastAction.teamName}`);
    } catch (e: any) {
      showToast("❌ " + (e?.message ?? "خطأ"), false);
    }
    setUndoing(false);
  };

  // ── Reset data ───────────────────────────────────────────────────────
  const applyRemovedTodayPointsToGame = (removedPointsByTeam?: Record<string, number>) => {
    const removed = removedPointsByTeam || {};
    const entries = schoolClasses
      .map((schoolClass) => [schoolClass.classId, Math.max(0, safeNumber(removed[schoolClass.classId]))] as const)
      .filter(([, pts]) => pts > 0);

    if (!entries.length) return;

    setTeams((previousTeams) => {
      const nextTeams = previousTeams.map((team) => {
        const removedPts = Math.max(0, safeNumber(removed[team.id]));
        if (!removedPts) return team;
        return { ...team, points: Math.max(0, safeNumber(team.points) - removedPts) };
      });
      writeStoredScoresFromTeams(nextTeams);
      return nextTeams;
    });

    entries.forEach(([teamId, pts]) => {
      try {
        wsClient.addPointsToTeam(
          teamId,
          -pts,
          "",
          getTeamName(teamId),
        );
      } catch (err) {
        console.warn("Today reset point rollback failed:", teamId, err);
      }
    });
  };

  const handleReset = async () => {
    const password = resetPassword.trim();

    if (!password) {
      showToast("❌ أدخل كلمة مرور التصفير", false);
      return;
    }

    setResetting(true);
    try {
      if (!APPS_SCRIPT_URL.includes("script.google.com")) {
        throw new Error("رابط Apps Script غير مضبوط");
      }

      const action = resetScope === "today" ? "clearToday" : "clearAll";
      const clearResult = await callAppsScriptJsonp(APPS_SCRIPT_URL, action, {
        password,
      }, 45000);

      if (resetScope === "today") {
        if (clearResult?.status !== "clearedToday") {
          throw new Error(clearResult?.message || "تعذر تصفير بيانات اليوم");
        }

        applyRemovedTodayPointsToGame(clearResult.removedPointsByTeam || {});

        if (typeof (wsClient as any).setLastAction === "function") {
          (wsClient as any).setLastAction(null);
        } else {
          setLastAction(null);
        }

        setShowReset(false);
        setResetPassword("");
        setStudentsReloadKey((v) => v + 1);
        showToast(
          `✅ تم تصفير بيانات اليوم (${clearResult.deletedRows || 0} سجل)`,
        );
        return;
      }

      if (clearResult?.status !== "cleared") {
        throw new Error(clearResult?.message || "كلمة مرور التصفير غير صحيحة");
      }

      const teamsSnapshot = [...teams];
      markScoreReset();
      rawServerPointsRef.current = {};
      setTeams((previousTeams) => {
        const resetTeams = previousTeams.map((team) => ({ ...team, points: 0 }));
        writeStoredScoresFromTeams(resetTeams);
        return resetTeams;
      });

      if (typeof (wsClient as any).resetGame === "function") {
        (wsClient as any).resetGame();
      } else {
        teamsSnapshot.forEach((team) => {
          const deficit = -safeNumber(team.points);
          if (deficit !== 0) {
            wsClient.addPointsToTeam(team.id, deficit, "", getTeamName(team.id, team.name || team.id));
          }
        });
      }

      if (typeof (wsClient as any).setLastAction === "function") {
        (wsClient as any).setLastAction(null);
      } else {
        setLastAction(null);
      }

      setShowReset(false);
      setResetPassword("");
      showToast("✅ تم تصفير جميع الأيام بنجاح");
    } catch (e: any) {
      showToast("❌ " + (e?.message ?? "خطأ"), false);
    } finally {
      setResetting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div style={S.page}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700;800;900&display=swap');
        html, body, #root { overflow-y: auto; }
        input::placeholder { color: rgba(255,255,255,0.25); }
        @keyframes slideDown {
          from { opacity:0; transform:translateX(-50%) translateY(-14px); }
          to   { opacity:1; transform:translateX(-50%) translateY(0); }
        }
        /* زر كرتوني: حدود سميكة + ظل صلب سفلي (تأثير 3D) + ضغطة نازلة واضحة */
        .smooth-btn {
          transition: transform 0.14s ease, box-shadow 0.14s ease, filter 0.16s ease, background 0.2s ease, border-color 0.2s ease, color 0.2s ease !important;
          will-change: transform;
          border: 3px solid rgba(0,0,0,0.30) !important;
          box-shadow: 0 5px 0 rgba(0,0,0,0.38), inset 0 2px 0 rgba(255,255,255,0.35), inset 0 -3px 0 rgba(0,0,0,0.15) !important;
        }
        .smooth-btn:hover:not(:disabled) {
          transform: translateY(-2px) !important;
          filter: brightness(1.08);
          box-shadow: 0 7px 0 rgba(0,0,0,0.38), inset 0 2px 0 rgba(255,255,255,0.40), inset 0 -3px 0 rgba(0,0,0,0.15) !important;
        }
        .smooth-btn:active:not(:disabled) {
          transform: translateY(4px) !important;
          filter: brightness(0.96);
          box-shadow: 0 1px 0 rgba(0,0,0,0.38), inset 0 2px 0 rgba(255,255,255,0.28), inset 0 -2px 0 rgba(0,0,0,0.15) !important;
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

      {/* ── Toast ── */}
      {toast && (
        <div
          style={{
            position: "fixed",
            top: 20,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 999,
            background: toast.ok ? "#166534" : "#7f1d1d",
            border: `1px solid ${toast.ok ? "#4ade80" : "#f87171"}`,
            color: "#fff",
            borderRadius: 14,
            padding: "12px 22px",
            fontSize: 14,
            fontWeight: 700,
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            animation: "slideDown 0.3s ease-out",
            fontFamily: "'Tajawal',sans-serif",
            maxWidth: 360,
            textAlign: "center",
            lineHeight: 1.5,
          }}
        >
          {toast.msg}
        </div>
      )}

      {/* ── Header ── */}
      <div style={S.header}>
        <span style={{ fontSize: 22 }}>⚓</span>
        <span>ربيع القلوب</span>
        <div style={{ marginRight: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={() => setSyncSheet((p) => !p)}
            className="smooth-btn"
            style={{
              background: syncSheet
                ? "linear-gradient(180deg,#22c55e,#15803d)"
                : "rgba(255,255,255,0.09)",
              border: `1px solid ${syncSheet ? "rgba(74,222,128,0.55)" : "rgba(255,255,255,0.12)"}`,
              borderRadius: 999,
              padding: "5px 12px",
              cursor: "pointer",
              color: syncSheet ? "#fff" : "rgba(255,255,255,0.45)",
              fontSize: 11,
              fontWeight: 800,
              fontFamily: "'Tajawal',sans-serif",
              boxShadow: syncSheet
                ? "0 3px 12px rgba(34,197,94,0.35), inset 0 1px 0 rgba(255,255,255,0.25)"
                : "none",
            }}
          >
            {syncSheet ? "🟢 Sheets تلقائي" : "⚪ Sheets"}
          </button>
          <button
            onClick={() => setStudentsReloadKey((v) => v + 1)}
            disabled={studentsLoading}
            className="smooth-btn"
            style={{
              background: studentsLoading
                ? "rgba(255,255,255,0.08)"
                : "linear-gradient(180deg,#10b981,#059669)",
              border: `1px solid ${studentsLoading ? "rgba(255,255,255,0.1)" : "rgba(52,211,153,0.55)"}`,
              borderRadius: 999,
              padding: "5px 12px",
              cursor: studentsLoading ? "not-allowed" : "pointer",
              color: studentsLoading ? "rgba(255,255,255,0.35)" : "#fff",
              fontSize: 11,
              fontWeight: 800,
              fontFamily: "'Tajawal',sans-serif",
              boxShadow: studentsLoading
                ? "none"
                : "0 3px 12px rgba(16,185,129,0.35), inset 0 1px 0 rgba(255,255,255,0.25)",
            }}
          >
            {studentsLoading ? "⏳ الفصول" : "🔄 الفصول"}
          </button>
          <button
            onClick={() => {
              setItemsDraft(regItems.map((item) => ({ ...item })));
              setItemsPassword("");
              setShowItemsSettings(true);
            }}
            className="smooth-btn"
            style={{
              background: "linear-gradient(180deg,rgba(56,189,248,0.25),rgba(2,132,199,0.2))",
              border: "1px solid rgba(56,189,248,0.4)",
              borderRadius: 999,
              padding: "5px 12px",
              cursor: "pointer",
              color: "#bae6fd",
              fontSize: 11,
              fontWeight: 800,
              fontFamily: "'Tajawal',sans-serif",
              boxShadow: "0 3px 12px rgba(56,189,248,0.2), inset 0 1px 0 rgba(255,255,255,0.12)",
            }}
          >
            ⚙️ البنود
          </button>
          <button
            onClick={() => { setResetPassword(""); setResetScope("today"); setShowReset(true); }}
            className="smooth-btn"
            style={{
              background: "linear-gradient(180deg,rgba(239,68,68,0.32),rgba(185,28,28,0.28))",
              border: "1px solid rgba(239,68,68,0.5)",
              borderRadius: 999,
              padding: "5px 12px",
              cursor: "pointer",
              color: "#fecaca",
              fontSize: 11,
              fontWeight: 800,
              fontFamily: "'Tajawal',sans-serif",
              boxShadow: "0 3px 12px rgba(239,68,68,0.22), inset 0 1px 0 rgba(255,255,255,0.12)",
            }}
          >
            🔄 تصفير
          </button>
        </div>
      </div>

      {/* ── Session save counter ── */}
      <div
        style={{
          width: "100%",
          maxWidth: 430,
          marginBottom: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 12,
          padding: "8px 14px",
          fontFamily: "'Tajawal',sans-serif",
          fontSize: 11.5,
          fontWeight: 700,
          color: "rgba(255,255,255,0.5)",
          boxSizing: "border-box" as const,
        }}
      >
        <span>📊 جلسة التسجيل</span>
        <span style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <span style={{ color: "#4ade80", fontWeight: 800 }}>
            ✅ {sheetStats.saved} محفوظ في الشيت
          </span>
          <span
            style={{
              color: sheetStats.pending > 0 ? "#fbbf24" : "rgba(255,255,255,0.35)",
              fontWeight: 800,
            }}
          >
            {sheetStats.pending > 0
              ? `⏳ ${sheetStats.pending} قيد الحفظ`
              : "◌ 0 في الانتظار"}
          </span>
        </span>
      </div>

      {/* ── Items Settings Modal — بنود التسجيل ── */}
      {showItemsSettings && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1100,
            background: "rgba(0,0,0,0.75)",
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              background: "#0f172a",
              border: "1.5px solid rgba(56,189,248,0.35)",
              borderRadius: "22px 22px 0 0",
              width: "100%",
              maxWidth: 430,
              maxHeight: "88vh",
              display: "flex",
              flexDirection: "column",
              padding: "18px 16px 30px",
              fontFamily: "'Tajawal',sans-serif",
              boxSizing: "border-box" as const,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 4,
              }}
            >
              <div style={{ color: "#fff", fontWeight: 900, fontSize: 16 }}>⚙️ بنود التسجيل</div>
              <button
                onClick={() => setShowItemsSettings(false)}
                className="smooth-btn"
                style={{ ...S.clearBtn, fontSize: 12 }}
              >
                ✕ إغلاق
              </button>
            </div>
            <div
              style={{
                color: "rgba(255,255,255,0.45)",
                fontSize: 11,
                marginBottom: 12,
                lineHeight: 1.7,
              }}
            >
              حدّد بنود التسجيل ونقاطها — ستتزامن فوراً على جميع أجهزة المعلمين.
              <br />النوع: «➕ إضافة نقاط» مثل الحضور، «✅ نعم/لا» مثل الحقيبة،
              «📖 سورة من وإلى» مثل الحفظ.
            </div>

            <div
              style={{
                overflowY: "auto",
                flex: 1,
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              {itemsDraft.map((item, index) => (
                <div
                  key={item.id}
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.09)",
                    borderRadius: 14,
                    padding: "12px",
                  }}
                >
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <input
                      type="text"
                      value={item.label}
                      onChange={(e) => updateItemDraft(index, { label: e.target.value })}
                      placeholder="اسم البند (مثال: الحضور)"
                      style={{ ...S.input, marginBottom: 0, flex: 1, fontSize: 14, padding: "10px 12px" }}
                    />
                    {item.type === "range" ? (
                      <select
                        value={
                          REG_ITEMS_RANGE_POINTS_OPTIONS.includes(item.points)
                            ? item.points
                            : REG_ITEMS_RANGE_POINTS_OPTIONS[0]
                        }
                        onChange={(e) =>
                          updateItemDraft(index, { points: Number(e.target.value) || 30 })
                        }
                        title="نقاط البند (سورة من وإلى: 30 / 25 / 20)"
                        style={{
                          ...S.input,
                          marginBottom: 0,
                          width: 74,
                          fontSize: 14,
                          padding: "10px 4px",
                          textAlign: "center",
                          cursor: "pointer",
                          fontFamily: "'Tajawal',sans-serif",
                        }}
                      >
                        {REG_ITEMS_RANGE_POINTS_OPTIONS.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="number"
                        min={0}
                        value={item.points}
                        onChange={(e) =>
                          updateItemDraft(index, { points: Math.max(0, Number(e.target.value) || 0) })
                        }
                        placeholder="النقاط"
                        title="عدد النقاط لهذا البند"
                        style={{ ...S.input, marginBottom: 0, width: 74, fontSize: 14, padding: "10px 8px", textAlign: "center" }}
                      />
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {(["points", "yesno", "range"] as const).map((type) => (
                      <button
                        key={type}
                        type="button"
                        className="smooth-btn"
                        onClick={() =>
                          updateItemDraft(index, {
                            type,
                            points:
                              type === "range" &&
                              !REG_ITEMS_RANGE_POINTS_OPTIONS.includes(item.points)
                                ? REG_ITEMS_RANGE_POINTS_OPTIONS[0]
                                : item.points,
                          })
                        }
                        style={{
                          flex: 1,
                          padding: "8px 4px",
                          borderRadius: 10,
                          fontSize: 11,
                          fontWeight: 800,
                          fontFamily: "'Tajawal',sans-serif",
                          cursor: "pointer",
                          background:
                            item.type === type
                              ? "linear-gradient(180deg,#38bdf8,#0284c7)"
                              : "rgba(255,255,255,0.06)",
                          color: item.type === type ? "#fff" : "rgba(255,255,255,0.5)",
                          border: `1.5px solid ${item.type === type ? "#38bdf8" : "rgba(255,255,255,0.12)"}`,
                        }}
                      >
                        {REG_ITEMS_TYPE_LABELS[type]}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="smooth-btn"
                      onClick={() => moveItemDraft(index, -1)}
                      disabled={index === 0}
                      style={{ ...S.clearBtn, padding: "8px 10px" }}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className="smooth-btn"
                      onClick={() => moveItemDraft(index, 1)}
                      disabled={index === itemsDraft.length - 1}
                      style={{ ...S.clearBtn, padding: "8px 10px" }}
                    >
                      ▼
                    </button>
                    <button
                      type="button"
                      className="smooth-btn"
                      onClick={() => removeItemDraft(index)}
                      style={{ ...S.clearBtn, padding: "8px 10px", color: "#f87171" }}
                    >
                      🗑
                    </button>
                  </div>
                </div>
              ))}
              {itemsDraft.length === 0 && (
                <div
                  style={{
                    color: "rgba(255,255,255,0.4)",
                    fontSize: 12,
                    textAlign: "center",
                    padding: 20,
                  }}
                >
                  لا توجد بنود — أضف بنداً واحداً على الأقل
                </div>
              )}
            </div>

            {/* زر الإضافة مثبّت أسفل القائمة (خارج منطقة التمرير) حتى يبقى ظاهراً دائماً */}
            <button
              type="button"
              onClick={addItemDraft}
              className="smooth-btn btn-shine"
              style={{
                marginTop: 10,
                padding: "13px",
                borderRadius: 14,
                border: "1.5px dashed rgba(56,189,248,0.5)",
                background: "rgba(56,189,248,0.08)",
                color: "#7dd3fc",
                fontFamily: "'Tajawal',sans-serif",
                fontSize: 14,
                fontWeight: 800,
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              ＋ إضافة بند جديد
            </button>

            <input
              type="password"
              value={itemsPassword}
              onChange={(e) => setItemsPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !itemsSaving) saveItemsDraft();
              }}
              placeholder="🔒 كلمة مرور الإدارة (نفس كلمة مرور التصفير)"
              autoComplete="off"
              dir="ltr"
              style={{
                width: "100%",
                boxSizing: "border-box" as const,
                marginTop: 12,
                padding: "13px 14px",
                borderRadius: 14,
                border: "1.5px solid rgba(56,189,248,0.35)",
                background: "rgba(15,23,42,0.85)",
                color: "#fff",
                outline: "none",
                fontSize: 14,
                fontWeight: 700,
                textAlign: "center",
                fontFamily: "'Tajawal',sans-serif",
              }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                type="button"
                onClick={resetItemsDraft}
                className="smooth-btn"
                style={{ ...S.clearBtn, padding: "13px 12px", fontSize: 12, whiteSpace: "nowrap" }}
              >
                ↩️ الافتراضي
              </button>
              <button
                type="button"
                onClick={saveItemsDraft}
                disabled={itemsSaving}
                className={itemsSaving ? "smooth-btn" : "smooth-btn btn-shine"}
                style={{
                  flex: 1,
                  padding: "13px",
                  borderRadius: 14,
                  border: "none",
                  background: itemsSaving
                    ? "rgba(255,255,255,0.1)"
                    : "linear-gradient(180deg,#22c55e,#15803d)",
                  color: itemsSaving ? "rgba(255,255,255,0.4)" : "#fff",
                  fontFamily: "'Tajawal',sans-serif",
                  fontSize: 14,
                  fontWeight: 900,
                  cursor: itemsSaving ? "not-allowed" : "pointer",
                }}
              >
                {itemsSaving ? "⏳ جارٍ الحفظ..." : "💾 حفظ وتفعيل عند الجميع"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reset Confirmation Modal ── */}
      {showReset && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
        >
          <div
            style={{
              background: "#1e293b",
              border: "1.5px solid rgba(239,68,68,0.5)",
              borderRadius: 20,
              padding: "28px 24px",
              maxWidth: 340,
              width: "100%",
              fontFamily: "'Tajawal',sans-serif",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
            <div style={{ color: "#fff", fontSize: 17, fontWeight: 800, marginBottom: 8 }}>
              اختر نوع التصفير
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                marginBottom: 16,
              }}
            >
              {[
                { id: "today" as const, label: "اليوم فقط", icon: "🧪" },
                { id: "all" as const, label: "جميع الأيام", icon: "🧨" },
              ].map((item) => {
                const active = resetScope === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="smooth-btn"
                    onClick={() => setResetScope(item.id)}
                    style={{
                      padding: "12px 8px",
                      borderRadius: 14,
                      border: `1.5px solid ${active ? "#f87171" : "rgba(255,255,255,0.13)"}`,
                      background: active
                        ? "linear-gradient(180deg,rgba(239,68,68,0.4),rgba(153,27,27,0.35))"
                        : "rgba(255,255,255,0.06)",
                      color: active ? "#fff" : "rgba(255,255,255,0.55)",
                      fontFamily: "'Tajawal',sans-serif",
                      fontSize: 13,
                      fontWeight: 800,
                      cursor: "pointer",
                      boxShadow: active
                        ? "0 4px 16px rgba(239,68,68,0.3), inset 0 1px 0 rgba(255,255,255,0.15)"
                        : "none",
                    }}
                  >
                    {item.icon} {item.label}
                  </button>
                );
              })}
            </div>
            <div
              style={{
                color: "rgba(255,255,255,0.55)",
                fontSize: 13,
                marginBottom: 20,
                lineHeight: 1.7,
                background: "rgba(15,23,42,0.45)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 14,
                padding: "12px",
              }}
            >
              {resetScope === "today" ? (
                <>
                  سيتم مسح <span style={{ color: "#fbbf24", fontWeight: 700 }}>تسجيلات اليوم فقط</span> من قوقل شيت والتقارير.
                  <br />وسيتم طرح مجموع نقاط اليوم من شاشة المسابقة حتى لا تبقى نقاط التجربة.
                  <br />
                  <span style={{ color: "#f87171", fontWeight: 700 }}>أسماء الطلاب وباقي الأيام لن تُحذف.</span>
                </>
              ) : (
                <>
                  سيتم مسح <span style={{ color: "#fbbf24", fontWeight: 700 }}>كل الأيام</span> بضغطة واحدة:
                  <br />🔢 نقاط الفصول الـ19 ← صفر
                  <br />📊 قاعدة البيانات والتقارير ← ممسوحة
                  <br />
                  <span style={{ color: "#f87171", fontWeight: 700 }}>أسماء الطلاب في أوراق الفصول لن تُحذف.</span>
                </>
              )}
            </div>
            <input
              type="password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !resetting) handleReset();
              }}
              placeholder="أدخل كلمة مرور التصفير"
              autoComplete="off"
              dir="ltr"
              style={{
                width: "100%",
                boxSizing: "border-box",
                marginBottom: 14,
                padding: "12px 14px",
                borderRadius: 12,
                border: "1px solid rgba(239,68,68,0.45)",
                background: "rgba(15,23,42,0.85)",
                color: "#fff",
                outline: "none",
                fontSize: 14,
                fontWeight: 700,
                textAlign: "center",
                fontFamily: "'Tajawal',sans-serif",
              }}
            />
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => { setShowReset(false); setResetPassword(""); setResetScope("today"); }}
                className="smooth-btn"
                style={{
                  flex: 1,
                  padding: "12px",
                  borderRadius: 14,
                  border: "1px solid rgba(255,255,255,0.15)",
                  background: "rgba(255,255,255,0.07)",
                  color: "rgba(255,255,255,0.7)",
                  fontFamily: "'Tajawal',sans-serif",
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                إلغاء
              </button>
              <button
                onClick={handleReset}
                disabled={resetting || !resetPassword.trim()}
                className="smooth-btn"
                style={{
                  flex: 1,
                  padding: "12px",
                  borderRadius: 14,
                  border: "none",
                  position: "relative",
                  overflow: "hidden",
                  background: resetting || !resetPassword.trim()
                    ? "rgba(255,255,255,0.1)"
                    : "linear-gradient(180deg,#ef4444,#b91c1c)",
                  color: resetting || !resetPassword.trim() ? "rgba(255,255,255,0.3)" : "#fff",
                  fontFamily: "'Tajawal',sans-serif",
                  fontSize: 14,
                  fontWeight: 800,
                  cursor: resetting || !resetPassword.trim() ? "not-allowed" : "pointer",
                  boxShadow: resetting || !resetPassword.trim()
                    ? "none"
                    : "0 4px 18px rgba(239,68,68,0.4), inset 0 1px 0 rgba(255,255,255,0.25)",
                }}
              >
                {resetting ? "⏳ جارٍ..." : resetScope === "today" ? "🧪 صفّر اليوم" : "🧨 صفّر الكل"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Current Standings ── */}
      <div style={{ ...S.card, padding: "14px 16px", marginBottom: 14 }}>
        <div style={S.sectionTitle}>🏆 الترتيب الحالي</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {ranked.map((team, i) => (
            <div
              key={team.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background: i === 0 ? `${team.color}1a` : "rgba(255,255,255,0.03)",
                border: `1px solid ${i === 0 ? `${team.color}55` : "rgba(255,255,255,0.06)"}`,
                borderRadius: 10,
                padding: "8px 12px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 16, minWidth: 22, textAlign: "center" }}>
                  {MEDALS[i] || `${i + 1}`}
                </span>
                <div
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: team.color,
                    boxShadow: `0 0 6px ${team.color}`,
                  }}
                />
                <span style={{ color: "#fff", fontWeight: 700, fontSize: 13 }}>
                  {getTeamName(team.id, team.name || team.id)}
                </span>
              </div>
              <span style={{ color: "#fde047", fontWeight: 800, fontSize: 13, fontFamily: "monospace" }}>
                {formatPoints(getTeamLocationPoints(team))} نقطة
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Undo Button ── */}
      {lastAction && (
        <button
          onClick={handleUndo}
          disabled={undoing}
          className="smooth-btn"
          style={{
            width: "100%",
            maxWidth: 430,
            marginBottom: 14,
            padding: "12px 16px",
            borderRadius: 16,
            border: "1.5px solid rgba(248,113,113,0.45)",
            background: "linear-gradient(180deg,rgba(239,68,68,0.32),rgba(153,27,27,0.3))",
            color: "#fecaca",
            fontFamily: "'Tajawal',sans-serif",
            fontSize: 13,
            fontWeight: 800,
            cursor: undoing ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            boxShadow: "0 4px 18px rgba(239,68,68,0.2), inset 0 1px 0 rgba(255,255,255,0.12)",
          }}
        >
          {undoing
            ? "⏳ جارٍ التراجع..."
            : `↩️ تراجع: ${lastAction.points > 0 ? "+" + lastAction.points : lastAction.points} لـ${lastAction.teamName}${lastAction.studentName ? ` (${lastAction.studentName})` : ""}`}
        </button>
      )}

      {/* ── Main Card ── */}
      <div style={S.card}>
        {/* Mode toggle — مفتاح مقسّم بنمط حبوب */}
        <div
          style={{
            display: "flex",
            gap: 6,
            marginBottom: 20,
            padding: 5,
            borderRadius: 18,
            background: "rgba(7,15,30,0.5)",
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04), 0 8px 24px rgba(0,0,0,0.12)",
          }}
        >
          <button
            onClick={() => setQuickMode(false)}
            className="smooth-btn"
            style={{
              flex: 1,
              padding: "11px",
              borderRadius: 14,
              border: "none",
              cursor: "pointer",
              fontFamily: "'Tajawal',sans-serif",
              fontWeight: 800,
              fontSize: 13,
              background: !quickMode
                ? `linear-gradient(180deg,${accentColor},${accentColor}cc)`
                : "transparent",
              color: !quickMode ? "#fff" : "rgba(255,255,255,0.45)",
              boxShadow: !quickMode
                ? `0 4px 16px ${accentColor}55, inset 0 1px 0 rgba(255,255,255,0.3)`
                : "none",
            }}
          >
            📋 التسجيل
          </button>
          <button
            onClick={() => setQuickMode(true)}
            className="smooth-btn"
            style={{
              flex: 1,
              padding: "11px",
              borderRadius: 14,
              border: "none",
              cursor: "pointer",
              fontFamily: "'Tajawal',sans-serif",
              fontWeight: 800,
              fontSize: 13,
              background: quickMode
                ? "linear-gradient(180deg,#fbbf24,#d97706)"
                : "transparent",
              color: quickMode ? "#fff" : "rgba(255,255,255,0.45)",
              boxShadow: quickMode
                ? "0 4px 16px rgba(245,158,11,0.5), inset 0 1px 0 rgba(255,255,255,0.3)"
                : "none",
            }}
          >
            ⚡ سريع
          </button>
        </div>

        {/* ── Class Version Filter ── */}
        <label style={{ ...S.label, marginBottom: 7 }}>عرض الفصول</label>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: 4,
            padding: 4,
            marginBottom: 18,
            borderRadius: 17,
            background: "rgba(7,15,30,0.56)",
            border: "1px solid rgba(255,255,255,0.07)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.035), 0 8px 24px rgba(0,0,0,0.12)",
            backdropFilter: "blur(10px)",
          }}
        >
          {([
            { id: "all" as const, label: "الكل", count: 19 },
            { id: 1 as const, label: "نسخة 1", count: 8 },
            { id: 2 as const, label: "نسخة 2", count: 6 },
            { id: 3 as const, label: "نسخة 3", count: 5 },
          ]).map((filter) => {
            const active = classFilter === filter.id;
            const activeColor = VERSION_ACCENT[String(filter.id)] || "#38bdf8";
            return (
              <button
                key={String(filter.id)}
                type="button"
                className="smooth-btn"
                onClick={() => {
                  setClassFilter(filter.id);
                  if (selectedTeam) {
                    const selectedClass = classById.get(selectedTeam);
                    if (filter.id !== "all" && selectedClass?.version !== filter.id) {
                      setSelected("");
                    }
                  }
                }}
                style={{
                  minHeight: 50,
                  padding: "7px 5px",
                  borderRadius: 14,
                  border: "none",
                  outline: "none",
                  background: active
                    ? `linear-gradient(180deg, ${activeColor}, ${activeColor}cc)`
                    : "rgba(255,255,255,0.085)",
                  color: active ? "#fff" : "rgba(226,232,240,0.78)",
                  fontFamily: "'Tajawal',sans-serif",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 3,
                  transform: active ? "translateY(-2px)" : "translateY(0)",
                  boxShadow: active
                    ? `0 7px 0 ${activeColor}88, inset 0 2px 0 rgba(255,255,255,0.35), inset 0 -3px 0 rgba(0,0,0,0.12)`
                    : "none",
                  transition: "background 180ms ease, color 180ms ease, transform 180ms ease, box-shadow 180ms ease",
                  WebkitTapHighlightColor: "transparent",
                }}
                aria-pressed={active}
              >
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 900,
                    lineHeight: 1.15,
                    whiteSpace: "nowrap",
                    letterSpacing: "0.01em",
                  }}
                >
                  {filter.label}
                </span>
                <span
                  style={{
                    minWidth: 22,
                    height: 16,
                    padding: "0 6px",
                    borderRadius: 999,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: active ? "rgba(255,255,255,0.17)" : "rgba(255,255,255,0.055)",
                    border: active ? "1px solid rgba(255,255,255,0.16)" : "1px solid rgba(255,255,255,0.045)",
                    color: active ? "rgba(255,255,255,0.94)" : "rgba(203,213,225,0.48)",
                    fontSize: 8.5,
                    fontWeight: 800,
                    lineHeight: 1,
                    transition: "all 180ms ease",
                  }}
                >
                  {filter.count}
                </span>
              </button>
            );
          })}
        </div>

        {/* ── Team Selection ── */}
        <label style={S.label}>اختر الفصل</label>
        {studentsLoading && schoolClasses.length === 0 && (
          <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 12, textAlign: "center", padding: "14px 8px" }}>
            ⏳ جارٍ تحميل الفصول من Google Sheets...
          </div>
        )}
        {studentsError && schoolClasses.length === 0 && (
          <div style={{ color: "#fca5a5", fontSize: 12, textAlign: "center", padding: "14px 8px", lineHeight: 1.7 }}>
            ⚠️ {studentsError}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
          {visibleClassTeams
            .sort((a, b) => safeNumber(a.slot) - safeNumber(b.slot))
            .map((team) => (
              <div key={team.id}>
                <button
                  onClick={() => setSelected(selectedTeam === team.id ? "" : team.id)}
                  className="smooth-btn"
                  style={{
                    width: "100%",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "12px 16px",
                    borderRadius: selectedTeam === team.id ? "14px 14px 0 0" : 14,
                    cursor: "pointer",
                    border: `2px solid ${selectedTeam === team.id ? team.color : "rgba(255,255,255,0.08)"}`,
                    borderBottom: selectedTeam === team.id ? `2px solid ${team.color}` : undefined,
                    background:
                      selectedTeam === team.id
                        ? `linear-gradient(180deg, ${team.color}38, ${team.color}14)`
                        : "rgba(255,255,255,0.04)",
                    fontFamily: "'Tajawal',sans-serif",
                    boxShadow: selectedTeam === team.id
                      ? `0 4px 18px ${team.color}33, inset 0 1px 0 rgba(255,255,255,0.06)`
                      : "none",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div
                      style={{
                        width: 11,
                        height: 11,
                        borderRadius: "50%",
                        background: team.color,
                        boxShadow: `0 0 8px ${team.color}`,
                      }}
                    />
                    <span style={{ color: "#fff", fontWeight: 700, fontSize: 15 }}>
                      {getTeamName(team.id, team.name || team.id)}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span
                      style={{
                        color: selectedTeam === team.id ? team.color : "rgba(255,255,255,0.3)",
                        fontSize: 12,
                      }}
                    >
                      {selectedTeam === team.id ? "▲" : "▼"}
                    </span>
                  </div>
                </button>

                {/* Student list (shown when team is selected) */}
                {selectedTeam === team.id && (
                  <div
                    style={{
                      background: `${team.color}0d`,
                      border: `2px solid ${team.color}`,
                      borderTop: "none",
                      borderRadius: "0 0 14px 14px",
                      padding: "10px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    <div
                      style={{
                        color: "rgba(255,255,255,0.4)",
                        fontSize: 10,
                        fontWeight: 700,
                        marginBottom: 4,
                        paddingRight: 4,
                      }}
                    >
                      اختر الطالب
                    </div>
                    {studentsError && (teamStudents[team.id] || []).length > 0 && (
                      <div
                        style={{
                          color: "rgba(251,191,36,0.85)",
                          fontSize: 10,
                          fontWeight: 700,
                          padding: "4px 4px 8px",
                          textAlign: "center",
                          lineHeight: 1.6,
                        }}
                      >
                        ⚠️ تعذر تحديث الأسماء — تعرض آخر نسخة محفوظة
                      </div>
                    )}
                    {(() => {
                      const studentsForTeam = teamStudents[team.id] || [];

                      if (studentsLoading && !studentsForTeam.length) {
                        return (
                          <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 12, padding: "12px", textAlign: "center" }}>
                            ⏳ جارٍ تحميل الفصول وأسماء الطلاب من Google Sheets...
                          </div>
                        );
                      }

                      if (studentsError && !studentsForTeam.length) {
                        return (
                          <div style={{ color: "#fca5a5", fontSize: 12, padding: "12px", textAlign: "center", lineHeight: 1.7 }}>
                            ⚠️ {studentsError}
                            <br />تأكد من نشر Apps Script ثم اضغط زر 🔄 الطلاب.
                          </div>
                        );
                      }

                      if (!studentsForTeam.length) {
                        return (
                          <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 12, padding: "12px", textAlign: "center", lineHeight: 1.7 }}>
                            لا توجد أسماء في ورقة الفصل {getTeamName(team.id, team.name || team.id)}.
                            <br />اكتب الأسماء في العمود A، ثم اضغط 🔄 الطلاب.
                          </div>
                        );
                      }

                      return studentsForTeam.map((student) => {
                        const isSelectedStudent = studentName === student.name;
                        const trackMeta = team.id === "blue" ? getFirstCircleTrackMeta(student.track) : null;

                        return (
                          <button
                            key={student.name}
                            className="smooth-btn"
                            onClick={() => {
                              const nextSelected = isSelectedStudent ? "" : student.name;
                              setStudent(nextSelected);

                              if (team.id === "blue") {
                                setFirstCircleTrack(nextSelected ? (ENABLE_FIRST_CIRCLE_TRACKS ? normalizeFirstCircleTrack(student.track) : "hifz-review") : null);
                                setFirstCircleScoreValue(null);
                                setNuraniaLesson(null);
                                setLessonPickerOpen(false);
                                setLessonSearch("");
                                setNuraniaFromText("");
                                setNuraniaToText("");
                                setTilawaSurah(null);
                                setTilawaPickerOpen(false);
                                setTilawaFromAyah("");
                                setTilawaToAyah("");
                              }
                            }}
                            style={{
                              padding: "13px 14px",
                              borderRadius: 14,
                              cursor: "pointer",
                              fontFamily: "'Tajawal',sans-serif",
                              fontSize: 14,
                              fontWeight: 700,
                              textAlign: "right",
                              background: isSelectedStudent
                                ? `linear-gradient(180deg, ${team.color}, ${team.color}cc)`
                                : "rgba(255,255,255,0.05)",
                              color: isSelectedStudent ? "#fff" : "rgba(255,255,255,0.7)",
                              border: `1.5px solid ${isSelectedStudent ? team.color : "rgba(255,255,255,0.1)"}`,
                              boxShadow: isSelectedStudent
                                ? `0 4px 16px ${team.color}55, inset 0 1px 0 rgba(255,255,255,0.25)`
                                : "none",
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              gap: 10,
                            }}
                          >
                            <span>{student.name}</span>
                            <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                              {ENABLE_FIRST_CIRCLE_TRACKS && trackMeta && (
                                <span style={{ fontSize: 10, opacity: 0.92, whiteSpace: "nowrap" }}>
                                  {trackMeta.icon} {trackMeta.label}
                                </span>
                              )}
                              {isSelectedStudent && <span style={{ fontSize: 16 }}>✔</span>}
                            </span>
                          </button>
                        );
                      });
                    })()}
                  </div>
                )}
              </div>
            ))}
        </div>

        {/* ── Quick Mode ── */}
        {quickMode && (
          <div
            style={{
              background: "rgba(245,158,11,0.08)",
              border: "1.5px solid rgba(245,158,11,0.3)",
              borderRadius: 16,
              padding: "16px",
              marginBottom: 8,
            }}
          >
            <div
              style={{
                color: "#fbbf24",
                fontSize: 12,
                fontWeight: 700,
                marginBottom: 12,
                textAlign: "center",
              }}
            >
              ⚡ للتجارب فقط
            </div>
            <label style={{ ...S.label, color: "rgba(245,158,11,0.7)" }}>عدد النقاط</label>
            <input
              type="number"
              value={quickPts}
              onChange={(e) => setQuickPts(e.target.value)}
              style={{
                ...S.input,
                marginBottom: 12,
                borderColor: "rgba(245,158,11,0.4)",
                background: "rgba(245,158,11,0.06)",
              }}
              placeholder="مثال: 50"
            />
            <button
              onClick={handleQuick}
              disabled={!canQuick}
              className={canQuick ? "smooth-btn btn-shine" : "smooth-btn"}
              style={{
                width: "100%",
                padding: "14px",
                borderRadius: 16,
                border: "none",
                position: "relative",
                overflow: "hidden",
                fontFamily: "'Tajawal',sans-serif",
                fontSize: 16,
                fontWeight: 900,
                cursor: canQuick ? "pointer" : "not-allowed",
                background: canQuick
                  ? "linear-gradient(180deg,#fbbf24,#d97706)"
                  : "rgba(255,255,255,0.07)",
                color: canQuick ? "#fff" : "rgba(255,255,255,0.3)",
                boxShadow: canQuick
                  ? "0 6px 22px rgba(245,158,11,0.5), inset 0 1px 0 rgba(255,255,255,0.3)"
                  : "none",
              }}
            >
              {sending ? "⏳ جارٍ..." : `⚡ إضافة ${quickPts || 0} نقطة`}
            </button>
          </div>
        )}

        {/* ── Full Registration Mode ── */}
        {!quickMode && studentName && (
          <div>
            {/* بنود التسجيل الديناميكية — تُعرض حسب النوع الذي حددته الإدارة */}
            {regItems.map((item) => {
              const v = itemValues[item.id] ?? emptyRegItemValue();

              // ── بند «إضافة نقاط» (مثل الحضور) ──
              if (item.type === "points") {
                return (
                  <div
                    key={item.id}
                    style={{
                      background: v.on ? "rgba(34,197,94,0.12)" : "rgba(255,255,255,0.04)",
                      border: `1.5px solid ${v.on ? "#22c55e" : "rgba(255,255,255,0.1)"}`,
                      borderRadius: 14,
                      padding: "14px 16px",
                      marginBottom: 16,
                      transition: "all 0.2s",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <span style={{ color: "#fff", fontWeight: 700, fontSize: 14 }}>✋ {item.label}</span>
                        <span style={S.hint}>(+{item.points} نقاط)</span>
                      </div>
                      <button
                        onClick={() =>
                          setItemValues((prev) => ({
                            ...prev,
                            [item.id]: {
                              ...(prev[item.id] ?? emptyRegItemValue()),
                              on: !v.on,
                            },
                          }))
                        }
                        className="smooth-btn"
                        style={{
                          padding: "8px 22px",
                          borderRadius: 999,
                          border: "none",
                          cursor: "pointer",
                          fontFamily: "'Tajawal',sans-serif",
                          fontSize: 13,
                          fontWeight: 800,
                          background: v.on
                            ? "linear-gradient(180deg,#22c55e,#15803d)"
                            : "rgba(255,255,255,0.1)",
                          color: v.on ? "#fff" : "rgba(255,255,255,0.5)",
                          boxShadow: v.on
                            ? "0 4px 16px #22c55e55, inset 0 1px 0 rgba(255,255,255,0.3)"
                            : "none",
                        }}
                      >
                        {v.on ? `✔ ${item.label}` : `${item.label}؟`}
                      </button>
                    </div>
                  </div>
                );
              }

              // ── بند «نعم / لا» (مثل إحضار الحقيبة) ──
              if (item.type === "yesno") {
                return (
                  <div key={item.id}>
                    <label style={S.label}>
                      🎯 {item.label}
                      <span style={S.hint}>(+{item.points})</span>
                      {v.value !== null && (
                        <span style={S.badge}>{v.value ? "✔ نعم" : "✘ لا"}</span>
                      )}
                    </label>
                    <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                      <OptionBtn
                        active={v.value === true}
                        accentColor={accentColor}
                        onClick={() =>
                          setItemValues((prev) => ({
                            ...prev,
                            [item.id]: { ...(prev[item.id] ?? emptyRegItemValue()), value: true },
                          }))
                        }
                      >
                        ✅ نعم
                      </OptionBtn>
                      <OptionBtn
                        active={v.value === false}
                        danger
                        accentColor={accentColor}
                        onClick={() =>
                          setItemValues((prev) => ({
                            ...prev,
                            [item.id]: { ...(prev[item.id] ?? emptyRegItemValue()), value: false },
                          }))
                        }
                      >
                        ❌ لا
                      </OptionBtn>
                      {v.value !== null && (
                        <button
                          onClick={() => {
                            setItemValues((prev) => {
                              const next = { ...prev };
                              delete next[item.id];
                              return next;
                            });
                          }}
                          className="smooth-btn"
                          style={S.clearBtn}
                        >
                          ↺ إلغاء
                        </button>
                      )}
                    </div>
                  </div>
                );
              }

              // ── بند «سورة من وإلى» (مثل الحفظ والمراجعة) ──
              const hasFrom = v.range.from.surahIndex !== null;
              const hasTo = v.range.to.surahIndex !== null;
              const rangeLabel = surahRangeLabel(v.range);
              return (
                <div key={item.id} style={{ marginBottom: 16 }}>
                  <label style={S.label}>
                    📖 {item.label}
                    <span style={S.hint}>(اختر النقاط عند إكمال من وإلى)</span>
                    {v.absent && <span style={S.badge}>لم يسمع</span>}
                    {!v.absent && hasFrom && hasTo && (
                      <span style={S.badge}>+{regItemRangeScore(item, v)} ✔</span>
                    )}
                  </label>
                  <div
                    style={{
                      marginBottom: 8,
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 14,
                      padding: "10px 12px",
                      opacity: v.absent ? 0.45 : 1,
                    }}
                  >
                    {rangeLabel && !v.absent && (
                      <div
                        style={{
                          color: accentColor,
                          fontSize: 12,
                          fontWeight: 700,
                          marginBottom: 8,
                          textAlign: "center",
                        }}
                      >
                        {rangeLabel}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        onClick={() => setPickerTarget({ itemId: item.id, side: "from" })}
                        disabled={v.absent}
                        className="smooth-btn"
                        style={{
                          flex: 1,
                          padding: "9px 8px",
                          borderRadius: 10,
                          cursor: v.absent ? "not-allowed" : "pointer",
                          fontFamily: "'Tajawal',sans-serif",
                          fontSize: 12,
                          fontWeight: 700,
                          background: hasFrom ? `${accentColor}25` : "rgba(255,255,255,0.06)",
                          border: `1.5px solid ${hasFrom ? accentColor : "rgba(255,255,255,0.12)"}`,
                          color: hasFrom ? "#fff" : "rgba(255,255,255,0.4)",
                        }}
                      >
                        {hasFrom
                          ? `من: ${formatSurahPoint(v.range.from)}`
                          : "📍 من (سورة + آية)"}
                      </button>
                      <button
                        onClick={() => setPickerTarget({ itemId: item.id, side: "to" })}
                        disabled={v.absent}
                        className="smooth-btn"
                        style={{
                          flex: 1,
                          padding: "9px 8px",
                          borderRadius: 10,
                          cursor: v.absent ? "not-allowed" : "pointer",
                          fontFamily: "'Tajawal',sans-serif",
                          fontSize: 12,
                          fontWeight: 700,
                          background: hasTo ? `${accentColor}25` : "rgba(255,255,255,0.06)",
                          border: `1.5px solid ${hasTo ? accentColor : "rgba(255,255,255,0.12)"}`,
                          color: hasTo ? "#fff" : "rgba(255,255,255,0.4)",
                        }}
                      >
                        {hasTo
                          ? `إلى: ${formatSurahPoint(v.range.to)}`
                          : "🏁 إلى (سورة + آية)"}
                      </button>
                      {(hasFrom || hasTo || v.absent) && (
                        <button
                          onClick={() => {
                            setItemValues((prev) => {
                              const next = { ...prev };
                              delete next[item.id];
                              return next;
                            });
                          }}
                          className="smooth-btn"
                          style={{ ...S.clearBtn, padding: "8px 10px", fontSize: 11 }}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    {hasFrom && hasTo && !v.absent && (
                      <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
                        <span
                          style={{
                            color: "rgba(255,255,255,0.45)",
                            fontSize: 11,
                            fontWeight: 700,
                            whiteSpace: "nowrap",
                          }}
                        >
                          النقاط:
                        </span>
                        {REG_ITEMS_RANGE_POINTS_OPTIONS.map((opt) => {
                          const selected = regItemRangeScore(item, v) === opt;
                          return (
                            <button
                              key={opt}
                              type="button"
                              className="smooth-btn"
                              onClick={() =>
                                setItemValues((prev) => ({
                                  ...prev,
                                  [item.id]: { ...(prev[item.id] ?? emptyRegItemValue()), score: opt },
                                }))
                              }
                              style={{
                                flex: 1,
                                padding: "8px 4px",
                                borderRadius: 10,
                                cursor: "pointer",
                                fontFamily: "'Tajawal',sans-serif",
                                fontSize: 13,
                                fontWeight: 900,
                                background: selected
                                  ? "linear-gradient(180deg,#fbbf24,#d97706)"
                                  : "rgba(255,255,255,0.07)",
                                color: selected ? "#fff" : "rgba(255,255,255,0.55)",
                                border: `1.5px solid ${selected ? "#fbbf24" : "rgba(255,255,255,0.14)"}`,
                                boxShadow: selected
                                  ? "0 4px 14px rgba(245,158,11,0.4)"
                                  : "none",
                              }}
                            >
                              {opt}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <OptionBtn
                      active={v.absent}
                      danger
                      accentColor={accentColor}
                      onClick={() =>
                        setItemValues((prev) => ({
                          ...prev,
                          [item.id]: {
                            ...(prev[item.id] ?? emptyRegItemValue()),
                            absent: !v.absent,
                            range: emptySurahRange(),
                          },
                        }))
                      }
                    >
                      ❌ لم يسمع
                    </OptionBtn>
                  </div>
                </div>
              );
            })}

            {/* ── Nurania Lesson Picker Modal ── */}
            {lessonPickerOpen && (
              <div style={{
                position: "fixed", inset: 0, zIndex: 2000,
                background: "rgba(0,0,0,0.82)",
                display: "flex", alignItems: "flex-end", justifyContent: "center",
              }}>
                <div style={{
                  background: "#1e293b",
                  border: "1.5px solid rgba(255,255,255,0.12)",
                  borderRadius: "24px 24px 0 0",
                  width: "100%", maxWidth: 430,
                  maxHeight: "85vh", display: "flex", flexDirection: "column",
                  padding: "20px 16px 30px",
                  fontFamily: "'Tajawal',sans-serif",
                }}>
                  <div style={{ color: "#fff", fontWeight: 800, fontSize: 15, marginBottom: 12, textAlign: "center" }}>
                    🔤 اختر درس القاعدة النورانية
                  </div>

                  <input
                    autoFocus
                    type="text"
                    placeholder="ابحث عن درس..."
                    value={lessonSearch}
                    onChange={(e) => setLessonSearch(e.target.value)}
                    style={{ ...S.input, marginBottom: 10, fontSize: 14 }}
                  />

                  <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
                    {NURANIA_LESSONS.map((lesson, index) =>
                      lesson.includes(lessonSearch.trim()) ? (
                        <button
                          key={lesson}
                          type="button"
                          onClick={() => {
                            setNuraniaLesson(index);
                            setLessonPickerOpen(false);
                            setLessonSearch("");
                          }}
                          style={{
                            background: nuraniaLesson === index ? `${accentColor}33` : "rgba(255,255,255,0.06)",
                            border: nuraniaLesson === index
                              ? `1.5px solid ${accentColor}`
                              : "1.5px solid rgba(255,255,255,0.1)",
                            borderRadius: 10, padding: "10px 14px",
                            color: "#fff", fontFamily: "'Tajawal',sans-serif",
                            fontSize: 14, fontWeight: 700, cursor: "pointer",
                            display: "flex", justifyContent: "space-between", alignItems: "center",
                          }}
                        >
                          <span>{index + 1}. {lesson}</span>
                          {nuraniaLesson === index && <span>✓</span>}
                        </button>
                      ) : null
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setLessonPickerOpen(false);
                      setLessonSearch("");
                    }}
                    style={{
                      width: "100%", marginTop: 16, padding: "15px", borderRadius: 14, border: "none",
                      background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.6)",
                      fontFamily: "'Tajawal',sans-serif", fontSize: 15, fontWeight: 700, cursor: "pointer",
                    }}
                  >
                    إلغاء
                  </button>
                </div>
              </div>
            )}

            {/* ── Tilawa Surah Picker Modal ── */}
            {tilawaPickerOpen && (
              <div style={{
                position: "fixed", inset: 0, zIndex: 2000,
                background: "rgba(0,0,0,0.82)",
                display: "flex", alignItems: "flex-end", justifyContent: "center",
              }}>
                <div style={{
                  background: "#1e293b",
                  border: "1.5px solid rgba(255,255,255,0.12)",
                  borderRadius: "24px 24px 0 0",
                  width: "100%", maxWidth: 430,
                  maxHeight: "85vh", display: "flex", flexDirection: "column",
                  padding: "20px 16px 30px",
                  fontFamily: "'Tajawal',sans-serif",
                }}>
                  <div style={{ color: "#fff", fontWeight: 800, fontSize: 15, marginBottom: 12, textAlign: "center" }}>
                    📖 اختر سورة التلاوة
                  </div>

                  <input
                    autoFocus
                    type="text"
                    placeholder="ابحث عن سورة..."
                    value={surahSearch}
                    onChange={(e) => setSurahSearch(e.target.value)}
                    style={{ ...S.input, marginBottom: 10, fontSize: 14 }}
                  />

                  <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
                    {PICKER_SURAHS.map((s) =>
                      s.name.includes(surahSearch.trim()) ? (
                        <button
                          key={s.index}
                          type="button"
                          onClick={() => {
                            setTilawaSurah(s.index);
                            setTilawaFromAyah("");
                            setTilawaToAyah("");
                            setTilawaPickerOpen(false);
                            setSurahSearch("");
                          }}
                          style={{
                            background: tilawaSurah === s.index ? `${accentColor}33` : "rgba(255,255,255,0.06)",
                            border: tilawaSurah === s.index
                              ? `1.5px solid ${accentColor}`
                              : "1.5px solid rgba(255,255,255,0.1)",
                            borderRadius: 10, padding: "10px 14px",
                            color: "#fff", fontFamily: "'Tajawal',sans-serif",
                            fontSize: 14, fontWeight: 700, cursor: "pointer",
                            display: "flex", justifyContent: "space-between", alignItems: "center",
                          }}
                        >
                          <span>{s.index + 1}. {s.name}</span>
                          <span style={{ color: "rgba(255,255,255,0.45)", fontSize: 12 }}>
                            {tilawaSurah === s.index ? "✓" : `${s.ayahs} آية`}
                          </span>
                        </button>
                      ) : null
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setTilawaPickerOpen(false);
                      setSurahSearch("");
                    }}
                    style={{
                      width: "100%", marginTop: 16, padding: "15px", borderRadius: 14, border: "none",
                      background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.6)",
                      fontFamily: "'Tajawal',sans-serif", fontSize: 15, fontWeight: 700, cursor: "pointer",
                    }}
                  >
                    إلغاء
                  </button>
                </div>
              </div>
            )}

            {/* ── Surah Picker Modal ── */}
            {pickerTarget !== null && (() => {
              const targetItem = regItems.find((item) => item.id === pickerTarget.itemId);
              const isFrom = pickerTarget.side === "from";
              const currentRange = targetItem
                ? (itemValues[pickerTarget.itemId]?.range ?? emptySurahRange())
                : emptySurahRange();
              const setRange = (updater: (prev: SurahRange) => SurahRange) =>
                setItemValues((prev) => {
                  const base = prev[pickerTarget.itemId] ?? emptyRegItemValue();
                  return { ...prev, [pickerTarget.itemId]: { ...base, range: updater(base.range) } };
                });
              const currentPoint = isFrom ? currentRange.from : currentRange.to;
              const title = `${targetItem?.label ?? "البند"} — ${isFrom ? "من" : "إلى"}`;

              return (
                <div style={{
                  position: "fixed", inset: 0, zIndex: 2000,
                  background: "rgba(0,0,0,0.82)",
                  display: "flex", alignItems: "flex-end", justifyContent: "center",
                }}>
                  <div style={{
                    background: "#1e293b",
                    border: "1.5px solid rgba(255,255,255,0.12)",
                    borderRadius: "24px 24px 0 0",
                    width: "100%", maxWidth: 430,
                    maxHeight: "85vh", display: "flex", flexDirection: "column",
                    padding: "20px 16px 30px",
                    fontFamily: "'Tajawal',sans-serif",
                  }}>
                    <div style={{ color: "#fff", fontWeight: 800, fontSize: 15, marginBottom: 12, textAlign: "center" }}>
                      {title}
                    </div>

                    {/* Ayah number (if surah already chosen) */}
                    {currentPoint.surahIndex !== null && (
                      <div style={{ marginBottom: 16 }}>
                        <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, fontWeight: 700, marginBottom: 10, textAlign: "center" }}>
                          سورة {SURAHS[currentPoint.surahIndex].name} — أدخل رقم الآية (1 – {SURAHS[currentPoint.surahIndex].ayahs})
                        </div>
                        <input
                          type="number" min={1} max={SURAHS[currentPoint.surahIndex].ayahs}
                          value={currentPoint.ayah ?? ""}
                          inputMode="numeric"
                          onChange={(e) => {
                            if (e.target.value === "") {
                              setRange((prev) => isFrom
                                ? { ...prev, from: { ...prev.from, ayah: null } }
                                : { ...prev, to:   { ...prev.to,   ayah: null } }
                              );
                            } else {
                              const v = Math.max(1, Math.min(Number(e.target.value), SURAHS[currentPoint.surahIndex!].ayahs));
                              setRange((prev) => isFrom
                                ? { ...prev, from: { ...prev.from, ayah: v } }
                                : { ...prev, to:   { ...prev.to,   ayah: v } }
                              );
                            }
                          }}
                          style={{ ...S.input, marginBottom: 12, fontSize: 20, textAlign: "center", letterSpacing: 2 }}
                          placeholder="مثال: 25"
                          autoFocus
                        />
                        <button onClick={() => {
                          setRange((prev) => isFrom
                            ? { ...prev, from: emptySurahPoint(), to: emptySurahPoint() }
                            : { ...prev, to:   emptySurahPoint() }
                          );
                        }} style={{ width: "100%", padding: "11px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.5)", fontFamily: "'Tajawal',sans-serif", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                          ↩️ تغيير السورة
                        </button>
                      </div>
                    )}

                    {/* Surah search + list */}
                    {currentPoint.surahIndex === null && (
                      <>
                        <input
                          autoFocus
                          type="text"
                          placeholder="ابحث عن سورة..."
                          value={surahSearch}
                          onChange={(e) => setSurahSearch(e.target.value)}
                          style={{ ...S.input, marginBottom: 10, fontSize: 14 }}
                        />
                        <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
                          {PICKER_SURAHS.map((s) =>
                            s.name.includes(surahSearch) ? (
                              <button key={s.index} onClick={() => {
                                setRange((prev) => {
                                  const selectedPoint = { surahIndex: s.index, ayah: null };

                                  // عند اختيار سورة "من"، نضع نفس السورة تلقائياً في "إلى"
                                  // ويبقى رقم الآية في "إلى" فارغاً ليختاره المستخدم بسرعة.
                                  if (isFrom) {
                                    return {
                                      ...prev,
                                      from: selectedPoint,
                                      to: { surahIndex: s.index, ayah: null },
                                    };
                                  }

                                  return { ...prev, to: selectedPoint };
                                });
                                setSurahSearch("");
                              }} style={{
                                background: "rgba(255,255,255,0.06)",
                                border: "1.5px solid rgba(255,255,255,0.1)",
                                borderRadius: 10, padding: "10px 14px",
                                color: "#fff", fontFamily: "'Tajawal',sans-serif",
                                fontSize: 14, fontWeight: 700, cursor: "pointer",
                                display: "flex", justifyContent: "space-between",
                              }}>
                                <span>{s.index + 1}. {s.name}</span>
                                <span style={{ color: "rgba(255,255,255,0.35)", fontSize: 12 }}>{s.ayahs} آية</span>
                              </button>
                            ) : null
                          )}
                        </div>
                      </>
                    )}

                    {/* Confirm + Cancel */}
                    <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                      <button onClick={() => { setPickerTarget(null); setSurahSearch(""); }}
                        style={{ flex: 1, padding: "15px", borderRadius: 14, border: "none",
                          background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.6)",
                          fontFamily: "'Tajawal',sans-serif", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
                        إلغاء
                      </button>
                      {currentPoint.surahIndex !== null && (
                        <button
                          onClick={() => {
                            setSurahSearch("");

                            // بعد تأكيد «من» ننتقل تلقائياً إلى «إلى» لنفس القسم،
                            // فلا يحتاج المعلم إلى إغلاق النافذة والضغط على زر «إلى» يدوياً.
                            if (isFrom) {
                              setPickerTarget({ itemId: pickerTarget.itemId, side: "to" });
                              return;
                            }

                            setPickerTarget(null);
                          }}
                          style={{ flex: 2, padding: "15px", borderRadius: 14, border: "none",
                            background: accentColor,
                            color: "#fff",
                            fontFamily: "'Tajawal',sans-serif", fontSize: 15, fontWeight: 800, cursor: "pointer",
                            boxShadow: `0 4px 18px ${accentColor}55`,
                            transition: "all 0.2s ease" }}>
                          {isFrom ? "التالي: اختر «إلى»" : "✔ تأكيد"}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}

            {ENABLE_FIRST_CIRCLE_TRACKS && isFirstCircle && studentName && firstCircleTrack && (
              <div
                style={{
                  marginBottom: 16,
                  padding: "13px 14px",
                  borderRadius: 14,
                  border: `1.5px solid ${accentColor}66`,
                  background: `${accentColor}18`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ color: "rgba(255,255,255,0.48)", fontSize: 10, fontWeight: 700, marginBottom: 4 }}>
                    مسار الطالب من شيت حلقة أولى
                  </div>
                  <div style={{ color: "#fff", fontSize: 14, fontWeight: 800 }}>
                    {getFirstCircleTrackMeta(firstCircleTrack).icon} {getFirstCircleTrackMeta(firstCircleTrack).label}
                  </div>
                </div>
                <span style={{ color: "#86efac", fontSize: 11, fontWeight: 800 }}>ثابت ✓</span>
              </div>
            )}

            {isFirstCircle && firstCircleTrack === "nurania" && (
              <div style={{ marginBottom: 16 }}>
                <label style={S.label}>🔤 درس القاعدة النورانية</label>
                <button
                  type="button"
                  onClick={() => {
                    if (firstCircleScoreValue !== "absent") {
                      setLessonSearch("");
                      setLessonPickerOpen(true);
                    }
                  }}
                  disabled={firstCircleScoreValue === "absent"}
                  style={{
                    ...S.input,
                    cursor: firstCircleScoreValue === "absent" ? "not-allowed" : "pointer",
                    opacity: firstCircleScoreValue === "absent" ? 0.55 : 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    textAlign: "right",
                    color: nuraniaLesson === null ? "rgba(255,255,255,0.45)" : "#fff",
                  }}
                >
                  <span>{nuraniaLesson === null ? "اختر الدرس" : NURANIA_LESSONS[nuraniaLesson]}</span>
                  <span style={{ opacity: 0.6 }}>⌄</span>
                </button>

                <label style={S.label}>✍️ الجزء المقروء من الدرس</label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                  <input
                    type="text"
                    value={nuraniaFromText}
                    onChange={(e) => setNuraniaFromText(e.target.value)}
                    placeholder="من"
                    disabled={firstCircleScoreValue === "absent"}
                    style={{ ...S.input, marginBottom: 0, opacity: firstCircleScoreValue === "absent" ? 0.55 : 1 }}
                  />
                  <input
                    type="text"
                    value={nuraniaToText}
                    onChange={(e) => setNuraniaToText(e.target.value)}
                    placeholder="إلى"
                    disabled={firstCircleScoreValue === "absent"}
                    style={{ ...S.input, marginBottom: 0, opacity: firstCircleScoreValue === "absent" ? 0.55 : 1 }}
                  />
                </div>

                <label style={S.label}>⭐ تقييم القاعدة النورانية <span style={S.hint}>(30 تحسب 60 نقطة)</span></label>
                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                  {MEM_OPTIONS.map((opt, idx) => {
                    const value: FirstCircleScore = opt === null ? "absent" : opt;
                    return (
                      <OptionBtn
                        key={idx}
                        active={firstCircleScoreValue === value}
                        danger={opt === null}
                        accentColor={accentColor}
                        onClick={() => {
                          const next = firstCircleScoreValue === value ? null : value;
                          setFirstCircleScoreValue(next);
                          if (next === "absent") {
                            setNuraniaLesson(null);
                            setLessonPickerOpen(false);
                            setLessonSearch("");
                            setNuraniaFromText("");
                            setNuraniaToText("");
                          }
                        }}
                      >
                        {opt === null ? "❌ لم يسمع" : `${opt} = ${opt * 2} نقطة`}
                      </OptionBtn>
                    );
                  })}
                </div>
              </div>
            )}

            {isFirstCircle && firstCircleTrack === "tilawa" && (
              <div style={{ marginBottom: 16 }}>
                <label style={S.label}>📖 سورة التلاوة</label>
                <button
                  type="button"
                  onClick={() => {
                    if (firstCircleScoreValue !== "absent") {
                      setSurahSearch("");
                      setTilawaPickerOpen(true);
                    }
                  }}
                  disabled={firstCircleScoreValue === "absent"}
                  style={{
                    ...S.input,
                    cursor: firstCircleScoreValue === "absent" ? "not-allowed" : "pointer",
                    opacity: firstCircleScoreValue === "absent" ? 0.55 : 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    textAlign: "right",
                    color: tilawaSurah === null ? "rgba(255,255,255,0.45)" : "#fff",
                  }}
                >
                  <span>{tilawaSurah === null ? "اختر السورة" : SURAHS[tilawaSurah]?.name}</span>
                  <span style={{ opacity: 0.6 }}>⌄</span>
                </button>

                <label style={S.label}>
                  🔢 الآيات من وإلى
                  {tilawaSurah !== null && (
                    <span style={S.hint}> (السورة {SURAHS[tilawaSurah]?.ayahs || 0} آية)</span>
                  )}
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={tilawaSurah !== null ? SURAHS[tilawaSurah]?.ayahs : undefined}
                    value={tilawaFromAyah}
                    onChange={(e) => setTilawaFromAyah(e.target.value)}
                    placeholder="من آية"
                    disabled={firstCircleScoreValue === "absent" || tilawaSurah === null}
                    style={{ ...S.input, marginBottom: 0, opacity: firstCircleScoreValue === "absent" || tilawaSurah === null ? 0.55 : 1 }}
                  />
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={tilawaSurah !== null ? SURAHS[tilawaSurah]?.ayahs : undefined}
                    value={tilawaToAyah}
                    onChange={(e) => setTilawaToAyah(e.target.value)}
                    placeholder="إلى آية"
                    disabled={firstCircleScoreValue === "absent" || tilawaSurah === null}
                    style={{ ...S.input, marginBottom: 0, opacity: firstCircleScoreValue === "absent" || tilawaSurah === null ? 0.55 : 1 }}
                  />
                </div>

                <label style={S.label}>⭐ تقييم التلاوة <span style={S.hint}>(30 تحسب 60 نقطة)</span></label>
                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                  {MEM_OPTIONS.map((opt, idx) => {
                    const value: FirstCircleScore = opt === null ? "absent" : opt;
                    return (
                      <OptionBtn
                        key={idx}
                        active={firstCircleScoreValue === value}
                        danger={opt === null}
                        accentColor={accentColor}
                        onClick={() => {
                          const next = firstCircleScoreValue === value ? null : value;
                          setFirstCircleScoreValue(next);
                          if (next === "absent") {
                            setTilawaSurah(null);
                            setTilawaPickerOpen(false);
                            setSurahSearch("");
                            setTilawaFromAyah("");
                            setTilawaToAyah("");
                          }
                        }}
                      >
                        {opt === null ? "❌ لم يسمع" : `${opt} = ${opt * 2} نقطة`}
                      </OptionBtn>
                    );
                  })}
                </div>
              </div>
            )}


            {/* Points summary */}
            {hasRegistrationData && (
              <div
                style={{
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 14,
                  padding: "14px 16px",
                  marginBottom: 16,
                }}
              >
                {(
                  [
                    usesFirstCircleSpecialTrack && firstCircleScoreValue !== null && [
                      firstCircleTrack === "nurania" ? "🔤 القاعدة النورانية" : "📖 التلاوة",
                      firstCircleScoreValue === "absent" ? "لم يسمع" : `+${specialTrackPoints}`,
                    ],
                    ...regItems
                      .filter((item) => !usesFirstCircleSpecialTrack || item.type !== "range")
                      .map((item) => {
                        const summary = regItemSummaryText(item, itemValues[item.id]);
                        return summary ? [summary.label, summary.value] : null;
                      }),
                  ] as (false | [string, string] | null)[]
                )
                  .filter(Boolean)
                  .map((row) => {
                    const [l, v] = row as [string, string];
                    return (
                      <div
                        key={l}
                        style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}
                      >
                        <span style={{ color: "rgba(255,255,255,0.45)", fontSize: 12 }}>{l}</span>
                        <span
                          style={{
                            color:
                              v.startsWith("+")
                                ? "#4ade80"
                                : v === "لم يسمع"
                                ? "#f87171"
                                : "#fff",
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                        >
                          {v}
                        </span>
                      </div>
                    );
                  })}
                <div
                  style={{
                    height: 1,
                    background: "rgba(255,255,255,0.1)",
                    margin: "10px 0",
                  }}
                />
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 14, fontWeight: 700 }}>
                    يُضاف الآن
                  </span>
                  <span
                    style={{
                      color: "#fde047",
                      fontSize: 26,
                      fontWeight: 900,
                      textShadow: "0 0 20px rgba(253,224,71,0.6)",
                    }}
                  >
                    {preview} نقطة
                  </span>
                </div>
              </div>
            )}

            {/* Submit button */}
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className={canSubmit ? "smooth-btn btn-shine" : "smooth-btn"}
              style={{
                width: "100%",
                padding: "18px",
                borderRadius: 18,
                border: "none",
                position: "relative",
                overflow: "hidden",
                fontFamily: "'Tajawal',sans-serif",
                fontSize: 16,
                fontWeight: 900,
                cursor: canSubmit ? "pointer" : "not-allowed",
                background: canSubmit
                  ? `linear-gradient(180deg, ${accentColor}, ${accentColor}bb)`
                  : "rgba(255,255,255,0.08)",
                color: canSubmit ? "#fff" : "rgba(255,255,255,0.3)",
                boxShadow: canSubmit
                  ? `0 6px 24px ${accentColor}66, inset 0 1px 0 rgba(255,255,255,0.3)`
                  : "none",
              }}
            >
              {sending
                ? "⏳ جارٍ الإرسال..."
                : canSubmit
                ? `➕ تسجيل (${preview} نقطة)`
                : "اختر طالباً وبنداً على الأقل"}
            </button>
          </div>
        )}

        {/* Prompt to select a team/student */}
        {!quickMode && !studentName && (
          <div
            style={{
              textAlign: "center",
              color: "rgba(255,255,255,0.3)",
              fontSize: 13,
              fontWeight: 600,
              padding: "10px 0",
            }}
          >
            👆 اختر الفصل ثم الطالب للبدء
          </div>
        )}
      </div>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(160deg,#0f172a 0%,#1e293b 60%,#0f2027 100%)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "16px 12px 100px",
    fontFamily: "'Tajawal',sans-serif",
    direction: "rtl",
    overflowY: "auto",
    WebkitOverflowScrolling: "touch",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    color: "#fff",
    fontSize: 20,
    fontWeight: 900,
    marginBottom: 20,
    letterSpacing: 1,
    width: "100%",
    maxWidth: 430,
  },
  card: {
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.09)",
    borderRadius: 20,
    padding: "18px 14px",
    width: "100%",
    maxWidth: 430,
    backdropFilter: "blur(12px)",
    marginBottom: 12,
    boxSizing: "border-box" as const,
  },
  label: {
    display: "block",
    color: "rgba(255,255,255,0.5)",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  input: {
    width: "100%",
    background: "rgba(255,255,255,0.07)",
    border: "1.5px solid rgba(255,255,255,0.1)",
    borderRadius: 14,
    color: "#fff",
    fontSize: 16,
    padding: "15px 16px",
    marginBottom: 16,
    outline: "none",
    fontFamily: "'Tajawal',sans-serif",
    boxSizing: "border-box" as const,
    transition: "border-color 0.2s",
    WebkitAppearance: "none",
  },
  sectionTitle: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 1.2,
    marginBottom: 10,
  },
  hint: {
    color: "rgba(255,255,255,0.3)",
    fontSize: 10,
    fontWeight: 400,
    marginRight: 6,
  },
  badge: {
    background: "rgba(99,102,241,0.25)",
    color: "#a5b4fc",
    fontSize: 10,
    fontWeight: 700,
    borderRadius: 8,
    padding: "2px 7px",
    marginRight: 6,
  },
  clearBtn: {
    padding: "10px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    color: "rgba(255,255,255,0.45)",
    fontSize: 11,
    cursor: "pointer",
    fontFamily: "'Tajawal',sans-serif",
    transition: "all 0.18s",
  },
};