import type {
  Command,
  Difficulty,
  GameEvent,
  GameMode,
  GameState,
  ReplayData,
  TargetMode,
  TowerTypeId,
  WaveComp,
} from './types.js';
import { ENEMIES, ENEMY_ORDER } from './balance/enemies.js';
import { affixMask } from './balance/affixes.js';
import { TOWER_ORDER } from './balance/towers.js';
import { MAPS } from './balance/maps.js';
import { TICK_RATE } from './constants.js';

// ---------- Lobby / sala ----------

export interface RoomSettings {
  mapId: string;
  mode: GameMode;
  difficulty: Difficulty;
  // F5 · sala PÚBLICA: aparece en la lista de salas de la portada (con partida en
  // curso se puede entrar a mirar). Opcional para no romper clientes viejos;
  // sanitizeSettings lo normaliza (por defecto: privada).
  public?: boolean;
}

export interface LobbyPlayer {
  id: string;
  name: string;
  color: string;
  isHost: boolean;
  connected: boolean;
  // ¿el jugador marcó «Listo»? El anfitrión está siempre listo. La partida solo
  // arranca cuando TODOS los no-anfitriones conectados están listos.
  ready: boolean;
}

// Los ajustes vienen del cliente: nunca confiar en ellos. Un mapId desconocido
// haría throw en getMap() al iniciar la partida y tumbaría el proceso/DO entero.
export function sanitizeSettings(s: Partial<RoomSettings> | undefined): RoomSettings {
  const mapId = s?.mapId && MAPS.some((m) => m.id === s.mapId) ? s.mapId : MAPS[0].id;
  const mode: GameMode = s?.mode === 'endless' ? 'endless' : s?.mode === 'horde' ? 'horde' : 'classic';
  const difficulty = s?.difficulty === 'easy' || s?.difficulty === 'hard' ? s.difficulty : 'normal';
  return { mapId, mode, difficulty, public: s?.public === true };
}

// F5 · entrada del directorio de salas públicas (GET /api/rooms en el Worker).
export interface PublicRoomInfo {
  code: string;
  host: string; // nombre del anfitrión
  mapId: string;
  mode: GameMode;
  difficulty: Difficulty;
  players: number; // jugadores conectados
  inGame: boolean; // true = partida en curso (se entra como espectador)
  wave: number; // oleada actual (0 en el lobby)
}

// ---------- Snapshot compacto (arrays para ahorrar bytes) ----------

// enemigo: [id, typeIdx, x, y, hpFrac, flags, affixMask]
//   flags: 1=slow 2=poison 4=boss 8=elite 16=inmune 32=shred 64=invisible 128=detectado
//   (bits nuevos AL FINAL; afijos aparte)   affixMask: bits de balance/affixes
export type SnapEnemy = [number, number, number, number, number, number, number];
// torre: [id, typeIdx, cx, cy, level, ownerIdx, targetModeIdx, kills, damage, spec, stunned, charges, growth, fusion, invested, goldGen, cd, halted, focusId]
//   spec: -1 sin especializar, 0/1 rama; stunned: 0/1; charges: Trampa (0 = N/A);
//   growth: bono de crecimiento permanente (Arco Largo/Explorador II; 0 = N/A);
//   fusion: índice en FUSION_ORDER (−1 = sin fusión); invested: oro invertido total
//   (el panel lo usa para el valor de venta de las fusiones, cuya inversión real
//   no puede reconstruirse desde type/level/spec);
//   goldGen: oro EXTRA que el aura del Alquimista añadió a los botines (F5.3);
//   cd: ticks que le faltan a la torre para su PRÓXIMO disparo (0 = lista). El panel
//   lo muestra como contador de cadencia; las torres que no disparan lo ignoran (F6.2);
//   halted: 0/1 — torre DETENIDA por su dueño (Lote 4; badge ⏸ + botón ⏹/▶);
//   focusId: id del enemigo ENFOCADO (Lote 4; 0 = ninguno — pinta el vínculo 🎯
//   al seleccionar y el estado del panel)
//   (los campos F4.2 charges/growth, F4.3 fusion/invested, F5.3 goldGen, F6.2 cd y
//   Lote 4 halted/focusId van al FINAL para no romper índices previos)
export type SnapTower = [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
// proyectil: [id, kindIdx(0 bullet,1 shell,2 bomb), x, y, colorIdx(=typeIdx de torre)]
export type SnapProj = [number, number, number, number, number];

export interface SnapPlayer {
  id: string;
  gold: number;
  wood: number; // F5.2 · madera talada por su orco leñador
  orcLevel: number; // F5.5 · nivel del orco (1..5): más nivel = más tala/s
  connected: boolean;
  kills: number;
  damage: number;
  goldEarned: number;
}

export interface Snap {
  lives: number;
  wave: number;
  totalWaves: number;
  active: boolean; // false = interludio
  interludeSec: number;
  nextWave: [number, number][]; // [enemyTypeIdx, count]
  // telegrafía de la PRÓXIMA oleada (durante el interludio): 🛡 inmune / ⭐ bendecida / 🦅 aérea / 👁 invisible / ☠ jefe
  nextImmune: boolean;
  nextBlessed: boolean;
  nextFlying: boolean;
  nextInvisible: boolean; // Lote 3 · la próxima oleada es INVISIBLE (necesitas un Sentry)
  nextBossType: number; // typeIdx del jefe de la próxima oleada, o -1
  players: SnapPlayer[];
  enemies: SnapEnemy[];
  towers: SnapTower[];
  projs: SnapProj[];
  woodPrice: number; // F5.4 · precio actual del mercado de madera (oro por 1 🪵)
  over: 0 | 1 | 2; // 0 nada, 1 derrota, 2 victoria
}

export const TARGET_MODES: TargetMode[] = ['first', 'last', 'strong', 'weak', 'near'];
const PROJ_KINDS = ['bullet', 'shell', 'bomb'] as const;

const r2 = (n: number) => Math.round(n * 100) / 100;

export function buildSnap(state: GameState): Snap {
  const playerIdx = new Map(state.players.map((p, i) => [p.id, i]));
  const towerTypeIdx = new Map(TOWER_ORDER.map((t, i) => [t, i]));
  const enemyTypeIdx = new Map(ENEMY_ORDER.map((t, i) => [t, i]));
  const towerById = new Map(state.towers.map((t) => [t.id, t]));

  return {
    lives: state.lives,
    wave: state.wave,
    totalWaves: state.totalWaves,
    active: state.waveState === 'active',
    interludeSec: Math.max(0, Math.ceil(state.interludeLeft / TICK_RATE)),
    nextWave: state.nextWaveComp.map((c: WaveComp) => [enemyTypeIdx.get(c.type) ?? 0, c.count]),
    nextImmune: state.nextWaveImmune,
    nextBlessed: state.nextWaveBlessed,
    nextFlying: state.nextWaveFlying,
    nextInvisible: state.nextWaveInvisible,
    nextBossType: state.nextWaveBoss ? (enemyTypeIdx.get(state.nextWaveBoss) ?? -1) : -1,
    players: state.players.map((p) => ({
      id: p.id,
      gold: Math.floor(p.gold),
      wood: Math.floor(p.wood),
      orcLevel: p.orcLevel,
      connected: p.connected,
      kills: p.stats.kills,
      damage: Math.round(p.stats.damage),
      goldEarned: Math.round(p.stats.goldEarned),
    })),
    enemies: state.enemies.map((e) => {
      let flags = 0;
      if (e.slowFactor < 1) flags |= 1;
      if (e.poisonUntil > state.tick) flags |= 2;
      if (ENEMIES[e.type].boss) flags |= 4;
      if (e.elite) flags |= 8;
      if (e.spellImmune) flags |= 16;
      if (e.armorShredUntil > state.tick) flags |= 32; // shred de armadura activo
      if (e.invisible) flags |= 64; // Lote 3 · invisible
      if (e.detected) flags |= 128; // Lote 3 · detectado por un Sentry
      return [
        e.id,
        enemyTypeIdx.get(e.type) ?? 0,
        r2(e.x),
        r2(e.y),
        Math.max(0, Math.round((e.hp / e.maxHp) * 1000) / 1000),
        flags,
        e.elite ? affixMask(e.affixes) : 0,
      ] as SnapEnemy;
    }),
    towers: state.towers.map(
      (t) =>
        [
          t.id,
          towerTypeIdx.get(t.type) ?? 0,
          t.cx,
          t.cy,
          t.level,
          playerIdx.get(t.owner) ?? 0,
          TARGET_MODES.indexOf(t.targetMode),
          t.kills,
          Math.round(t.damage),
          t.spec,
          t.stunnedUntil > state.tick ? 1 : 0,
          t.charges,
          Math.round(t.growthBonus),
          t.fusion,
          Math.round(t.invested),
          Math.round(t.goldGen),
          // F6.2 · ticks hasta el próximo disparo (0 = lista). Solo LEEMOS el
          // cooldown de la sim; no lo tocamos. El panel de torre lo pinta como
          // contador de cadencia (las torres de apoyo/camino no lo muestran).
          t.cooldownLeft,
          // Lote 4 · detenida (⏸) + enemigo enfocado (0 = ninguno)
          t.halted ? 1 : 0,
          t.focusId,
        ] as SnapTower,
    ),
    projs: state.projectiles.map((p) => {
      const tower = towerById.get(p.towerId);
      return [
        p.id,
        PROJ_KINDS.indexOf(p.kind),
        r2(p.x),
        r2(p.y),
        tower ? (towerTypeIdx.get(tower.type) ?? 0) : 0,
      ] as SnapProj;
    }),
    woodPrice: Math.round(state.woodPrice * 100) / 100,
    over: state.over === null ? 0 : state.over.victory ? 2 : 1,
  };
}

// ---------- Estadísticas de fin de partida ----------

export interface EndStatsPlayer {
  id: string;
  name: string;
  color: string;
  kills: number;
  damage: number;
  goldEarned: number;
  goldSpent: number;
  towersBuilt: number;
}

export interface EndStats {
  victory: boolean;
  wave: number;
  totalWaves: number;
  mapId: string;
  mode: GameMode;
  difficulty: Difficulty;
  players: EndStatsPlayer[];
}

export interface HighscoreEntry {
  names: string[];
  wave: number;
  mapId: string;
  difficulty: Difficulty;
  date: string;
  // modo con récord. Opcional para compatibilidad con récords antiguos (sin campo),
  // que se asumen 'endless' (el único modo que guardaba récords antes de F2.2).
  mode?: 'endless' | 'horde';
}

// ---------- Mensajes cliente -> servidor ----------

export type ClientMsg =
  | { type: 'create_room'; name: string; token: string; settings: RoomSettings }
  // `prevToken`: respaldo de identidad. El token vive en sessionStorage (una
  // identidad por pestaña), pero los móviles lo pierden con facilidad (pestaña
  // descartada, reabrir desde el enlace). El cliente guarda en localStorage el
  // token con el que jugó cada sala y lo manda aquí: si el token nuevo no
  // coincide con nadie, el servidor recupera al jugador DESCONECTADO cuyo token
  // era `prevToken` en vez de degradarlo a espectador.
  | { type: 'join_room'; name: string; token: string; code: string; prevToken?: string }
  | { type: 'leave_room' }
  // ABANDONO explícito de la partida (salir a mitad de juego). En el lobby / como
  // espectador se comporta como `leave_room` (cierra el socket). DURANTE la partida
  // marca al jugador como desconectado PERMANENTE: sus torres quedan en el tablero,
  // su token de reconexión queda invalidado (si vuelve, entra de espectador) y el
  // resto ve el aviso «💨 X abandonó la partida». Sin payload (el jugador se deduce
  // del socket, igual que `leave_room`/`pause`/`resume`).
  | { type: 'leave' }
  | { type: 'set_settings'; settings: RoomSettings }
  // el anfitrión expulsa a un jugador de la sala (solo en el lobby)
  | { type: 'kick_player'; playerId: string }
  // el anfitrión cede la propiedad de la sala a otro jugador conectado (solo en el lobby)
  | { type: 'transfer_host'; playerId: string }
  // el jugador marca/desmarca «Listo» en el lobby
  | { type: 'set_ready'; ready: boolean }
  | { type: 'start_game' }
  | { type: 'chat'; text: string }
  | { type: 'cmd'; cmd: Command }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'set_speed'; speed: number }
  | { type: 'map_ping'; x: number; y: number; towerType?: TowerTypeId } // ping cooperativo (opcional: sugerir una torre)
  | { type: 'ping'; t: number };

// ---------- Mensajes servidor -> cliente ----------

export interface GameInit {
  mapId: string;
  mode: GameMode;
  difficulty: Difficulty;
  players: { id: string; name: string; color: string }[];
  youAre: string;
}

export type ServerMsg =
  | { type: 'error'; msg: string }
  | { type: 'room_joined'; code: string; playerId: string; isHost: boolean; spectator?: boolean }
  | { type: 'lobby_state'; players: LobbyPlayer[]; settings: RoomSettings; inGame: boolean }
  // cuenta regresiva antes de iniciar ('start') o reanudar ('resume') la partida.
  // El cliente muestra `seconds`..1 en pantalla; el servidor arranca/reanuda al
  // llegar a 0. seconds=0 significa CANCELADA (alguien desmarcó «Listo», entró
  // un jugador nuevo…): el cliente solo oculta el número.
  | { type: 'countdown'; kind: 'start' | 'resume'; seconds: number }
  | { type: 'game_started'; init: GameInit }
  | { type: 'tick'; t: number; snap: Snap; events: GameEvent[] }
  | { type: 'game_over'; stats: EndStats; replay?: ReplayData }
  | { type: 'chat'; from: string; color: string; text: string }
  | { type: 'paused'; by: string }
  | { type: 'resumed' }
  | { type: 'speed'; speed: number; by: string }
  | { type: 'map_ping'; x: number; y: number; by: string; color: string; towerType?: TowerTypeId }
  | { type: 'pong'; t: number };
