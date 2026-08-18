import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { v4 as uuidv4 } from "uuid";

type DisplayVersion = 1;

type TeamId = string;

interface Team {
  id: TeamId;
  name: string;
  color: string;
  points: number;
  roundPoints: number;
  coins: number;
  position: number;
  movesToday: number;
  dailyDate: string;
  doublePoints: boolean;
  doublePointsDate: string;
  visitedIslands: number[];
  createdAt: string;

  // بيانات الفصل الديناميكي القادمة من Google Apps Script — خمسة فصول ونسخة واحدة.
  sheetId?: number;
  slot?: number;
  version?: DisplayVersion;
  displayVersion?: DisplayVersion;
}

interface Tile {
  id: number;
  type: "normal" | "surprise";
  surpriseMessage?: string;
}

interface GameEvent {
  text: string;
  time: string;
  ts: number;
}

interface RegistrationItem {
  id: string;
  label: string;
  type: "points" | "yesno" | "range";
  points: number;
}

interface GameState {
  teams: Team[];
  tiles: Tile[];
  events: GameEvent[];
  // البنود هنا قناة بث لحظية فقط؛ المصدر الرسمي الدائم هو Google Apps Script.
  registrationItems?: RegistrationItem[];
  registrationItemsUpdatedAt?: string;
}

interface ClassSyncItem {
  id?: string;
  classId?: string;
  name?: string;
  className?: string;
  sheetId?: number | string;
  slot?: number | string;
  version?: number | string;
  displayVersion?: number | string;
  color?: string;
}

const ACTIVE_CLASS_COUNT = 5;

const MAX_BOARD_POSITION = 18;

const DEFAULT_CONSTANTS = {
  POINTS_PER_STEP: 1500,
  COINS_PER_STEP: 10,
  ISLAND_COINS_BONUS: 500,
  DOUBLE_POINTS_COST: 500,
};

// هذه هويات النظام القديم فقط لغرض تنظيف game.json القديم عند التشغيل.
const LEGACY_TEAM_IDS = new Set(["blue", "red", "green", "purple"]);

function getToday() {
  return new Date().toDateString();
}

function colorFromId(id: string): string {
  // لون ثابت يعتمد على classId، لذلك تغيير اسم الفصل لا يغيّر اللون.
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 72% 55%)`;
}

function createDynamicTeam(
  id: string,
  name: string,
  metadata: Partial<Pick<Team, "sheetId" | "slot" | "version" | "displayVersion" | "color">> = {},
): Team {
  return {
    id,
    name: name || id,
    color: metadata.color || colorFromId(id),
    points: 0,
    roundPoints: 0,
    coins: 0,
    position: 0,
    movesToday: 0,
    dailyDate: getToday(),
    doublePoints: false,
    doublePointsDate: "",
    visitedIslands: [0],
    createdAt: new Date().toISOString(),
    ...(typeof metadata.sheetId === "number" ? { sheetId: metadata.sheetId } : {}),
    ...(typeof metadata.slot === "number" ? { slot: metadata.slot } : {}),
    ...(metadata.version ? { version: metadata.version } : {}),
    ...(metadata.displayVersion ? { displayVersion: metadata.displayVersion } : {}),
  };
}

function normalizeSavedTeam(raw: any): Team | null {
  const id = String(raw?.id || "").trim();
  if (!id || LEGACY_TEAM_IDS.has(id) || !id.startsWith("class-")) return null;

  const name = String(raw?.name || id).trim() || id;
  const slotNumber = Number(raw?.slot);
  const sheetIdNumber = Number(raw?.sheetId);
  if (!Number.isFinite(slotNumber) || slotNumber < 1 || slotNumber > ACTIVE_CLASS_COUNT) return null;
  const version: DisplayVersion = 1;

  return {
    ...createDynamicTeam(id, name, {
      color: String(raw?.color || "").trim() || colorFromId(id),
      ...(Number.isFinite(sheetIdNumber) ? { sheetId: sheetIdNumber } : {}),
      ...(Number.isFinite(slotNumber) ? { slot: slotNumber } : {}),
      ...(version ? { version, displayVersion: version } : {}),
    }),
    points: Number.isFinite(Number(raw?.points)) ? Number(raw.points) : 0,
    roundPoints: Number.isFinite(Number(raw?.roundPoints)) ? Number(raw.roundPoints) : 0,
    coins: Number.isFinite(Number(raw?.coins)) ? Number(raw.coins) : 0,
    position: Number.isFinite(Number(raw?.position)) ? Number(raw.position) : 0,
    movesToday: Number.isFinite(Number(raw?.movesToday)) ? Number(raw.movesToday) : 0,
    dailyDate: String(raw?.dailyDate || getToday()),
    doublePoints: Boolean(raw?.doublePoints),
    doublePointsDate: String(raw?.doublePointsDate || ""),
    visitedIslands: Array.isArray(raw?.visitedIslands)
      ? raw.visitedIslands.map(Number).filter(Number.isFinite)
      : [0],
    createdAt: String(raw?.createdAt || new Date().toISOString()),
  };
}

function generateDefaultTiles(): Tile[] {
  const tiles: Tile[] = Array.from({ length: MAX_BOARD_POSITION + 1 }, (_, i) => ({
    id: i,
    type: "normal" as const,
  }));
  tiles[4] = {
    id: 4,
    type: "surprise",
    surpriseMessage: "ايس كريم للفصل كامل",
  };
  return tiles;
}

const DATA_FILE = "./game.json";

async function loadState(): Promise<GameState> {
  if (!existsSync(DATA_FILE)) {
    return { teams: [], tiles: generateDefaultTiles(), events: [] };
  }

  try {
    const raw = await readFile(DATA_FILE, "utf-8");
    const saved = JSON.parse(raw);

    const teams = Array.isArray(saved?.teams)
      ? saved.teams.map(normalizeSavedTeam).filter((team: Team | null): team is Team => Boolean(team))
      : [];

    const tiles = Array.isArray(saved?.tiles) && saved.tiles.length > 0
      ? saved.tiles
      : generateDefaultTiles();

    const events = Array.isArray(saved?.events) ? saved.events : [];

    // لا نستعيد بنود التسجيل من game.json حتى لا تصبح نسخة Render القديمة
    // أسبق من Google Apps Script. الصفحة تقرأ البنود الرسمية من Google أولاً.
    return { teams, tiles, events };
  } catch (err) {
    console.error("Failed to read game.json; starting with a safe empty dynamic state:", err);
    return { teams: [], tiles: generateDefaultTiles(), events: [] };
  }
}

async function saveState(state: GameState) {
  await writeFile(DATA_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function addEvent(state: GameState, text: string) {
  state.events.push({
    text,
    time: new Date().toLocaleTimeString("ar-EG"),
    ts: Date.now(),
  });
}

function getTeam(state: GameState, teamId: string) {
  return state.teams.find((team) => team.id === teamId) || null;
}

function ensureDynamicTeam(
  state: GameState,
  teamId: string,
  teamName = "",
): Team | null {
  const id = String(teamId || "").trim();
  if (!id) return null;

  let team = getTeam(state, id);
  if (team) {
    const cleanName = String(teamName || "").trim();
    if (cleanName && team.name !== cleanName) team.name = cleanName;
    return team;
  }

  // AdminPage الحالي يرسل classId + teamName عند التسجيل.
  // هذا يسمح بأول تسجيل حتى قبل أن نضيف syncClasses إلى DisplayPage.
  if (!id.startsWith("class-")) return null;

  team = createDynamicTeam(id, String(teamName || id).trim() || id);
  state.teams.push(team);
  addEvent(state, `🆕 تمت تهيئة الفصل "${team.name}" في السباق`);
  return team;
}

function parseClassSyncItem(item: ClassSyncItem) {
  const id = String(item?.classId || item?.id || "").trim();
  if (!id || !id.startsWith("class-")) return null;

  const name = String(item?.className || item?.name || id).trim() || id;
  const sheetId = Number(item?.sheetId);
  const slot = Number(item?.slot);
  if (!Number.isFinite(slot) || slot < 1 || slot > ACTIVE_CLASS_COUNT) return null;
  const color = String(item?.color || "").trim();

  return {
    id,
    name,
    ...(Number.isFinite(sheetId) ? { sheetId } : {}),
    slot,
    version: 1 as DisplayVersion,
    displayVersion: 1 as DisplayVersion,
    ...(color ? { color } : {}),
  };
}

function syncDynamicClasses(state: GameState, rawClasses: unknown) {
  if (!Array.isArray(rawClasses)) {
    return { changed: false, count: state.teams.length };
  }

  const beforeFingerprint = JSON.stringify(
    [...state.teams]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((team) => [
        team.id,
        team.name,
        team.color,
        team.sheetId ?? null,
        team.slot ?? null,
        team.version ?? team.displayVersion ?? null,
      ]),
  );

  const parsed = rawClasses
    .map((item) => parseClassSyncItem(item as ClassSyncItem))
    .filter((item): item is NonNullable<ReturnType<typeof parseClassSyncItem>> => Boolean(item));

  // لا نمسح حالة سليمة بسبب response ناقص/فارغ بالخطأ.
  if (parsed.length === 0) {
    return { changed: false, count: state.teams.length };
  }

  const existingById = new Map(state.teams.map((team) => [team.id, team]));
  const syncedTeams: Team[] = parsed.map((schoolClass) => {
    const existing = existingById.get(schoolClass.id);

    if (!existing) {
      return createDynamicTeam(schoolClass.id, schoolClass.name, schoolClass);
    }

    // الهوية والنقاط والحركة تبقى كما هي. فقط metadata والاسم الحالي تتحدث.
    existing.name = schoolClass.name;
    existing.color = schoolClass.color || existing.color || colorFromId(schoolClass.id);
    if (typeof schoolClass.sheetId === "number") existing.sheetId = schoolClass.sheetId;
    if (typeof schoolClass.slot === "number") existing.slot = schoolClass.slot;
    existing.version = 1;
    existing.displayVersion = 1;
    return existing;
  });

  // syncClasses هي قائمة الحقيقة من Apps Script؛ نحذف legacy وأي فصل لم يعد ضمن القائمة.
  state.teams = syncedTeams.sort((a, b) => {
    const slotA = Number.isFinite(Number(a.slot)) ? Number(a.slot) : Number.MAX_SAFE_INTEGER;
    const slotB = Number.isFinite(Number(b.slot)) ? Number(b.slot) : Number.MAX_SAFE_INTEGER;
    return slotA - slotB;
  });

  const afterFingerprint = JSON.stringify(
    [...state.teams]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((team) => [
        team.id,
        team.name,
        team.color,
        team.sheetId ?? null,
        team.slot ?? null,
        team.version ?? team.displayVersion ?? null,
      ]),
  );

  return { changed: beforeFingerprint !== afterFingerprint, count: state.teams.length };
}

function applyAddPoints(
  state: GameState,
  teamId: string,
  pts: number,
  teamName = "",
) {
  const team = ensureDynamicTeam(state, teamId, teamName);
  if (!team) return null;

  const numericPts = Number(pts);
  if (!Number.isFinite(numericPts)) return null;

  const today = getToday();
  if (team.dailyDate !== today) {
    team.movesToday = 0;
    team.dailyDate = today;
  }

  if (team.doublePoints && team.doublePointsDate !== today) {
    team.doublePoints = false;
    team.doublePointsDate = "";
  }

  const actual = team.doublePoints ? numericPts * 2 : numericPts;
  team.points += actual;
  team.roundPoints = (team.roundPoints || 0) + actual;

  // Undo لا ينبغي أن يترك الرصيد الكلي سالباً.
  if (team.points < 0) team.points = 0;
  if (team.roundPoints < 0) team.roundPoints = 0;

  return { team, actual };
}

function normalizeRegistrationItems(rawItems: unknown): RegistrationItem[] {
  if (!Array.isArray(rawItems)) return [];
  const seen = new Set<string>();
  return rawItems
    .map((raw: any) => {
      const id = String(raw?.id || "").trim();
      const label = String(raw?.label || "").trim();
      const rawType = String(raw?.type || "points");
      const type: RegistrationItem["type"] =
        rawType === "yesno" || rawType === "range" ? rawType : "points";
      const points = Math.max(0, Number.isFinite(Number(raw?.points)) ? Number(raw.points) : 0);
      if (!id || !label || seen.has(id)) return null;
      seen.add(id);
      return { id, label, type, points };
    })
    .filter((item): item is RegistrationItem => Boolean(item));
}

const clients = new Set<any>();

function broadcast(message: any) {
  const payload = JSON.stringify(message);
  for (const ws of clients) {
    try {
      ws.send(payload);
    } catch (err) {
      console.warn("Failed to broadcast to a websocket client:", err);
    }
  }
}

function broadcastFullState() {
  broadcast({ type: "fullState", state });
}

async function handleMessage(ws: any, msg: string) {
  void ws;

  let data: any;
  try {
    data = JSON.parse(msg);
  } catch {
    return;
  }

  switch (data.type) {
    case "syncClasses": {
      const result = syncDynamicClasses(state, data.classes);
      if (result.changed) {
        addEvent(state, `🔄 تمت مزامنة ${result.count} فصل من Google Sheets`);
        broadcastFullState();
      }
      break;
    }

    case "syncRegItems": {
      const items = normalizeRegistrationItems(data.items);
      if (!items.length) break;

      state.registrationItems = items;
      state.registrationItemsUpdatedAt = String(data.updatedAt || new Date().toISOString());
      addEvent(state, `⚙️ تم تحديث بنود التسجيل الرسمية (${items.length} بنود)`);
      broadcastFullState();
      break;
    }

    case "submitStudentPoints": {
      const { teamId, pts, studentName, teamName } = data;
      const result = applyAddPoints(state, String(teamId || ""), Number(pts), teamName);
      if (!result) return;

      addEvent(state, `➕ إضافة ${result.actual} نقطة للفصل "${result.team.name}"`);

      // النظام الحالي نسخة واحدة فقط.
      const announcedVersion: DisplayVersion = 1;

      broadcast({
        type: "announcement",
        id: uuidv4(),
        studentName: studentName || "غير معروف",
        points: result.actual,
        teamColor: result.team.color,
        teamName: result.team.name,
        teamId: result.team.id,
        version: announcedVersion,
        slot: result.team.slot ?? 0,
      });

      broadcastFullState();
      break;
    }

    case "moveTeamManual": {
      const { teamId, steps } = data;
      const team = getTeam(state, String(teamId || ""));
      if (!team) return;

      const oldPos = team.position;
      const numericSteps = Number(steps);
      if (!Number.isFinite(numericSteps)) return;

      const newPos = Math.min(Math.max(team.position + numericSteps, 0), MAX_BOARD_POSITION);
      team.position = newPos;
      team.coins += Math.abs(newPos - oldPos) * DEFAULT_CONSTANTS.COINS_PER_STEP;
      addEvent(state, `🚢 تحريك "${team.name}" ${numericSteps} مربعات يدوياً`);
      broadcastFullState();
      break;
    }

    case "visitIsland": {
      const { teamId, islandIndex } = data;
      const team = getTeam(state, String(teamId || ""));
      if (!team) return;

      const numericIslandIndex = Number(islandIndex);
      if (!Number.isFinite(numericIslandIndex)) return;

      if (!team.visitedIslands.includes(numericIslandIndex)) {
        team.visitedIslands.push(numericIslandIndex);
        team.coins += DEFAULT_CONSTANTS.ISLAND_COINS_BONUS;
        addEvent(state, `🏝️ الفصل "${team.name}" زار جزيرة ${numericIslandIndex}`);
        broadcastFullState();
      }
      break;
    }

    case "addCoins": {
      const { teamId, amount } = data;
      const team = getTeam(state, String(teamId || ""));
      if (!team) return;

      const numericAmount = Number(amount);
      if (!Number.isFinite(numericAmount)) return;

      team.coins = Math.max(0, team.coins + numericAmount);
      broadcastFullState();
      break;
    }

    case "toggleDoublePoints": {
      const { teamId } = data;
      const team = getTeam(state, String(teamId || ""));
      if (!team) return;

      if (team.doublePoints) {
        team.doublePoints = false;
        team.doublePointsDate = "";
      } else {
        if (team.coins < DEFAULT_CONSTANTS.DOUBLE_POINTS_COST) return;
        team.coins -= DEFAULT_CONSTANTS.DOUBLE_POINTS_COST;
        team.doublePoints = true;
        team.doublePointsDate = getToday();
      }
      broadcastFullState();
      break;
    }

    case "renameTeam": {
      const { teamId, name } = data;
      const team = getTeam(state, String(teamId || ""));
      const cleanName = String(name || "").trim();
      if (team && cleanName) {
        team.name = cleanName;
        broadcastFullState();
      }
      break;
    }

    case "changeTeamColor": {
      const { teamId, color } = data;
      const team = getTeam(state, String(teamId || ""));
      const cleanColor = String(color || "").trim();
      if (team && cleanColor) {
        team.color = cleanColor;
        broadcastFullState();
      }
      break;
    }

    case "addTeam": {
      // النظام ثابت على خمسة فصول رسمية؛ لا نسمح بإضافة فريق سادس من أدوات الإدارة القديمة.
      break;
    }

    case "deleteTeam": {
      const { teamId } = data;
      const idx = state.teams.findIndex((team) => team.id === String(teamId || ""));
      if (idx !== -1) {
        const name = state.teams[idx]?.name;
        state.teams.splice(idx, 1);
        addEvent(state, `🗑️ تم حذف الفريق "${name}"`);
        broadcastFullState();
      }
      break;
    }

    case "updateTile": {
      const { tileId, updates } = data;
      const tile = state.tiles.find((item) => item.id === Number(tileId));
      if (tile && updates && typeof updates === "object") {
        Object.assign(tile, updates);
        broadcastFullState();
      }
      break;
    }

    case "moveShips": {
      const positions = data.positions || {};
      for (const team of state.teams) {
        if (positions[team.id] !== undefined) {
          const nextPosition = Number(positions[team.id]);
          if (!Number.isFinite(nextPosition)) continue;
          team.position = nextPosition;
          team.roundPoints = 0;
        }
      }
      addEvent(state, "🚢 تم تحريك السفن إلى المواضع الجديدة");
      broadcastFullState();
      break;
    }

    case "adjustPoints": {
      const { teamId, amount } = data;
      const team = getTeam(state, String(teamId || ""));
      if (!team) return;

      const numericAmount = Number(amount);
      if (!Number.isFinite(numericAmount)) return;

      const before = team.points;
      team.points = Math.max(0, team.points + numericAmount);
      const actualDelta = team.points - before;
      team.roundPoints = Math.max(0, (team.roundPoints || 0) + actualDelta);
      broadcastFullState();
      break;
    }

    case "resetGame": {
      // مهم: لا نرجع blue/red/green/purple.
      // نحافظ على هوية واسم وslot/version لكل فصل ونصفر بيانات السباق فقط.
      state = {
        teams: state.teams
          .filter((team) =>
            !LEGACY_TEAM_IDS.has(team.id) &&
            team.id.startsWith("class-") &&
            Number(team.slot) >= 1 &&
            Number(team.slot) <= ACTIVE_CLASS_COUNT
          )
          .map((team) =>
            createDynamicTeam(team.id, team.name, {
              color: team.color || colorFromId(team.id),
              ...(typeof team.sheetId === "number" ? { sheetId: team.sheetId } : {}),
              ...(typeof team.slot === "number" ? { slot: team.slot } : {}),
              ...(team.version
                ? { version: team.version, displayVersion: team.version }
                : {}),
            }),
          ),
        tiles: generateDefaultTiles(),
        events: [],
      };
      addEvent(state, "🔄 تم إعادة ضبط اللعبة مع الاحتفاظ بالفصول");
      broadcastFullState();
      break;
    }

    case "setLastAction": {
      // موجود للتوافق مع عميل قديم؛ لا يحتاج تخزيناً في السيرفر.
      break;
    }

    default:
      console.log("Unknown message type:", data.type);
  }

  saveState(state).catch(console.error);
}

let state: GameState = await loadState();

// نحفظ فوراً بعد التحميل لإزالة blue/red/green/purple من game.json القديم بأمان.
await saveState(state).catch((err) => {
  console.error("Failed to persist migrated dynamic state:", err);
});

Bun.serve({
  port: 3001,
  fetch(req, server) {
    if (req.headers.get("upgrade") === "websocket") {
      if (server.upgrade(req)) return;
      return new Response("Upgrade failed", { status: 500 });
    }
    return new Response("Sailor Race Server Running");
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      ws.send(JSON.stringify({ type: "fullState", state }));
    },
    message(ws, message) {
      handleMessage(ws, message.toString());
    },
    close(ws) {
      clients.delete(ws);
    },
  },
});

console.log("WebSocket server running on ws://localhost:3001");
console.log(`Dynamic classes loaded: ${state.teams.length}`);