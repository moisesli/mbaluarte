import {
  MAPS,
  MULTI_DOOR_MIN,
  type EndStats,
  type HighscoreEntry,
  type MapDef,
  type PublicRoomInfo,
  type RoomSettings,
  type SavedLobbyInfo,
} from '@td/shared';
import { net, wsPathCreate, wsPathJoin } from './net.js';
import { roomPrevToken, saveName, store } from './store.js';
import { ask } from './dialog.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const DIFF_LABELS: Record<string, string> = { easy: 'Fácil', normal: 'Normal', hard: 'Difícil' };
const DIFF_EMOJI: Record<string, string> = { easy: '😊', normal: '🙂', hard: '😈' };
const MODE_LABELS: Record<string, string> = { classic: 'Clásico', endless: 'Infinito', horde: 'Horda 🌀' };

// F9b/F9d · nº mínimo de rutas para habilitar puertas (reclamo y cierre): ahora
// viene de @td/shared (MULTI_DOOR_MIN) — la misma constante que usan
// sanitizeSettings y el RoomDO, imposible de desincronizar.
const DOOR_MIN_ROUTES = MULTI_DOOR_MIN;

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

// `doorColors`: F9b · color reclamado por puerta (índice de ruta), para teñir la
// entrada correspondiente con el color del jugador que la reclamó. undefined en
// las entradas sin reclamo (se pintan del morado por defecto).
// `closedDoors`: F9d · puertas CERRADAS por el anfitrión — su entrada se pinta
// gris apagado con una cruz (por ahí no saldrán monstruos).
function drawMiniMap(canvas: HTMLCanvasElement, map: MapDef, doorColors?: (string | undefined)[], closedDoors?: number[]): void {
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
  // entradas (morado, o el color de quien reclamó la puerta) y salidas (dorado)
  const closedSet = new Set(closedDoors ?? []);
  for (let i = 0; i < map.paths.length; i++) {
    const path = map.paths[i];
    const [sc, sr] = path[0];
    const [ec, er] = path[path.length - 1];
    // F9d · puerta CERRADA: gris apagado + cruz (nada de morado «vivo»)
    if (closedSet.has(i)) {
      c.fillStyle = '#4a4a55';
      c.beginPath();
      c.arc((sc + 0.5) * s, (sr + 0.5) * s, s * 0.5, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = 'rgba(230,230,235,0.85)';
      c.lineWidth = Math.max(1, s * 0.14);
      const r = s * 0.3;
      c.beginPath();
      c.moveTo((sc + 0.5) * s - r, (sr + 0.5) * s - r);
      c.lineTo((sc + 0.5) * s + r, (sr + 0.5) * s + r);
      c.moveTo((sc + 0.5) * s + r, (sr + 0.5) * s - r);
      c.lineTo((sc + 0.5) * s - r, (sr + 0.5) * s + r);
      c.stroke();
      c.fillStyle = '#ffd54f';
      c.fillRect((ec + 0.1) * s, (er + 0.1) * s, s * 0.8, s * 0.8);
      continue;
    }
    const claimed = doorColors?.[i];
    c.fillStyle = claimed ?? '#9575cd';
    c.beginPath();
    c.arc((sc + 0.5) * s, (sr + 0.5) * s, s * (claimed ? 0.62 : 0.5), 0, Math.PI * 2);
    c.fill();
    // aro blanco sobre la puerta reclamada, para que resalte a este tamaño
    if (claimed) {
      c.strokeStyle = 'rgba(255,255,255,0.9)';
      c.lineWidth = Math.max(1, s * 0.12);
      c.stroke();
    }
    c.fillStyle = '#ffd54f';
    c.fillRect((ec + 0.1) * s, (er + 0.1) * s, s * 0.8, s * 0.8);
  }
}

function renderMapCards(
  containerId: string,
  selectedId: string,
  disabled: boolean,
  onSelect: (mapId: string) => void,
  // F9b · colores de puerta reclamada (por índice de ruta), solo para el mapa
  // SELECCIONADO: tiñe sus entradas con el color de cada jugador que reclamó.
  doorColors?: (string | undefined)[],
  // F9d · puertas CERRADAS del mapa seleccionado (gris + cruz en la miniatura)
  closedDoors?: number[],
): void {
  const box = $(containerId);
  box.innerHTML = '';
  for (const map of MAPS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `map-card${map.id === selectedId ? ' selected' : ''}`;
    card.disabled = disabled;
    const mini = document.createElement('canvas');
    drawMiniMap(mini, map, map.id === selectedId ? doorColors : undefined, map.id === selectedId ? closedDoors : undefined);
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

// ---------- F9b · selección de puerta por color ----------

// ¿el mapa admite reclamo de puerta? (multi-ruta ≥4, estilo Green TD)
function mapHasDoors(map: MapDef | undefined): map is MapDef {
  return !!map && map.paths.length >= DOOR_MIN_ROUTES;
}

// color reclamado por cada puerta (índice de ruta) del mapa dado, para teñir sus
// entradas en la miniatura. undefined si el mapa no admite puertas.
function doorColorsFor(map: MapDef | undefined): (string | undefined)[] | undefined {
  if (!mapHasDoors(map)) return undefined;
  const colors: (string | undefined)[] = new Array(map.paths.length).fill(undefined);
  for (const p of store.lobby.players) {
    if (p.door !== undefined && p.door >= 0 && p.door < colors.length) colors[p.door] = p.color;
  }
  return colors;
}

// lista de puertas reclamables. Cada chip: clic para reclamar la libre o liberar
// la propia; las de otros quedan deshabilitadas. Solo jugadores (no espectadores).
// F9d · estado CERRADA 🚫: el ANFITRIÓN cierra/abre puertas LIBRES con el botón
// 🚫/🔓 del chip (por ahí no saldrán monstruos; una reclamada no ofrece cerrar y
// una cerrada no se puede reclamar). Los demás la ven cerrada y deshabilitada.
function renderDoors(map: MapDef | undefined): void {
  const box = $('lobby-doors-box');
  const list = $('lobby-doors');
  if (!mapHasDoors(map) || store.spectator) {
    box.hidden = true;
    list.innerHTML = '';
    return;
  }
  box.hidden = false;
  const players = store.lobby.players;
  const closed = new Set(store.lobby.settings.closedDoors ?? []);
  const ownerByDoor = new Map<number, (typeof players)[number]>();
  for (const p of players) if (p.door !== undefined) ownerByDoor.set(p.door, p);
  list.innerHTML = map.paths
    .map((_, i) => {
      const owner = ownerByDoor.get(i);
      const mine = owner?.id === store.playerId;
      const isClosed = closed.has(i) && !owner; // defensa: una reclamada jamás se pinta cerrada
      const state = isClosed ? 'closed' : mine ? 'mine' : owner ? 'taken' : 'free';
      const dotStyle = owner
        ? `background:${owner.color};color:${owner.color}`
        : 'background:transparent;color:#6b7280;box-shadow:none;border:1.5px solid #6b7280';
      const owned = isClosed ? '🚫 Cerrada' : owner ? `${escapeHtml(owner.name)}${mine ? ' (tú)' : ''}` : 'Libre';
      // cerrada: nadie la reclama (el server también lo rechaza); ajena: no se roba
      const disabled = isClosed || (owner && !mine) ? ' disabled' : '';
      // F9d · palanca del ANFITRIÓN: cerrar una libre / reabrir una cerrada.
      // Nunca en puertas reclamadas (primero que el dueño la libere) ni en la
      // última abierta (el server la reabriría igual: siempre queda ≥1).
      const canClose = store.isHost && !owner && (isClosed || map.paths.length - closed.size > 1);
      const toggle = canClose
        ? `<button type="button" class="door-toggle" data-close="${i}" title="${isClosed ? 'Reabrir la puerta' : 'Cerrar la puerta (no saldrán monstruos)'}" aria-label="${isClosed ? 'Reabrir' : 'Cerrar'} puerta ${i + 1}">${isClosed ? '🔓' : '🚫'}</button>`
        : '';
      return `<li>
        <button type="button" class="door-chip ${state}" data-door="${i}"${disabled}>
          <span class="player-dot" style="${dotStyle}"></span>
          <span class="door-num">Puerta ${i + 1}</span>
          <span class="door-owner">${owned}</span>
        </button>
        ${toggle}
      </li>`;
    })
    .join('');
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

// Ajustes POR DEFECTO de una sala nueva: mapa, modo y dificultad se cambian
// DENTRO de la sala (lobby); la VISIBILIDAD, en cambio, se decide en la portada.
const homeSel: RoomSettings = { mapId: MAPS[0].id, mode: 'classic', difficulty: 'normal' };

// Visibilidad elegida en la portada: pública por defecto para que al entrar
// de una se cree sala visible. El usuario puede cambiarla antes de crear.
let homeVisibility: 'private' | 'public' | null = 'public';

// ---------- pestañas del panel lateral (Salas · Récords · Repeticiones) ----------
// Antes las tres secciones se apilaban siempre (mostraban/ocultaban según si
// había datos), tapándose entre sí. Ahora es una sola visible a la vez; el
// "hay datos o no" pasa a ser el estado VACÍO propio de cada panel, ya no
// controla si la sección se ve. Se recuerda la última pestaña elegida.

type SideTab = 'rooms' | 'scores' | 'replays';
const SIDE_TABS: SideTab[] = ['rooms', 'scores', 'replays'];
const SIDE_PANEL_ID: Record<SideTab, string> = { rooms: 'home-rooms', scores: 'home-scores', replays: 'home-replays' };
const SIDE_TAB_STORAGE_KEY = 'td_home_tab';

function isSideTab(v: string | null): v is SideTab {
  return v === 'rooms' || v === 'scores' || v === 'replays';
}

function setSideTab(tab: SideTab): void {
  for (const t of SIDE_TABS) {
    const active = t === tab;
    const btn = $(`side-tab-${t}`);
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
    $(SIDE_PANEL_ID[t]).hidden = !active;
  }
  localStorage.setItem(SIDE_TAB_STORAGE_KEY, tab);
}

// chip numérico en una pestaña (p. ej. «Salas 2»); oculto en 0 para no
// ensuciar la barra cuando el panel está vacío. Lo llaman renderRooms,
// loadHighscores (aquí abajo) y renderReplayList (replay.ts).
export function setSideTabCount(tab: SideTab, count: number): void {
  const el = $(`side-tab-${tab}-count`);
  el.textContent = String(count);
  el.hidden = count <= 0;
}

function initSideTabs(): void {
  const stored = localStorage.getItem(SIDE_TAB_STORAGE_KEY);
  setSideTab(isSideTab(stored) ? stored : 'rooms');

  for (const t of SIDE_TABS) {
    $(`side-tab-${t}`).addEventListener('click', () => setSideTab(t));
  }

  // navegación con flechas ←/→ dentro del tablist (roving tabindex, patrón
  // estándar de ARIA: solo la pestaña activa es alcanzable con Tab)
  $('home-side-tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const current = SIDE_TABS.findIndex((t) => $(`side-tab-${t}`).classList.contains('active'));
    const next = SIDE_TABS[(current + (e.key === 'ArrowRight' ? 1 : -1) + SIDE_TABS.length) % SIDE_TABS.length];
    setSideTab(next);
    $(`side-tab-${next}`).focus();
  });
}

export function initHome(): void {
  initSideTabs();
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

  // habilita «Crear sala» solo con nombre + visibilidad, y explica qué falta
  const createBtn = $<HTMLButtonElement>('btn-create');
  const createHint = $('create-hint');
  const updateCreateState = (): void => {
    const hasName = nameInput.value.trim().length > 0;
    const hasVis = homeVisibility !== null;
    createBtn.disabled = !hasName || !hasVis;
    createHint.classList.toggle('blocked', !hasName || !hasVis);
    createHint.textContent =
      !hasName && !hasVis
        ? 'Ponte un nombre y elige la visibilidad para crear la sala.'
        : !hasName
          ? 'Ponte un nombre para crear la sala 🙂'
          : !hasVis
            ? 'Elige si la sala será 🔒 privada o 🌐 pública.'
            : 'El mapa, el modo y la dificultad se eligen dentro, con tu equipo ya en la sala.';
  };
  wireSeg('home-visibility', (v) => {
    homeVisibility = v as 'private' | 'public';
    setSeg('home-visibility', v);
    updateCreateState();
  });
  // Pre-marcar "Pública" por defecto
  setSeg('home-visibility', 'public');
  updateCreateState();
  nameInput.addEventListener('input', updateCreateState);
  updateCreateState();

  createBtn.addEventListener('click', () => {
    const name = requireName();
    if (!name || homeVisibility === null) return;
    // conecta a una sala nueva (el backend asigna un código libre) y crea al abrir;
    // la visibilidad elegida viaja en los settings del create_room
    net.connect(wsPathCreate(), {
      type: 'create_room',
      name,
      token: store.token,
      settings: { ...homeSel, public: homeVisibility === 'public' },
    });
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
    // el `hidden` del panel es TERRITORIO EXCLUSIVO de las pestañas (setSideTab):
    // tocarlo aquí re-mostraba Salas cada 4 s aunque estuvieras en Récords. Un
    // !ok es transitorio (el worker siempre tiene directorio): conservar lo visible.
    if (!res.ok) return;
    const rooms = (await res.json()) as PublicRoomInfo[];
    renderRooms(Array.isArray(rooms) ? rooms : []);
  } catch {
    // error transitorio de red: conservar lo que hubiera en pantalla
  }
}

function renderRooms(rooms: PublicRoomInfo[]): void {
  $('home-rooms-empty').hidden = rooms.length > 0;
  setSideTabCount('rooms', rooms.length);
  const list = $('home-rooms-list');
  list.innerHTML = rooms
    .slice(0, 12)
    .map((r) => {
      const map = MAPS.find((m) => m.id === r.mapId);
      const mapName = map?.name ?? r.mapId;
      const state = r.inGame
        ? `<span class="room-state ingame">⚔️ Oleada ${r.wave}</span>`
        : '<span class="room-state lobby">🟢 En el lobby</span>';
      // fila escaneable: miniatura del mapa + anfitrión/estado arriba y las
      // etiquetas (mapa · modo · dificultad · jugadores) debajo
      return `<li class="room-row">
        <canvas class="room-thumb"${map ? ` data-map="${map.id}"` : ''} aria-hidden="true"></canvas>
        <div class="room-info">
          <div class="room-top"><b class="room-host">${escapeHtml(r.host)}</b>${state}</div>
          <div class="room-tags">
            <span class="room-tag">🗺 ${escapeHtml(mapName)}</span>
            <span class="room-tag">${MODE_LABELS[r.mode] ?? escapeHtml(r.mode)}</span>
            <span class="room-tag">${DIFF_EMOJI[r.difficulty] ?? ''} ${DIFF_LABELS[r.difficulty] ?? escapeHtml(r.difficulty)}</span>
            ${r.turbo ? '<span class="room-tag turbo">⚡ Turbo</span>' : ''}
            <span class="room-tag">👥 ${r.players}</span>
          </div>
        </div>
        <button class="btn small ${r.inGame ? 'ghost' : 'primary'}" data-code="${r.code}">${r.inGame ? '👁 Mirar' : '⚔️ Entrar'}</button>
      </li>`;
    })
    .join('');
  // las miniaturas se pintan tras el innerHTML (canvas no serializa contenido)
  for (const canvas of list.querySelectorAll<HTMLCanvasElement>('canvas[data-map]')) {
    const map = MAPS.find((m) => m.id === canvas.dataset.map);
    if (map) drawMiniMap(canvas, map);
  }
}

async function loadHighscores(): Promise<void> {
  try {
    const res = await fetch('/api/highscores');
    const scores = (await res.json()) as HighscoreEntry[];
    renderHighscores(Array.isArray(scores) ? scores : []);
  } catch {
    // error transitorio: conservar lo que hubiera en pantalla (el estado
    // vacío del panel, si aún no había cargado nada, ya lo cubre el HTML)
  }
}

// panel de récords: SIEMPRE se pinta (lista o estado vacío) — la visibilidad
// de la sección la decide la pestaña activa, no si hay datos (ver setSideTab)
function renderHighscores(scores: HighscoreEntry[]): void {
  $('home-scores-empty').hidden = scores.length > 0;
  setSideTabCount('scores', scores.length);
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
  // MODO TURBO ⚡ (issue #14): igual patrón; el server lo ignora en horda (sanitizeSettings)
  wireSeg('lobby-turbo', (v) => sendSettings({ turbo: v === 'on' }));

  $('btn-start').addEventListener('click', () => net.send({ type: 'start_game' }));

  // botón «Listo» (jugadores no-anfitrión): alterna el estado propio
  $('btn-ready').addEventListener('click', () => {
    const me = store.lobby.players.find((p) => p.id === store.playerId);
    net.send({ type: 'set_ready', ready: !(me?.ready ?? false) });
  });

  // banear pide confirmación (es irreversible para ese token); compartido entre
  // la lista de jugadores y la zona de espectadores. true si CONSUMIÓ el clic (esto
  // es síncrono: solo mira si el clic cayó en un botón de banear, no si el usuario
  // termina confirmando — el modal es asíncrono y se resuelve aparte).
  const handleBanClick = (e: Event): boolean => {
    const banBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-ban]');
    if (!banBtn || !store.isHost) return false;
    const name = banBtn.dataset.name ?? 'este jugador';
    const playerId = banBtn.dataset.ban!;
    void ask(
      `¿Banear a ${name}? No podrá volver a entrar a esta sala (expulsar sí le permite volver como espectador).`,
      { okLabel: 'Banear', danger: true },
    ).then((confirmed) => {
      if (confirmed) net.send({ type: 'ban_player', playerId });
    });
    return true;
  };

  // expulsar / banear / ceder anfitrión / mover a espectadores (solo anfitrión):
  // delegación en la lista de jugadores
  $('lobby-players').addEventListener('click', (e) => {
    if (handleBanClick(e)) return;
    const kickBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-kick]');
    if (kickBtn && store.isHost) {
      net.send({ type: 'kick_player', playerId: kickBtn.dataset.kick! });
      return;
    }
    const cedeBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-cede]');
    if (cedeBtn && store.isHost) {
      const name = cedeBtn.title.replace('Ceder anfitrión a ', '');
      const playerId = cedeBtn.dataset.cede!;
      void ask(`¿Ceder la sala a ${name}? Ya no podrás iniciar la partida ni cambiar los ajustes.`, { okLabel: 'Ceder' }).then(
        (confirmed) => {
          if (confirmed) net.send({ type: 'transfer_host', playerId });
        },
      );
      return;
    }
    const spectateBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-spectate]');
    if (spectateBtn && store.isHost) {
      net.send({ type: 'move_to_spectator', playerId: spectateBtn.dataset.spectate! });
    }
  });

  // traer de vuelta como jugador / banear (solo anfitrión): delegación en la zona
  // de espectadores (es un <ul> hermano de #lobby-players, no un descendiente)
  $('lobby-spectators').addEventListener('click', (e) => {
    if (handleBanClick(e)) return;
    const toPlayerBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-toplayer]');
    if (toPlayerBtn && store.isHost) {
      net.send({ type: 'move_to_player', spectatorId: toPlayerBtn.dataset.toplayer! });
    }
  });

  // issue #12 · lobby de una partida CARGADA: adoptar un slot libre (delegación)
  $('lobby-slots').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-claim]');
    if (btn) net.send({ type: 'claim_slot', slot: btn.dataset.claim! });
  });

  // F9b · reclamar/liberar puerta (delegación): clic en la propia la libera; clic
  // en una libre la reclama. Las de otros están deshabilitadas (no roban puerta).
  // F9d · el botón 🚫/🔓 del anfitrión cierra/reabre la puerta: viaja como un
  // ajuste de sala más (set_settings.closedDoors) y el server lo valida entero.
  $('lobby-doors').addEventListener('click', (e) => {
    const closeBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-close]');
    if (closeBtn && store.isHost) {
      const door = Number(closeBtn.dataset.close);
      const current = store.lobby.settings.closedDoors ?? [];
      const next = current.includes(door) ? current.filter((d) => d !== door) : [...current, door];
      sendSettings({ closedDoors: next });
      return;
    }
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-door]');
    if (!btn || btn.disabled) return;
    const door = Number(btn.dataset.door);
    const me = store.lobby.players.find((p) => p.id === store.playerId);
    net.send({ type: 'claim_door', door: me?.door === door ? null : door });
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
  // issue #12 · lobby de una partida CARGADA: vista distinta (banner + slots)
  if (store.lobby.saved) {
    renderSavedLobby(store.lobby.saved);
    return;
  }
  // lobby normal: asegurar que los elementos del modo «guardado» están ocultos
  $('lobby-saved-banner').hidden = true;
  $('lobby-slots').hidden = true;
  $('lobby-slots-hint').hidden = true;
  $('lobby-players').hidden = false;
  $('lobby-players-title').textContent = 'Jugadores';
  $('lobby-maps-box').hidden = false;
  $('lobby-settings-fields').hidden = false;

  const { players, spectators, settings } = store.lobby;
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
      // el anfitrión puede ceder la sala a otro jugador CONECTADO, y expulsar a
      // cualquiera, incluso desconectado (limpia los huecos fantasma del lobby)
      const cede = store.isHost && !isMe && p.connected
        ? `<button class="cede-btn" data-cede="${p.id}" title="Ceder anfitrión a ${escapeHtml(p.name)}" aria-label="Ceder anfitrión">👑</button>`
        : '';
      // expulsar (kick): lo saca de la sala, pero puede volver — solo de espectador
      const kick = store.isHost && !isMe
        ? `<button class="kick-btn" data-kick="${p.id}" title="Expulsar a ${escapeHtml(p.name)} (podrá volver como espectador)" aria-label="Expulsar">✕</button>`
        : '';
      // banear: lo saca y su token ya no puede volver a entrar de ninguna forma
      const ban = store.isHost && !isMe
        ? `<button class="ban-btn" data-ban="${p.id}" data-name="${escapeHtml(p.name)}" title="Banear a ${escapeHtml(p.name)} (no podrá volver)" aria-label="Banear">🚫</button>`
        : '';
      // mover a la zona de espectadores: para quien no quiere jugar la revancha,
      // sin sacarlo de la sala. Solo CONECTADOS: sin socket no hay a quién
      // reclasificar (el server lo rechaza igualmente).
      const spectate = store.isHost && !isMe && !p.isHost && p.connected
        ? `<button class="spectate-btn" data-spectate="${p.id}" title="Mover a ${escapeHtml(p.name)} a espectadores" aria-label="Mover a espectadores">👁</button>`
        : '';
      return `
      <li class="${p.connected ? '' : 'offline'}">
        <span class="player-dot" style="background:${p.color};color:${p.color}"></span>
        <span class="player-name">${escapeHtml(p.name)}${isMe ? ' (tú)' : ''}</span>
        ${badge}
        ${cede}
        ${spectate}
        ${kick}
        ${ban}
      </li>`;
    })
    .join('');

  renderSpectatorZone();

  const selectedMap = MAPS.find((m) => m.id === settings.mapId);
  const doorColors = doorColorsFor(selectedMap);
  renderMapCards('lobby-maps', settings.mapId, !store.isHost, (id) => sendSettings({ mapId: id }), doorColors, settings.closedDoors);
  $('lobby-map-desc').textContent = mapDesc(settings.mapId);
  // F9b · lista de puertas reclamables (solo mapas multi-ruta; oculta si no)
  renderDoors(selectedMap);
  setSeg('lobby-mode', settings.mode, !store.isHost);
  setSeg('lobby-diff', settings.difficulty, !store.isHost);
  setSeg('lobby-visibility', settings.public ? 'public' : 'private', !store.isHost);
  // MODO TURBO ⚡: en HORDA no aplica (economía de bucle) → se deshabilita y se
  // muestra el porqué. Fuera de horda: editable solo por el anfitrión.
  const turboHorde = settings.mode === 'horde';
  setSeg('lobby-turbo', settings.turbo ? 'on' : 'off', !store.isHost || turboHorde);
  $('lobby-turbo-hint').textContent = turboHorde
    ? 'El Turbo ⚡ no aplica en Horda (su economía es un bucle de saturación).'
    : 'Economía ×1.75, madera ×1.5, interludios a la mitad. Mismo reto, la mitad de tiempo. Sin récords.';

  // estado de «Listo» del equipo (solo cuentan los no-anfitriones conectados)
  const others = players.filter((p) => p.connected && !p.isHost);
  const readyCount = others.filter((p) => p.ready).length;
  const allReady = others.every((p) => p.ready);
  const me = players.find((p) => p.id === store.playerId);

  const startBtn = $<HTMLButtonElement>('btn-start');
  const readyBtn = $<HTMLButtonElement>('btn-ready');
  const status = $('lobby-ready-status');

  // en la zona de espectadores del lobby no hay «Listo» que marcar: solo se
  // espera a que el anfitrión te traiga de vuelta como jugador
  startBtn.hidden = !store.isHost;
  readyBtn.hidden = store.isHost || store.spectator;
  $('lobby-wait').hidden = store.isHost || store.spectator;
  $('lobby-spectating').hidden = !store.spectator;

  if (store.isHost) {
    startBtn.disabled = !allReady;
    startBtn.textContent = allReady ? '▶ ¡Empezar partida!' : '⏳ Esperando a que todos estén listos…';
    status.hidden = others.length === 0;
    status.textContent = others.length > 0 ? `${readyCount}/${others.length} jugadores listos` : '';
  } else if (!store.spectator) {
    const iAmReady = me?.ready ?? false;
    readyBtn.classList.toggle('active', iAmReady);
    readyBtn.textContent = iAmReady ? '⏳ Cancelar «Listo»' : '✅ Estoy listo';
    status.hidden = true;
  } else {
    status.hidden = true;
  }
}

// issue #12 · lobby de una partida CARGADA (guardado): banner con el resumen y
// lista de slots reclamables. Cada jugador recupera su slot por token (auto) o
// adopta uno libre. El anfitrión (quien cargó) reanuda cuando quiera.
function renderSavedLobby(saved: SavedLobbyInfo): void {
  $('lobby-code').textContent = store.roomCode;

  const mapName = MAPS.find((m) => m.id === saved.mapId)?.name ?? saved.mapId;
  const n = saved.slots.length;
  const banner = $('lobby-saved-banner');
  banner.hidden = false;
  banner.innerHTML = `<b>📥 Partida guardada</b> · 🗺 ${escapeHtml(mapName)} · ${
    MODE_LABELS[saved.mode] ?? escapeHtml(saved.mode)
  } · ${DIFF_EMOJI[saved.difficulty] ?? ''} ${DIFF_LABELS[saved.difficulty] ?? escapeHtml(saved.difficulty)} · ⚔️ oleada ${
    saved.wave
  } · 🛡 ${n} defensor${n === 1 ? '' : 'es'}`;

  // ocultar la edición de ajustes (mapa/modo/dificultad los fija el guardado)
  $('lobby-maps-box').hidden = true;
  $('lobby-settings-fields').hidden = true;

  // slots en lugar de la lista de jugadores
  $('lobby-players').hidden = true;
  $('lobby-players-title').textContent = 'Defensores';
  const slotsEl = $('lobby-slots');
  slotsEl.hidden = false;
  $('lobby-slots-hint').hidden = false;
  const nameById = new Map(store.lobby.players.map((p) => [p.id, p.name]));
  slotsEl.innerHTML = saved.slots
    .map((s) => {
      const mine = s.claimedBy === store.playerId;
      const claimedName = s.claimedBy ? nameById.get(s.claimedBy) ?? 'alguien' : null;
      const status = mine
        ? '<span class="ready-tag on">✅ tú</span>'
        : claimedName
          ? `<span class="ready-tag on">👤 ${escapeHtml(claimedName)}</span>`
          : `<button class="btn small primary" data-claim="${s.id}">Adoptar</button>`;
      return `<li>
        <span class="player-dot" style="background:${s.color};color:${s.color}"></span>
        <span class="player-name">${escapeHtml(s.name)}</span>
        ${status}
      </li>`;
    })
    .join('');

  // la zona de espectadores también existe aquí (benchados o expulsados que
  // volvieron): misma lista y botones 🎮/🚫 que en el lobby normal
  renderSpectatorZone();

  // controles: el anfitrión reanuda; el resto espera
  const startBtn = $<HTMLButtonElement>('btn-start');
  const readyBtn = $<HTMLButtonElement>('btn-ready');
  startBtn.hidden = !store.isHost;
  startBtn.disabled = false;
  startBtn.textContent = '▶ ¡Reanudar partida!';
  readyBtn.hidden = true;
  $('lobby-ready-status').hidden = true;
  $('lobby-wait').hidden = store.isHost;
}

// zona de espectadores del lobby (normal o de guardado): solo visible cuando hay
// alguien ahí. El anfitrión puede traerlos de vuelta como jugador (🎮, respetando
// MAX_PLAYERS en el server) o banearlos (🚫).
function renderSpectatorZone(): void {
  const spectators = store.lobby.spectators;
  $('lobby-spectators-box').hidden = spectators.length === 0;
  $('lobby-spectators').innerHTML = spectators
    .map((s) => {
      const isMe = s.id === store.playerId;
      const toPlayer = store.isHost && !isMe
        ? `<button class="cede-btn" data-toplayer="${s.id}" title="Traer a ${escapeHtml(s.name)} como jugador" aria-label="Traer como jugador">🎮</button>`
        : '';
      // banear también desde la zona de espectadores (p. ej. un expulsado que
      // volvió de espectador y sigue molestando en el chat)
      const ban = store.isHost && !isMe
        ? `<button class="ban-btn" data-ban="${s.id}" data-name="${escapeHtml(s.name)}" title="Banear a ${escapeHtml(s.name)} (no podrá volver)" aria-label="Banear">🚫</button>`
        : '';
      return `
      <li>
        <span class="player-name">👁 ${escapeHtml(s.name)}${isMe ? ' (tú)' : ''}</span>
        ${toPlayer}
        ${ban}
      </li>`;
    })
    .join('');
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
