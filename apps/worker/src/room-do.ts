import {
  buildSnap,
  createGame,
  getMap,
  makePlacementContext,
  makeSimContext,
  sanitizeSettings,
  stepGame,
  BALANCE_VERSION,
  GAME_SPEEDS,
  MAX_PLAYERS,
  PLAYER_COLORS,
  TICK_MS,
  TOWER_ORDER,
  type ClientMsg,
  type EndStats,
  type GameState,
  type LobbyPlayer,
  type PlayerCommand,
  type ReplayData,
  type PublicRoomInfo,
  type ReplayEntry,
  type RoomSettings,
  type ServerMsg,
  type SimContext,
  type TowerTypeId,
} from '@td/shared';
import { saveScore } from './scores.js';

export interface Env {
  ASSETS: Fetcher;
  ROOM: DurableObjectNamespace;
  DIRECTORY?: DurableObjectNamespace; // directorio de salas públicas (F5)
  SCORES?: KVNamespace;
}

interface RoomPlayer {
  id: string;
  token: string;
  name: string;
  color: string;
  ws: WebSocket | null;
  isHost: boolean;
  ready: boolean; // ¿marcó «Listo»? El anfitrión está siempre listo.
  // ABANDONO voluntario a mitad de partida: el slot se queda (sus torres siguen
  // disparando y cuenta como desconectado para el escalado), pero su token de
  // reconexión queda invalidado — NUNCA se reclama (ni por token, ni por prevToken,
  // ni por nombre) para volver a jugar; si vuelve con el enlace, entra de
  // espectador. Ver el flujo en addPlayer.
  abandoned?: boolean;
}

// Espectador: entra con la partida en curso. Ve la partida y puede guiar (chat
// con prefijo 👁, pings, sugerencias de torre) pero no juega. Al acabar la
// partida se convierte en jugador (ver endGame).
interface Spectator {
  id: string;
  token: string;
  name: string;
  ws: WebSocket;
}

type JoinResult =
  | { kind: 'player'; player: RoomPlayer }
  | { kind: 'spectator'; spectator: Spectator }
  | { kind: 'error'; msg: string };

const CHAT_MAX = 200;
const MAX_SPECTATORS = 8;
// segundos de cuenta regresiva antes de iniciar o reanudar la partida
const COUNTDOWN_SEC = 3;
// código de cierre de socket cuando el anfitrión expulsa a un jugador (el cliente
// lo respeta y NO se reconecta, igual que el 4001 de inactividad)
const KICK_CODE = 4002;

// F6.1 · Cierre por INACTIVIDAD (control de costes): si en 30 min nadie hace
// NADA humano (los pings de keepalive NO cuentan), la sala avisa a los 28 y al
// cumplirse cierra todos los sockets con el código 4001 — el cliente lo respeta
// y NO se reconecta (sin esto, la auto-reconexión revivía la sala al instante).
// Sin sockets, el Durable Object se desaloja solo y deja de facturar duración.
const IDLE_CLOSE_MS = 30 * 60_000;
const IDLE_WARN_MS = IDLE_CLOSE_MS - 2 * 60_000;
const IDLE_CLOSE_CODE = 4001;

// Una sala = un Durable Object. Reutiliza toda la simulación de @td/shared;
// solo el transporte (WebSocket) y la orquestación son específicos de Cloudflare.
// Mientras haya un WebSocket abierto, el DO permanece en memoria (sin hibernar),
// así el estado de la partida vive en RAM igual que en el servidor Node.
export class RoomDO {
  private env: Env;
  private code = '';
  private initialized = false;
  private reserved = false;

  private players: RoomPlayer[] = [];
  private spectators: Spectator[] = [];
  private settings: RoomSettings = sanitizeSettings(undefined);
  private game: GameState | null = null;
  private simCtx: SimContext | null = null;
  private pendingCmds: PlayerCommand[] = [];
  private loop: ReturnType<typeof setInterval> | null = null;
  // cuentas regresivas de inicio y de reanudación (3 s); no-null = en marcha
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  // tokens expulsados por el anfitrión: no pueden volver a entrar a ESTA sala
  // (el token vive en el storage del navegador; limpiarlo lo evade, pero cubre
  // el caso real: el expulsado reintentando con el mismo código)
  private banned = new Set<string>();
  private paused = false;
  private speed = 1;
  // ---- grabación de la repetición (replay) de la partida en curso ----
  private replaySeed = 0;
  private replayInit: { mapId: string; mode: RoomSettings['mode']; difficulty: RoomSettings['difficulty']; players: { id: string; name: string; color: string }[] } | null = null;
  private replayLog: ReplayEntry[] = [];
  private lastPingAt = new Map<string, number>();
  private lastDirReport = 0; // último latido enviado al directorio de salas públicas
  private lastActivity = Date.now(); // última acción HUMANA (para el cierre por inactividad)
  private idleWarned = false;
  private nextPlayerNum = 1;
  private nextSpectatorNum = 1;

  constructor(_state: DurableObjectState, env: Env) {
    this.env = env;
  }

  // ---------- entrada HTTP (reserva de código + upgrade a WebSocket) ----------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // reserva atómica de un código libre (la usa el Worker al crear una sala)
    if (url.pathname === '/reserve') {
      if (this.initialized || this.reserved) return new Response('taken', { status: 409 });
      this.reserved = true;
      this.code = (url.searchParams.get('code') ?? '').toUpperCase();
      return new Response('ok');
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    if (!this.code) this.code = (url.searchParams.get('code') ?? '').toUpperCase();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.acceptSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private acceptSocket(ws: WebSocket): void {
    ws.accept();
    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(ev.data as string) as ClientMsg;
      } catch {
        return;
      }
      try {
        this.handleMessage(ws, msg);
      } catch (err) {
        console.error('[room] error procesando mensaje', (msg as { type?: string })?.type, err);
        this.sendTo(ws, { type: 'error', msg: 'Mensaje inválido' });
      }
    });
    const drop = () => this.dropSocket(ws);
    ws.addEventListener('close', drop);
    ws.addEventListener('error', drop);
  }

  // ---------- utilidades de socket ----------

  private sendTo(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private send(player: RoomPlayer, msg: ServerMsg): void {
    if (player.ws && player.ws.readyState === WebSocket.OPEN) player.ws.send(JSON.stringify(msg));
  }

  // difunde a jugadores Y espectadores: ticks, chat, pausa, velocidad, pings y
  // game_over deben verlos también los que están mirando.
  private broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const p of this.players) {
      if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
    }
    for (const s of this.spectators) {
      if (s.ws.readyState === WebSocket.OPEN) s.ws.send(data);
    }
  }

  private systemMsg(text: string): void {
    this.broadcast({ type: 'chat', from: '', color: '#9e9e9e', text });
  }

  // participantes con socket abierto: mantienen el DO vivo y el loop corriendo.
  // Los espectadores cuentan: la partida sigue aunque no queden jugadores.
  private connectedCount(): number {
    return this.players.filter((p) => p.ws).length + this.spectators.length;
  }

  // ---------- gestión de jugadores ----------

  private addPlayer(name: string, token: string, ws: WebSocket, prevToken?: string): JoinResult {
    // prevToken también: un expulsado con sessionStorage limpio aún presenta su
    // respaldo de localStorage — sin esto evadiría el ban sin querer
    if (this.banned.has(token) || (prevToken && this.banned.has(prevToken))) {
      return { kind: 'error', msg: 'El anfitrión te expulsó de esta sala' };
    }
    // un slot ABANDONADO nunca se reclama por token: quien se fue voluntariamente
    // no vuelve a jugar esta partida (cae al camino de espectador más abajo).
    const existing = this.players.find((p) => p.token === token && !p.abandoned);
    if (existing) {
      // reconexión de un jugador que ya jugaba (por token): sigue siendo jugador
      existing.ws?.close();
      existing.ws = ws;
      existing.name = (name || existing.name).slice(0, 16);
      this.markConnected(existing.id, true);
      this.reviveLoop();
      return { kind: 'player', player: existing };
    }

    // Recuperación de identidad: el token vive en sessionStorage y los móviles lo
    // pierden con facilidad (pestaña descartada, reabrir desde el enlace). Antes
    // eso degradaba al jugador a espectador para siempre. Dos rescates, en orden:
    //  1) `prevToken` (respaldo por sala que el cliente guarda en localStorage):
    //     recupera al jugador DESCONECTADO que tenía ese token. Si sigue conectado
    //     no se toca (sería otra pestaña del mismo navegador: no robar la sesión).
    //  2) con la partida EN CURSO, mismo NOMBRE (sin mayúsculas) de un jugador
    //     desconectado: cubre volver a entrar desde otro navegador/dispositivo.
    // En ambos casos el slot adopta el token nuevo, así el siguiente refresco ya
    // reconecta por la vía normal. Va ANTES del rescate de espectador: un antiguo
    // jugador siempre vuelve como jugador.
    {
      // los slots ABANDONADOS quedan fuera de ambos rescates: quien se fue a
      // propósito no se recupera ni por su respaldo (prevToken) ni por su nombre.
      const wanted = (name || '').slice(0, 16).trim().toLowerCase();
      const reclaim =
        (prevToken ? this.players.find((p) => !p.ws && p.token === prevToken && !p.abandoned) : undefined) ??
        (this.game && !this.game.over && wanted
          ? this.players.find((p) => !p.ws && !p.abandoned && p.name.trim().toLowerCase() === wanted)
          : undefined);
      if (reclaim) {
        reclaim.ws = ws;
        reclaim.token = token;
        reclaim.name = (name || reclaim.name).slice(0, 16);
        this.markConnected(reclaim.id, true);
        this.reviveLoop();
        return { kind: 'player', player: reclaim };
      }
    }

    // un espectador que reconecta (mismo token) sigue de espectador
    const spec = this.spectators.find((s) => s.token === token);
    if (spec) {
      spec.ws.close();
      spec.ws = ws;
      spec.name = (name || spec.name).slice(0, 16);
      this.reviveLoop();
      return { kind: 'spectator', spectator: spec };
    }
    // con la partida en curso, un token nuevo entra como espectador
    // (la reconexión de los que ya jugaban sí funciona, por token, arriba)
    if (this.game && !this.game.over) {
      if (this.spectators.length >= MAX_SPECTATORS) return { kind: 'error', msg: 'Hay demasiados espectadores, intenta luego' };
      const spectator: Spectator = {
        id: `s${this.nextSpectatorNum++}`,
        token,
        name: (name || 'Espectador').slice(0, 16),
        ws,
      };
      this.spectators.push(spectator);
      this.reviveLoop();
      return { kind: 'spectator', spectator };
    }
    if (this.players.filter((p) => p.ws).length >= MAX_PLAYERS) return { kind: 'error', msg: 'La sala está llena' };
    const isHost = this.players.length === 0;
    const player: RoomPlayer = {
      id: `p${this.nextPlayerNum++}`,
      token,
      name: (name || 'Jugador').slice(0, 16),
      color: PLAYER_COLORS[(this.nextPlayerNum - 2) % PLAYER_COLORS.length],
      ws,
      isHost,
      ready: isHost, // el anfitrión ya cuenta como listo
    };
    this.players.push(player);
    // un jugador nuevo entra sin estar listo: si había cuenta atrás de inicio,
    // se cancela (si no, la partida le arrancaría de golpe saltándose el gate)
    this.cancelStartCountdown(`entró ${player.name}`);
    return { kind: 'player', player };
  }

  // cancela la cuenta atrás de INICIO (si está en marcha) avisando a todos:
  // countdown con seconds=0 oculta el número en los clientes
  private cancelStartCountdown(reason: string): void {
    if (!this.startTimer) return;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.broadcast({ type: 'countdown', kind: 'start', seconds: 0 });
    this.systemMsg(`⏹ Inicio cancelado: ${reason}`);
  }

  private sendGameStateTo(player: RoomPlayer): void {
    if (this.game && !this.game.over) {
      this.send(player, { type: 'game_started', init: this.gameInit(player.id) });
      if (this.speed !== 1) this.send(player, { type: 'speed', speed: this.speed, by: '' });
      if (this.paused) this.send(player, { type: 'paused', by: '' });
    }
  }

  // igual que sendGameStateTo pero para un espectador (usa su propio id como
  // youAre, aunque no controle nada) para que renderice la partida.
  private sendGameStateToSpectator(spec: Spectator): void {
    if (this.game && !this.game.over) {
      this.sendTo(spec.ws, { type: 'game_started', init: this.gameInit(spec.id) });
      if (this.speed !== 1) this.sendTo(spec.ws, { type: 'speed', speed: this.speed, by: '' });
      if (this.paused) this.sendTo(spec.ws, { type: 'paused', by: '' });
    }
  }

  private dropSocket(ws: WebSocket): void {
    // ¿era un espectador? quitarlo de la lista
    const spec = this.spectators.find((s) => s.ws === ws);
    if (spec) {
      this.spectators = this.spectators.filter((s) => s !== spec);
      // los espectadores cuentan para mantener el loop vivo: si el último se va
      // (y no quedan jugadores conectados) el loop se para. También aquí hay que
      // des-listar la sala: el último en irse puede ser un espectador.
      if (this.connectedCount() === 0) {
        this.unlistPublic();
        if (this.loop) {
          clearInterval(this.loop);
          this.loop = null;
        }
        this.clearCountdowns();
      }
      return;
    }

    const player = this.players.find((p) => p.ws === ws);
    if (!player) return;
    player.ws = null;
    this.markConnected(player.id, false);

    if (!this.game) {
      this.players = this.players.filter((p) => p !== player);
    }
    if (player.isHost) {
      const next = this.players.find((p) => p.ws);
      if (next) {
        player.isHost = false;
        next.isHost = true;
        next.ready = true; // el nuevo anfitrión cuenta como listo
        this.systemMsg(`${next.name} ahora es el anfitrión`);
      }
    }
    this.broadcastLobby();

    // sin nadie conectado (ni jugadores ni espectadores), paramos el loop para
    // que el DO pueda liberarse (si alguien reconecta antes, reviveLoop reanuda)
    if (this.connectedCount() === 0) {
      // sala vacía: fuera de la lista de salas públicas (no dejar fantasmas)
      this.unlistPublic();
      if (this.loop) {
        clearInterval(this.loop);
        this.loop = null;
      }
      this.clearCountdowns();
    }
  }

  // cancela cualquier cuenta regresiva de inicio/reanudación pendiente
  private clearCountdowns(): void {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  private markConnected(playerId: string, connected: boolean): void {
    const gp = this.game?.players.find((p) => p.id === playerId);
    if (gp && gp.connected !== connected) {
      gp.connected = connected;
      // grabar el cambio con el tick de sim en que ocurre: afecta a connectedCount
      // (escalado de HP y presupuesto de oleada) → es crítico para el determinismo
      if (this.game && !this.game.over) {
        this.replayLog.push({ t: this.game.tick, kind: 'conn', playerId, connected });
      }
    }
  }

  private lobbyPlayers(): LobbyPlayer[] {
    return this.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      isHost: p.isHost,
      connected: p.ws !== null,
      ready: p.isHost || p.ready,
    }));
  }

  // ¿están listos TODOS los no-anfitriones conectados? (el anfitrión juega en
  // solitario si no hay nadie más). Bloquea el inicio hasta que el equipo confirme.
  private allReady(): boolean {
    return this.players.filter((p) => p.ws && !p.isHost).every((p) => p.ready);
  }

  private broadcastLobby(): void {
    this.broadcast({
      type: 'lobby_state',
      players: this.lobbyPlayers(),
      settings: this.settings,
      inGame: this.game !== null && !this.game.over,
    });
    // cualquier cambio de sala (miembros/ajustes/estado) refresca el directorio
    this.reportPublic(true);
  }

  // ---------- directorio de salas públicas (F5) ----------

  private directoryStub(): DurableObjectStub | null {
    const ns = this.env.DIRECTORY;
    return ns ? ns.get(ns.idFromName('v1')) : null;
  }

  // Reporta esta sala al directorio (fire-and-forget; jamás bloquea la sala).
  // `force` = cambio de estado real; sin force actúa de LATIDO con throttle de
  // 10 s (lo disparan los pings de keepalive de los clientes y el tick de sim).
  private reportPublic(force = false): void {
    if (!this.initialized || !this.settings.public) return;
    if (!force && Date.now() - this.lastDirReport < 10_000) return;
    const stub = this.directoryStub();
    if (!stub) return;
    const connected = this.players.filter((p) => p.ws).length;
    if (connected === 0) return; // sala sin jugadores conectados: no listar
    this.lastDirReport = Date.now();
    const host = this.players.find((p) => p.isHost) ?? this.players[0];
    const info: PublicRoomInfo = {
      code: this.code,
      host: host?.name ?? '',
      mapId: this.settings.mapId,
      mode: this.settings.mode,
      difficulty: this.settings.difficulty,
      players: connected,
      inGame: this.game !== null && !this.game.over,
      wave: this.game && !this.game.over ? this.game.wave : 0,
    };
    void stub
      .fetch('https://do/report', { method: 'POST', body: JSON.stringify(info) })
      .catch(() => {});
  }

  // Saca la sala de la lista (se volvió privada o se quedó vacía).
  private unlistPublic(): void {
    const stub = this.directoryStub();
    if (!stub || !this.code) return;
    this.lastDirReport = 0;
    void stub
      .fetch('https://do/remove', { method: 'POST', body: JSON.stringify({ code: this.code }) })
      .catch(() => {});
  }

  private gameInit(forPlayerId: string) {
    return {
      mapId: this.game!.mapId,
      mode: this.game!.mode,
      difficulty: this.game!.difficulty,
      players: this.game!.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
      youAre: forPlayerId,
    };
  }

  // ---------- partida ----------

  private startGame(): void {
    const map = getMap(this.settings.mapId);
    const seed = (Math.random() * 0xffffffff) | 0;
    this.game = createGame(
      map.id,
      this.settings.mode,
      this.settings.difficulty,
      seed,
      this.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
    );
    this.simCtx = makeSimContext(map, makePlacementContext(map));
    this.pendingCmds = [];
    this.paused = false;
    this.speed = 1;
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }

    // arrancar la grabación de la repetición: semilla, roster inicial y log vacío
    this.replaySeed = seed;
    this.replayInit = {
      mapId: map.id,
      mode: this.settings.mode,
      difficulty: this.settings.difficulty,
      players: this.game.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
    };
    this.replayLog = [];

    for (const p of this.players) {
      this.send(p, { type: 'game_started', init: this.gameInit(p.id) });
    }
    this.reviveLoop(true);
    // la lista de salas públicas pasa a mostrarla "en partida" (👁 observable)
    this.reportPublic(true);
  }

  // arranca (o reanuda) el bucle de simulación si hay partida activa y jugadores
  private reviveLoop(force = false): void {
    if (!this.game || this.game.over) return;
    if (this.loop && !force) return;
    if (this.loop) clearInterval(this.loop);
    this.loop = setInterval(() => this.tick(), TICK_MS);
  }

  private tick(): void {
    // el chequeo de inactividad corre también con la partida EN PAUSA (una pausa
    // eterna con la pestaña abierta era justo el caso que facturaba sin fin)
    this.checkIdle();
    if (!this.game || !this.simCtx || this.paused) return;
    const cmds = this.pendingCmds;
    this.pendingCmds = [];
    const wasOver = this.game.over !== null;
    // grabar los comandos con el TICK DE SIM en que se aplican: a x2/x3 solo se
    // aplican en el PRIMER stepGame de la ráfaga, así que todos llevan game.tick de
    // ANTES de ese primer paso (los siguientes pasos van sin comandos).
    const cmdTick = this.game.tick;
    for (const c of cmds) this.replayLog.push({ t: cmdTick, kind: 'cmd', playerId: c.playerId, cmd: c.cmd });
    const events = stepGame(this.game, this.simCtx, cmds);
    for (let i = 1; i < this.speed && !this.game.over; i++) {
      events.push(...stepGame(this.game, this.simCtx, []));
    }
    this.broadcast({ type: 'tick', t: this.game.tick, snap: buildSnap(this.game), events });

    // latido del directorio durante la partida (throttle interno de 10 s):
    // mantiene fresca la oleada que muestra la lista de salas públicas
    this.reportPublic();

    if (this.game.over && !wasOver) this.endGame();
  }

  // Construye la ReplayData de la partida que acaba de terminar. Pequeña: los
  // comandos de una partida son decenas, no miles. undefined si no hay grabación.
  private buildReplay(g: GameState): ReplayData | undefined {
    if (!this.replayInit) return undefined;
    return {
      v: BALANCE_VERSION,
      seed: this.replaySeed,
      mapId: this.replayInit.mapId,
      mode: this.replayInit.mode,
      difficulty: this.replayInit.difficulty,
      players: this.replayInit.players,
      log: this.replayLog,
      finalTick: g.tick,
      victory: g.over?.victory ?? false,
      wave: g.wave,
    };
  }

  private endGame(): void {
    if (!this.game) return;
    const g = this.game;
    const replay = this.buildReplay(g);
    const stats: EndStats = {
      victory: g.over?.victory ?? false,
      wave: g.wave,
      totalWaves: g.totalWaves,
      mapId: g.mapId,
      mode: g.mode,
      difficulty: g.difficulty,
      players: g.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        kills: p.stats.kills,
        damage: Math.round(p.stats.damage),
        goldEarned: Math.round(p.stats.goldEarned),
        goldSpent: Math.round(p.stats.goldSpent),
        towersBuilt: p.stats.towersBuilt,
      })),
    };
    // récords: endless (Infinito) y horde (Horda) puntúan por oleada alcanzada
    if (g.mode === 'endless' || g.mode === 'horde') {
      void saveScore(this.env, {
        names: g.players.map((p) => p.name),
        wave: g.wave,
        mapId: g.mapId,
        difficulty: g.difficulty,
        date: new Date().toISOString(),
        mode: g.mode,
      });
    }
    setTimeout(() => {
      if (this.game !== g) return; // ya se reinició
      if (this.loop) clearInterval(this.loop);
      this.loop = null;
      this.game = null;
      this.simCtx = null;
      this.broadcast({ type: 'game_over', stats, ...(replay ? { replay } : {}) });
      // los «Listo» caducan con la partida: la revancha exige reconfirmar
      // (igual que cambiar la configuración; los promovidos ya entran no-listos)
      for (const p of this.players) p.ready = p.isHost;
      this.promoteSpectators();
      this.broadcastLobby();
    }, 1200);
  }

  // Al terminar la partida, los espectadores pasan a ser jugadores de pleno
  // derecho en el lobby (respetando MAX_PLAYERS). Los que no caben siguen como
  // espectadores.
  private promoteSpectators(): void {
    if (this.spectators.length === 0) return;
    const stayed: Spectator[] = [];
    for (const spec of this.spectators) {
      if (this.players.filter((p) => p.ws).length >= MAX_PLAYERS) {
        stayed.push(spec);
        continue;
      }
      const isHost = this.players.length === 0;
      const player: RoomPlayer = {
        // conserva el id del espectador para que el cliente se reconozca como el
        // mismo participante (si no, quedaría atascado en modo espectador)
        id: spec.id,
        token: spec.token,
        name: spec.name,
        color: PLAYER_COLORS[this.players.length % PLAYER_COLORS.length],
        ws: spec.ws,
        isHost,
        ready: isHost,
      };
      this.players.push(player);
      // avísale que ya es jugador (actualiza spectator/isHost en el cliente)
      this.send(player, { type: 'room_joined', code: this.code, playerId: player.id, isHost: player.isHost, spectator: false });
    }
    this.spectators = stayed;
  }

  // ---------- entrada de mensajes ----------

  // ---------- cierre por inactividad ----------

  // Cualquier mensaje que NO sea el ping de keepalive cuenta como vida humana.
  private touchActivity(): void {
    this.lastActivity = Date.now();
    this.idleWarned = false;
  }

  // Se evalúa desde el tick de sim (partidas, incluso en pausa) y desde los pings
  // de keepalive (lobby sin loop). Barato: una resta de Date.now().
  private checkIdle(): void {
    if (this.connectedCount() === 0) return;
    const idle = Date.now() - this.lastActivity;
    if (idle >= IDLE_CLOSE_MS) {
      this.systemMsg('⏰ Sala cerrada por 30 minutos de inactividad.');
      this.lastActivity = Date.now(); // no re-disparar si algún cierre tarda
      this.idleWarned = false;
      for (const p of this.players) {
        try {
          p.ws?.close(IDLE_CLOSE_CODE, 'idle');
        } catch {
          /* nada */
        }
      }
      for (const s of this.spectators) {
        try {
          s.ws.close(IDLE_CLOSE_CODE, 'idle');
        } catch {
          /* nada */
        }
      }
    } else if (idle >= IDLE_WARN_MS && !this.idleWarned) {
      this.idleWarned = true;
      this.systemMsg('⏰ Sala inactiva: se cerrará en 2 minutos si nadie hace nada (cualquier acción la mantiene viva).');
    }
  }

  private handleMessage(ws: WebSocket, msg: ClientMsg): void {
    // toda acción humana (no el keepalive) mantiene viva la sala
    if (msg.type !== 'ping') this.touchActivity();
    // crear / unirse crean el vínculo socket↔jugador; el resto exige jugador ya ligado
    if (msg.type === 'create_room') {
      if (this.initialized) {
        this.sendTo(ws, { type: 'error', msg: 'Ese código ya está en uso, intenta de nuevo' });
        return;
      }
      this.initialized = true;
      this.settings = sanitizeSettings(msg.settings);
      const res = this.addPlayer(msg.name, msg.token, ws);
      if (res.kind === 'error') {
        this.sendTo(ws, { type: 'error', msg: res.msg });
        return;
      }
      // crear una sala nunca produce espectador (no hay partida), pero por
      // simetría con join_room lo tratamos igual
      if (res.kind === 'spectator') {
        const spec = res.spectator;
        this.sendTo(ws, { type: 'room_joined', code: this.code, playerId: spec.id, isHost: false, spectator: true });
        this.broadcastLobby();
        this.sendGameStateToSpectator(spec);
        return;
      }
      const player = res.player;
      this.sendTo(ws, { type: 'room_joined', code: this.code, playerId: player.id, isHost: player.isHost });
      this.broadcastLobby();
      return;
    }

    if (msg.type === 'join_room') {
      if (!this.initialized) {
        this.sendTo(ws, { type: 'error', msg: `No existe la sala "${this.code}"` });
        return;
      }
      const res = this.addPlayer(msg.name, msg.token, ws, msg.prevToken);
      if (res.kind === 'error') {
        this.sendTo(ws, { type: 'error', msg: res.msg });
        return;
      }
      if (res.kind === 'spectator') {
        const spec = res.spectator;
        this.sendTo(ws, { type: 'room_joined', code: this.code, playerId: spec.id, isHost: false, spectator: true });
        this.broadcastLobby();
        this.sendGameStateToSpectator(spec);
        return;
      }
      const player = res.player;
      this.sendTo(ws, { type: 'room_joined', code: this.code, playerId: player.id, isHost: player.isHost });
      this.broadcastLobby();
      this.sendGameStateTo(player);
      return;
    }

    // canal restringido de espectador: solo chat, ping de mapa y keepalive
    const spectator = this.spectators.find((s) => s.ws === ws);
    if (spectator) {
      this.handleSpectatorMessage(spectator, msg);
      return;
    }

    const player = this.players.find((p) => p.ws === ws);
    if (!player) return;

    switch (msg.type) {
      case 'set_settings': {
        if (!player.isHost || this.game) break;
        const wasPublic = this.settings.public === true;
        this.settings = sanitizeSettings(msg.settings);
        // pública → privada: salir de la lista al instante (no esperar la poda)
        if (wasPublic && !this.settings.public) this.unlistPublic();
        // cambiar la configuración invalida los «Listo»: que el equipo reconfirme
        for (const p of this.players) if (!p.isHost) p.ready = false;
        this.broadcastLobby();
        break;
      }

      case 'kick_player': {
        if (!player.isHost) {
          this.send(player, { type: 'error', msg: 'Solo el anfitrión puede expulsar' });
          break;
        }
        if (this.game && !this.game.over) break; // expulsar solo en el lobby
        const target = this.players.find((p) => p.id === msg.playerId);
        if (!target || target.id === player.id) break;
        this.systemMsg(`${target.name} fue expulsado por el anfitrión`);
        this.players = this.players.filter((p) => p !== target);
        this.banned.add(target.token); // expulsado = no puede volver a esta sala
        try {
          target.ws?.close(KICK_CODE, 'kicked');
        } catch {
          // ignore
        }
        this.broadcastLobby();
        break;
      }

      case 'transfer_host': {
        if (!player.isHost) {
          this.send(player, { type: 'error', msg: 'Solo el anfitrión puede ceder la sala' });
          break;
        }
        if (this.game && !this.game.over) break; // ceder solo en el lobby
        const target = this.players.find((p) => p.id === msg.playerId);
        if (!target || target.id === player.id || !target.ws) break;
        player.isHost = false;
        player.ready = true;
        target.isHost = true;
        target.ready = true;
        this.systemMsg(`${player.name} cedió la sala a ${target.name}`);
        this.broadcastLobby();
        break;
      }

      case 'set_ready':
        if (this.game) break;
        player.ready = msg.ready === true;
        // desmarcar «Listo» durante la cuenta atrás de inicio la cancela (si no,
        // la partida arrancaría igual 3 s después de que alguien se arrepintiera)
        if (!player.ready) this.cancelStartCountdown(`${player.name} ya no está listo`);
        this.broadcastLobby();
        break;

      case 'start_game':
        if (!player.isHost) {
          this.send(player, { type: 'error', msg: 'Solo el anfitrión puede iniciar' });
          break;
        }
        if (this.game && !this.game.over) break;
        if (this.startTimer) break; // ya en cuenta atrás
        if (!this.allReady()) {
          this.send(player, { type: 'error', msg: 'Espera a que todos marquen «Listo»' });
          break;
        }
        // cuenta regresiva de 3 s y luego arranca (solo si queda alguien conectado)
        this.broadcast({ type: 'countdown', kind: 'start', seconds: COUNTDOWN_SEC });
        this.startTimer = setTimeout(() => {
          this.startTimer = null;
          if (this.players.some((p) => p.ws)) this.startGame();
        }, COUNTDOWN_SEC * 1000);
        break;

      case 'chat': {
        const text = String(msg.text ?? '').slice(0, CHAT_MAX).trim();
        if (!text) break;
        this.broadcast({ type: 'chat', from: player.name, color: player.color, text });
        break;
      }

      case 'cmd':
        if (!this.game || this.game.over) break;
        this.pendingCmds.push({ playerId: player.id, cmd: msg.cmd });
        break;

      // pausa/reanudar: CUALQUIER jugador de la sala (no solo el anfitrión) puede
      // pausar y despausar — es co-op y cualquiera puede necesitar un descanso.
      // Los espectadores no llegan aquí (su canal restringido se filtra antes).
      case 'pause': {
        if (!this.game) break;
        // pausar cancela una reanudación en cuenta atrás: nos quedamos en pausa
        const hadResume = this.resumeTimer !== null;
        if (this.resumeTimer) {
          clearTimeout(this.resumeTimer);
          this.resumeTimer = null;
        }
        if (this.paused && !hadResume) break; // ya en pausa firme
        this.paused = true;
        this.broadcast({ type: 'paused', by: player.name });
        break;
      }

      case 'resume':
        if (!this.game || !this.paused) break;
        if (this.resumeTimer) break; // ya en cuenta atrás
        // cuenta regresiva de 3 s antes de reanudar (sigue en pausa mientras tanto)
        this.broadcast({ type: 'countdown', kind: 'resume', seconds: COUNTDOWN_SEC });
        this.resumeTimer = setTimeout(() => {
          this.resumeTimer = null;
          this.paused = false;
          this.broadcast({ type: 'resumed' });
        }, COUNTDOWN_SEC * 1000);
        break;

      case 'set_speed': {
        if (!player.isHost || !this.game) break;
        const speed = Number(msg.speed);
        if (!(GAME_SPEEDS as readonly number[]).includes(speed) || speed === this.speed) break;
        this.speed = speed;
        this.broadcast({ type: 'speed', speed, by: player.name });
        break;
      }

      case 'map_ping':
        this.emitPing(player.id, player.name, player.color, msg);
        break;

      case 'leave_room':
        ws.close();
        break;

      // ABANDONO explícito. Con partida en curso: marca al jugador como
      // desconectado PERMANENTE (sus torres se quedan) e invalida su token de
      // reconexión (`abandoned`), avisa al resto y cierra el socket — la
      // desconexión (host, sala vacía, loop, unlist, replay conn=false) la
      // resuelve dropSocket. En el lobby es un simple cierre, como `leave_room`.
      case 'leave':
        if (this.game && !this.game.over) {
          player.abandoned = true;
          this.systemMsg(`💨 ${player.name} abandonó la partida`);
        }
        ws.close();
        break;

      case 'ping':
        this.send(player, { type: 'pong', t: msg.t });
        // los pings de keepalive (cada 5 s por cliente) hacen de latido del
        // directorio también con la sala en el LOBBY (sin loop de sim corriendo)
        this.reportPublic();
        // …y de reloj del cierre por inactividad (en el lobby no hay tick de sim)
        this.checkIdle();
        break;
    }
  }

  // canal restringido de espectador (chat con prefijo 👁, ping y keepalive)
  private handleSpectatorMessage(spec: Spectator, msg: ClientMsg): void {
    switch (msg.type) {
      case 'chat': {
        const text = String(msg.text ?? '').slice(0, CHAT_MAX).trim();
        if (!text) break;
        // prefijo 👁 en el nombre para distinguir a quien mira de quien juega
        this.broadcast({ type: 'chat', from: `👁 ${spec.name}`, color: '#b0bec5', text });
        break;
      }
      case 'map_ping':
        this.emitPing(spec.id, `👁 ${spec.name}`, '#b0bec5', msg);
        break;
      case 'ping':
        this.sendTo(spec.ws, { type: 'pong', t: msg.t });
        this.checkIdle();
        break;
      // un espectador que se va: cierre limpio del socket (dropSocket lo quita)
      case 'leave':
        spec.ws.close();
        break;
      // cmd, start_game, pause, resume, set_speed, set_settings, leave_room: ignorados
    }
  }

  // ping cooperativo (de jugador o espectador), rate-limit por participante.
  // Si trae towerType válido (de TOWER_ORDER) lo reenvía como sugerencia de torre.
  private emitPing(id: string, by: string, color: string, msg: Extract<ClientMsg, { type: 'map_ping' }>): void {
    if (!this.game) return;
    const now = Date.now();
    if (now - (this.lastPingAt.get(id) ?? 0) < 600) return;
    const map = getMap(this.game.mapId);
    const x = Number(msg.x);
    const y = Number(msg.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.lastPingAt.set(id, now);
    const towerType =
      msg.towerType && (TOWER_ORDER as TowerTypeId[]).includes(msg.towerType) ? msg.towerType : undefined;
    this.broadcast({
      type: 'map_ping',
      x: Math.max(0, Math.min(map.gridW, x)),
      y: Math.max(0, Math.min(map.gridH, y)),
      by,
      color,
      ...(towerType ? { towerType } : {}),
    });
  }
}
