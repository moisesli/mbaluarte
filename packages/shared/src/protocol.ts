import type {
  Command,
  Difficulty,
  GameEvent,
  GameMode,
  GameState,
  ReplayData,
  SaveData,
  TargetMode,
  TowerTypeId,
  WaveComp,
} from './types.js';
import { ENEMIES, ENEMY_ORDER } from './balance/enemies.js';
import { AFFIX_ORDER, affixMask } from './balance/affixes.js';
import { TOWER_ORDER } from './balance/towers.js';
import { MAPS } from './balance/maps.js';
import { boomCost, repairCost } from './sim/commands.js';
import { BALANCE_VERSION, MAX_PLAYERS, sanitizeClosedDoors, TICK_RATE } from './constants.js';

// ---------- Lobby / sala ----------

export interface RoomSettings {
  mapId: string;
  mode: GameMode;
  difficulty: Difficulty;
  // F5 · sala PÚBLICA: aparece en la lista de salas de la portada (con partida en
  // curso se puede entrar a mirar). Opcional para no romper clientes viejos;
  // sanitizeSettings lo normaliza (por defecto: privada).
  public?: boolean;
  // MODO TURBO ⚡ (issue #14): economía comprimida e interludios a la mitad, mismo
  // reto (el HP no cambia). Aplica a clásico e infinito; en HORDA se IGNORA (su
  // economía de bucle es otro animal). Opcional; sanitizeSettings lo normaliza
  // (por defecto OFF, y SIEMPRE OFF en horda). Las partidas turbo no puntúan récords.
  turbo?: boolean;
  // F9d · PUERTAS CERRADAS (ajuste del ANFITRIÓN, solo en el lobby): índices de
  // ruta por los que NO saldrán monstruos («si somos 4, cierro las otras»). Solo
  // mapas multi-puerta (≥ MULTI_DOOR_MIN rutas); sanitizeClosedDoors lo normaliza
  // (válidos, únicos, ordenados, SIEMPRE ≥1 abierta). El RoomDO además rechaza
  // cerrar una puerta RECLAMADA y limpia los cierres al cambiar de mapa (como los
  // reclamos). La sim reparte los spawns solo entre las abiertas y densifica la
  // oleada según cuántas queden (dificultad neutra — ver constants.ts F9d).
  closedDoors?: number[];
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
  // F9b · PUERTA reclamada (selección de puerta por color): índice de ruta
  // (map.paths[door]) que este jugador reclamó en el lobby, o ausente si ninguna.
  // Es SOCIAL/decorativa: en partida su spawn luce el estandarte del color del
  // jugador (dibujo del cliente). Solo aplica en mapas multi-ruta (≥4). El RoomDO
  // valida que no esté ocupada y la libera al salir; NO toca la sim ni el snapshot.
  door?: number;
}

// Los ajustes vienen del cliente: nunca confiar en ellos. Un mapId desconocido
// haría throw en getMap() al iniciar la partida y tumbaría el proceso/DO entero.
export function sanitizeSettings(s: Partial<RoomSettings> | undefined): RoomSettings {
  const mapId = s?.mapId && MAPS.some((m) => m.id === s.mapId) ? s.mapId : MAPS[0].id;
  const mode: GameMode = s?.mode === 'endless' ? 'endless' : s?.mode === 'horde' ? 'horde' : 'classic';
  const difficulty = s?.difficulty === 'easy' || s?.difficulty === 'hard' ? s.difficulty : 'normal';
  // Turbo ⚡ SIEMPRE OFF en horda: su economía es un bucle de saturación (sin fin de
  // oleada clásico ni fuga), así que comprimir botín/bono/interludios no tiene un
  // punto de aplicación coherente. Normalizarlo aquí es la fuente única de verdad:
  // la sala nunca guarda turbo en horda y el lobby/lista pública lo reflejan bien.
  const turbo = s?.turbo === true && mode !== 'horde';
  // F9d · puertas cerradas: normalización estructural contra el mapa YA saneado
  // (solo multi-puerta, índices válidos/únicos/ordenados, ≥1 abierta). La regla
  // que exige estado de sala (no cerrar una RECLAMADA) vive en el RoomDO.
  const closedDoors = sanitizeClosedDoors(
    MAPS.find((m) => m.id === mapId)?.paths.length ?? 1,
    s?.closedDoors,
  );
  return {
    mapId,
    mode,
    difficulty,
    public: s?.public === true,
    turbo,
    ...(closedDoors.length > 0 ? { closedDoors } : {}),
  };
}

// issue #12 · info del lobby de una partida CARGADA (guardado). Viaja en
// `lobby_state.saved`: el cliente pinta el banner («Partida guardada: mapa ·
// oleada N · k defensores») y, por slot, quién lo reclamó (o botón «Adoptar»).
export interface SavedLobbySlot {
  id: string; // id del SaveSlot (= id del jugador en la sim)
  name: string;
  color: string;
  // id del RoomPlayer que reclama este slot; null = libre (se puede adoptar)
  claimedBy: string | null;
}
export interface SavedLobbyInfo {
  mapId: string;
  mode: GameMode;
  difficulty: Difficulty;
  wave: number;
  tick: number;
  slots: SavedLobbySlot[];
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
  turbo: boolean; // MODO TURBO ⚡ activo (distintivo en la lista de salas públicas)
}

// ---------- Snapshot compacto (arrays para ahorrar bytes) ----------

// enemigo: [id, typeIdx, x, y, hpFrac, flags, affixMask]
//   flags: 1=slow 2=poison 4=boss 8=elite 16=inmune 32=shred 64=invisible 128=detectado
//          256=campeón 👑 (F9a)
//   (bits nuevos AL FINAL; afijos aparte)   affixMask: bits de balance/affixes —
//   viaja para élites Y para jefes con afijo (F9a; el resto manda 0)
export type SnapEnemy = [number, number, number, number, number, number, number];
// torre: [id, typeIdx, cx, cy, level, ownerIdx, targetModeIdx, kills, damage, spec, stunned, charges, growth, fusion, invested, goldGen, cd, halted, focusId, expiresTick]
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
//   al seleccionar y el estado del panel);
//   expiresTick: tick de sim en el que el Sentry CADUCA (v17; 0 = nunca). El cliente
//   calcula el tiempo restante con el tick del snap (el `t` del mensaje tick) para el
//   countdown ⏳ del panel y el parpadeo de aviso; el resto de torres lo ignoran
//   (los campos F4.2 charges/growth, F4.3 fusion/invested, F5.3 goldGen, F6.2 cd,
//   Lote 4 halted/focusId y v17 expiresTick van al FINAL para no romper índices previos)
export type SnapTower = [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
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
  // F9a (v19) · telegrafía nueva (campos de OBJETO al final: seguro añadirlos)
  nextChampion: boolean; // 👑 la próxima oleada es de CAMPEONES
  nextBossAffix: number; // índice en AFFIX_ORDER del afijo del próximo jefe, o -1
  players: SnapPlayer[];
  enemies: SnapEnemy[];
  towers: SnapTower[];
  projs: SnapProj[];
  woodPrice: number; // F5.4 · precio actual del mercado de madera (oro por 1 🪵)
  over: 0 | 1 | 2; // 0 nada, 1 derrota, 2 victoria
  // F9a (v19) · precios de EQUIPO calculados por el server (el cliente solo pinta;
  // la validación del precio real vive en applyCommands — nada que falsificar):
  boomCost: number; // precio EFECTIVO del próximo Barril (escala ×1.3 por compra)
  repairCost: number; // precio EFECTIVO de Reparar la fortaleza (×1.5 por compra)
  repairsBought: number; // horda: aforo efectivo = HORDE_CAP + repairsBought
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
    nextChampion: state.nextWaveChampion,
    nextBossAffix: state.nextWaveBossAffix ? AFFIX_ORDER.indexOf(state.nextWaveBossAffix) : -1,
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
      if (e.champion) flags |= 256; // F9a · campeón 👑
      return [
        e.id,
        enemyTypeIdx.get(e.type) ?? 0,
        r2(e.x),
        r2(e.y),
        Math.max(0, Math.round((e.hp / e.maxHp) * 1000) / 1000),
        flags,
        // F9a · la máscara viaja también para JEFES con afijo (los élites como
        // siempre; el resto manda 0 — las bendecidas siguen sin icono, a propósito)
        e.elite || (ENEMIES[e.type].boss && e.affixes.length > 0) ? affixMask(e.affixes) : 0,
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
          // v17 · Sentry temporal: tick de caducidad (0 = nunca). El cliente lo
          // resta al tick del snap para el countdown ⏳ y el parpadeo de aviso.
          t.expiresTick,
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
    // F9a (v19) · precios de equipo (server = única fuente de verdad)
    boomCost: boomCost(state),
    repairCost: repairCost(state),
    repairsBought: state.repairsBought,
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
  // el anfitrión EXPULSA a un jugador de la sala (solo en el lobby). Expulsar no
  // banea: puede volver a entrar con el código, pero solo a la ZONA DE
  // ESPECTADORES (pineado). Para bloquearle la entrada del todo, ver ban_player.
  | { type: 'kick_player'; playerId: string }
  // el anfitrión BANEA a un jugador o espectador (solo en el lobby): se le saca
  // de la sala y su token ya no puede volver a entrar de ninguna forma
  | { type: 'ban_player'; playerId: string }
  // el anfitrión cede la propiedad de la sala a otro jugador conectado (solo en el lobby)
  | { type: 'transfer_host'; playerId: string }
  // el anfitrión mueve a un jugador del lobby a la zona de espectadores (solo en
  // el lobby, sin banear): para quien solo quiere mirar y no jugar la revancha.
  // Queda PINEADO ahí (ver Spectator.pinned en el servidor): ya no se le vuelve
  // a promover a jugador solo, ni al terminar futuras partidas.
  | { type: 'move_to_spectator'; playerId: string }
  // el anfitrión saca a alguien de la zona de espectadores y lo trae de vuelta
  // como jugador del lobby (solo en el lobby; falla si la sala está llena)
  | { type: 'move_to_player'; spectatorId: string }
  // el jugador marca/desmarca «Listo» en el lobby
  | { type: 'set_ready'; ready: boolean }
  // F9b · el jugador RECLAMA una puerta (índice de ruta) en el lobby, o la libera
  // con door=null. Solo en mapas multi-ruta (≥4). Lo valida el RoomDO (puerta
  // existente y libre); es un estado de lobby (NO un comando de sim).
  | { type: 'claim_door'; door: number | null }
  | { type: 'start_game' }
  | { type: 'chat'; text: string }
  | { type: 'cmd'; cmd: Command }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'set_speed'; speed: number }
  | { type: 'map_ping'; x: number; y: number; towerType?: TowerTypeId } // ping cooperativo (opcional: sugerir una torre)
  // GUARDAR (issue #12): el jugador pide al servidor construir el guardado usando
  // ESTA sal (para hashear los tokens server-side; el cliente no tiene los tokens
  // ajenos). El servidor responde con `save_info`. Solo jugadores (no espectadores).
  | { type: 'save_request'; salt: string }
  // CARGAR: en el lobby de un guardado, ADOPTAR un slot libre (identidad de la
  // partida cuyo token no coincidió con el tuyo). `slot` = id del SaveSlot.
  | { type: 'claim_slot'; slot: string }
  | { type: 'ping'; t: number };

// ---------- Mensajes servidor -> cliente ----------

export interface GameInit {
  mapId: string;
  mode: GameMode;
  difficulty: Difficulty;
  turbo: boolean; // MODO TURBO ⚡ (issue #14): el cliente pinta el distintivo ⚡ en el HUD
  // F9b · `door`: puerta reclamada por el jugador en el lobby (índice de ruta), o
  // ausente. Viaja aquí (no en el snapshot ni en la sim) para que el cliente pinte
  // el estandarte del color del dueño en el spawn de esa ruta durante la partida.
  players: { id: string; name: string; color: string; door?: number }[];
  // F9d · puertas CERRADAS de la partida (índices de ruta; ausente = ninguna).
  // Viaja aquí (fijo toda la partida — el reparto real vive en la sim) para que
  // el renderer pinte el portal APAGADO con reja en las rutas sin monstruos.
  closedDoors?: number[];
  youAre: string;
}

// espectador visible en el lobby (p. ej. alguien que el anfitrión movió a la
// zona de espectadores): solo lo necesario para listarlo y traerlo de vuelta
export interface LobbySpectator {
  id: string;
  name: string;
}

export type ServerMsg =
  | { type: 'error'; msg: string }
  | { type: 'room_joined'; code: string; playerId: string; isHost: boolean; spectator?: boolean }
  // `saved`: presente solo en el lobby de una partida CARGADA (guardado), para
  // pintar el banner y los slots reclamables. Opcional → los lobbies normales lo omiten.
  | { type: 'lobby_state'; players: LobbyPlayer[]; spectators: LobbySpectator[]; settings: RoomSettings; inGame: boolean; saved?: SavedLobbyInfo }
  // cuenta regresiva antes de iniciar ('start') o reanudar ('resume') la partida.
  // El cliente muestra `seconds`..1 en pantalla; el servidor arranca/reanuda al
  // llegar a 0. seconds=0 significa CANCELADA (alguien desmarcó «Listo», entró
  // un jugador nuevo…): el cliente solo oculta el número.
  | { type: 'countdown'; kind: 'start' | 'resume'; seconds: number }
  | { type: 'game_started'; init: GameInit }
  | { type: 'tick'; t: number; snap: Snap; events: GameEvent[] }
  | { type: 'game_over'; stats: EndStats; replay?: ReplayData }
  // GUARDAR (issue #12): respuesta a `save_request` con el guardado ya construido
  // (log hasta el tick actual + tokenHash por slot). El cliente lo descarga como .json.
  | { type: 'save_info'; save: SaveData }
  | { type: 'chat'; from: string; color: string; text: string }
  | { type: 'paused'; by: string }
  | { type: 'resumed' }
  | { type: 'speed'; speed: number; by: string }
  | { type: 'map_ping'; x: number; y: number; by: string; color: string; towerType?: TowerTypeId }
  | { type: 'pong'; t: number };

// ---------- Validación y hash de guardados (issue #12) ----------
//
// La MISMA función valida el .json en el cliente (antes de subirlo), en el borde
// (Worker /api/rooms/from-save) y en el Durable Object (defensa en profundidad).
// Comprueba tamaños máximos, formato y —clave— que el BALANCE_VERSION coincida
// EXACTO: un guardado de otra versión del balance no reproduciría el mismo estado,
// así que se rechaza con un mensaje claro en vez de reconstruir una partida rota.

const MAX_SAVE_LOG = 500_000; // tope de entradas de log (una partida real son miles)
const MAX_SAVE_TICK = TICK_RATE * 60 * 60 * 8; // 8 h de sim (tope defensivo)
// Tope de oro/madera de una entrada `join` (mid-join) del log. El guardado es un
// REPLAY: los comandos los re-valida el sim (no se puede fabricar oro colocando
// torres), PERO el oro/madera de entrada de un mid-join se cargan DIRECTOS del
// archivo (replay.ts → makePlayer). Un mid-join legítimo da `180 + oleada*22`
// (~11K ni en endless profundo); este tope generoso corta la inyección
// («gold: 999999999») sin rechazar jamás un guardado real. No cambia el sim.
const MAX_JOIN_ECON = 1_000_000;

export type ValidateSaveResult = { ok: true; save: SaveData } | { ok: false; msg: string };

export function validateSaveData(x: unknown): ValidateSaveResult {
  const bad = (msg: string): ValidateSaveResult => ({ ok: false, msg });
  if (!x || typeof x !== 'object') return bad('Ese archivo no es una partida guardada de Fortaleza.');
  const d = x as Record<string, unknown>;
  if (d.kind !== 'fortaleza-save') return bad('Ese archivo no es una partida guardada de Fortaleza.');
  if (typeof d.v !== 'number') return bad('Guardado corrupto (sin versión).');
  if (d.v !== BALANCE_VERSION) {
    return bad('Esta partida es de una versión anterior del juego y ya no se puede continuar.');
  }
  if (typeof d.seed !== 'number' || !Number.isFinite(d.seed)) return bad('Guardado corrupto (semilla).');
  if (typeof d.mapId !== 'string' || !MAPS.some((m) => m.id === d.mapId)) {
    return bad('El mapa de este guardado no existe en esta versión del juego.');
  }
  if (d.mode !== 'classic' && d.mode !== 'endless' && d.mode !== 'horde') return bad('Guardado corrupto (modo).');
  if (d.difficulty !== 'easy' && d.difficulty !== 'normal' && d.difficulty !== 'hard') {
    return bad('Guardado corrupto (dificultad).');
  }
  if (typeof d.tick !== 'number' || !Number.isInteger(d.tick) || d.tick < 0 || d.tick > MAX_SAVE_TICK) {
    return bad('Guardado corrupto (tick).');
  }
  if (typeof d.wave !== 'number' || !Number.isInteger(d.wave) || d.wave < 0) return bad('Guardado corrupto (oleada).');
  if (typeof d.salt !== 'string' || d.salt.length === 0 || d.salt.length > 128) return bad('Guardado corrupto (sal).');
  // F9d · puertas cerradas (opcional): forma canónica EXACTA contra el mapa ya
  // validado — sanitizeClosedDoors es la única fuente de verdad, así que un
  // guardado legítimo siempre coincide consigo mismo saneado; cualquier
  // adulteración (índices fuera de rango, duplicados, todo cerrado) se rechaza.
  if (d.closedDoors !== undefined) {
    const pathCount = MAPS.find((m) => m.id === d.mapId)?.paths.length ?? 1;
    if (
      !Array.isArray(d.closedDoors) ||
      d.closedDoors.length > pathCount ||
      JSON.stringify(sanitizeClosedDoors(pathCount, d.closedDoors)) !== JSON.stringify(d.closedDoors)
    ) {
      return bad('Guardado corrupto (puertas cerradas).');
    }
  }
  if (!Array.isArray(d.players) || d.players.length === 0 || d.players.length > MAX_PLAYERS) {
    return bad('Guardado corrupto (jugadores).');
  }
  for (const p of d.players) {
    if (!p || typeof p !== 'object') return bad('Guardado corrupto (jugador).');
    const pp = p as Record<string, unknown>;
    if (typeof pp.id !== 'string' || typeof pp.name !== 'string' || typeof pp.color !== 'string') {
      return bad('Guardado corrupto (jugador).');
    }
  }
  if (!Array.isArray(d.slots) || d.slots.length === 0 || d.slots.length > MAX_PLAYERS) {
    return bad('Guardado corrupto (slots).');
  }
  for (const s of d.slots) {
    if (!s || typeof s !== 'object') return bad('Guardado corrupto (slot).');
    const ss = s as Record<string, unknown>;
    if (
      typeof ss.id !== 'string' ||
      typeof ss.name !== 'string' ||
      typeof ss.color !== 'string' ||
      typeof ss.tokenHash !== 'string'
    ) {
      return bad('Guardado corrupto (slot).');
    }
  }
  if (!Array.isArray(d.log) || d.log.length > MAX_SAVE_LOG) return bad('Guardado corrupto (registro de comandos).');
  for (const e of d.log) {
    if (!e || typeof e !== 'object') return bad('Guardado corrupto (entrada de registro).');
    const ee = e as Record<string, unknown>;
    if (typeof ee.t !== 'number' || !Number.isInteger(ee.t) || ee.t < 0 || ee.t > (d.tick as number)) {
      return bad('Guardado corrupto (tick de comando).');
    }
    if (ee.kind === 'cmd') {
      if (typeof ee.playerId !== 'string') return bad('Guardado corrupto (comando).');
      const c = ee.cmd as Record<string, unknown> | undefined;
      if (!c || typeof c !== 'object' || typeof c.kind !== 'string') return bad('Guardado corrupto (comando).');
    } else if (ee.kind === 'conn') {
      if (typeof ee.playerId !== 'string' || typeof ee.connected !== 'boolean') return bad('Guardado corrupto (conexión).');
    } else if (ee.kind === 'join') {
      // el `player` (id/name/color) y el oro/madera de entrada se cargan DIRECTOS
      // del archivo al reconstruir → validar forma Y ACOTAR la economía (anti
      // inyección de oro; ver MAX_JOIN_ECON). El name/color además se sanean
      // server-side en room-do (XSS), como los de players[]/slots[].
      const pl = ee.player as Record<string, unknown> | undefined;
      if (!pl || typeof pl !== 'object' || typeof pl.id !== 'string' || typeof pl.name !== 'string' || typeof pl.color !== 'string') {
        return bad('Guardado corrupto (unión).');
      }
      const econOk = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_JOIN_ECON;
      // `wood` es opcional (default en makePlayer); si viene, debe estar acotado
      if (!econOk(ee.gold) || (ee.wood !== undefined && !econOk(ee.wood))) {
        return bad('Guardado corrupto (economía de unión fuera de rango).');
      }
    } else {
      return bad('Guardado corrupto (tipo de entrada).');
    }
  }
  return { ok: true, save: x as SaveData };
}

// sha256 en hex de una cadena. crypto.subtle existe en el navegador, en el Worker
// de Cloudflare y en Node ≥20 (globalThis.crypto). Se usa SERVER-SIDE para hashear
// tokens con la sal del guardado — el token JAMÁS viaja en claro ni al archivo.
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
