import {
  buildSnap,
  createGame,
  getMap,
  makePlacementContext,
  makeSimContext,
  replayInit as makeReplaySim,
  replayStep as stepReplaySim,
  sanitizeSettings,
  sha256Hex,
  stepGame,
  validateSaveData,
  BALANCE_VERSION,
  GAME_SPEEDS,
  MAX_PLAYERS,
  MULTI_DOOR_MIN,
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
  type SaveData,
  type SaveSlot,
  type SavedLobbyInfo,
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
  ADMIN_TOKEN?: string; // secreto (wrangler secret) para /api/admin/announce
  // Discord Activity (Embedded App): el Client ID es una var pública (wrangler.jsonc
  // vars → /api/discord/config; configurarlo NO exige recompilar el cliente); el
  // Client Secret es un secreto (wrangler secret) y JAMÁS sale al cliente. Ambos
  // opcionales: sin ellos la integración de Discord queda apagada.
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
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
  // llegó a jugador por promoción automática al terminar una partida donde
  // estaba de espectador (ver promoteSpectators). Si nunca marca «Listo», el
  // fallback automático lo regresa solo a espectador (ver demoteIdlePromoted).
  cameFromSpectator?: boolean;
  // issue #12 · lobby de una partida CARGADA: id del SaveSlot que este jugador
  // reclama (por hash de token automático o «Adoptar»). Al reanudar, el jugador
  // adopta ESA identidad (id/nombre/color) de la sim reconstruida.
  claimedSlot?: string;
  // F9b · PUERTA reclamada (índice de ruta del mapa) en el lobby de mapas
  // multi-ruta. Social/decorativa: viaja en lobby_state (LobbyPlayer.door) y en
  // GameInit para pintar el estandarte del color del jugador en su spawn. Se
  // libera sola al salir (el RoomPlayer se elimina del lobby) o al cambiar de mapa.
  door?: number;
}

// Espectador: entra con la partida en curso. Ve la partida y puede guiar (chat
// con prefijo 👁, pings, sugerencias de torre) pero no juega. Al acabar la
// partida se convierte en jugador (ver endGame).
interface Spectator {
  id: string;
  token: string;
  name: string;
  ws: WebSocket;
  // PINEADO por el anfitrión (o por demoteIdlePromoted): a diferencia de un
  // espectador normal (que sí se promueve a jugador al terminar la partida en
  // curso), este NUNCA se promueve solo — se queda en la zona de espectadores
  // hasta que el anfitrión lo traiga de vuelta a mano (move_to_player).
  pinned?: boolean;
}

type JoinResult =
  | { kind: 'player'; player: RoomPlayer }
  | { kind: 'spectator'; spectator: Spectator }
  | { kind: 'error'; msg: string };

const CHAT_MAX = 200;
const MAX_SPECTATORS = 8;
// F9b/F9d · el nº mínimo de rutas para tener «puertas» (reclamo y cierre) ahora
// vive en @td/shared (MULTI_DOOR_MIN): lo comparten sanitizeSettings, este DO y
// el lobby del cliente — una sola fuente de verdad.
// segundos de cuenta regresiva antes de iniciar o reanudar la partida
const COUNTDOWN_SEC = 3;
// código de cierre de socket cuando el anfitrión expulsa a un jugador (el cliente
// lo respeta y NO se reconecta, igual que el 4001 de inactividad)
const KICK_CODE = 4002;
// tiempo de gracia para marcar «Listo» tras ser promovido de espectador a
// jugador; pasado esto, se le regresa solo a espectador automáticamente (ver
// demoteIdlePromoted) en vez de bloquear el lobby para siempre
const SPECTATOR_GRACE_MS = 45_000;

// F6.1 · Cierre por INACTIVIDAD (control de costes): si en 30 min nadie hace
// NADA humano (los pings de keepalive NO cuentan), la sala avisa a los 28 y al
// cumplirse cierra todos los sockets con el código 4001 — el cliente lo respeta
// y NO se reconecta (sin esto, la auto-reconexión revivía la sala al instante).
// Sin sockets, el Durable Object se desaloja solo y deja de facturar duración.
const IDLE_CLOSE_MS = 30 * 60_000;
const IDLE_WARN_MS = IDLE_CLOSE_MS - 2 * 60_000;
const IDLE_CLOSE_CODE = 4001;

// RESILIENCIA DEL BUCLE DE SIM: el tick corre dentro de un setInterval; una
// excepción NO capturada del sim ahí reventaba el callback y podía tumbar el
// Durable Object entero → TODOS perdían la conexión de golpe («la sala se cae de
// la nada», intermitente). El tick ahora va en try/catch. Si un tick falla, se
// registra con contexto (observabilidad → tail de Cloudflare) y se salta; si
// fallan MAX_TICK_ERRORS SEGUIDOS el estado es irrecuperable y se aborta la
// partida con gracia (todos al lobby) en vez de dejar la sala congelada o caída.
const MAX_TICK_ERRORS = 4;

// issue #12 · saneado de identidades venidas de un archivo de guardado (no
// confiable): nombre acotado en longitud y sin caracteres de control; color
// limitado a un patrón hex (evita inyección en style="..."). Igual criterio que
// el saneado de join_room.
function cleanName(s: unknown): string {
  // acota a 16 y descarta caracteres de control (code point < 32 o 127) sin
  // meter bytes de control en el fuente ni depender de escapes frágiles.
  let out = '';
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 32 && c !== 127) out += ch;
    if (out.length >= 16) break;
  }
  return out.trim() || 'Jugador';
}
function safeColor(s: unknown): string {
  return typeof s === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : PLAYER_COLORS[0];
}

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
  // ventana de gracia tras promoteSpectators(): a quien no marque «Listo» a
  // tiempo se le devuelve solo a espectador (ver demoteIdlePromoted)
  private demoteTimer: ReturnType<typeof setTimeout> | null = null;
  // tokens BANEADOS por el anfitrión: no pueden volver a entrar a ESTA sala
  // (el token vive en el storage del navegador; limpiarlo lo evade, pero cubre
  // el caso real: el baneado reintentando con el mismo código)
  private banned = new Set<string>();
  // tokens EXPULSADOS (kick): sí pueden volver, pero solo a la zona de
  // espectadores, pineados (nunca vuelven a jugador salvo que el anfitrión los
  // traiga con move_to_player, que además los perdona — ver restoreToPlayer)
  private kicked = new Set<string>();
  private paused = false;
  private speed = 1;
  // fallos CONSECUTIVOS del tick de sim: se reinicia a 0 en cada tick sano; al
  // llegar a MAX_TICK_ERRORS la partida se aborta con gracia (ver tick/abortGame)
  private tickErrors = 0;
  // ---- grabación de la repetición (replay) de la partida en curso ----
  private replaySeed = 0;
  private replayInit: { mapId: string; mode: RoomSettings['mode']; difficulty: RoomSettings['difficulty']; turbo: boolean; closedDoors: number[]; players: { id: string; name: string; color: string }[] } | null = null;
  private replayLog: ReplayEntry[] = [];
  // issue #12 · partida CARGADA de un guardado, esperando en el lobby de carga.
  // Mientras no-null y sin `game`, la sala está en modo «reanudar guardado».
  private savedGame: SaveData | null = null;
  // tick/oleada finales retenidos tras game_over para poder guardar desde la
  // pantalla de FIN (this.game ya es null pero replayInit/replayLog siguen vivos).
  private finishedTick = 0;
  private finishedWave = 0;
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

    // Discord Activity: reclamo ATÓMICO de la sala determinista de una instancia.
    // Reusa la semántica de /reserve (los Durable Objects serializan requests, así
    // que exactamente UNA de las llamadas concurrentes reserva): la PRIMERA es el
    // host, el resto ven la sala ya reservada/activa y son invitados. Devuelve
    // { host } en vez de 200/409 para que el Worker sepa a quién toca crear la sala
    // (create_room) y a quién unirse (join_room). Sin esta atomicidad, dos jugadores
    // que abren la Activity a la vez crearían dos salas distintas.
    if (url.pathname === '/discord-claim') {
      const claimed = !this.initialized && !this.reserved;
      if (claimed) {
        this.reserved = true;
        this.code = (url.searchParams.get('code') ?? '').toUpperCase();
      }
      return new Response(JSON.stringify({ host: claimed }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // issue #12 · CARGAR partida guardada: el Worker reserva este DO y le manda el
    // SaveData ya validado en el borde (revalidamos aquí, defensa en profundidad).
    // La sala queda en modo «lobby de guardado» (savedGame no-null, sin game) hasta
    // que alguien se una por WS y el anfitrión pulse empezar (fast-forward + reanudar).
    if (url.pathname === '/loadsave') {
      if (this.initialized || this.reserved) return new Response('taken', { status: 409 });
      let save: unknown;
      try {
        save = await request.json();
      } catch {
        return new Response('bad save', { status: 400 });
      }
      const v = validateSaveData(save);
      if (!v.ok) return new Response(v.msg, { status: 400 });
      // el archivo es de origen no confiable: sanear nombres (longitud/control) y
      // colores (patrón hex) igual que hace join_room, antes de que lleguen a los
      // clientes (se inyectan en textContent/style). Los ids NO se tocan: los
      // referencian el log y las tuplas jugador↔slot (romperlos rompería la reconstrucción).
      // Cubre players[], slots[] Y el `player` de las entradas `join` del LOG (un
      // mid-join reconstruido aparece en el marcador con ESE nombre; sin este saneo
      // se saltaba la limpieza y solo lo frenaba el escape del cliente al pintar).
      const clean: SaveData = {
        ...v.save,
        players: v.save.players.map((p) => ({ ...p, name: cleanName(p.name), color: safeColor(p.color) })),
        slots: v.save.slots.map((s) => ({ ...s, name: cleanName(s.name), color: safeColor(s.color) })),
        log: v.save.log.map((e) =>
          e.kind === 'join'
            ? { ...e, player: { ...e.player, name: cleanName(e.player.name), color: safeColor(e.player.color) } }
            : e,
        ),
      };
      this.reserved = true;
      this.initialized = true;
      this.code = (url.searchParams.get('code') ?? '').toUpperCase();
      this.savedGame = clean;
      // conservar el turbo del guardado para que el lobby de carga muestre el ⚡ y la
      // reanudación arranque en modo turbo (sanitizeSettings lo ignora en horda igual).
      // F9d · ídem con las puertas cerradas (una revancha en la misma sala las hereda).
      this.settings = sanitizeSettings({ mapId: clean.mapId, mode: clean.mode, difficulty: clean.difficulty, turbo: clean.turbo, closedDoors: clean.closedDoors });
      return new Response('ok');
    }

    // anuncio administrativo (aviso de despliegue): el Worker ya validó el
    // ADMIN_TOKEN; aquí solo se difunde a todos los conectados de esta sala.
    if (url.pathname === '/announce' && request.method === 'POST') {
      let text = '';
      try {
        const body = (await request.json()) as { text?: string };
        text = String(body.text ?? '').slice(0, 200).trim();
      } catch {
        /* cuerpo inválido → text vacío */
      }
      if (!text) return new Response('bad text', { status: 400 });
      const delivered = this.connectedCount();
      // con autor NO vacío: los mensajes de sistema (from '') solo se pintan en
      // el killfeed in-game, y este aviso debe verse también en el chat del LOBBY
      if (delivered > 0) this.broadcast({ type: 'chat', from: '📢 Aviso', color: '#ffb300', text });
      return new Response(JSON.stringify({ delivered }), {
        headers: { 'content-type': 'application/json' },
      });
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
    // prevToken también: un baneado con sessionStorage limpio aún presenta su
    // respaldo de localStorage — sin esto evadiría el ban sin querer
    if (this.banned.has(token) || (prevToken && this.banned.has(prevToken))) {
      return { kind: 'error', msg: 'El anfitrión te baneó de esta sala' };
    }
    // EXPULSADO (kick, no ban): puede volver, pero SOLO a la zona de espectadores
    // y pineado (no se auto-promueve al terminar la partida). Va antes que los
    // rescates de identidad: un expulsado jamás recupera su puesto de jugador solo.
    if (this.kicked.has(token) || (prevToken && this.kicked.has(prevToken))) {
      const spec = this.spectators.find((s) => s.token === token);
      if (spec) {
        // reconexión del expulsado que ya estaba mirando
        spec.ws.close();
        spec.ws = ws;
        spec.name = (name || spec.name).slice(0, 16);
        this.reviveLoop();
        return { kind: 'spectator', spectator: spec };
      }
      if (this.spectators.length >= MAX_SPECTATORS) {
        return { kind: 'error', msg: 'Hay demasiados espectadores, intenta luego' };
      }
      const spectator: Spectator = {
        id: `s${this.nextSpectatorNum++}`,
        token,
        name: (name || 'Espectador').slice(0, 16),
        ws,
        pinned: true,
      };
      this.spectators.push(spectator);
      this.reviveLoop();
      return { kind: 'spectator', spectator };
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
    if (this.demoteTimer) {
      clearTimeout(this.demoteTimer);
      this.demoteTimer = null;
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
      // F9b · la puerta reclamada solo se anuncia si la lleva Y el mapa la admite
      // (multi-ruta): así el lobby no muestra reclamos de un mapa ya cambiado.
      ...(p.door !== undefined ? { door: p.door } : {}),
    }));
  }

  private lobbySpectators(): { id: string; name: string }[] {
    return this.spectators.map((s) => ({ id: s.id, name: s.name }));
  }

  // ¿están listos TODOS los no-anfitriones conectados? (el anfitrión juega en
  // solitario si no hay nadie más). Bloquea el inicio hasta que el equipo confirme.
  private allReady(): boolean {
    return this.players.filter((p) => p.ws && !p.isHost).every((p) => p.ready);
  }

  private broadcastLobby(): void {
    const saved = this.savedLobbyInfo();
    this.broadcast({
      type: 'lobby_state',
      players: this.lobbyPlayers(),
      spectators: this.lobbySpectators(),
      settings: this.settings,
      inGame: this.game !== null && !this.game.over,
      ...(saved ? { saved } : {}),
    });
    // cualquier cambio de sala (miembros/ajustes/estado) refresca el directorio
    this.reportPublic(true);
  }

  // ---------- lobby de una partida CARGADA (issue #12) ----------

  // Info del guardado para el lobby de carga: mapa/oleada/defensores + qué
  // RoomPlayer reclama cada slot. undefined cuando no hay guardado pendiente.
  private savedLobbyInfo(): SavedLobbyInfo | undefined {
    const save = this.savedGame;
    if (!save || this.game) return undefined;
    const claimBySlot = new Map<string, string>();
    for (const p of this.players) if (p.claimedSlot) claimBySlot.set(p.claimedSlot, p.id);
    return {
      mapId: save.mapId,
      mode: save.mode,
      difficulty: save.difficulty,
      wave: save.wave,
      tick: save.tick,
      slots: save.slots.map((s) => ({
        id: s.id,
        name: s.name,
        color: s.color,
        claimedBy: claimBySlot.get(s.id) ?? null,
      })),
    };
  }

  // Intenta reclamar automáticamente el slot cuyo tokenHash coincide con el token
  // del jugador (recupera su identidad de la partida guardada). Async por sha256.
  private async autoClaim(player: RoomPlayer): Promise<void> {
    const save = this.savedGame;
    if (!save || this.game || player.claimedSlot) return;
    const hash = await sha256Hex(player.token + save.salt);
    // no robar un slot ya reclamado por otro jugador conectado
    const taken = new Set(this.players.filter((p) => p !== player && p.claimedSlot).map((p) => p.claimedSlot));
    const slot = save.slots.find((s) => s.tokenHash && s.tokenHash === hash && !taken.has(s.id));
    // el jugador pudo desconectarse mientras hasheábamos; comprobar que sigue
    if (slot && this.players.includes(player) && !player.claimedSlot) {
      player.claimedSlot = slot.id;
      this.systemMsg(`✅ ${player.name} recuperó su lugar (${slot.name})`);
      this.broadcastLobby();
    }
  }

  // ---------- directorio de salas públicas (F5) ----------

  private directoryStub(): DurableObjectStub | null {
    const ns = this.env.DIRECTORY;
    return ns ? ns.get(ns.idFromName('v1')) : null;
  }

  // Reporta esta sala al directorio (fire-and-forget; jamás bloquea la sala).
  // `force` = cambio de estado real; sin force actúa de LATIDO con throttle de
  // 10 s (lo disparan los pings de keepalive de los clientes y el tick de sim).
  // TODAS las salas con gente conectada laten (también las privadas): el
  // directorio necesita conocerlas para difundir los avisos de despliegue.
  // Solo las públicas con jugadores llevan `listed` y salen en /list.
  private reportPublic(force = false): void {
    if (!this.initialized) return;
    if (!force && Date.now() - this.lastDirReport < 10_000) return;
    const stub = this.directoryStub();
    if (!stub) return;
    const connected = this.players.filter((p) => p.ws).length;
    if (this.connectedCount() === 0) return; // sala sin nadie conectado: no reportar
    this.lastDirReport = Date.now();
    const host = this.players.find((p) => p.isHost) ?? this.players[0];
    const info: PublicRoomInfo & { listed: boolean } = {
      listed: this.settings.public === true && connected > 0,
      code: this.code,
      host: host?.name ?? '',
      mapId: this.settings.mapId,
      mode: this.settings.mode,
      difficulty: this.settings.difficulty,
      players: connected,
      inGame: this.game !== null && !this.game.over,
      wave: this.game && !this.game.over ? this.game.wave : 0,
      turbo: this.settings.turbo === true, // MODO TURBO ⚡: distintivo en la lista de salas públicas
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
    // F9b · adjuntar la puerta reclamada por cada jugador (del RoomPlayer, no de la
    // sim) para que el cliente pinte el estandarte en el spawn de esa ruta. En una
    // partida CARGADA los ids son de slots (sin door); el lookup simplemente no
    // encuentra puerta y no se adjunta nada.
    const doorById = new Map(this.players.map((p) => [p.id, p.door]));
    return {
      mapId: this.game!.mapId,
      mode: this.game!.mode,
      difficulty: this.game!.difficulty,
      turbo: this.game!.turbo, // MODO TURBO ⚡: el cliente pinta el distintivo ⚡ en el HUD
      // F9d · puertas CERRADAS de la partida (de la sim, la fuente normalizada):
      // el renderer pinta esos portales APAGADOS. También sale bien en partidas
      // CARGADAS (la sim reconstruida lleva las del guardado).
      ...(this.game!.closedDoors.length > 0 ? { closedDoors: this.game!.closedDoors } : {}),
      players: this.game!.players.map((p) => {
        const door = doorById.get(p.id);
        return { id: p.id, name: p.name, color: p.color, ...(door !== undefined ? { door } : {}) };
      }),
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
      // MODO TURBO ⚡: ya normalizado por sanitizeSettings (false en horda); createGame
      // lo vuelve a normalizar como defensa
      this.settings.turbo,
      // F9d · puertas cerradas de la sala (createGame las renormaliza como defensa)
      this.settings.closedDoors ?? [],
    );
    this.simCtx = makeSimContext(map, makePlacementContext(map));
    this.pendingCmds = [];
    this.paused = false;
    this.speed = 1;
    // partida NUEVA: sin guardado pendiente
    this.savedGame = null;
    this.finishedTick = 0;
    this.finishedWave = 0;
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    if (this.demoteTimer) {
      clearTimeout(this.demoteTimer);
      this.demoteTimer = null;
    }
    for (const p of this.players) p.cameFromSpectator = false;

    // arrancar la grabación de la repetición: semilla, roster inicial y log vacío
    this.replaySeed = seed;
    this.replayInit = {
      mapId: map.id,
      mode: this.settings.mode,
      difficulty: this.settings.difficulty,
      turbo: this.game.turbo, // el valor YA normalizado por createGame (false en horda)
      closedDoors: this.game.closedDoors, // F9d · el valor YA normalizado (canónico)
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

  // issue #12 · REANUDAR una partida guardada: reconstruye el estado ejecutando el
  // registro de comandos hasta el tick guardado (fast-forward EN TROZOS para no
  // bloquear el event loop del DO ni los pings WS) y arranca el loop en vivo. Los
  // jugadores toman su slot (el reclamado o, si son pendientes, uno libre); el
  // resto queda de espectador. La grabación continúa sobre el log del archivo.
  private async startLoadedGame(): Promise<void> {
    const save = this.savedGame;
    if (!save || this.game) return;

    // 1) fast-forward con el MISMO motor puro del replay, en trozos de 2000 ticks
    const rdata: ReplayData = {
      v: save.v,
      seed: save.seed,
      mapId: save.mapId,
      mode: save.mode,
      difficulty: save.difficulty,
      players: save.players,
      log: save.log,
      finalTick: save.tick,
      victory: false,
      wave: save.wave,
      turbo: save.turbo ?? false, // MODO TURBO ⚡: reconstruir con el mismo turbo del guardado
      // F9d · puertas cerradas del guardado: mismo reparto de spawns al reanudar
      ...(save.closedDoors ? { closedDoors: save.closedDoors } : {}),
    };
    const sim = makeReplaySim(rdata);
    const target = save.tick;
    while (sim.state.tick < target && !sim.state.over) {
      const end = Math.min(target, sim.state.tick + 2000);
      while (sim.state.tick < end && !sim.state.over) stepReplaySim(sim, rdata, sim.state.tick);
      // ceder el event loop entre trozos (deja respirar pings/mensajes WS)
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    // ¿algo cambió mientras reconstruíamos (revancha, otra carga)? abortar sin tocar nada
    if (this.game || this.savedGame !== save) return;

    this.game = sim.state;
    this.simCtx = sim.ctx;

    // 2) continuar la GRABACIÓN: el log del archivo + lo nuevo = historial completo
    this.replaySeed = save.seed;
    // F9d · closedDoors: las CANÓNICAS de la sim reconstruida (createGame ya las
    // renormalizó), no las crudas del archivo — futuros saves/replays heredan bien.
    this.replayInit = { mapId: save.mapId, mode: save.mode, difficulty: save.difficulty, turbo: save.turbo ?? false, closedDoors: sim.state.closedDoors, players: save.players };
    this.replayLog = save.log.slice();

    // 3) identidades: cada jugador conectado toma su slot reclamado o, si es
    //    pendiente, el primer slot libre. Los que no quepan pasan a espectadores.
    const claimedIds = new Set(this.players.filter((p) => p.claimedSlot).map((p) => p.claimedSlot!));
    const freeSlots = save.slots.filter((s) => !claimedIds.has(s.id)).map((s) => s.id);
    const gamePlayers: RoomPlayer[] = [];
    const newSpectators: Spectator[] = [];
    for (const p of this.players) {
      const slotId = p.claimedSlot ?? freeSlots.shift();
      if (slotId) {
        const slot = save.slots.find((s) => s.id === slotId)!;
        p.id = slot.id; // adopta la identidad de la sim (controla sus torres)
        p.name = slot.name;
        p.color = slot.color;
        p.claimedSlot = undefined;
        gamePlayers.push(p);
      } else if (p.ws) {
        // sin slot libre: entra de espectador (la partida ya tiene sus defensores)
        newSpectators.push({ id: `s${this.nextSpectatorNum++}`, token: p.token, name: p.name, ws: p.ws });
      }
    }
    // el anfitrión debe seguir siendo jugador; si quedó fuera, ceder al primero
    if (gamePlayers.length > 0 && !gamePlayers.some((p) => p.isHost)) {
      for (const p of gamePlayers) p.isHost = false;
      gamePlayers[0].isHost = true;
    }
    this.players = gamePlayers;
    this.spectators.push(...newSpectators);

    // 4) conexión de cada jugador de la sim = ¿hay jugador con ESE id y socket?
    //    Registrar el delta como `conn` en el tick del guardado para que un futuro
    //    guardado/replay de la partida reanudada reproduzca el mismo escalado.
    for (const gp of this.game.players) {
      const connected = this.players.some((p) => p.id === gp.id && p.ws);
      if (gp.connected !== connected) {
        gp.connected = connected;
        this.replayLog.push({ t: this.game.tick, kind: 'conn', playerId: gp.id, connected });
      }
    }

    this.savedGame = null;
    this.pendingCmds = [];
    this.paused = false;
    this.speed = 1;

    // 5) avisar a jugadores (su id cambió al del slot) y espectadores, y arrancar
    for (const p of this.players) {
      this.send(p, { type: 'room_joined', code: this.code, playerId: p.id, isHost: p.isHost });
      this.send(p, { type: 'game_started', init: this.gameInit(p.id) });
    }
    for (const s of this.spectators) {
      this.sendTo(s.ws, { type: 'room_joined', code: this.code, playerId: s.id, isHost: false, spectator: true });
      this.sendGameStateToSpectator(s);
    }
    // un guardado tomado en la pantalla de FIN reconstruye una partida YA terminada:
    // no hay nada que reanudar (el loop nunca la volvería a cerrar) → mostrar el fin.
    if (this.game.over) {
      this.endGame();
    } else {
      this.reviveLoop(true);
      this.systemMsg(`▶ Partida reanudada desde la oleada ${this.game.wave}`);
    }
    this.reportPublic(true);
  }

  // issue #12 · GUARDAR: construye el SaveData y lo envía al que lo pidió. Toma una
  // FOTO síncrona del tick + log (evita capturar entradas de ticks posteriores si
  // llega un tick durante los await de sha256) y luego hashea los tokens con la sal.
  private async handleSaveRequest(ws: WebSocket, saltRaw: string): Promise<void> {
    const salt = String(saltRaw ?? '')
      .replace(/[^a-f0-9]/gi, '')
      .slice(0, 128);
    if (!salt) {
      this.sendTo(ws, { type: 'error', msg: 'No se pudo guardar (sal inválida)' });
      return;
    }
    if (!this.replayInit) {
      this.sendTo(ws, { type: 'error', msg: 'No hay partida para guardar todavía' });
      return;
    }
    const active = this.game !== null && !this.game.over;
    const tick = active ? this.game!.tick : this.finishedTick;
    const wave = active ? this.game!.wave : this.finishedWave;
    if (!active && this.finishedTick === 0) {
      this.sendTo(ws, { type: 'error', msg: 'No hay partida para guardar' });
      return;
    }
    // foto síncrona ANTES de cualquier await
    const roster = this.replayInit.players.slice();
    const logSnapshot = this.replayLog.slice();
    const tokenById = new Map(this.players.map((p) => [p.id, p.token]));
    const init = this.replayInit;
    const seed = this.replaySeed;

    const slots: SaveSlot[] = [];
    for (const rp of roster) {
      const token = tokenById.get(rp.id);
      const tokenHash = token ? await sha256Hex(token + salt) : '';
      slots.push({ id: rp.id, name: rp.name, color: rp.color, tokenHash });
    }
    const save: SaveData = {
      kind: 'fortaleza-save',
      v: BALANCE_VERSION,
      seed,
      mapId: init.mapId,
      mode: init.mode,
      difficulty: init.difficulty,
      players: roster,
      log: logSnapshot,
      tick,
      wave,
      salt,
      slots,
      turbo: init.turbo, // MODO TURBO ⚡: el guardado conserva el turbo para reanudar igual
      // F9d · puertas cerradas: el guardado las conserva para reanudar con el
      // mismo reparto de spawns (solo si hay — formato estable para saves viejos)
      ...(init.closedDoors.length > 0 ? { closedDoors: init.closedDoors } : {}),
    };
    this.sendTo(ws, { type: 'save_info', save });
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
    // eterna con la pestaña abierta era justo el caso que facturaba sin fin).
    // Fuera del try de la sim: es su propia preocupación y NUNCA debe saltarse.
    try {
      this.checkIdle();
    } catch (err) {
      console.error('[room] checkIdle lanzó', err);
    }
    if (!this.game || !this.simCtx || this.paused) return;

    // TODA la simulación va en try/catch: sin esto, una excepción del sim en el
    // setInterval tumbaba el Durable Object y desconectaba a toda la sala.
    try {
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
      this.tickErrors = 0; // el tick salió limpio: se reinicia la racha de fallos
    } catch (err) {
      this.tickErrors++;
      // registro con CONTEXTO para dar con la causa raíz desde el tail de
      // Cloudflare (el bug es raro → necesitamos el estado exacto que lo dispara)
      const g = this.game;
      console.error(
        `[room] EXCEPCIÓN en tick — mapa ${g?.mapId} modo ${g?.mode} oleada ${g?.wave} ` +
          `tick ${g?.tick} enemigos ${g?.enemies.length} turbo ${g?.turbo} ` +
          `puertas-cerradas [${g?.closedDoors.join(',')}] fallo ${this.tickErrors}/${MAX_TICK_ERRORS}`,
        err,
      );
      // varios fallos seguidos = estado corrupto que volverá a lanzar cada tick:
      // abortar con gracia (todos al lobby) en vez de dejar la sala congelada.
      if (this.tickErrors >= MAX_TICK_ERRORS) this.abortGame();
    }
  }

  // Aborta la partida por fallo irrecuperable del bucle de sim: detiene el bucle y
  // devuelve a TODOS al lobby con un aviso, en vez de dejar la sala congelada o
  // que la excepción tumbe el Durable Object. NO puntúa ni graba replay: el estado
  // puede estar corrupto y volvería a lanzar. Todo defensivo (try por si el propio
  // estado corrupto lanza al leerlo).
  private abortGame(): void {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    this.paused = false;
    this.tickErrors = 0;
    // stats mínimos y válidos, leídos a la defensiva: si `this.game` está corrupto
    // y lanza, caemos al esqueleto vacío. game_over lo entienden todos los clientes
    // (viejos y nuevos), así que devuelve al lobby sin cambiar el protocolo.
    let stats: EndStats;
    try {
      const g = this.game!;
      stats = {
        victory: false,
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
    } catch {
      stats = { victory: false, wave: this.finishedWave, totalWaves: 0, mapId: '', mode: 'classic', difficulty: 'normal', players: [] };
    }
    this.game = null;
    this.simCtx = null;
    try {
      this.broadcast({ type: 'chat', from: '⚠️', color: '#ef5350', text: 'La partida sufrió un error y tuvo que detenerse. Vuelven al lobby.' });
      this.broadcast({ type: 'game_over', stats });
    } catch (e) {
      console.error('[room] abortGame broadcast', e);
    }
    for (const p of this.players) p.ready = p.isHost;
    this.promoteSpectators();
    this.broadcastLobby();
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
      turbo: g.turbo, // MODO TURBO ⚡: el replay tiene que reconstruir con el mismo turbo
      // F9d · puertas cerradas: mismo motivo (cambian spawns/densidad). Solo si hay.
      ...(g.closedDoors.length > 0 ? { closedDoors: g.closedDoors } : {}),
    };
  }

  private endGame(): void {
    if (!this.game) return;
    const g = this.game;
    const replay = this.buildReplay(g);
    // retener tick/oleada finales: permiten guardar desde la pantalla de FIN
    // (this.game pasará a null pero replayInit/replayLog siguen vivos hasta la revancha)
    this.finishedTick = g.tick;
    this.finishedWave = g.wave;
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
    // récords: endless (Infinito) y horde (Horda) puntúan por oleada alcanzada.
    // Una partida REANUDADA de un guardado SÍ puntúa: guardar y retomar es una
    // feature, no un descalificador — si partes de un guardado y empujas hasta la
    // oleada 70, es un logro real. El riesgo de duplicados (recargar el MISMO
    // guardado varias veces y reenviar la misma marca) lo corta el dedup de
    // saveScore (misma gente + oleada + modo/dificultad/mapa = una sola entrada).
    // MODO TURBO ⚡: las partidas turbo NO puntúan — su economía comprimida da más
    // oro con el mismo reto, así que compararlas con las normales sería injusto
    // (irían a una tabla aparte; en v1, sencillamente no envían récord).
    if (!g.turbo && (g.mode === 'endless' || g.mode === 'horde')) {
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
  // espectadores. Quien solo quería mirar y no marca «Listo» a tiempo vuelve
  // solo a espectador automáticamente (ver demoteIdlePromoted) en vez de quedar
  // atascado bloqueando el inicio de la revancha.
  private promoteSpectators(): void {
    if (this.spectators.length === 0) return;
    const stayed: Spectator[] = [];
    let promotedAny = false;
    for (const spec of this.spectators) {
      // pineado por el anfitrión (o por el fallback de inactividad): se queda
      // de espectador para siempre, hasta que lo traigan de vuelta a mano
      if (spec.pinned) {
        stayed.push(spec);
        continue;
      }
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
        cameFromSpectator: !isHost,
      };
      this.players.push(player);
      promotedAny = promotedAny || !isHost;
      // avísale que ya es jugador (actualiza spectator/isHost en el cliente)
      this.send(player, { type: 'room_joined', code: this.code, playerId: player.id, isHost: player.isHost, spectator: false });
    }
    this.spectators = stayed;
    if (promotedAny) {
      if (this.demoteTimer) clearTimeout(this.demoteTimer);
      this.demoteTimer = setTimeout(() => {
        this.demoteTimer = null;
        this.demoteIdlePromoted();
      }, SPECTATOR_GRACE_MS);
    }
  }

  // pasado el tiempo de gracia, a quien fue promovido de espectador y sigue sin
  // marcar «Listo» se le regresa solo a espectador (no banea, no lo saca de la
  // sala): así deja de bloquear el «todos listos» para el resto del equipo.
  private demoteIdlePromoted(): void {
    if (this.game) return; // ya empezó otra partida: ya no aplica
    const idle = this.players.filter((p) => p.cameFromSpectator && !p.ready);
    for (const p of idle) {
      this.demoteToSpectator(p, `${p.name} pasó a la zona de espectadores (no marcó «Listo»)`);
    }
    if (idle.length > 0) this.broadcastLobby();
  }

  // Mueve a un jugador del lobby a la lista de espectadores SIN banearlo (a
  // diferencia de kick_player). Conserva id/token/nombre para que el cliente se
  // reconozca. Usado por la acción manual del anfitrión y por demoteIdlePromoted.
  private demoteToSpectator(target: RoomPlayer, announce: string): void {
    this.players = this.players.filter((p) => p !== target);
    if (target.isHost) {
      const next = this.players.find((p) => p.ws);
      if (next) {
        next.isHost = true;
        next.ready = true;
      }
    }
    const ws = target.ws;
    if (!ws) return; // desconectado: no hay socket que reclasificar
    const spectator: Spectator = {
      id: target.id,
      token: target.token,
      name: target.name,
      ws,
      pinned: true,
    };
    this.spectators.push(spectator);
    this.systemMsg(announce);
    this.sendTo(ws, { type: 'room_joined', code: this.code, playerId: spectator.id, isHost: false, spectator: true });
    this.sendGameStateToSpectator(spectator);
  }

  // El anfitrión trae de vuelta a un espectador (pineado o no) como jugador del
  // lobby. Falla en silencio si la sala está llena o no hay partida en el lobby.
  // Sin fallback de gracia: si el restaurado nunca marca «Listo», el anfitrión
  // puede volver a moverlo a espectadores a mano (fue su decisión traerlo).
  private restoreToPlayer(spectator: Spectator): void {
    this.spectators = this.spectators.filter((s) => s !== spectator);
    this.kicked.delete(spectator.token); // traerlo de vuelta lo perdona del kick
    const isHost = this.players.length === 0;
    const player: RoomPlayer = {
      id: spectator.id,
      token: spectator.token,
      name: spectator.name,
      color: PLAYER_COLORS[this.players.length % PLAYER_COLORS.length],
      ws: spectator.ws,
      isHost,
      ready: isHost,
    };
    this.players.push(player);
    this.systemMsg(`${player.name} volvió a la sala como jugador`);
    this.send(player, { type: 'room_joined', code: this.code, playerId: player.id, isHost: player.isHost, spectator: false });
    this.sendGameStateTo(player);
    // issue #12 · lobby de un guardado: al volver a jugador se perdió su reclamo
    // (vivía en el RoomPlayer anterior) — reintentar el auto-reclamo por token
    void this.autoClaim(player);
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
      // lobby de un guardado: intentar recuperar su slot por hash de token (async)
      void this.autoClaim(player);
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
        if (this.game) break;
        // F9d · rechazo EXPLÍCITO al no-anfitrión (antes se ignoraba en silencio):
        // con las puertas cerrables los ajustes ganaron poder de sala y un cliente
        // manipulado debe recibir un no claro, no un lobby que «no reacciona».
        if (!player.isHost) {
          this.send(player, { type: 'error', msg: 'Solo el anfitrión puede cambiar los ajustes' });
          break;
        }
        const wasPublic = this.settings.public === true;
        const prevMapId = this.settings.mapId;
        const next = sanitizeSettings(msg.settings);
        // F9d · NO se puede cerrar una puerta RECLAMADA por un jugador: rechazo
        // con mensaje claro y SIN aplicar nada (el anfitrión debe pedirle que la
        // libere, o el jugador soltarla — la coordinación es social, no forzada).
        // Solo aplica si el mapa no cambió (al cambiar, reclamos y cierres se
        // limpian juntos más abajo, así que no hay conflicto posible).
        if (next.mapId === prevMapId && next.closedDoors && next.closedDoors.length > 0) {
          const conflict = this.players.find(
            (p) => p.door !== undefined && next.closedDoors!.includes(p.door),
          );
          if (conflict) {
            this.send(player, {
              type: 'error',
              msg: `No puedes cerrar la puerta ${conflict.door! + 1}: la reclamó ${conflict.name}`,
            });
            break;
          }
        }
        this.settings = next;
        // pública → privada: salir de la lista al instante (no esperar la poda)
        if (wasPublic && !this.settings.public) this.unlistPublic();
        // F9b · cambiar de MAPA invalida los reclamos de puerta (los índices de
        // ruta ya no corresponden): liberarlos todos para no arrastrar reclamos
        // fantasma de un mapa a otro con distinto nº de rutas.
        // F9d · y lo MISMO con los cierres: el cliente manda los ajustes enteros
        // (con los cierres del mapa anterior a cuestas) — se descartan aquí.
        if (prevMapId !== this.settings.mapId) {
          for (const p of this.players) p.door = undefined;
          delete this.settings.closedDoors;
        }
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
        this.systemMsg(`${target.name} fue expulsado por el anfitrión (puede volver como espectador)`);
        this.players = this.players.filter((p) => p !== target);
        this.kicked.add(target.token); // expulsado = si vuelve, solo de espectador (ver addPlayer)
        try {
          target.ws?.close(KICK_CODE, 'kicked');
        } catch {
          // ignore
        }
        this.broadcastLobby();
        break;
      }

      // BANEAR: como expulsar, pero el token ya no puede volver a entrar de
      // ninguna forma. Funciona sobre jugadores Y sobre espectadores (un troll
      // en la zona de espectadores también se banea desde ahí).
      case 'ban_player': {
        if (!player.isHost) {
          this.send(player, { type: 'error', msg: 'Solo el anfitrión puede banear' });
          break;
        }
        if (this.game && !this.game.over) break; // banear solo en el lobby
        const target = this.players.find((p) => p.id === msg.playerId);
        if (target && target.id !== player.id) {
          this.systemMsg(`${target.name} fue baneado por el anfitrión`);
          this.players = this.players.filter((p) => p !== target);
          this.banned.add(target.token);
          try {
            target.ws?.close(KICK_CODE, 'banned');
          } catch {
            // ignore
          }
          this.broadcastLobby();
          break;
        }
        const spec = this.spectators.find((s) => s.id === msg.playerId);
        if (spec) {
          this.systemMsg(`${spec.name} fue baneado por el anfitrión`);
          this.spectators = this.spectators.filter((s) => s !== spec);
          this.banned.add(spec.token);
          try {
            spec.ws.close(KICK_CODE, 'banned');
          } catch {
            // ignore
          }
          this.broadcastLobby();
        }
        break;
      }

      case 'move_to_spectator': {
        if (!player.isHost) {
          this.send(player, { type: 'error', msg: 'Solo el anfitrión puede mover a espectadores' });
          break;
        }
        if (this.game && !this.game.over) break; // solo en el lobby
        const target = this.players.find((p) => p.id === msg.playerId);
        if (!target || target.id === player.id) break;
        // sin socket no hay a quién reclasificar: demoteToSpectator lo dejaría
        // FUERA de la sala en silencio (ni jugador ni espectador). Rechazar.
        if (!target.ws) {
          this.send(player, { type: 'error', msg: `${target.name} está desconectado` });
          break;
        }
        this.demoteToSpectator(target, `${target.name} pasó a la zona de espectadores`);
        this.broadcastLobby();
        break;
      }

      case 'move_to_player': {
        if (!player.isHost) {
          this.send(player, { type: 'error', msg: 'Solo el anfitrión puede traer jugadores' });
          break;
        }
        if (this.game && !this.game.over) break; // solo en el lobby
        const spectator = this.spectators.find((s) => s.id === msg.spectatorId);
        if (!spectator) break;
        if (this.players.filter((p) => p.ws).length >= MAX_PLAYERS) {
          this.send(player, { type: 'error', msg: 'La sala está llena' });
          break;
        }
        this.restoreToPlayer(spectator);
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

      // F9b · RECLAMAR/LIBERAR una puerta (selección de puerta por color). Estado de
      // lobby, no comando de sim. Cada jugador reclama la SUYA (el anfitrión no la
      // fuerza): la petición solo toca el RoomPlayer del emisor. Validaciones: solo
      // en el lobby, solo en mapas multi-ruta, índice de ruta existente y NO ocupado
      // por otro. door=null libera. Se libera sola al salir (el RoomPlayer se quita).
      case 'claim_door': {
        if (this.game && !this.game.over) break; // solo en el lobby
        if (this.savedGame) break; // el lobby de un guardado usa slots, no puertas
        const door = msg.door;
        if (door === null) {
          // liberar la puerta propia (idempotente)
          if (player.door !== undefined) {
            player.door = undefined;
            this.broadcastLobby();
          }
          break;
        }
        const map = getMap(this.settings.mapId);
        if (map.paths.length < MULTI_DOOR_MIN) {
          this.send(player, { type: 'error', msg: 'Este mapa no tiene puertas que reclamar' });
          break;
        }
        if (!Number.isInteger(door) || door < 0 || door >= map.paths.length) break; // índice inválido
        if (player.door === door) break; // ya es la suya: nada que hacer
        // F9d · no reclamar una puerta CERRADA por el anfitrión (por ahí no
        // saldrán monstruos: reclamarla sería un estandarte sobre una reja)
        if (this.settings.closedDoors?.includes(door)) {
          this.send(player, { type: 'error', msg: 'Esa puerta está cerrada' });
          break;
        }
        // no reclamar una puerta que otro jugador ya tiene
        if (this.players.some((p) => p !== player && p.door === door)) {
          this.send(player, { type: 'error', msg: 'Esa puerta ya está reclamada' });
          break;
        }
        player.door = door;
        this.broadcastLobby();
        break;
      }

      case 'start_game':
        if (!player.isHost) {
          this.send(player, { type: 'error', msg: 'Solo el anfitrión puede iniciar' });
          break;
        }
        if (this.game && !this.game.over) break;
        if (this.startTimer) break; // ya en cuenta atrás
        // REANUDAR un guardado: sin gate de «Listo» (el anfitrión decide). Al llegar
        // a 0, reconstruye la sim (fast-forward) y arranca en vivo desde el guardado.
        if (this.savedGame) {
          this.broadcast({ type: 'countdown', kind: 'start', seconds: COUNTDOWN_SEC });
          this.startTimer = setTimeout(() => {
            this.startTimer = null;
            if (this.players.some((p) => p.ws)) void this.startLoadedGame();
          }, COUNTDOWN_SEC * 1000);
          break;
        }
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

      // issue #12 · CARGAR: adoptar un slot libre del guardado (identidad de la
      // partida). Solo en el lobby de carga (savedGame y sin partida).
      case 'claim_slot': {
        const save = this.savedGame;
        if (!save || this.game) break;
        const slot = save.slots.find((s) => s.id === msg.slot);
        if (!slot) break;
        const taken = this.players.some((p) => p !== player && p.claimedSlot === slot.id);
        if (taken) {
          this.send(player, { type: 'error', msg: 'Ese lugar ya está ocupado' });
          break;
        }
        player.claimedSlot = slot.id;
        this.broadcastLobby();
        break;
      }

      // issue #12 · GUARDAR: construir el guardado con la sal del cliente (hashea los
      // tokens server-side) y devolverlo. Async por sha256.
      case 'save_request':
        void this.handleSaveRequest(ws, msg.salt);
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
        // también late al directorio: una sala en LOBBY con solo espectadores
        // no tiene ni tick de sim ni pings de jugador que la mantengan viva
        // en el registro de anuncios
        this.reportPublic();
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
