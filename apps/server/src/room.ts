import type { WebSocket } from 'ws';
import {
  buildSnap,
  createGame,
  getMap,
  makePlacementContext,
  makeSimContext,
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
import { sanitizeSettings } from '@td/shared';
import { saveHighscore } from './highscores.js';

export interface RoomPlayer {
  id: string;
  token: string;
  name: string;
  color: string;
  ws: WebSocket | null;
  isHost: boolean;
  ready: boolean; // ¿marcó «Listo»? El anfitrión está siempre listo.
  // ABANDONO voluntario a mitad de partida: el slot se queda (sus torres siguen
  // disparando y cuenta como desconectado para el escalado), pero su token de
  // reconexión queda invalidado — NUNCA se reclama por token para volver a jugar
  // (si vuelve con el enlace, entra de espectador). Ver el flujo en addPlayer.
  abandoned?: boolean;
}

// Espectador: entra con la partida en curso. Ve la partida en vivo y puede guiar
// (chat con prefijo 👁, pings y sugerencias de torre), pero NO juega. Al terminar
// la partida se convierte en jugador (ver endGame).
export interface Spectator {
  id: string;
  token: string;
  name: string;
  ws: WebSocket;
}

// resultado de una unión: jugador (nuevo o reconexión) o espectador
export type JoinResult =
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

export class Room {
  readonly code: string;
  players: RoomPlayer[] = [];
  spectators: Spectator[] = [];
  settings: RoomSettings;
  game: GameState | null = null;
  simCtx: SimContext | null = null;
  private pendingCmds: PlayerCommand[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  // cuentas regresivas de inicio y de reanudación (3 s); no-null = en marcha
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  // tokens expulsados por el anfitrión: no pueden volver a entrar a ESTA sala
  // (el token vive en el localStorage del navegador; limpiar storage lo evade,
  // pero cubre el caso real: el expulsado reintentando con el mismo código)
  private banned = new Set<string>();
  private paused = false;
  private speed = 1; // steps de simulación por tick de red (x1/x2/x3)
  // ---- grabación de la repetición (replay) de la partida en curso ----
  private replaySeed = 0;
  private replayInit: { mapId: string; mode: RoomSettings['mode']; difficulty: RoomSettings['difficulty']; players: { id: string; name: string; color: string }[] } | null = null;
  private replayLog: ReplayEntry[] = [];
  private lastPingAt = new Map<string, number>(); // rate-limit de pings por participante
  private nextPlayerNum = 1;
  private nextSpectatorNum = 1;
  emptySince: number | null = Date.now();
  private onEmpty: (room: Room) => void;

  constructor(code: string, settings: RoomSettings, onEmpty: (room: Room) => void) {
    this.code = code;
    this.settings = sanitizeSettings(settings);
    this.onEmpty = onEmpty;
  }

  // ---------- gestión de jugadores ----------

  addPlayer(name: string, token: string, ws: WebSocket): JoinResult {
    if (this.banned.has(token)) return { kind: 'error', msg: 'El anfitrión te expulsó de esta sala' };
    // un slot ABANDONADO nunca se reclama por token: quien se fue voluntariamente
    // no vuelve a jugar esta partida (cae al camino de espectador más abajo).
    const existing = this.players.find((p) => p.token === token && !p.abandoned);
    if (existing) {
      // reconexión de un jugador que ya jugaba (por token): sigue siendo jugador
      existing.ws?.close();
      existing.ws = ws;
      existing.name = (name || existing.name).slice(0, 16);
      this.markConnected(existing.id, true);
      return { kind: 'player', player: existing };
    }
    // un espectador que reconecta (mismo token) sigue de espectador
    const spec = this.spectators.find((s) => s.token === token);
    if (spec) {
      spec.ws.close();
      spec.ws = ws;
      spec.name = (name || spec.name).slice(0, 16);
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
      this.emptySince = null;
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
    this.emptySince = null;
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

  // Tras el room_joined: si hay partida en curso, reenviar el estado inicial
  // (cubre tanto a los que entran a mitad de partida como a los que reconectan).
  sendGameStateTo(player: RoomPlayer): void {
    if (this.game && !this.game.over) {
      this.send(player, { type: 'game_started', init: this.gameInit(player.id) });
      if (this.speed !== 1) this.send(player, { type: 'speed', speed: this.speed, by: '' });
      if (this.paused) this.send(player, { type: 'paused', by: '' });
    }
  }

  // Igual que sendGameStateTo pero para un espectador: le manda el init actual
  // (con su propio id como `youAre`, aunque no controle nada) para que renderice.
  sendGameStateToSpectator(spec: Spectator): void {
    if (this.game && !this.game.over) {
      this.sendTo(spec.ws, { type: 'game_started', init: this.gameInit(spec.id) });
      if (this.speed !== 1) this.sendTo(spec.ws, { type: 'speed', speed: this.speed, by: '' });
      if (this.paused) this.sendTo(spec.ws, { type: 'paused', by: '' });
    }
  }

  dropSocket(ws: WebSocket): void {
    // ¿era un espectador? quitarlo de la lista y ya
    const spec = this.spectators.find((s) => s.ws === ws);
    if (spec) {
      this.spectators = this.spectators.filter((s) => s !== spec);
      if (this.connectedCount() === 0) this.emptySince = Date.now();
      return;
    }

    const player = this.players.find((p) => p.ws === ws);
    if (!player) return;
    player.ws = null;
    this.markConnected(player.id, false);

    if (!this.game) {
      // en el lobby los desconectados se eliminan de la sala
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
    // los espectadores también mantienen viva la sala: solo marcamos vacía si no
    // queda NADIE conectado (ni jugadores ni espectadores)
    if (this.connectedCount() === 0) {
      this.emptySince = Date.now();
    }
    this.broadcastLobby();
  }

  // participantes con socket abierto: jugadores conectados + espectadores
  private connectedCount(): number {
    return this.players.filter((p) => p.ws).length + this.spectators.length;
  }

  private markConnected(playerId: string, connected: boolean) {
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

  // ---------- mensajería ----------

  send(player: RoomPlayer, msg: ServerMsg): void {
    if (player.ws && player.ws.readyState === player.ws.OPEN) {
      player.ws.send(JSON.stringify(msg));
    }
  }

  sendTo(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  // difunde a jugadores Y espectadores: ticks, chat, pausa, velocidad, pings y
  // game_over deben verlos también los que están mirando.
  broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const p of this.players) {
      if (p.ws && p.ws.readyState === p.ws.OPEN) p.ws.send(data);
    }
    for (const s of this.spectators) {
      if (s.ws.readyState === s.ws.OPEN) s.ws.send(data);
    }
  }

  systemMsg(text: string): void {
    this.broadcast({ type: 'chat', from: '', color: '#9e9e9e', text });
  }

  lobbyPlayers(): LobbyPlayer[] {
    return this.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      isHost: p.isHost,
      connected: p.ws !== null,
      ready: p.isHost || p.ready,
    }));
  }

  // ¿están listos TODOS los no-anfitriones conectados? (el anfitrión juega en solitario
  // si no hay nadie más). Cierra la puerta a iniciar hasta que el equipo confirme.
  private allReady(): boolean {
    return this.players.filter((p) => p.ws && !p.isHost).every((p) => p.ready);
  }

  broadcastLobby(): void {
    this.broadcast({
      type: 'lobby_state',
      players: this.lobbyPlayers(),
      settings: this.settings,
      inGame: this.game !== null && !this.game.over,
    });
  }

  gameInit(forPlayerId: string) {
    return {
      mapId: this.game!.mapId,
      mode: this.game!.mode,
      difficulty: this.game!.difficulty,
      players: this.game!.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
      youAre: forPlayerId,
    };
  }

  // ---------- partida ----------

  startGame(): void {
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
    // por si se reinicia dentro de la ventana de gracia de endGame()
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => this.tick(), TICK_MS);
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
    // a velocidad x2/x3 se simulan varios pasos por tick de red (un solo snapshot)
    const events = stepGame(this.game, this.simCtx, cmds);
    for (let i = 1; i < this.speed && !this.game.over; i++) {
      events.push(...stepGame(this.game, this.simCtx, []));
    }
    this.broadcast({ type: 'tick', t: this.game.tick, snap: buildSnap(this.game), events });

    if (this.game.over && !wasOver) {
      this.endGame();
    }
  }

  // Construye la ReplayData de la partida que acaba de terminar. Pequeña: los
  // comandos de una partida son decenas, no miles. null si no hay grabación.
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
      saveHighscore({
        names: g.players.map((p) => p.name),
        wave: g.wave,
        mapId: g.mapId,
        difficulty: g.difficulty,
        date: new Date().toISOString(),
        mode: g.mode,
      });
    }
    // dejar correr unos ticks más para que el cliente vea la explosión final
    setTimeout(() => {
      // si el anfitrión ya reinició en esta ventana, no destruir la partida nueva
      if (this.game !== g) return;
      if (this.interval) clearInterval(this.interval);
      this.interval = null;
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
  // espectadores hasta que se libere un hueco (p. ej. si alguien sale).
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

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.startTimer = null;
    this.resumeTimer = null;
    for (const p of this.players) p.ws?.close();
    for (const s of this.spectators) s.ws.close();
  }

  // ---------- entrada de mensajes ----------

  handleMessage(ws: WebSocket, msg: ClientMsg): void {
    // los espectadores tienen un canal restringido: solo chat, ping de mapa y
    // keepalive. Todo lo demás (cmd, start, pause, resume, set_speed, settings)
    // se ignora — no controlan la partida.
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
        // cambiar la configuración invalida los «Listo»: que el equipo reconfirme
        for (const p of this.players) if (!p.isHost) p.ready = false;
        this.broadcastLobby();
        break;

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
        player.ready = true; // el ex-anfitrión ya estaba listo; lo dejamos listo
        target.isHost = true;
        target.ready = true; // el nuevo anfitrión cuenta como listo
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

      case 'pause': {
        if (!player.isHost || !this.game) break;
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
        if (!player.isHost || !this.game || !this.paused) break;
        if (this.resumeTimer) break; // ya en cuenta atrás
        // cuenta regresiva de 3 s antes de reanudar (el juego sigue en pausa mientras tanto)
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
      // desconexión (host, sala vacía, replay conn=false) la resuelve dropSocket.
      // En el lobby es un simple cierre de socket, como `leave_room`.
      case 'leave':
        if (this.game && !this.game.over) {
          player.abandoned = true;
          this.systemMsg(`💨 ${player.name} abandonó la partida`);
        }
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
      // un espectador que se va: cierre limpio del socket (dropSocket lo quita)
      case 'leave':
        spec.ws.close();
        break;
      // cmd, start_game, pause, resume, set_speed, set_settings, leave_room: ignorados
    }
  }

  // ping cooperativo (de jugador o espectador), con rate-limit por participante.
  // Si trae towerType válido (de TOWER_ORDER) lo reenvía como sugerencia de torre.
  private emitPing(id: string, by: string, color: string, msg: Extract<ClientMsg, { type: 'map_ping' }>): void {
    if (!this.game) return;
    const now = Date.now();
    if (now - (this.lastPingAt.get(id) ?? 0) < 600) return; // máx ~1.6/s
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

  maybeCleanup(maxIdleMs: number): void {
    if (this.emptySince !== null && Date.now() - this.emptySince > maxIdleMs) {
      this.stop();
      this.onEmpty(this);
    }
  }
}
