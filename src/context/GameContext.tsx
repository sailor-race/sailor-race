import React, {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useCallback,
} from "react";
import * as wsClient from "../websocket/websocketClient";

// -------- Reducer --------
const initialState = {
  teams: [] as any[],
  tiles: [] as any[],
  events: [] as any[],
  loading: true,
  error: null as string | null,
};

type Action =
  | { type: "SET_STATE"; payload: any }
  | { type: "SET_ERROR"; payload: string }
  | { type: "SET_LOADING"; payload: boolean };

function reducer(
  state: typeof initialState,
  action: Action,
): typeof initialState {
  switch (action.type) {
    case "SET_STATE":
      return {
        ...state,
        teams: action.payload.teams || [],
        tiles: action.payload.tiles || [],
        events: action.payload.events || [],
        loading: false,
      };
    case "SET_ERROR":
      return { ...state, error: action.payload, loading: false };
    case "SET_LOADING":
      return { ...state, loading: action.payload };
    default:
      return state;
  }
}

// -------- Context --------
const GameContext = createContext<any>(null);

export function GameProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  //@ts-ignore
  useEffect(() => {
    const unsub = wsClient.subscribe((data) => {
      dispatch({ type: "SET_STATE", payload: data });
    });
    wsClient.connect();
    return () => unsub();
  }, []);

  const value = {
    teams: state.teams,
    tiles: state.tiles,
    events: state.events,
    loading: state.loading,
    error: state.error,
    addPointsToTeam: useCallback(
      (
        teamId: string,
        pts: number,
        studentName?: string,
        teamName?: string,
      ) => {
        wsClient.addPointsToTeam(teamId, pts, studentName, teamName);
      },
      [],
    ),
    moveTeam: useCallback(
      (teamId: string, steps: number) => wsClient.moveTeamManual(teamId, steps),
      [],
    ),
    visitIsland: useCallback(
      (teamId: string, islandIndex: number) =>
        wsClient.visitIsland(teamId, islandIndex),
      [],
    ),
    addCoins: useCallback(
      (teamId: string, amount: number) => wsClient.addCoins(teamId, amount),
      [],
    ),
    toggleDoublePoints: useCallback(
      (teamId: string) => wsClient.toggleDoublePoints(teamId),
      [],
    ),
    renameTeam: useCallback(
      (teamId: string, name: string) => wsClient.renameTeam(teamId, name),
      [],
    ),
    changeTeamColor: useCallback(
      (teamId: string, color: string) =>
        wsClient.changeTeamColor(teamId, color),
      [],
    ),
    addTeam: useCallback(
      (name: string, color: string) => wsClient.addTeam(name, color),
      [],
    ),
    deleteTeam: useCallback(
      (teamId: string) => wsClient.deleteTeam(teamId),
      [],
    ),
    updateTile: useCallback(
      (tileId: number, updates: object) => wsClient.updateTile(tileId, updates),
      [],
    ),
    resetGame: useCallback(() => wsClient.resetGame(), []),
  };

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame() {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error("useGame must be used inside <GameProvider>");
  return ctx;
}
