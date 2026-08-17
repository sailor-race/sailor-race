// src/websocket/websocketClient.ts
// نسخة مصححة تدعم admin + display
// - تصلح Invalid WebSocket URL
// - تضيف onAnnouncement المطلوبة في DisplayPage
// - تحافظ على نفس أسماء الدوال المستخدمة في المشروع

type StateSubscriber = (state: any) => void;
type AnnouncementSubscriber = (message: any) => void;

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let lastState: any = null;

const stateSubscribers = new Set<StateSubscriber>();
const announcementSubscribers = new Set<AnnouncementSubscriber>();
const pendingMessages: any[] = [];

function getWebSocketUrl(): string {
  const envValue = String(import.meta.env.VITE_WS_URL || "").trim();

  // إزالة علامات التنصيص لو كانت موجودة بالغلط في .env
  const cleaned = envValue.replace(/^['\"]|['\"]$/g, "");

  let url: string;

  if (!cleaned) {
    url = "ws://localhost:3001";
  } else if (cleaned.startsWith("ws://") || cleaned.startsWith("wss://")) {
    url = cleaned;
  } else if (cleaned.startsWith("http://")) {
    url = cleaned.replace(/^http:\/\//, "ws://");
  } else if (cleaned.startsWith("https://")) {
    url = cleaned.replace(/^https:\/\//, "wss://");
  } else if (cleaned.startsWith("localhost:") || cleaned.startsWith("127.0.0.1:")) {
    url = `ws://${cleaned}`;
  } else {
    console.warn(
      `[websocketClient] VITE_WS_URL غير صحيح: "${cleaned}" — سيتم استخدام ws://localhost:3001`,
    );
    url = "ws://localhost:3001";
  }

  // إذا فعّلت رمز الحماية في السيرفر، ضع نفس الرمز في VITE_WS_TOKEN داخل .env
  const token = String(import.meta.env.VITE_WS_TOKEN || "").trim();
  if (token) {
    url += (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
  }

  return url;
}

function notifyStateSubscribers(state: any) {
  stateSubscribers.forEach((cb) => {
    try {
      cb(state);
    } catch (err) {
      console.error("[websocketClient] state subscriber error:", err);
    }
  });
}

function notifyAnnouncementSubscribers(message: any) {
  announcementSubscribers.forEach((cb) => {
    try {
      cb(message);
    } catch (err) {
      console.error("[websocketClient] announcement subscriber error:", err);
    }
  });
}

function flushPendingMessages() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  while (pendingMessages.length > 0) {
    const msg = pendingMessages.shift();
    socket.send(JSON.stringify(msg));
  }
}

export function connect() {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return socket;
  }

  const url = getWebSocketUrl();

  try {
    socket = new WebSocket(url);
  } catch (err) {
    console.error("[websocketClient] Failed to create WebSocket:", err);
    return null;
  }

  socket.onopen = () => {
    console.log("[websocketClient] connected:", url);

    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    flushPendingMessages();
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === "fullState") {
        lastState = data.state;
        notifyStateSubscribers(data.state);
        return;
      }

      if (data.type === "announcement") {
        notifyAnnouncementSubscribers(data);
        window.dispatchEvent(
          new CustomEvent("sailor-race:announcement", { detail: data }),
        );
        return;
      }

      // احتياط لو السيرفر أرسل الحالة مباشرة بدون type
      if (data && data.teams) {
        lastState = data;
        notifyStateSubscribers(data);
      }
    } catch (err) {
      console.warn("[websocketClient] invalid message:", event.data);
    }
  };

  socket.onerror = (err) => {
    console.warn("[websocketClient] socket error:", err);
  };

  socket.onclose = () => {
    socket = null;

    if (!reconnectTimer) {
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 1500);
    }
  };

  return socket;
}

function send(message: any) {
  connect();

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return;
  }

  pendingMessages.push(message);
}

export function subscribe(cb: StateSubscriber) {
  stateSubscribers.add(cb);
  connect();

  if (lastState) cb(lastState);

  return () => {
    stateSubscribers.delete(cb);
  };
}

// هذه الدالة كانت ناقصة، و DisplayPage يحتاجها
export function onAnnouncement(cb: AnnouncementSubscriber) {
  announcementSubscribers.add(cb);
  connect();

  return () => {
    announcementSubscribers.delete(cb);
  };
}


export function syncClasses(classes: Array<{
  id?: string;
  classId?: string;
  name?: string;
  className?: string;
  sheetId?: number;
  slot?: number;
  version?: number;
  displayVersion?: number;
  color?: string;
}>) {
  send({ type: "syncClasses", classes });
}

export function addPointsToTeam(
  teamId: string,
  pts: number,
  studentName = "",
  teamName = "",
  version?: number,
) {
  send({
    type: "submitStudentPoints",
    teamId,
    pts,
    studentName,
    teamName,
    version,
  });
}

export function moveTeamManual(teamId: string, steps: number) {
  send({ type: "moveTeamManual", teamId, steps });
}

export function visitIsland(teamId: string, islandIndex: number) {
  send({ type: "visitIsland", teamId, islandIndex });
}

export function addCoins(teamId: string, amount: number) {
  send({ type: "addCoins", teamId, amount });
}

export function toggleDoublePoints(teamId: string) {
  send({ type: "toggleDoublePoints", teamId });
}

export function renameTeam(teamId: string, name: string) {
  send({ type: "renameTeam", teamId, name });
}

export function changeTeamColor(teamId: string, color: string) {
  send({ type: "changeTeamColor", teamId, color });
}

export function addTeam(name: string, color: string) {
  send({ type: "addTeam", name, color });
}

export function deleteTeam(teamId: string) {
  send({ type: "deleteTeam", teamId });
}

export function updateTile(tileId: number, updates: any) {
  send({ type: "updateTile", tileId, updates });
}

export function moveShips(positions: Record<string, number>) {
  send({ type: "moveShips", positions });
}

export function adjustPoints(teamId: string, amount: number) {
  send({ type: "adjustPoints", teamId, amount });
}

export function resetGame() {
  send({ type: "resetGame" });
}

// اختيارية: لو كان عندك كود قديم يستدعيها، نخليها موجودة بدون كسر
export function setLastAction(action: any) {
  send({ type: "setLastAction", action });
}
