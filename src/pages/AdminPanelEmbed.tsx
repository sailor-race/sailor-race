import { useState, useEffect } from "react";
import * as wsClient from "../websocket/websocketClient";

// ── Types ──────────────────────────────────────────────────────────
interface Team {
  id: string;
  points: number;
  color: string;
  name?: string;
  slot?: number;
  version?: number;
}

interface ToastData {
  msg: string;
  ok: boolean;
}

// ── Constants ──────────────────────────────────────────────────────
function compareTeamsBySlot(a: Team, b: Team): number {
  const aSlot = Number.isFinite(Number(a.slot)) ? Number(a.slot) : Number.MAX_SAFE_INTEGER;
  const bSlot = Number.isFinite(Number(b.slot)) ? Number(b.slot) : Number.MAX_SAFE_INTEGER;
  return aSlot - bSlot;
}
const MEM_OPTIONS = [30, 25, 20];
const REV_OPTIONS = [30, 25, 20];
const ATTENDANCE = 10;

// ── Sub-component ──────────────────────────────────────────────────
const OptionBtn: React.FC<{
  active: boolean;
  onClick: () => void;
  accentColor: string;
  children: React.ReactNode;
}> = ({ active, onClick, accentColor, children }) => (
  <button
    onClick={onClick}
    className="smooth-btn"
    style={{
      flex: 1,
      padding: "10px 0",
      borderRadius: 14,
      cursor: "pointer",
      fontSize: 15,
      fontWeight: 800,
      fontFamily: "'Tajawal',sans-serif",
      background: active
        ? `linear-gradient(180deg, ${accentColor}, ${accentColor}cc)`
        : "rgba(255,255,255,0.06)",
      color: active ? "#fff" : "rgba(255,255,255,0.5)",
      boxShadow: active
        ? `0 4px 16px ${accentColor}55, inset 0 1px 0 rgba(255,255,255,0.25)`
        : "inset 0 1px 0 rgba(255,255,255,0.04)",
      border: `1.5px solid ${active ? accentColor : "rgba(255,255,255,0.1)"}`,
    }}
  >
    {children}
  </button>
);

export function AdminPanelEmbed() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [studentName, setStudent] = useState("");
  const [selectedTeam, setSelected] = useState("");
  const [memPts, setMemPts] = useState<number | null>(null);
  const [revPts, setRevPts] = useState<number | null>(null);
  const [listening, setListening] = useState(false);
  const [bag, setBag] = useState(false);
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [quickMode, setQuickMode] = useState(false);
  const [quickPts, setQuickPts] = useState("");

  const preview =
    ATTENDANCE +
    (memPts || 0) +
    (revPts || 0) +
    (listening ? 20 : 0) +
    (bag ? 10 : 0);

  const accentColor =
    teams.find((t) => t.id === selectedTeam)?.color || "#6366f1";

  const canSubmit =
    studentName.trim() &&
    selectedTeam &&
    memPts !== null &&
    revPts !== null &&
    !sending;

  const canQuick = studentName.trim() && selectedTeam && quickPts && !sending;

  //@ts-ignore
  useEffect(() => {
    const unsub = wsClient.subscribe((state) => {
      setTeams(state.teams || []);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const showToast = (msg: string, ok = true) => setToast({ msg, ok });

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSending(true);
    try {
      wsClient.addPointsToTeam(
        selectedTeam,
        preview,
        studentName.trim(),
        teams.find((team) => team.id === selectedTeam)?.name || selectedTeam,
      );
      showToast(`✅ تمت إضافة ${preview} نقطة`);
      // Reset form
      setStudent("");
      setMemPts(null);
      setRevPts(null);
      setListening(false);
      setBag(false);
    } catch (e: any) {
      showToast("❌ " + (e?.message ?? "خطأ"), false);
    }
    setSending(false);
  };

  const handleQuick = async () => {
    if (!canQuick) return;
    setSending(true);
    const pts = parseInt(quickPts);
    try {
      wsClient.addPointsToTeam(
        selectedTeam,
        pts,
        studentName.trim(),
        teams.find((team) => team.id === selectedTeam)?.name || selectedTeam,
      );
      showToast(`✅ تمت إضافة ${pts} نقطة`);
      setStudent("");
      setQuickPts("");
    } catch (e: any) {
      showToast("❌ " + (e?.message ?? "خطأ"), false);
    }
    setSending(false);
  };

  return (
    <div
      style={{
        fontFamily: "'Tajawal',sans-serif",
        direction: "rtl",
        padding: "4px 2px",
      }}
    >
      <style>{`input::placeholder { color: rgba(255,255,255,0.25); }`}</style>

      {toast && (
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 999,
            textAlign: "center",
            background: toast.ok ? "#166534" : "#7f1d1d",
            border: `1px solid ${toast.ok ? "#4ade80" : "#f87171"}`,
            color: "#fff",
            borderRadius: 12,
            padding: "10px 20px",
            fontSize: 14,
            fontWeight: 700,
            marginBottom: 12,
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
          }}
        >
          {toast.msg}
        </div>
      )}

      {/* Toggle — مفتاح مقسّم بنمط حبوب */}
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
            ...btnStyle,
            borderRadius: 14,
            background: !quickMode
              ? `linear-gradient(180deg, ${accentColor}, ${accentColor}cc)`
              : "transparent",
            color: !quickMode ? "#fff" : "rgba(255,255,255,0.45)",
            boxShadow: !quickMode
              ? `0 4px 16px ${accentColor}55, inset 0 1px 0 rgba(255,255,255,0.3)`
              : "none",
          }}
        >
          📋 النظام الكامل
        </button>
        <button
          onClick={() => setQuickMode(true)}
          className="smooth-btn"
          style={{
            ...btnStyle,
            borderRadius: 14,
            background: quickMode
              ? "linear-gradient(180deg,#fbbf24,#d97706)"
              : "transparent",
            color: quickMode ? "#fff" : "rgba(255,255,255,0.45)",
            boxShadow: quickMode
              ? "0 4px 16px rgba(245,158,11,0.5), inset 0 1px 0 rgba(255,255,255,0.3)"
              : "none",
          }}
        >
          ⚡ إضافة سريعة
        </button>
      </div>

      {/* Team selection */}
      <label style={labelStyle}>اختر الفصل</label>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          marginBottom: 20,
        }}
      >
        {[...teams]
          .sort(compareTeamsBySlot)
          .map((team) => (
            <button
              key={team.id}
              onClick={() => setSelected(team.id)}
              className="smooth-btn"
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "12px 16px",
                borderRadius: 14,
                cursor: "pointer",
                border: `2px solid ${selectedTeam === team.id ? team.color : "rgba(255,255,255,0.08)"}`,
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
                  {team.name || `فصل ${team.slot || ""}`}
                </span>
              </div>
              <span style={{ color: "#fde047", fontSize: 13, fontWeight: 700 }}>
                {team.points.toLocaleString()} نقطة
              </span>
            </button>
          ))}
      </div>

      {/* Student name */}
      <label style={labelStyle}>اسم الطالب</label>
      <input
        value={studentName}
        onChange={(e) => setStudent(e.target.value)}
        style={{
          ...inputStyle,
          borderColor: studentName
            ? `${accentColor}88`
            : "rgba(255,255,255,0.1)",
        }}
        placeholder="اكتب اسم الطالب..."
        autoComplete="off"
      />

      {/* Quick mode */}
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
          <label style={{ ...labelStyle, color: "rgba(245,158,11,0.7)" }}>
            عدد النقاط
          </label>
          <input
            type="number"
            value={quickPts}
            onChange={(e) => setQuickPts(e.target.value)}
            style={{
              ...inputStyle,
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
              padding: "13px",
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

      {/* Full system */}
      {!quickMode && (
        <div>
          <label style={labelStyle}>
            الحفظ{" "}
            {memPts === null && (
              <span style={{ color: "#f87171", fontSize: 10, marginRight: 6 }}>
                * مطلوب
              </span>
            )}
          </label>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            {MEM_OPTIONS.map((opt) => (
              <OptionBtn
                key={opt}
                active={memPts === opt}
                onClick={() => setMemPts(opt)}
                accentColor={accentColor}
              >
                {opt} 🌟
              </OptionBtn>
            ))}
          </div>
          <label style={labelStyle}>
            المراجعة{" "}
            {revPts === null && (
              <span style={{ color: "#f87171", fontSize: 10, marginRight: 6 }}>
                * مطلوب
              </span>
            )}
          </label>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            {REV_OPTIONS.map((opt) => (
              <OptionBtn
                key={opt}
                active={revPts === opt}
                onClick={() => setRevPts(opt)}
                accentColor={accentColor}
              >
                {opt} 🌟
              </OptionBtn>
            ))}
          </div>
          <label style={labelStyle}>
            السماع إلى الشيخ{" "}
            <span
              style={{
                color: "rgba(255,255,255,0.35)",
                fontSize: 11,
                fontWeight: 400,
                marginRight: 6,
              }}
            >
              (+20)
            </span>
          </label>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <OptionBtn
              active={listening === true}
              onClick={() => setListening(true)}
              accentColor={accentColor}
            >
              نعم
            </OptionBtn>
            <OptionBtn
              active={listening === false}
              onClick={() => setListening(false)}
              accentColor={accentColor}
            >
              لا
            </OptionBtn>
          </div>
          <label style={labelStyle}>
            إحضار الحقيبة{" "}
            <span
              style={{
                color: "rgba(255,255,255,0.35)",
                fontSize: 11,
                fontWeight: 400,
                marginRight: 6,
              }}
            >
              (+10)
            </span>
          </label>
          <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
            <OptionBtn
              active={bag === true}
              onClick={() => setBag(true)}
              accentColor={accentColor}
            >
              نعم
            </OptionBtn>
            <OptionBtn
              active={bag === false}
              onClick={() => setBag(false)}
              accentColor={accentColor}
            >
              لا
            </OptionBtn>
          </div>
          <div
            style={{
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 14,
              padding: "14px 16px",
              marginBottom: 16,
            }}
          >
            {[
              ["الحضور", `+${ATTENDANCE}`],
              ["الحفظ", memPts ? `+${memPts}` : "—"],
              ["المراجعة", revPts ? `+${revPts}` : "—"],
              ["السماع", listening ? "+20" : "0"],
              ["الحقيبة", bag ? "+10" : "0"],
            ].map(([l, v]) => (
              <div
                key={l}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 8,
                }}
              >
                <span style={{ color: "rgba(255,255,255,0.45)", fontSize: 12 }}>
                  {l}
                </span>
                <span style={{ color: "#fff", fontSize: 12, fontWeight: 700 }}>
                  {v}
                </span>
              </div>
            ))}
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
              <span
                style={{
                  color: "rgba(255,255,255,0.7)",
                  fontSize: 14,
                  fontWeight: 700,
                }}
              >
                المجموع الكلي
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
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={canSubmit ? "smooth-btn btn-shine" : "smooth-btn"}
            style={{
              width: "100%",
              padding: "15px",
              borderRadius: 16,
              border: "none",
              position: "relative",
              overflow: "hidden",
              fontFamily: "'Tajawal',sans-serif",
              fontSize: 17,
              fontWeight: 900,
              cursor: canSubmit ? "pointer" : "not-allowed",
              background: canSubmit
                ? `linear-gradient(180deg,${accentColor},${accentColor}bb)`
                : "rgba(255,255,255,0.08)",
              color: canSubmit ? "#fff" : "rgba(255,255,255,0.3)",
              boxShadow: canSubmit
                ? `0 6px 24px ${accentColor}66, inset 0 1px 0 rgba(255,255,255,0.3)`
                : "none",
            }}
          >
            {sending ? "⏳ جارٍ الإرسال..." : `➕ إضافة ${preview} نقطة`}
          </button>
        </div>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  flex: 1,
  padding: "10px",
  borderRadius: 12,
  border: "none",
  cursor: "pointer",
  fontFamily: "'Tajawal',sans-serif",
  fontWeight: 700,
  fontSize: 13,
  transition: "all 0.2s",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  color: "rgba(255,255,255,0.5)",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 1.2,
  marginBottom: 8,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "rgba(255,255,255,0.07)",
  border: "1.5px solid rgba(255,255,255,0.1)",
  borderRadius: 12,
  color: "#fff",
  fontSize: 16,
  padding: "13px 15px",
  marginBottom: 18,
  outline: "none",
  fontFamily: "'Tajawal',sans-serif",
  boxSizing: "border-box",
  transition: "border-color 0.2s",
};
