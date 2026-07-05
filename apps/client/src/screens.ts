import { MAPS, type EndStats, type HighscoreEntry, type MapDef, type PublicRoomInfo, type RoomSettings } from '@td/shared';
import { net, wsPathCreate, wsPathJoin } from './net.js';
import { roomPrevToken, saveName, store } from './store.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const DIFF_LABELS: Record<string, string> = { easy: 'Fácil', normal: 'Normal', hard: 'Difícil' };
const MODE_LABELS: Record<string, string> = { classic: 'Clásico', endless: 'Infinito', horde: 'Horda 🌀' };

// colores de las miniaturas por tema (versión compacta de las paletas del renderer)
const MINI_THEME: Record<MapDef['theme'], { bg: string; path: string; blocked: string }> = {
  grass: { bg: '#2e4b2c', path: '#8a6f4d', blocked: '#1b5e20' },
  desert: { bg: '#8a7449', path: '#c2a878', blocked: '#2e7d32' },
  snow: { bg: '#9fb4c7', path: '#d7e3ee', blocked: '#4e6a84' },
  volcano: { bg: '#3a2b28', path: '#6b5147', blocked: '#ff6d00' },
  crystal: { bg: '#2b2547', path: '#5d5480', blocked: '#7c4dff' },
};

export function switchScreen(screen: 'home' | 'lobby' | 'game'): void {
  store.screen = screen;
  $('screen-home').hidden = screen !== 'home';
  $('screen-lobby').hidden = screen !== 'lobby';
  $('screen-game').hidden = screen !== 'game';
}

export function homeError(msg: string): void {
  const el = $('home-error');
  el.textContent = msg;
  el.hidden = !msg;
}

// ---------- tarjetas de mapa con miniatura ----------

function drawMiniMap(canvas: HTMLCanvasElement, map: MapDef): void {
  const W = 180;
  const H = Math.round((W * map.gridH) / map.gridW);
  canvas.width = W;
  canvas.height = H;
  const c = canvas.getContext('2d')!;
  const s = W / map.gridW;
  const t = MINI_THEME[map.theme];

  c.fillStyle = t.bg;
  c.fillRect(0, 0, W, H);
  // variación sutil
  c.fillStyle = 'rgba(255,255,255,0.04)';
  for (let cy = 0; cy < map.gridH; cy++) {
    for (let cx = (cy % 2); cx < map.gridW; cx += 2) c.fillRect(cx * s, cy * s, s, s);
  }
  // caminos
  for (const path of map.paths) {
    c.strokeStyle = t.path;
    c.lineWidth = s * 0.8;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    c.moveTo((path[0][0] + 0.5) * s, (path[0][1] + 0.5) * s);
    for (let i = 1; i < path.length; i++) c.lineTo((path[i][0] + 0.5) * s, (path[i][1] + 0.5) * s);
    c.stroke();
  }
  // decoración
  c.fillStyle = t.blocked;
  for (const [bx, by] of map.blocked) {
    c.beginPath();
    c.arc((bx + 0.5) * s, (by + 0.5) * s, s * 0.32, 0, Math.PI * 2);
    c.fill();
  }
  // entradas (morado) y salidas (dorado)
  for (const path of map.paths) {
    const [sc, sr] = path[0];
    const [ec, er] = path[path.length - 1];
    c.fillStyle = '#9575cd';
    c.beginPath();
    c.arc((sc + 0.5) * s, (sr + 0.5) * s, s * 0.5, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#ffd54f';
    c.fillRect((ec + 0.1) * s, (er + 0.1) * s, s * 0.8, s * 0.8);
  }
}

function renderMapCards(
  containerId: string,
  selectedId: string,
  disabled: boolean,
  onSelect: (mapId: string) => void,
): void {
  const box = $(containerId);
  box.innerHTML = '';
  for (const map of MAPS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `map-card${map.id === selectedId ? ' selected' : ''}`;
    card.disabled = disabled;
    const mini = document.createElement('canvas');
    drawMiniMap(mini, map);
    card.appendChild(mini);
    const name = document.createElement('span');
    name.className = 'map-name';
    name.textContent = map.name;
    card.appendChild(name);
    const meta = document.createElement('span');
    meta.className = 'map-meta';
    meta.textContent = `${map.gridW}×${map.gridH}${map.paths.length > 1 ? ` · ${map.paths.length} rutas` : ''}`;
    card.appendChild(meta);
    card.addEventListener('click', () => onSelect(map.id));
    box.appendChild(card);
  }
}

function mapDesc(mapId: string): string {
  return MAPS.find((m) => m.id === mapId)?.desc ?? '';
}

// ---------- controles segmentados ----------

function wireSeg(id: string, onChange: (value: string) => void): void {
  for (const btn of $(id).querySelectorAll<HTMLButtonElement>('button')) {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      onChange(btn.dataset.value!);
    });
  }
}

function setSeg(id: string, value: string, disabled = false): void {
  for (const btn of $(id).querySelectorAll<HTMLButtonElement>('button')) {
    btn.classList.toggle('active', btn.dataset.value === value);
    btn.disabled = disabled;
  }
}

// ---------- inicio ----------

// Ajustes POR DEFECTO de una sala nueva: la portada ya no elige nada (mapa,
// modo, dificultad y visibilidad se cambian DENTRO de la sala, en el lobby).
const homeSel: RoomSettings = { mapId: MAPS[0].id, mode: 'classic', difficulty: 'normal', public: false };

export function initHome(): void {
  const nameInput = $<HTMLInputElement>('home-name');
  nameInput.value = store.name;

  $('tab-create').addEventListener('click', () => {
    $('tab-create').classList.add('active');
    $('tab-join').classList.remove('active');
    $('home-create').hidden = false;
    $('home-join').hidden = true;
  });
  $('tab-join').addEventListener('click', () => {
    $('tab-join').classList.add('active');
    $('tab-create').classList.remove('active');
    $('home-join').hidden = false;
    $('home-create').hidden = true;
  });

  const requireName = (): string | null => {
    const name = nameInput.value.trim();
    if (!name) {
      homeError('Ponte un nombre primero 🙂');
      nameInput.focus();
      return null;
    }
    saveName(name);
    homeError('');
    return name;
  };

  $('btn-create').addEventListener('click', () => {
    const name = requireName();
    if (!name) return;
    // conecta a una sala nueva (el backend asigna un código libre) y crea al abrir
    net.connect(wsPathCreate(), { type: 'create_room', name, token: store.token, settings: { ...homeSel } });
  });

  $('btn-join').addEventListener('click', () => joinFromInput());
  $<HTMLInputElement>('home-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinFromInput();
  });

  // código en la URL (#ABCD) → precargar la pestaña de unirse
  const hashCode = location.hash.replace('#', '').trim().toUpperCase();
  if (hashCode.length === 4) {
    $<HTMLInputElement>('home-code').value = hashCode;
    $('tab-join').click();
  }

  // lista de salas públicas: clic en Entrar/Observar une por código (delegación:
  // las filas se reescriben en cada refresco)
  $('home-rooms-list').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-code]');
    if (btn) joinByCode(btn.dataset.code!);
  });
  void loadRooms();
  setInterval(() => void loadRooms(), 4000);

  void loadHighscores();
}

// Une a una sala por código (desde el input o desde la lista de salas públicas).
// Si la sala está en partida, el servidor nos hace ESPECTADORES automáticamente.
function joinByCode(code: string): void {
  const nameInput = $<HTMLInputElement>('home-name');
  const name = nameInput.value.trim();
  if (!name) {
    homeError('Ponte un nombre primero 🙂');
    nameInput.focus();
    return;
  }
  saveName(name);
  homeError('');
  net.connect(wsPathJoin(code), { type: 'join_room', name, token: store.token, code, prevToken: roomPrevToken(code) });
}

function joinFromInput(): void {
  const code = $<HTMLInputElement>('home-code').value.trim().toUpperCase();
  if (code.length !== 4) {
    homeError('El código tiene 4 letras');
    return;
  }
  joinByCode(code);
}

// ---------- salas públicas (F5) ----------

async function loadRooms(): Promise<void> {
  // solo con la portada visible (ni en lobby/partida ni con la pestaña oculta)
  if (store.screen !== 'home' || document.hidden) return;
  try {
    const res = await fetch('/api/rooms');
    if (!res.ok) {
      // backend sin directorio (p. ej. el servidor Node): ocultar la sección
      $('home-rooms').hidden = true;
      return;
    }
    const rooms = (await res.json()) as PublicRoomInfo[];
    $('home-rooms').hidden = false;
    renderRooms(Array.isArray(rooms) ? rooms : []);
  } catch {
    // error transitorio de red: conservar lo que hubiera en pantalla
  }
}

function renderRooms(rooms: PublicRoomInfo[]): void {
  $('home-rooms-empty').hidden = rooms.length > 0;
  $('home-rooms-list').innerHTML = rooms
    .slice(0, 12)
    .map((r) => {
      const mapName = MAPS.find((m) => m.id === r.mapId)?.name ?? r.mapId;
      const state = r.inGame
        ? `<span class="room-state ingame">⚔️ Oleada ${r.wave}</span>`
        : '<span class="room-state lobby">🟢 En el lobby</span>';
      return `<li class="room-row">
        <div class="room-info">
          ${state}
          <span class="room-meta"><b>${escapeHtml(r.host)}</b> · ${mapName} · ${MODE_LABELS[r.mode]} · ${DIFF_LABELS[r.difficulty]} · 👥 ${r.players}</span>
        </div>
        <button class="btn small ${r.inGame ? 'ghost' : 'primary'}" data-code="${r.code}">${r.inGame ? '👁 Observar' : '⚔️ Entrar'}</button>
      </li>`;
    })
    .join('');
}

async function loadHighscores(): Promise<void> {
  try {
    const res = await fetch('/api/highscores');
    const scores = (await res.json()) as HighscoreEntry[];
    if (!Array.isArray(scores) || scores.length === 0) return;
    $('home-scores').hidden = false;
    $('home-scores-list').innerHTML = scores
      .slice(0, 8)
      .map(
        (s) =>
          `<li><b>Oleada ${s.wave}</b> — ${s.names.map(escapeHtml).join(', ')} <span class="hint">(${
            MODE_LABELS[s.mode ?? 'endless']
          } · ${MAPS.find((m) => m.id === s.mapId)?.name ?? s.mapId}, ${
            DIFF_LABELS[s.difficulty] ?? s.difficulty
          })</span></li>`,
      )
      .join('');
  } catch {
    // sin récords todavía
  }
}

// ---------- lobby ----------

function sendSettings(patch: Partial<RoomSettings>): void {
  if (!store.isHost) return;
  net.send({ type: 'set_settings', settings: { ...store.lobby.settings, ...patch } });
}

export function initLobby(): void {
  wireSeg('lobby-mode', (v) => sendSettings({ mode: v as RoomSettings['mode'] }));
  wireSeg('lobby-diff', (v) => sendSettings({ difficulty: v as RoomSettings['difficulty'] }));
  wireSeg('lobby-visibility', (v) => sendSettings({ public: v === 'public' }));

  $('btn-start').addEventListener('click', () => net.send({ type: 'start_game' }));

  // botón «Listo» (jugadores no-anfitrión): alterna el estado propio
  $('btn-ready').addEventListener('click', () => {
    const me = store.lobby.players.find((p) => p.id === store.playerId);
    net.send({ type: 'set_ready', ready: !(me?.ready ?? false) });
  });

  // expulsar / ceder anfitrión (solo anfitrión): delegación en la lista de jugadores
  $('lobby-players').addEventListener('click', (e) => {
    const kickBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-kick]');
    if (kickBtn && store.isHost) {
      net.send({ type: 'kick_player', playerId: kickBtn.dataset.kick! });
      return;
    }
    const cedeBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-cede]');
    if (cedeBtn && store.isHost) {
      const name = cedeBtn.title.replace('Ceder anfitrión a ', '');
      if (confirm(`¿Ceder la sala a ${name}? Ya no podrás iniciar la partida ni cambiar los ajustes.`))
        net.send({ type: 'transfer_host', playerId: cedeBtn.dataset.cede! });
    }
  });

  $('btn-leave').addEventListener('click', () => {
    net.disconnect(); // cierra el socket: el servidor nos saca de la sala
    store.roomCode = '';
    store.game = null;
    history.replaceState(null, '', location.pathname);
    switchScreen('home');
  });

  $('lobby-code').addEventListener('click', () => {
    const url = `${location.origin}/#${store.roomCode}`;
    navigator.clipboard?.writeText(url).then(
      () => {
        $('lobby-code').textContent = '¡Copiado!';
        setTimeout(() => ($('lobby-code').textContent = store.roomCode), 900);
      },
      () => {},
    );
  });

  $('lobby-chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('lobby-chat-input');
    const text = input.value.trim();
    if (text) net.send({ type: 'chat', text });
    input.value = '';
  });
}

export function renderLobby(): void {
  const { players, settings } = store.lobby;
  $('lobby-code').textContent = store.roomCode;

  $('lobby-players').innerHTML = players
    .map((p) => {
      const isMe = p.id === store.playerId;
      // insignia de estado: el anfitrión no necesita marcar «Listo»; el resto sí
      const badge = p.isHost
        ? '<span class="host-tag">👑 anfitrión</span>'
        : p.ready
          ? '<span class="ready-tag on">✅ listo</span>'
          : '<span class="ready-tag off">⏳ esperando</span>';
      // el anfitrión puede expulsar y ceder la sala a cualquier otro jugador conectado
      const canManage = store.isHost && !isMe && p.connected;
      const cede = canManage
        ? `<button class="cede-btn" data-cede="${p.id}" title="Ceder anfitrión a ${escapeHtml(p.name)}" aria-label="Ceder anfitrión">👑</button>`
        : '';
      const kick = canManage
        ? `<button class="kick-btn" data-kick="${p.id}" title="Expulsar a ${escapeHtml(p.name)}" aria-label="Expulsar">✕</button>`
        : '';
      return `
      <li class="${p.connected ? '' : 'offline'}">
        <span class="player-dot" style="background:${p.color};color:${p.color}"></span>
        <span class="player-name">${escapeHtml(p.name)}${isMe ? ' (tú)' : ''}</span>
        ${badge}
        ${cede}
        ${kick}
      </li>`;
    })
    .join('');

  renderMapCards('lobby-maps', settings.mapId, !store.isHost, (id) => sendSettings({ mapId: id }));
  $('lobby-map-desc').textContent = mapDesc(settings.mapId);
  setSeg('lobby-mode', settings.mode, !store.isHost);
  setSeg('lobby-diff', settings.difficulty, !store.isHost);
  setSeg('lobby-visibility', settings.public ? 'public' : 'private', !store.isHost);

  // estado de «Listo» del equipo (solo cuentan los no-anfitriones conectados)
  const others = players.filter((p) => p.connected && !p.isHost);
  const readyCount = others.filter((p) => p.ready).length;
  const allReady = others.every((p) => p.ready);
  const me = players.find((p) => p.id === store.playerId);

  const startBtn = $<HTMLButtonElement>('btn-start');
  const readyBtn = $<HTMLButtonElement>('btn-ready');
  const status = $('lobby-ready-status');

  startBtn.hidden = !store.isHost;
  readyBtn.hidden = store.isHost;
  $('lobby-wait').hidden = store.isHost;

  if (store.isHost) {
    startBtn.disabled = !allReady;
    startBtn.textContent = allReady ? '▶ ¡Empezar partida!' : '⏳ Esperando a que todos estén listos…';
    status.hidden = others.length === 0;
    status.textContent = others.length > 0 ? `${readyCount}/${others.length} jugadores listos` : '';
  } else {
    const iAmReady = me?.ready ?? false;
    readyBtn.classList.toggle('active', iAmReady);
    readyBtn.textContent = iAmReady ? '⏳ Cancelar «Listo»' : '✅ Estoy listo';
    status.hidden = true;
  }
}

// ---------- fin de partida ----------

export function showEnd(stats: EndStats): void {
  $('end-title').textContent = stats.victory ? '🎉 ¡VICTORIA!' : '💀 Derrota…';
  if (stats.mode === 'horde') {
    // en horda no hay victoria: se juega hasta la saturación
    $('end-sub').textContent = `La horda 🌀 desbordó la fortaleza en la oleada ${stats.wave}. ¡Buen aguante!`;
  } else {
    $('end-sub').textContent = stats.victory
      ? `Defendieron la fortaleza durante las ${stats.wave} oleadas. ¡Bien jugado, equipo!`
      : `La fortaleza cayó en la oleada ${stats.wave}${stats.totalWaves ? ` de ${stats.totalWaves}` : ''}.`;
  }

  const sorted = [...stats.players].sort((a, b) => b.damage - a.damage);
  const maxDamage = sorted[0]?.damage ?? 0;

  // podio (solo si hay daño que celebrar)
  const podium = $('end-podium');
  podium.innerHTML = '';
  const medals = ['🥇', '🥈', '🥉'];
  const order = [1, 0, 2]; // 2º, 1º, 3º para la silueta clásica del podio
  const top = sorted.slice(0, 3);
  if (top.length > 1 && maxDamage > 0) {
    for (const idx of order) {
      const p = top[idx];
      if (!p) continue;
      const col = document.createElement('div');
      col.className = `podium-col p${idx + 1}`;
      col.innerHTML = `
        <span class="pname" style="color:${p.color}">${escapeHtml(p.name)}</span>
        <span class="pdmg">${p.damage.toLocaleString()} daño</span>
        <div class="pblock">${medals[idx]}</div>`;
      podium.appendChild(col);
    }
  }

  $('end-stats').innerHTML = `
    <table>
      <thead><tr><th>Jugador</th><th>Bajas</th><th>Daño</th><th>🪙 Ganado</th><th>Torres</th></tr></thead>
      <tbody>
        ${sorted
          .map(
            (p) => `
          <tr class="${p.damage === maxDamage && maxDamage > 0 ? 'mvp' : ''}">
            <td><span class="player-dot" style="background:${p.color};color:${p.color};display:inline-block;margin-right:6px"></span>${escapeHtml(p.name)}${p.damage === maxDamage && maxDamage > 0 ? ' 🏆' : ''}</td>
            <td>${p.kills}</td>
            <td>${p.damage.toLocaleString()}</td>
            <td>${p.goldEarned.toLocaleString()}</td>
            <td>${p.towersBuilt}</td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>`;

  const overlay = $('overlay-end');
  overlay.hidden = false;

  // confeti de victoria
  overlay.querySelectorAll('.confetti').forEach((el) => el.remove());
  if (stats.victory) {
    const colors = ['#ffd54f', '#4fc3f7', '#f06292', '#aed581', '#ba68c8', '#ffb74d'];
    for (let i = 0; i < 60; i++) {
      const c = document.createElement('span');
      c.className = 'confetti';
      c.style.left = `${Math.random() * 100}%`;
      c.style.background = colors[i % colors.length];
      c.style.animationDuration = `${2.4 + Math.random() * 2.2}s`;
      c.style.animationDelay = `${Math.random() * 1.6}s`;
      c.style.transform = `rotate(${Math.random() * 360}deg)`;
      overlay.appendChild(c);
    }
  }
}

export function hideEnd(): void {
  const overlay = $('overlay-end');
  overlay.hidden = true;
  overlay.querySelectorAll('.confetti').forEach((el) => el.remove());
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
