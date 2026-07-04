import type {
  EndStats,
  GameInit,
  LobbyPlayer,
  MapDef,
  ReplayData,
  RoomSettings,
  Snap,
  TowerTypeId,
} from '@td/shared';
import { getMap } from '@td/shared';

export interface SnapFrame {
  time: number; // performance.now() al llegar
  t: number; // tick del servidor
  snap: Snap;
}

export type Selection =
  | { kind: 'tower'; id: number }
  | { kind: 'placing'; towerType: TowerTypeId };

export interface GameStore {
  init: GameInit;
  map: MapDef;
  frames: SnapFrame[];
  latest: Snap | null;
  selection: Selection | null;
  hoverCell: { cx: number; cy: number } | null;
  // colocación táctil en dos toques: primer toque marca la celda, el segundo confirma
  pendingPlace: { cx: number; cy: number } | null;
  speed: number;
  paused: boolean;
  pausedBy: string;
  over: EndStats | null;
}

function randomToken(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// lee un volumen guardado como entero 0..100; devuelve fracción 0..1.
function readVol(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n / 100));
}

export const store = {
  name: localStorage.getItem('td_name') ?? '',
  // El token vive en sessionStorage: sobrevive a un F5 (reconexión) pero cada
  // pestaña es un jugador distinto. Si estuviera en localStorage, dos pestañas
  // pelearían por la misma identidad expulsándose mutuamente en bucle.
  token: sessionStorage.getItem('td_token') ?? '',
  muted: localStorage.getItem('td_muted') === '1',
  // volúmenes 0..1 (persisten como enteros 0..100 en localStorage).
  sfxVol: readVol('td_sfx_vol', 0.8),
  musicVol: readVol('td_music_vol', 0.6),
  screen: 'home' as 'home' | 'lobby' | 'game',
  playerId: '',
  roomCode: '',
  isHost: false,
  spectator: false, // true si entramos con la partida en curso (miramos, no jugamos)
  pingArmed: false, // el botón 📍 arma el siguiente toque como ping
  // modo sugerencia: al armar una torre desde la barra, el siguiente toque en el
  // mapa manda un map_ping con towerType en vez de colocar (espectadores; también
  // disponible para jugadores). null = sin sugerencia armada.
  suggestType: null as TowerTypeId | null,
  lobby: {
    players: [] as LobbyPlayer[],
    settings: { mapId: 'sendero', mode: 'classic', difficulty: 'normal' } as RoomSettings,
    inGame: false,
  },
  game: null as GameStore | null,
  // reproductor de repeticiones: no-null mientras se reproduce una (desactiva el
  // input de juego y corre la sim localmente sin red). Ver replay.ts del cliente.
  replay: null as ReplayState | null,
};

// estado del reproductor de repeticiones en curso (null = no estamos viendo una)
export interface ReplayState {
  data: ReplayData;
  playing: boolean;
  tick: number; // tick de sim actual del reproductor
  speed: number; // x1 / x2 / x4
}

if (!store.token) {
  store.token = randomToken();
  sessionStorage.setItem('td_token', store.token);
}

export function saveName(name: string): void {
  store.name = name;
  localStorage.setItem('td_name', name);
}

export function startGameStore(init: GameInit): GameStore {
  store.game = {
    init,
    map: getMap(init.mapId),
    frames: [],
    latest: null,
    selection: null,
    hoverCell: null,
    pendingPlace: null,
    speed: 1,
    paused: false,
    pausedBy: '',
    over: null,
  };
  return store.game;
}

const MAX_FRAMES = 30;

export function pushFrame(g: GameStore, t: number, snap: Snap): void {
  g.frames.push({ time: performance.now(), t, snap });
  if (g.frames.length > MAX_FRAMES) g.frames.splice(0, g.frames.length - MAX_FRAMES);
  g.latest = snap;
}

export function myGold(g: GameStore): number {
  const me = g.latest?.players.find((p) => p.id === store.playerId);
  return me?.gold ?? 0;
}
