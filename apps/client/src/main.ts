import './style.css';
import { ENEMIES, ENEMY_ORDER, FUSIONS, GAME_SPEEDS, START_LIVES, TOWERS, type GameEvent, type Snap } from '@td/shared';
import { net, wsPathJoin } from './net.js';
import { pushFrame, roomPrevToken, saveName, saveRoomToken, seedRoomPrevToken, startGameStore, store } from './store.js';
import { addPing, addShake, initRenderer, isMinimapOn, resetRenderer, toggleMinimap, towerFired } from './renderer.js';
import { initInput } from './input.js';
import { initBestiary } from './bestiary.js';
import { applySpectatorUI, buildTowerBar, hidePanel, initMarket, initScoreboard, initShop, onTick, toast, addChat, refreshPanel, syncSpeedButton, syncTowerBar, toggleSpectatorTowers } from './hud.js';
import { hideEnd, homeError, initHome, initLobby, renderLobby, showEnd, switchScreen } from './screens.js';
import { beam, burst, clearParticles, floatText, fx, line, ring } from './particles.js';
import { sfx, setSfxVolume, setMusicVolume, unlockAudio } from './audio.js';
import { startMusic, setMusicState, pauseMusic, resumeMusic, stopMusic, type MusicState } from './music.js';
import { initReplayHome, saveReplay, setReplayEventSink, startReplay } from './replay.js';
import type { ReplayData } from '@td/shared';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// la repetición de la partida que acaba de terminar (para "🎬 Ver repetición")
let lastReplay: ReplayData | null = null;

// ---------- cuenta regresiva (inicio de partida / reanudación) ----------
// El servidor manda `countdown` con los segundos; el cliente los muestra en
// grande N..1. El arranque/reanudación real lo dispara el servidor al llegar a 0
// (game_started / resumed), que además ocultan el overlay por si hubiera desfase.
let countdownTimer: ReturnType<typeof setInterval> | null = null;

function hideCountdown(): void {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  $('overlay-countdown').hidden = true;
}

function showCountdown(kind: 'start' | 'resume', seconds: number): void {
  const overlay = $('overlay-countdown');
  const num = $('countdown-num');
  $('countdown-label').textContent = kind === 'start' ? '¡La partida empieza en…!' : '¡Reanudando en…!';
  // reanudación: el overlay tapa el botón de pausa, así que ofrece cancelar aquí
  // mismo (manda `pause`, que en el servidor aborta la reanudación en curso)
  $('countdown-cancel').hidden = kind !== 'resume' || store.spectator;
  overlay.hidden = false;
  let n = Math.max(1, Math.round(seconds));
  const tick = () => {
    num.textContent = String(n);
    // reinicia la animación de "pop" en cada número
    num.classList.remove('pop');
    void num.offsetWidth;
    num.classList.add('pop');
    sfx.ping(0);
  };
  tick();
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    n -= 1;
    if (n <= 0) {
      hideCountdown();
      return;
    }
    tick();
  }, 1000);
}

// ---------- procesado de eventos de la simulación ----------

function processEvents(events: GameEvent[]): void {
  const gs = store.game;
  if (!gs) return;
  const myColor = gs.init.players.find((p) => p.id === store.playerId)?.color ?? '#fff';
  // pan estéreo por posición: la x de la celda -> [-1 izq, +1 der] según el ancho.
  const gw = gs.map.gridW;
  const panOf = (x: number): number => Math.max(-1, Math.min(1, (x / gw) * 2 - 1));

  for (const ev of events) {
    switch (ev.e) {
      case 'shot':
        line(ev.x, ev.y, ev.tx, ev.ty, ev.color);
        fx(ev.tx, ev.ty, 'spark', ev.color, 0.7, 0.25, { add: true }); // fogonazo en el blanco
        towerFired(ev.x, ev.y);
        sfx.snipe(panOf(ev.x), ev.color);
        break;
      case 'chain':
        beam(ev.pts, ev.color);
        for (const [px, py] of ev.pts) fx(px, py, 'spark', '#fff59d', 0.55, 0.2, { add: true });
        towerFired(ev.pts[0][0], ev.pts[0][1]);
        sfx.zap(panOf(ev.pts[0][0]));
        break;
      case 'hit':
        if (ev.kind === 'splash') {
          ring(ev.x, ev.y, ev.r, '#ffab40');
          fx(ev.x, ev.y, 'flame', '#ffab40', ev.r * 0.9, 0.35, { add: true });
          fx(ev.x, ev.y, 'smoke', '#b0a89a', ev.r * 0.8, 0.7, { grow: 1.3, add: false, spin: 0.6 });
          fx(ev.x, ev.y, 'spark', '#ff7043', ev.r * 0.7, 0.28, { add: true });
          if (ev.r >= 1.2) addShake(2.5);
          sfx.boom(panOf(ev.x));
        } else if (ev.kind === 'poison') {
          fx(ev.x, ev.y, 'glow', '#9ccc65', 0.55, 0.4, { add: true });
        } else if (ev.kind === 'frost') {
          fx(ev.x, ev.y, 'sparkle', '#81d4fa', 0.55, 0.35, { add: true, spin: 2 });
        } else {
          fx(ev.x, ev.y, 'spark', '#ffe082', 0.5, 0.25, { add: true });
          sfx.shot(panOf(ev.x));
        }
        break;
      case 'death': {
        const def = ENEMIES[ev.type];
        const big = def.boss || ev.elite;
        const pan = panOf(ev.x);
        burst(ev.x, ev.y, def.color, def.boss ? 24 : ev.elite ? 14 : 7, big ? 3.5 : 2.2);
        ring(ev.x, ev.y, def.boss ? 1.6 : ev.elite ? 1.1 : def.radius * 2.2, def.color);
        fx(ev.x, ev.y, 'glow', def.color, big ? 2.0 : 1.0, 0.4, { add: true });
        if (big) for (let k = 0; k < (def.boss ? 8 : 4); k++)
          fx(ev.x, ev.y, 'spark', '#fff', 0.6, 0.4, { vx: (Math.random() - 0.5) * 4, vy: (Math.random() - 0.5) * 4, add: true });
        if (def.boss) addShake(10);
        else if (ev.elite) addShake(3);
        if (ev.bounty > 0) {
          const killerColor =
            gs.init.players.find((p) => p.id === ev.killer)?.color ?? '#ffd54f';
          // botín aumentado por un Alquimista: en verde y con ⚗, que se note
          const boosted = (ev.alch ?? 0) > 0;
          floatText(
            ev.x,
            ev.y - 0.3,
            boosted ? `+${ev.bounty} ⚗` : `+${ev.bounty}`,
            boosted ? '#81c784' : killerColor,
            boosted ? 14 : ev.elite ? 15 : 13,
          );
        }
        // firma de muerte según jerarquía: jefe (percusión) > élite (sting) > resto.
        if (def.boss) sfx.bossDeath(pan);
        else if (ev.elite) sfx.eliteDeath(pan);
        else sfx.death(pan);
        break;
      }
      case 'shred':
        // proc de shred de armadura (Obús/Metralla II): anillo naranja + chispas
        ring(ev.x, ev.y, ev.r, '#ff9800');
        burst(ev.x, ev.y, '#ffcc80', 6, 1.6);
        break;
      case 'miss':
        floatText(ev.x, ev.y - 0.2, '¡esquivó!', '#e0e0e0', 11);
        break;
      case 'leak':
        toast(`💔 ¡Se escapó un ${ENEMIES[ev.type].name}! Quedan ${ev.lives} vidas`);
        addShake(4);
        sfx.leak();
        break;
      case 'steal':
        toast(`🪙 ¡El Ladrón te robó ${ev.gold} de oro!`);
        floatText(ev.x, ev.y - 0.3, `-🪙${ev.gold}`, '#ef5350', 14);
        addShake(3);
        sfx.leak();
        break;
      case 'wave_start':
        toast(`⚔️ ¡Oleada ${ev.wave}!`, 'info');
        sfx.wave();
        break;
      case 'wave_end':
        toast(`✅ Oleada ${ev.wave} superada · +🪙${ev.bonus} para todos`, 'info');
        sfx.coin();
        break;
      case 'income':
        floatText(ev.x, ev.y - 0.4, `+🪙${ev.amount}`, '#ffd54f', 13);
        // el ingreso de la mina es de oleada (sin foco espacial): pan neutro.
        sfx.coin();
        break;
      case 'assist': {
        // ORO DE ASISTENCIA (co-op): texto discreto en el color del asistente. La
        // moneda SOLO suena si el asistente eres TÚ (no ensuciar el audio ajeno).
        const acolor = gs.init.players.find((p) => p.id === ev.player)?.color ?? '#ffd54f';
        floatText(ev.x, ev.y - 0.15, `+${ev.gold} 🤝`, acolor, 12);
        if (ev.player === store.playerId) sfx.coin();
        break;
      }
      case 'orc':
        if (ev.playerId === store.playerId) {
          toast(`🪓 ¡Orco leñador nivel ${ev.level}! Ahora tala +${ev.rate}🪵/s`, 'info');
          sfx.upgrade(0);
        }
        break;
      case 'trade':
        // solo la operación PROPIA hace ruido (las ajenas ya mueven el precio del panel)
        if (ev.playerId === store.playerId) {
          toast(
            ev.buy
              ? `🪵 +${ev.wood} por 🪙${ev.gold} · el precio sube a ${ev.price.toFixed(2)}`
              : `🪵 −${ev.wood} → +🪙${ev.gold} · el precio baja a ${ev.price.toFixed(2)}`,
            'info',
          );
          sfx.coin();
        }
        break;
      case 'give': {
        // F7.1 · regalo de recursos: toast al EMISOR y al RECEPTOR (los nombres van
        // por textContent → sin riesgo de XSS), y una línea de killfeed para todos.
        const fromName = gs.init.players.find((p) => p.id === ev.from)?.name ?? '?';
        const toName = gs.init.players.find((p) => p.id === ev.to)?.name ?? '?';
        const amount = [ev.gold > 0 ? `🪙${ev.gold}` : '', ev.wood > 0 ? `🪵${ev.wood}` : '']
          .filter(Boolean)
          .join(' ');
        if (ev.to === store.playerId) {
          toast(`🎁 ${fromName} te envió ${amount}`, 'info');
          sfx.coin();
        } else if (ev.from === store.playerId) {
          toast(`🎁 Enviaste ${amount} a ${toName}`, 'info');
          sfx.coin();
        }
        addChat('', '#9e9e9e', `🎁 ${fromName} envió ${amount} a ${toName}`);
        break;
      }
      case 'place':
        burst(ev.x, ev.y, TOWERS[ev.towerType].color, 8, 1.8);
        sfx.place(panOf(ev.x));
        break;
      case 'upgrade':
        ring(ev.x, ev.y, 0.7, '#ffd54f');
        sfx.upgrade(panOf(ev.x));
        break;
      case 'specialize':
        ring(ev.x, ev.y, 1.3, '#ffd54f');
        ring(ev.x, ev.y, 0.9, TOWERS[ev.towerType].color);
        burst(ev.x, ev.y, '#ffd54f', 18, 2.8);
        addShake(3);
        floatText(ev.x, ev.y - 0.6, `★ ${ev.name}`, '#ffd54f', 15);
        sfx.specialize(panOf(ev.x));
        break;
      case 'fuse': {
        // F4.3 · fusión: doble anillo (color de la receta + arcano) + estallido
        const fdef = FUSIONS[ev.fusion];
        const fcolor = fdef?.color ?? '#ce93d8';
        ring(ev.x, ev.y, 1.5, fcolor);
        ring(ev.x, ev.y, 1.0, '#ce93d8');
        burst(ev.x, ev.y, fcolor, 24, 3.2);
        addShake(4);
        floatText(ev.x, ev.y - 0.6, `⚗ ${ev.name}`, fcolor, 16);
        toast(`⚗ ¡Fusión: ${ev.name}!`, 'info');
        sfx.specialize(panOf(ev.x));
        break;
      }
      case 'sell':
        if (ev.refund > 0) {
          floatText(ev.x, ev.y, `+🪙${ev.refund}`, '#ffd54f', 13);
          sfx.sell(panOf(ev.x));
        } else {
          // objeto sin reembolso (p. ej. una Trampa de púas agotada): poof discreto,
          // sin texto de oro ni sonido de caja, para no spamear con muchas trampas.
          burst(ev.x, ev.y, '#b0bec5', 8, 1.8);
        }
        break;
      case 'reject':
        if (ev.playerId === store.playerId) {
          toast(ev.reason);
          sfx.error();
        }
        break;
      case 'boss':
        toast(`🗿 ¡${ev.name} se acerca!`);
        addShake(6);
        sfx.boss();
        break;
      case 'gameover':
        if (ev.victory) sfx.victory();
        else sfx.defeat();
        break;
      case 'sys':
        addChat('', '#9e9e9e', ev.msg);
        break;
    }
  }
  void myColor;
}

// ---------- música adaptativa (F3.1) ----------
// Traduce el estado del juego (snapshot + modo) a la capa musical:
//   · interludio (no oleada) → calma;
//   · oleada en curso → combate; si hay un JEFE en pantalla → capa de jefe;
//   · vidas ≤ 25% de START_LIVES → overlay de tensión disonante;
//   · modo horda → energía sostenida (bandera `horde`).
// El flag de jefe del enemigo va en SnapEnemy[5] (bit 4). Ver protocol.ts.
function updateMusicFromSnap(snap: Snap): void {
  const bossOnField = snap.enemies.some((e) => (e[5] & 4) !== 0);
  let state: MusicState = 'calm';
  if (snap.active) state = bossOnField ? 'boss' : 'wave';
  else if (bossOnField) state = 'boss'; // por si el jefe sigue vivo entre oleadas
  const horde = store.game?.init.mode === 'horde';
  // en horda las "vidas" son el aforo (maxLives distinto), pero START_LIVES sigue
  // siendo la referencia de tensión razonable para el tinte urgente.
  const tension = snap.lives > 0 && snap.lives <= START_LIVES * 0.25;
  setMusicState(state, tension, horde);
}

// ---------- mensajes del servidor ----------

function wireNet(): void {
  net.on('room_joined', (msg) => {
    store.playerId = msg.playerId;
    store.roomCode = msg.code;
    store.isHost = msg.isHost;
    store.spectator = msg.spectator ?? false;
    history.replaceState(null, '', `#${msg.code}`);
    $('overlay-reconnect').hidden = true;
    // entramos como JUGADOR: respaldar el token de esta sala en localStorage para
    // poder recuperar la identidad si el móvil pierde el sessionStorage (NUNCA
    // al entrar de espectador: pisaría el respaldo bueno del jugador)
    if (!msg.spectator) saveRoomToken(msg.code);
    // a partir de ahora, cualquier reconexión se une a esta sala por su código
    net.setReconnect(wsPathJoin(msg.code), {
      type: 'join_room',
      name: store.name,
      token: store.token,
      code: msg.code,
      prevToken: roomPrevToken(msg.code),
    });
    if (store.screen === 'home') switchScreen('lobby');
  });

  net.on('lobby_state', (msg) => {
    store.lobby = { players: msg.players, settings: msg.settings, inGame: msg.inGame };
    const me = msg.players.find((p) => p.id === store.playerId);
    if (me) {
      store.isHost = me.isHost;
      // si aparezco en la lista de jugadores es que fui convertido a jugador al
      // terminar la partida: ya no soy espectador
      store.spectator = false;
      $('spectator-banner').hidden = true;
    }
    renderLobby();
    // pausar/reanudar es de TODOS los jugadores (co-op); la velocidad, del anfitrión
    $('btn-pause').hidden = store.spectator;
    $('btn-speed').hidden = !store.isHost;
    $('btn-resume').hidden = store.spectator;
  });

  // cuenta regresiva de inicio ('start', en el lobby) o de reanudación ('resume',
  // sobre la pausa). unlockAudio para que suene el tic aunque no se haya tocado nada.
  // seconds=0 = el servidor la canceló (alguien desmarcó «Listo», entró alguien…).
  net.on('countdown', (msg) => {
    if (msg.seconds <= 0) {
      hideCountdown();
      return;
    }
    unlockAudio();
    showCountdown(msg.kind, msg.seconds);
  });

  net.on('game_started', (msg) => {
    hideCountdown();
    store.playerId = msg.init.youAre;

    // Si ya estamos jugando esta partida, el mensaje es solo la lista de
    // jugadores actualizada (alguien entró a mitad de partida): NO resetear
    // velocidad/pausa/cámara/selección de los que ya juegan.
    const gs = store.game;
    if (store.screen === 'game' && gs && !gs.over) {
      gs.init = msg.init;
      $('overlay-reconnect').hidden = true;
      $('btn-pause').hidden = store.spectator;
      $('btn-speed').hidden = !store.isHost;
      startMusic(); // no-op si ya sonaba; arranca si entramos a mitad de partida
      return;
    }

    startGameStore(msg.init);
    store.pingArmed = false;
    store.suggestType = null;
    $('btn-ping').classList.remove('armed');
    clearParticles();
    resetRenderer();
    buildTowerBar();
    hidePanel();
    hideEnd();
    $('overlay-pause').hidden = true;
    $('screen-game').classList.remove('paused');
    $('overlay-reconnect').hidden = true;
    switchScreen('game');
    // arranca la música procedural adaptativa (se difiere al primer gesto si el
    // audio aún no está desbloqueado; empieza en calma/interludio).
    startMusic();
    setMusicState('calm', false, msg.init.mode === 'horde');
    $('btn-pause').hidden = store.spectator;
    $('btn-speed').hidden = !store.isHost;
    syncSpeedButton();
    // Descubrimiento del mercado 🪵: hasta que el jugador lo abra por primera
    // vez, el chip palpita y (una vez por partida, a los 8 s) un toast le dice
    // dónde está — el aviso del chat no se ve en móvil (log colapsado).
    const marketSeen = localStorage.getItem('td_market_seen') === '1';
    $('hud-wood').classList.toggle('attn', !marketSeen && !store.spectator);
    if (!marketSeen && !store.spectator) {
      setTimeout(() => {
        if (store.screen === 'game' && store.game && !store.game.over && localStorage.getItem('td_market_seen') !== '1') {
          toast('🪵 Toca el chip de madera (arriba) para COMERCIAR y mejorar a tu orco leñador', 'info');
        }
      }, 8000);
    }
    // modo espectador de la UI (banner + ocultar controles de jugador). Para un
    // jugador normal esto lo desactiva (deja la UI completa).
    applySpectatorUI();
  });

  net.on('tick', (msg) => {
    const gs = store.game;
    if (!gs) return;
    pushFrame(gs, msg.t, msg.snap);
    onTick(msg.snap);
    processEvents(msg.events);
    updateMusicFromSnap(msg.snap);
  });

  net.on('game_over', (msg) => {
    if (store.game) store.game.over = msg.stats;
    // si terminó estando en pausa, que el chat no quede flotando sobre el fin
    $('screen-game').classList.remove('paused');
    stopMusic(); // fin de partida: detener la música (el sting de victoria/derrota es SFX)
    // guardar la repetición (localStorage, máx 10) y recordarla para el botón
    // "🎬 Ver repetición" de la pantalla de fin.
    let replay: ReplayData | null = msg.replay ?? null;
    if (replay) {
      try {
        saveReplay(replay);
      } catch {
        // guardar es best-effort; aun sin guardar, se puede ver la recién terminada
      }
    }
    lastReplay = replay;
    showEnd(msg.stats);
    const btn = document.getElementById('btn-watch-replay') as HTMLButtonElement;
    btn.hidden = !replay;
  });

  net.on('chat', (msg) => addChat(msg.from, msg.color, msg.text));

  net.on('paused', (msg) => {
    if (store.game) store.game.paused = true;
    // una pausa cancela cualquier cuenta regresiva de reanudación en curso
    hideCountdown();
    $('pause-by').textContent = msg.by ? `${msg.by} pausó la partida` : 'La partida está en pausa';
    // cualquier jugador puede reanudar (los espectadores no)
    $('btn-resume').hidden = store.spectator;
    $('overlay-pause').hidden = false;
    $('btn-pause').textContent = '▶';
    // .paused sube el chat POR ENCIMA del velo de pausa: se puede hablar en pausa
    $('screen-game').classList.add('paused');
    // en pausa el input del chat SIEMPRE está visible y disponible (los
    // espectadores usan su propio flujo; aquí es para los jugadores)
    if (!store.spectator) {
      $('game-chat-form').hidden = false;
      $('hud-chat').classList.add('open');
    }
    pauseMusic(); // la música se atenúa/detiene en pausa
  });

  net.on('resumed', () => {
    if (store.game) store.game.paused = false;
    hideCountdown();
    $('overlay-pause').hidden = true;
    $('btn-pause').textContent = '⏸';
    $('screen-game').classList.remove('paused');
    // al reanudar, recoge el chat (salvo que el jugador esté escribiendo ahora)
    if (document.activeElement !== $('game-chat-input')) {
      $('game-chat-form').hidden = true;
      $('hud-chat').classList.remove('open');
    }
    resumeMusic();
  });

  net.on('speed', (msg) => {
    if (store.game) store.game.speed = msg.speed;
    syncSpeedButton();
    if (msg.by) toast(`${msg.speed === 1 ? '▶' : '⏩'} Velocidad x${msg.speed} (${msg.by})`, 'info');
  });

  net.on('map_ping', (msg) => {
    addPing(msg.x, msg.y, msg.color, msg.by, msg.towerType);
    const gw = store.game?.map.gridW;
    sfx.ping(gw ? Math.max(-1, Math.min(1, (msg.x / gw) * 2 - 1)) : 0);
  });

  net.on('error', (msg) => {
    const wasReconnecting = !$('overlay-reconnect').hidden;
    $('overlay-reconnect').hidden = true;
    const onHome = store.screen === 'home';
    if (onHome) homeError(msg.msg);
    else toast(msg.msg);
    // el intento de crear/unirse falló, o la sala murió: volver al inicio limpio
    if (onHome || msg.msg.startsWith('No existe la sala') || wasReconnecting) {
      store.roomCode = '';
      store.game = null;
      stopMusic(); // la sala murió / volvemos a home: cortar la música
      net.disconnect();
      if (!onHome) {
        history.replaceState(null, '', location.pathname);
        switchScreen('home');
      }
    }
  });

  // el mensaje inicial (create_room/join_room) lo envía el propio Net al abrir
  net.onOpen = () => {
    $('overlay-reconnect').hidden = true;
  };

  // cierre deliberado del servidor: volver a la portada limpio, SIN reintentos.
  // 4002 = expulsado por el anfitrión; 4001 = sala cerrada por inactividad.
  net.onKicked = (code) => {
    store.roomCode = '';
    store.game = null;
    stopMusic();
    hideCountdown();
    $('overlay-reconnect').hidden = true;
    $('overlay-pause').hidden = true;
    $('screen-game').classList.remove('paused');
    history.replaceState(null, '', location.pathname);
    switchScreen('home');
    homeError(
      code === 4002
        ? '🚪 Fue expulsado por el anfitrión.'
        : '⏰ La sala se cerró por inactividad (30 min sin actividad). Crea otra cuando quieran — es un toque.',
    );
  };

  net.onDrop = () => {
    if (store.roomCode) $('overlay-reconnect').hidden = false;
  };
}

// Abandonar la partida (o dejar de mirarla como espectador) y volver a la
// portada, dejando el estado local limpio igual que un game over / expulsión:
// avisamos al servidor con `leave` (marca abandono permanente e invalida el
// token) y CORTAMOS la reconexión automática (net.disconnect) — sin esto, el
// watchdog nos reconectaría como espectador al instante.
function leaveMatch(): void {
  net.send({ type: 'leave' });
  net.disconnect();
  store.roomCode = '';
  store.game = null;
  stopMusic();
  hideCountdown();
  hideEnd();
  $('overlay-pause').hidden = true;
  $('overlay-reconnect').hidden = true;
  $('settings-panel').hidden = true;
  $('screen-game').classList.remove('paused');
  history.replaceState(null, '', location.pathname);
  switchScreen('home');
}

// ---------- botones del HUD ----------

function wireHudButtons(): void {
  $('btn-callwave').addEventListener('click', () => {
    net.send({ type: 'cmd', cmd: { kind: 'call_wave' } });
  });

  $('btn-pause').addEventListener('click', () => {
    if (store.game?.paused) net.send({ type: 'resume' });
    else net.send({ type: 'pause' });
  });
  $('btn-resume').addEventListener('click', () => net.send({ type: 'resume' }));
  // cancela la cuenta atrás de reanudación desde el propio overlay (que tapa el
  // resto de botones): `pause` aborta la reanudación y nos deja en pausa firme
  $('countdown-cancel').addEventListener('click', () => net.send({ type: 'pause' }));

  // velocidad de juego: el anfitrión cicla x1 → x2 → x3
  $('btn-speed').addEventListener('click', () => {
    const current = store.game?.speed ?? 1;
    const idx = GAME_SPEEDS.indexOf(current as (typeof GAME_SPEEDS)[number]);
    const next = GAME_SPEEDS[(idx + 1) % GAME_SPEEDS.length];
    net.send({ type: 'set_speed', speed: next });
  });

  // ping: arma el siguiente toque en el mapa como marcador (o mantener pulsado)
  $('btn-ping').addEventListener('click', () => {
    store.pingArmed = !store.pingArmed;
    $('btn-ping').classList.toggle('armed', store.pingArmed);
    // pinear y sugerir son excluyentes: al armar el ping, desarma la sugerencia
    if (store.pingArmed && store.suggestType) {
      store.suggestType = null;
      syncTowerBar();
    }
  });

  // espectador en móvil (issue #5): 🏗 muestra/esconde la barra de torres
  $('btn-towers-toggle').addEventListener('click', () => toggleSpectatorTowers());

  // minimapa: mostrar/ocultar (persistido en localStorage vía el renderer)
  const miniBtn = $('btn-minimap');
  const syncMini = () => miniBtn.classList.toggle('off', !isMinimapOn());
  syncMini();
  miniBtn.addEventListener('click', () => {
    toggleMinimap();
    syncMini();
  });

  const muteBtn = $('btn-mute');
  const syncMute = () => (muteBtn.textContent = store.muted ? '🔇' : '🔊');
  syncMute();
  muteBtn.addEventListener('click', () => {
    store.muted = !store.muted;
    localStorage.setItem('td_muted', store.muted ? '1' : '0');
    syncMute();
  });

  // ---------- panel de ajustes ⚙ (sliders SFX + Música) ----------
  const settingsBtn = $('btn-settings');
  const panel = $('settings-panel');
  const sfxRange = $<HTMLInputElement>('set-sfx');
  const musicRange = $<HTMLInputElement>('set-music');
  const sfxVal = $('set-sfx-val');
  const musicVal = $('set-music-val');

  const syncSliders = () => {
    sfxRange.value = String(Math.round(store.sfxVol * 100));
    musicRange.value = String(Math.round(store.musicVol * 100));
    sfxVal.textContent = `${sfxRange.value}%`;
    musicVal.textContent = `${musicRange.value}%`;
  };
  syncSliders();

  const closePanel = () => {
    panel.hidden = true;
    settingsBtn.setAttribute('aria-expanded', 'false');
  };
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    unlockAudio(); // abrir ajustes cuenta como interacción: desbloquea el audio
    const open = panel.hidden;
    panel.hidden = !open;
    settingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      syncSliders();
      // «Continuar en otro dispositivo» (issue #6): solo jugadores reales, nunca
      // espectadores ni el reproductor de repeticiones (store.replay también
      // marca store.spectator=true, pero por claridad se comprueban ambos).
      $('btn-continue-device').hidden = store.spectator || !!store.replay;
    }
  });
  // clic fuera cierra el panel; clic dentro no.
  panel.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => {
    if (!panel.hidden) closePanel();
  });

  // 📱 Continuar en otro dispositivo (issue #6): enlace con el código de sala +
  // el token de reconexión de ESTA pestaña, para retomar la partida en otro
  // navegador/dispositivo sin cuentas. Mismo patrón que copiar el código del
  // lobby (screens.ts), con fallback a prompt si el portapapeles falla o no existe.
  $('btn-continue-device').addEventListener('click', (e) => {
    e.stopPropagation();
    const url = `${location.origin}${location.pathname}?rt=${encodeURIComponent(store.token)}#${store.roomCode}`;
    const showFallback = () => window.prompt('Copia este enlace y ábrelo en el otro dispositivo:', url);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(
        () => toast('📱 Enlace copiado — ábrelo en el otro dispositivo', 'info'),
        showFallback,
      );
    } else {
      showFallback();
    }
  });

  // 🚪 Abandonar partida: desde la pausa Y desde ⚙ (para los que no pueden abrir
  // la pausa: no-anfitriones en Node, espectadores). Con confirmación para no
  // salir por accidente. Cierra el panel de ajustes si estaba abierto.
  const wireAbandon = (id: string) =>
    $(id).addEventListener('click', (e) => {
      e.stopPropagation();
      closePanel();
      if (!confirm('¿Seguro que quieres ABANDONAR la partida? Tus torres se quedan, pero no podrás volver a jugar esta partida.')) return;
      leaveMatch();
    });
  wireAbandon('btn-abandon-pause');
  wireAbandon('btn-abandon-settings');

  sfxRange.addEventListener('input', () => {
    setSfxVolume(Number(sfxRange.value) / 100);
    sfxVal.textContent = `${sfxRange.value}%`;
  });
  // al soltar, un chasquido de prueba para oír el volumen elegido.
  sfxRange.addEventListener('change', () => sfx.place());
  musicRange.addEventListener('input', () => {
    setMusicVolume(Number(musicRange.value) / 100);
    musicVal.textContent = `${musicRange.value}%`;
  });

  $('btn-back-lobby').addEventListener('click', () => {
    hideEnd();
    store.game = null;
    stopMusic(); // volver al lobby sin dejar música colgada
    switchScreen('lobby');
    renderLobby();
  });

  // 🎬 Ver repetición: reproduce la partida que acaba de terminar (sin red)
  $('btn-watch-replay').addEventListener('click', () => {
    if (!lastReplay) return;
    hideEnd();
    startReplay(lastReplay);
  });

  // chat dentro del juego; en móvil la clase .open muestra también el log.
  // En PAUSA el input nunca se esconde: siempre queda visible y disponible.
  const chatForm = $('game-chat-form');
  const chatInput = $<HTMLInputElement>('game-chat-input');
  const isPaused = () => store.game?.paused === true && !store.spectator;
  const syncChatOpen = () => $('hud-chat').classList.toggle('open', !chatForm.hidden);
  $('btn-chat-toggle').addEventListener('click', () => {
    // en pausa el botón solo puede ABRIR el chat (no cerrarlo)
    chatForm.hidden = isPaused() ? false : !chatForm.hidden;
    syncChatOpen();
    if (!chatForm.hidden) chatInput.focus();
  });
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (text) net.send({ type: 'chat', text });
    chatInput.value = '';
    // mantener el formulario abierto con el input enfocado para escribir el siguiente mensaje
    // (tanto en juego normal como en pausa)
    chatInput.focus();
  });
  window.addEventListener('keydown', (e) => {
    if (store.screen !== 'game') return;
    const active = document.activeElement;
    if (e.key === 'Enter' && !(active instanceof HTMLInputElement)) {
      chatForm.hidden = false;
      syncChatOpen();
      chatInput.focus();
      e.preventDefault();
    }
    if (e.key === 'Escape' && active === chatInput) {
      chatInput.blur();
      // en pausa el input permanece visible (solo se pierde el foco)
      if (!isPaused()) {
        chatForm.hidden = true;
        syncChatOpen();
      }
    }
  });

  // ping periódico para mantener viva la conexión (proxies, móviles)
  setInterval(() => net.send({ type: 'ping', t: Date.now() }), 5000);

  // la selección de torre se refresca al abrir el panel
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshPanel();
  });
}

// ---------- arranque ----------

// Continuar en otro dispositivo (issue #6): un enlace `?rt=TOKEN#CODIGO`
// (generado por btn-continue-device en otro dispositivo) trae el token de
// reconexión ANTES del hash, para no romper el parseo de `#CODIGO` de abajo
// (que exige longitud exacta 4). Se siembra en localStorage con la MISMA clave
// que usa roomPrevToken/saveRoomToken — así el join de más abajo (o el que
// dispare el usuario a mano desde el formulario) lo recoge sin más cambios.
// Corre ANTES de initHome()/el auto-join de abajo, y limpia el `rt` de la URL
// visible aunque el código no fuera válido (nunca dejarlo a la vista).
{
  const rt = new URLSearchParams(location.search).get('rt');
  if (rt) {
    const hashCode = location.hash.replace('#', '').trim().toUpperCase();
    if (hashCode.length === 4) seedRoomPrevToken(hashCode, rt);
    history.replaceState(null, '', location.pathname + location.hash);
  }
}

const canvas = $('game-canvas') as HTMLCanvasElement;
initRenderer(canvas);
initInput(canvas);
initHome();
initLobby();
initBestiary();
initMarket();
initScoreboard();
initShop();
wireHudButtons();
wireNet();
// el reproductor de repeticiones reusa el MISMO pipeline de eventos que la red
setReplayEventSink(processEvents);
initReplayHome();
switchScreen('home');

// enlace directo ?n=Nombre#SALA: entra a la sala sin pasar por el formulario
{
  const qName = new URLSearchParams(location.search).get('n');
  if (qName && !store.name) saveName(qName.slice(0, 16));
  const hashCode = location.hash.replace('#', '').trim().toUpperCase();
  if (hashCode.length === 4 && store.name) {
    net.connect(wsPathJoin(hashCode), {
      type: 'join_room',
      name: store.name,
      token: store.token,
      code: hashCode,
      prevToken: roomPrevToken(hashCode),
    });
  }
}
