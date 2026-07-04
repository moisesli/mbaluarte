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
  SCORES?: KVNamespace;
}

interface RoomPlayer {
  id: string;
  token: string;
  name: string;
  color: string;
  ws: WebSocket | null;
  isHost: boolean;
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
  private paused = false;
  private speed = 1;
  // ---- grabación de la repetición (replay) de la partida en curso ----
  private replaySeed = 0;
  private replayInit: { mapId: string; mode: RoomSettings['mode']; difficulty: RoomSettings['difficulty']; players: { id: string; name: string; color: string }[] } | null = null;
  private replayLog: ReplayEntry[] = [];
  private lastPingAt = new Map<string, number>();
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

  private addPlayer(name: string, token: string, ws: WebSocket): JoinResult {
    const existing = this.players.find((p) => p.token === token);
    if (existing) {
      // reconexión de un jugador que ya jugaba (por token): sigue siendo jugador
      existing.ws?.close();
      existing.ws = ws;
      existing.name = (name || existing.name).slice(0, 16);
      this.markConnected(existing.id, true);
      this.reviveLoop();
      return { kind: 'player', player: existing };
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
    const player: RoomPlayer = {
      id: `p${this.nextPlayerNum++}`,
      token,
      name: (name || 'Jugador').slice(0, 16),
      color: PLAYER_COLORS[(this.nextPlayerNum - 2) % PLAYER_COLORS.length],
      ws,
      isHost: this.players.length === 0,
    };
    this.players.push(player);
    return { kind: 'player', player };
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
      // (y no quedan jugadores conectados) el loop se para
      if (this.connectedCount() === 0 && this.loop) {
        clearInterval(this.loop);
        this.loop = null;
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
        this.systemMsg(`${next.name} ahora es el anfitrión`);
      }
    }
    this.broadcastLobby();

    // sin nadie conectado (ni jugadores ni espectadores), paramos el loop para
    // que el DO pueda liberarse (si alguien reconecta antes, reviveLoop reanuda)
    if (this.connectedCount() === 0 && this.loop) {
      clearInterval(this.loop);
      this.loop = null;
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
    }));
  }

  private broadcastLobby(): void {
    this.broadcast({
      type: 'lobby_state',
      players: this.lobbyPlayers(),
      settings: this.settings,
      inGame: this.game !== null && !this.game.over,
    });
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
  }

  // arranca (o reanuda) el bucle de simulación si hay partida activa y jugadores
  private reviveLoop(force = false): void {
    if (!this.game || this.game.over) return;
    if (this.loop && !force) return;
    if (this.loop) clearInterval(this.loop);
    this.loop = setInterval(() => this.tick(), TICK_MS);
  }

  private tick(): void {
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
      const player: RoomPlayer = {
        // conserva el id del espectador para que el cliente se reconozca como el
        // mismo participante (si no, quedaría atascado en modo espectador)
        id: spec.id,
        token: spec.token,
        name: spec.name,
        color: PLAYER_COLORS[this.players.length % PLAYER_COLORS.length],
        ws: spec.ws,
        isHost: this.players.length === 0,
      };
      this.players.push(player);
      // avísale que ya es jugador (actualiza spectator/isHost en el cliente)
      this.send(player, { type: 'room_joined', code: this.code, playerId: player.id, isHost: player.isHost, spectator: false });
    }
    this.spectators = stayed;
  }

  // ---------- entrada de mensajes ----------

  private handleMessage(ws: WebSocket, msg: ClientMsg): void {
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
      const res = this.addPlayer(msg.name, msg.token, ws);
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
      case 'set_settings':
        if (!player.isHost || this.game) break;
        this.settings = sanitizeSettings(msg.settings);
        this.broadcastLobby();
        break;

      case 'start_game':
        if (!player.isHost) {
          this.send(player, { type: 'error', msg: 'Solo el anfitrión puede iniciar' });
          break;
        }
        if (this.game && !this.game.over) break;
        this.startGame();
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

      case 'pause':
        if (!player.isHost || !this.game) break;
        this.paused = true;
        this.broadcast({ type: 'paused', by: player.name });
        break;

      case 'resume':
        if (!player.isHost || !this.game) break;
        this.paused = false;
        this.broadcast({ type: 'resumed' });
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

      case 'ping':
        this.send(player, { type: 'pong', t: msg.t });
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
