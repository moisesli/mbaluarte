import {
  AFFIXES,
  affixesFromMask,
  activeStats,
  ENEMIES,
  ENEMY_ORDER,
  fusionByIndex,
  INTERP_DELAY_MS,
  TOWERS,
  TOWER_ORDER,
  towerTargetsAir,
  makePlacementContext,
  pathWaypoints,
  type EnemyTypeId,
  type FusionId,
  type MapDef,
  type PlacementContext,
  type Snap,
  type SnapEnemy,
  type SnapTower,
  type TowerLevelDef,
  type TowerTypeId,
} from '@td/shared';
import { store, type GameStore, type SnapFrame } from './store.js';
import { drawParticles, floatText, updateParticles, fx } from './particles.js';
import { getTowerSprite, getProjSprite } from './sprites.js';

// ancho del sprite de torre en celdas (la base ≈ este valor; la estructura sube).
const SPRITE_W = 1.15;
// LARGO (alto) del sprite de proyectil en celdas — apuntan al norte, así que su
// dimensión larga es la altura; escalar por ancho hacía las flechas enormes.
const PROJ_H = 0.7;
// sprite de proyectil por tipo de torre (tesla/francotirador son instantáneos, sin sprite).
const PROJ_BY_TYPE: Partial<Record<TowerTypeId, string>> = {
  archer: 'arrow',
  frost: 'iceshard',
  poison: 'poison',
  cannon: 'cannonball',
  mortar: 'bomb',
};

// Los emojis siguen siendo el "lenguaje" de iconos del HUD (DOM);
// en el canvas todo se dibuja con arte vectorial procedural.
export const TOWER_ICONS: Record<TowerTypeId, string> = {
  archer: '🏹',
  cannon: '💣',
  frost: '❄️',
  poison: '☠️',
  tesla: '⚡',
  sniper: '🎯',
  mortar: '🧨',
  bank: '💰',
  banner: '🚩',
  // F4.2
  trap: '🪤',
  alchemist: '⚗️',
  // F4.4
  boom: '💥',
  // Lote 3
  sentry: '👁',
};

export const ENEMY_ICONS: Record<EnemyTypeId, string> = {
  goblin: '👺',
  runner: '🏃',
  brute: '👹',
  bat: '🦇',
  armored: '🛡️',
  shaman: '🧙',
  larva: '🐛',
  troll: '🧌',
  slime: '🫧',
  slimelet: '💧',
  ghost: '👻',
  golem: '🗿',
  // F4.1
  sapper: '🔨',
  thief: '💰',
  berserker: '🐗',
  skywhale: '🐋',
  wraith: '👤',
  chimera: '🦁',
  behemoth: '🦏',
};

// ---------- paletas por tema ----------

interface Theme {
  sky: string; // fondo fuera del mapa
  tones: [string, string, string]; // variación del suelo
  path: string;
  pathEdge: string;
  pathStone: string;
  ambient: 'leaves' | 'sand' | 'snow' | 'embers' | 'sparkles';
  decor: ('pine' | 'rock' | 'flower' | 'cactus' | 'skull' | 'snowpine' | 'snowman' | 'obsidian' | 'lavacrack' | 'crystal' | 'mushroom')[];
}

const THEMES: Record<MapDef['theme'], Theme> = {
  grass: {
    sky: '#131a12',
    tones: ['#2e4b2c', '#335231', '#294427'],
    path: '#8a6f4d',
    pathEdge: '#5f4a30',
    pathStone: '#9c7f5c',
    ambient: 'leaves',
    decor: ['pine', 'pine', 'rock', 'flower'],
  },
  desert: {
    sky: '#1c150c',
    tones: ['#8a7449', '#937d50', '#806b42'],
    path: '#c2a878',
    pathEdge: '#8d764f',
    pathStone: '#d3bb8d',
    ambient: 'sand',
    decor: ['cactus', 'cactus', 'rock', 'skull'],
  },
  snow: {
    sky: '#0e1420',
    tones: ['#9fb4c7', '#a9bdcf', '#93a9bd'],
    path: '#d7e3ee',
    pathEdge: '#8ea3b8',
    pathStone: '#e8f1f8',
    ambient: 'snow',
    decor: ['snowpine', 'snowpine', 'rock', 'snowman'],
  },
  volcano: {
    sky: '#160b08',
    tones: ['#3a2b28', '#42302c', '#332521'],
    path: '#6b5147',
    pathEdge: '#472f28',
    pathStone: '#7d6156',
    ambient: 'embers',
    decor: ['obsidian', 'obsidian', 'lavacrack', 'rock'],
  },
  crystal: {
    sky: '#0b0a18',
    tones: ['#2b2547', '#312a52', '#251f3e'],
    path: '#5d5480',
    pathEdge: '#3c3559',
    pathStone: '#6f6596',
    ambient: 'sparkles',
    decor: ['crystal', 'crystal', 'mushroom', 'rock'],
  },
};

// ---------- estado del renderer ----------

interface View {
  ox: number;
  oy: number;
  scale: number;
}

let canvas: HTMLCanvasElement;
let g: CanvasRenderingContext2D;
let view: View = { ox: 0, oy: 0, scale: 40 };
let baseScale = 40;
let zoom = 1;
let panX = 0;
let panY = 0;
const MAX_ZOOM = 3.2;

let mapLayer: HTMLCanvasElement | null = null;
let mapLayerKey = '';
let mapLayerScale = 40; // px por celda dentro de la capa estática

// ---------- minimapa ----------
// recuadro en coordenadas de PANTALLA calculado en cada frame (o null si oculto)
let miniRect: { x: number; y: number; w: number; h: number; s: number } | null = null;
let miniOn = localStorage.getItem('td_minimap') !== '0'; // visible por defecto

export function isMinimapOn(): boolean {
  return miniOn;
}

export function toggleMinimap(): boolean {
  miniOn = !miniOn;
  localStorage.setItem('td_minimap', miniOn ? '1' : '0');
  return miniOn;
}
let placeCtx: PlacementContext | null = null;
let placeCtxMap = '';
let lastTime = performance.now();
let shake = 0;

// animación por torre (ángulo de torreta, retroceso, fogonazo)
const towerAnim = new Map<number, { angle: number; recoil: number; flash: number }>();
// detección de proyectiles nuevos (para fogonazos) y estelas
const projSeen = new Set<number>();
const projPrev = new Map<number, { x: number; y: number }>();

// partículas ambientales (nieve, brasas…), separadas de las de eventos
interface Ambient { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; kind: Theme['ambient'] }
const ambient: Ambient[] = [];

// pings cooperativos: marcadores efímeros en el mapa con el color del jugador.
// Si trae towerType, es una SUGERENCIA de torre (fantasma de esa torre).
interface Ping { x: number; y: number; color: string; name: string; life: number; towerType?: TowerTypeId }
const PING_LIFE = 2.6;
const SUGGEST_LIFE = 4.5; // las sugerencias de torre duran un poco más
const pings: Ping[] = [];

const toX = (x: number) => view.ox + x * view.scale;
const toY = (y: number) => view.oy + y * view.scale;

export function getView(): View {
  return view;
}

export function getZoom(): number {
  return zoom;
}

// zoom manteniendo fijo el punto (px, py) en coordenadas CSS del canvas
export function zoomAt(px: number, py: number, factor: number): void {
  const gs = store.game;
  if (!gs) return;
  const worldX = (px - view.ox) / view.scale;
  const worldY = (py - view.oy) / view.scale;
  zoom = Math.min(MAX_ZOOM, Math.max(1, zoom * factor));
  const s2 = baseScale * zoom;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const ox2 = px - worldX * s2;
  const oy2 = py - worldY * s2;
  panX = ox2 - (w - gs.map.gridW * s2) / 2;
  panY = oy2 - (PAD_TOP + (h - PAD_TOP - PAD_BOTTOM - gs.map.gridH * s2) / 2);
  // actualizar la vista YA: durante un pellizco llegan varios eventos por frame
  // y el siguiente debe partir de esta vista, no de la del último rAF
  view = { scale: s2, ox: ox2, oy: oy2 };
}

export function panBy(dx: number, dy: number): void {
  panX += dx;
  panY += dy;
  view.ox += dx;
  view.oy += dy;
}

// Cámara inicial estilo Green TD: en TÁCTIL no se muestra todo el mapa de golpe
// — se arranca ACERCADO (×1.6) sobre la entrada de los enemigos, que es donde se
// construye al principio. El resto del mapa se explora paneando, con pellizco/
// rueda (el zoom mínimo sigue mostrando el mapa entero) o con el minimapa, que
// así recupera su razón de ser. El doble tap vuelve a ESTA vista.
//
// En ESCRITORIO (ratón con hover fino) este arranque acercado resultó ser mala
// UX real (issue: "siempre que entro por desktop hay que hacer antizoom"): el
// jugador tenía que alejar el zoom a mano en CADA partida para ver el tablero
// completo. Ahí el reset muestra el mapa entero de una vez (zoom 1 = el fit
// calculado en computeView), que es exactamente lo que el jugador quería.
const START_ZOOM = 1.6;
const HAS_HOVER = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
// centro pendiente de aplicar: computeView lo consume cuando ya conoce el
// baseScale real del frame (aplicarlo aquí usaría una escala desfasada)
let pendingCenter: { x: number; y: number } | null = null;

export function resetCamera(): void {
  const gs = store.game;
  if (!gs || HAS_HOVER) {
    zoom = 1;
    panX = 0;
    panY = 0;
    pendingCenter = null;
    return;
  }
  zoom = START_ZOOM;
  panX = 0;
  panY = 0;
  const [c, r] = gs.map.paths[0][0];
  pendingCenter = { x: c + 0.5, y: r + 0.5 };
}

// Centra la cámara sobre un punto del mundo (celdas). Ajusta panX/panY; el
// siguiente computeView() los recorta a los límites del mapa. Usado por el
// minimapa. No cambia el zoom.
export function centerOn(worldX: number, worldY: number): void {
  const gs = store.game;
  if (!gs) return;
  const s = baseScale * zoom;
  const mapW = gs.map.gridW * s;
  const mapH = gs.map.gridH * s;
  panX = mapW / 2 - worldX * s;
  panY = mapH / 2 - worldY * s;
}

// limpieza total al empezar una partida nueva: cámara, sacudida, partículas
// ambientales del tema anterior y animaciones de torres/proyectiles viejos
export function resetRenderer(): void {
  resetCamera();
  shake = 0;
  ambient.length = 0;
  pings.length = 0;
  towerAnim.clear();
  projSeen.clear();
  projPrev.clear();
  orcCampsKey = ''; // los campamentos dependen del mapa y del nº de jugadores
  orcWoodSeen.clear();
}

export function addShake(mag: number): void {
  shake = Math.min(14, shake + mag);
}

// marca un ping cooperativo en (x, y) celdas. Con towerType es una sugerencia de
// torre: se dibuja el fantasma de esa torre en la celda (ver drawPings).
export function addPing(x: number, y: number, color: string, name: string, towerType?: TowerTypeId): void {
  pings.push({ x, y, color, name, life: towerType ? SUGGEST_LIFE : PING_LIFE, towerType });
  if (pings.length > 12) pings.shift();
}

// ---------- orcos leñadores (F5.4, cosmético) ----------
// La madera la tala "tu orco" (en la sim es un goteo pasivo); esto lo hace
// VISIBLE: cada jugador tiene un orco hacheando junto a una decoración del mapa
// (celdas `blocked`, no construibles — nunca chocan con torres). Puro cliente.
interface OrcCamp { x: number; y: number }
let orcCampsKey = '';
let orcCamps: OrcCamp[] = [];
// último 🪵 entero visto por jugador, para el "+🪵" flotante del orco propio
const orcWoodSeen = new Map<string, number>();

function campsFor(map: MapDef, players: number): OrcCamp[] {
  const key = `${map.id}:${players}`;
  if (key === orcCampsKey) return orcCamps;
  orcCampsKey = key;
  orcCamps = [];
  const n = map.blocked.length;
  for (let i = 0; i < players && n > 0; i++) {
    // repartidos por las decoraciones del mapa (espaciados entre sí)
    const [c, r] = map.blocked[Math.floor((i * n) / Math.max(1, players)) % n];
    orcCamps.push({ x: c + 0.5, y: r + 0.5 });
  }
  return orcCamps;
}

// filo del hacha por nivel del orco (F5.5): piedra → cobre → dorado → gélido → arcano
const ORC_BLADE_COLORS = ['#cfd8dc', '#ffcc80', '#ffd54f', '#80deea', '#ce93d8'];

function drawOrcs(gs: GameStore, now: number): void {
  const players = gs.init.players;
  const camps = campsFor(gs.map, players.length);
  const s = view.scale;
  const t = now / 1000;
  for (let i = 0; i < camps.length && i < players.length; i++) {
    const p = players[i];
    const camp = camps[i];
    const x = toX(camp.x - 0.62);
    const y = toY(camp.y + 0.12);
    // nivel del orco (del snapshot): hacha mejor y hachazos más rápidos
    const orcLvl = gs.latest?.players.find((sp) => sp.id === p.id)?.orcLevel ?? 1;
    // cada orco hachea con su propia fase (más nivel = más cadencia)
    const ph = (t * (2.4 + (orcLvl - 1) * 0.35) + i * 1.9) % (Math.PI * 2);
    const swing = Math.sin(ph);
    const hit = swing > 0.92; // instante del hachazo

    g.save();
    g.translate(x, y);
    const os = s * 0.52; // orco de ~media celda
    // sombra
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath();
    g.ellipse(0, os * 0.44, os * 0.32, os * 0.09, 0, 0, Math.PI * 2);
    g.fill();
    // cuerpo
    g.fillStyle = '#4a7c3f';
    roundRect(g, -os * 0.22, -os * 0.08, os * 0.44, os * 0.5, os * 0.12);
    g.fill();
    // faja con el color del dueño (para saber de quién es cada orco)
    g.fillStyle = p.color;
    roundRect(g, -os * 0.22, os * 0.2, os * 0.44, os * 0.13, os * 0.05);
    g.fill();
    // cabeza con orejas puntiagudas y colmillos
    g.fillStyle = '#5d9950';
    g.beginPath();
    g.arc(0, -os * 0.26, os * 0.2, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.moveTo(-os * 0.18, -os * 0.34);
    g.lineTo(-os * 0.34, -os * 0.44);
    g.lineTo(-os * 0.14, -os * 0.46);
    g.closePath();
    g.moveTo(os * 0.18, -os * 0.34);
    g.lineTo(os * 0.34, -os * 0.44);
    g.lineTo(os * 0.14, -os * 0.46);
    g.closePath();
    g.fill();
    g.fillStyle = '#f5f5f5';
    g.fillRect(-os * 0.09, -os * 0.19, os * 0.05, os * 0.07); // colmillo izq
    g.fillRect(os * 0.05, -os * 0.19, os * 0.05, os * 0.07); // colmillo der
    // brazo + hacha (pivote en el hombro; balancea hacia la decoración)
    g.save();
    g.translate(os * 0.16, -os * 0.04);
    g.rotate(-0.95 + swing * 0.85);
    g.strokeStyle = '#3c6634';
    g.lineWidth = Math.max(1.5, os * 0.09);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(os * 0.34, 0);
    g.stroke();
    g.strokeStyle = '#8d6e63';
    g.lineWidth = Math.max(1.2, os * 0.06);
    g.beginPath();
    g.moveTo(os * 0.26, 0);
    g.lineTo(os * 0.62, 0);
    g.stroke();
    // filo según nivel; al máximo, brilla
    g.fillStyle = ORC_BLADE_COLORS[Math.min(orcLvl, ORC_BLADE_COLORS.length) - 1];
    if (orcLvl >= ORC_BLADE_COLORS.length) {
      g.shadowColor = ORC_BLADE_COLORS[ORC_BLADE_COLORS.length - 1];
      g.shadowBlur = os * 0.25;
    }
    g.beginPath();
    g.moveTo(os * 0.62, -os * 0.14);
    g.lineTo(os * 0.8, 0);
    g.lineTo(os * 0.62, os * 0.14);
    g.closePath();
    g.fill();
    g.shadowBlur = 0;
    g.restore();
    // astillas al impactar
    if (hit) {
      g.strokeStyle = '#d7ccc8';
      g.lineWidth = Math.max(1, os * 0.045);
      for (let k = 0; k < 3; k++) {
        const a = -0.7 + k * 0.55;
        g.beginPath();
        g.moveTo(os * 0.66, -os * 0.06);
        g.lineTo(os * (0.66 + 0.24 * Math.cos(a)), -os * 0.06 + os * 0.24 * Math.sin(a));
        g.stroke();
      }
    }
    g.restore();

    // "+🪵" flotante SOLO del orco propio (con 8 jugadores sería ruido)
    if (p.id === store.playerId && gs.latest) {
      const me = gs.latest.players.find((sp) => sp.id === p.id);
      if (me) {
        const seen = orcWoodSeen.get(p.id);
        if (seen !== undefined && me.wood > seen) {
          floatText(camp.x - 0.62, camp.y - 0.55, `+🪵${me.wood - seen}`, p.color, 11);
        }
        if (me.wood !== seen) orcWoodSeen.set(p.id, me.wood);
      }
    }
  }
}

// fogonazo + retroceso de la torre más cercana a (x, y) en celdas
export function towerFired(x: number, y: number): void {
  const gs = store.game;
  if (!gs?.latest) return;
  let best = -1;
  let bestD = 0.8;
  for (const t of gs.latest.towers) {
    const d = Math.hypot(t[2] + 0.5 - x, t[3] + 0.5 - y);
    if (d < bestD) {
      bestD = d;
      best = t[0];
    }
  }
  if (best >= 0) {
    const a = towerAnim.get(best);
    if (a) {
      a.recoil = 1;
      a.flash = 1;
    }
  }
}

export function getPlacementCtx(map: MapDef): PlacementContext {
  if (placeCtxMap !== map.id || !placeCtx) {
    placeCtx = makePlacementContext(map);
    placeCtxMap = map.id;
  }
  return placeCtx;
}

export function initRenderer(c: HTMLCanvasElement): void {
  canvas = c;
  g = canvas.getContext('2d')!;
  requestAnimationFrame(loop);
}

// ---------- utilidades ----------

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263) ^ (seed * 144665);
  h = (h ^ (h >> 13)) * 1274126177;
  h = (h ^ (h >> 16)) >>> 0;
  return h / 4294967295;
}

function strSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h;
}

const shadeCache = new Map<string, string>();
function shade(hex: string, f: number): string {
  const key = `${hex}:${f}`;
  const hit = shadeCache.get(key);
  if (hit) return hit;
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * f)));
  const gr = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * f)));
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * f)));
  const out = `rgb(${r},${gr},${b})`;
  shadeCache.set(key, out);
  return out;
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// El canvas nace con la pantalla de juego oculta (0×0), así que el tamaño se
// comprueba en CADA frame: cubre la primera aparición, resize, rotación y DPR.
function ensureCanvasSize(): boolean {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (w === 0 || h === 0) return false; // pantalla aún oculta
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    mapLayerKey = ''; // fuerza regenerar la capa del mapa
  }
  return true;
}

const PAD_TOP = 54;
const PAD_BOTTOM = 106;
const PAD_SIDE = 10;

function computeView(map: MapDef): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const availW = w - PAD_SIDE * 2;
  const availH = h - PAD_TOP - PAD_BOTTOM;
  baseScale = Math.max(6, Math.min(availW / map.gridW, availH / map.gridH));
  // centro diferido de resetCamera: se aplica con el baseScale fresco de ESTE
  // frame (el clampeo de abajo lo recorta a los bordes del mapa)
  if (pendingCenter) {
    const s0 = baseScale * zoom;
    panX = (map.gridW * s0) / 2 - pendingCenter.x * s0;
    panY = (map.gridH * s0) / 2 - pendingCenter.y * s0;
    pendingCenter = null;
  }
  const s = baseScale * zoom;
  const mapW = map.gridW * s;
  const mapH = map.gridH * s;

  // centrado por defecto; con zoom, el paneo se limita a los bordes del mapa
  let ox = (w - mapW) / 2 + panX;
  let oy = PAD_TOP + (availH - mapH) / 2 + panY;
  if (mapW <= availW) {
    ox = (w - mapW) / 2;
    panX = 0;
  } else {
    ox = Math.min(PAD_SIDE, Math.max(w - PAD_SIDE - mapW, ox));
    panX = ox - (w - mapW) / 2;
  }
  if (mapH <= availH) {
    oy = PAD_TOP + (availH - mapH) / 2;
    panY = 0;
  } else {
    oy = Math.min(PAD_TOP, Math.max(h - PAD_BOTTOM - mapH, oy));
    panY = oy - (PAD_TOP + (availH - mapH) / 2);
  }
  view = { scale: s, ox, oy };
}

// ---------- capa estática del mapa ----------

function decorAt(theme: Theme, r: number): Theme['decor'][number] {
  return theme.decor[Math.floor(r * theme.decor.length) % theme.decor.length];
}

function buildMapLayer(map: MapDef): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // la capa se construye en "cubetas" de zoom para mantenerla nítida sin
  // regenerarla en cada frame de un pellizco
  const bucket = zoom < 1.25 ? 1 : zoom < 1.75 ? 1.5 : zoom < 2.5 ? 2 : 3;
  let ls = baseScale * bucket * dpr;
  const maxDim = 4096;
  ls = Math.min(ls, maxDim / Math.max(map.gridW, map.gridH));
  const key = `${map.id}:${Math.round(ls * 4)}:${canvas.width}x${canvas.height}`;
  if (mapLayerKey === key && mapLayer) return;
  mapLayerKey = key;
  mapLayerScale = ls;

  const s = ls;
  const seed = strSeed(map.id);
  const theme = THEMES[map.theme];
  const layer = document.createElement('canvas');
  layer.width = Math.max(1, Math.round(map.gridW * s));
  layer.height = Math.max(1, Math.round(map.gridH * s));
  const m = layer.getContext('2d')!;

  // suelo con variación orgánica de tonos
  for (let cy = 0; cy < map.gridH; cy++) {
    for (let cx = 0; cx < map.gridW; cx++) {
      const r = hash2(cx, cy, seed);
      m.fillStyle = theme.tones[Math.floor(r * 3) % 3];
      m.fillRect(cx * s, cy * s, s + 1, s + 1);
    }
  }
  // luz suave hacia el centro
  const grad = m.createRadialGradient(
    layer.width / 2, layer.height / 2, Math.min(layer.width, layer.height) * 0.2,
    layer.width / 2, layer.height / 2, Math.max(layer.width, layer.height) * 0.75,
  );
  grad.addColorStop(0, 'rgba(255,255,240,0.07)');
  grad.addColorStop(1, 'rgba(0,0,20,0.18)');
  m.fillStyle = grad;
  m.fillRect(0, 0, layer.width, layer.height);

  // detalles del suelo (matas, piedritas, destellos…) en celdas libres
  const pathSet = getPlacementCtx(map).paths;
  for (let cy = 0; cy < map.gridH; cy++) {
    for (let cx = 0; cx < map.gridW; cx++) {
      if (pathSet.has(`${cx},${cy}`)) continue;
      const r = hash2(cx * 7 + 3, cy * 5 + 1, seed);
      if (r > 0.5) continue;
      const px = (cx + 0.2 + hash2(cx, cy, seed + 1) * 0.6) * s;
      const py = (cy + 0.2 + hash2(cx, cy, seed + 2) * 0.6) * s;
      drawGroundDetail(m, map.theme, px, py, s, r);
    }
  }

  // camino: borde, relleno y adoquines
  for (const path of map.paths) {
    const wps = path.map(([c, r]) => [(c + 0.5) * s, (r + 0.5) * s] as const);
    for (const [width, color] of [
      [s * 0.92, theme.pathEdge],
      [s * 0.72, theme.path],
    ] as const) {
      m.strokeStyle = color;
      m.lineWidth = width;
      m.lineCap = 'round';
      m.lineJoin = 'round';
      m.beginPath();
      m.moveTo(wps[0][0], wps[0][1]);
      for (let i = 1; i < wps.length; i++) m.lineTo(wps[i][0], wps[i][1]);
      m.stroke();
    }
  }
  // adoquines sobre las celdas del camino
  m.fillStyle = theme.pathStone;
  for (const cell of pathSet) {
    const [cx, cy] = cell.split(',').map(Number);
    for (let i = 0; i < 3; i++) {
      const r1 = hash2(cx * 31 + i, cy * 17 + i, seed);
      const r2 = hash2(cx * 13 + i, cy * 41 + i, seed + 9);
      if (r1 < 0.35) continue;
      m.globalAlpha = 0.35;
      m.beginPath();
      m.ellipse((cx + 0.25 + r1 * 0.5) * s, (cy + 0.25 + r2 * 0.5) * s, s * 0.07, s * 0.05, r1 * 3, 0, Math.PI * 2);
      m.fill();
    }
  }
  m.globalAlpha = 1;

  // flechas de dirección
  m.fillStyle = 'rgba(0,0,0,0.16)';
  for (let p = 0; p < map.paths.length; p++) {
    const wps = pathWaypoints(map, p);
    for (let i = 1; i < wps.length; i++) {
      const a = wps[i - 1];
      const b = wps[i];
      const segLen = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      const steps = Math.floor(segLen / 2.5);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      for (let j = 1; j <= steps; j++) {
        const t = j / (steps + 1);
        const x = (a.x + (b.x - a.x) * t) * s;
        const y = (a.y + (b.y - a.y) * t) * s;
        m.save();
        m.translate(x, y);
        m.rotate(ang);
        m.beginPath();
        m.moveTo(s * 0.13, 0);
        m.lineTo(-s * 0.05, -s * 0.11);
        m.lineTo(-s * 0.01, 0);
        m.lineTo(-s * 0.05, s * 0.11);
        m.fill();
        m.restore();
      }
    }
  }

  // decoración vectorial en celdas bloqueadas
  for (const [c, r] of map.blocked) {
    const kind = decorAt(theme, hash2(c, r, seed + 5));
    drawDecor(m, kind, (c + 0.5) * s, (r + 0.5) * s, s, hash2(c, r, seed + 6));
  }

  // portales (entradas) y castillo (salidas)
  for (const path of map.paths) {
    const [sc, sr] = path[0];
    drawPortalBase(m, (sc + 0.5) * s, (sr + 0.5) * s, s);
  }
  const exits = new Set(map.paths.map((p) => p[p.length - 1].join(',')));
  for (const e of exits) {
    const [ec, er] = e.split(',').map(Number);
    drawCastle(m, (ec + 0.5) * s, (er + 0.5) * s, s);
  }

  mapLayer = layer;
}

function drawGroundDetail(m: CanvasRenderingContext2D, theme: MapDef['theme'], x: number, y: number, s: number, r: number): void {
  m.save();
  m.translate(x, y);
  if (theme === 'grass') {
    m.strokeStyle = 'rgba(20,60,20,0.5)';
    m.lineWidth = Math.max(1, s * 0.03);
    for (let i = -1; i <= 1; i++) {
      m.beginPath();
      m.moveTo(i * s * 0.05, 0);
      m.quadraticCurveTo(i * s * 0.08, -s * 0.1, i * s * 0.12, -s * 0.16);
      m.stroke();
    }
  } else if (theme === 'desert') {
    m.strokeStyle = 'rgba(120,95,55,0.5)';
    m.lineWidth = Math.max(1, s * 0.025);
    m.beginPath();
    m.arc(0, 0, s * 0.12, Math.PI * 0.1, Math.PI * 0.9);
    m.stroke();
  } else if (theme === 'snow') {
    m.fillStyle = 'rgba(255,255,255,0.5)';
    m.beginPath();
    m.arc(0, 0, Math.max(1, s * 0.03), 0, Math.PI * 2);
    m.fill();
  } else if (theme === 'volcano') {
    m.strokeStyle = r < 0.12 ? 'rgba(255,120,40,0.55)' : 'rgba(0,0,0,0.35)';
    m.lineWidth = Math.max(1, s * 0.03);
    m.beginPath();
    m.moveTo(-s * 0.12, 0);
    m.lineTo(-s * 0.02, s * 0.04);
    m.lineTo(s * 0.06, -s * 0.03);
    m.lineTo(s * 0.14, s * 0.02);
    m.stroke();
  } else {
    m.fillStyle = 'rgba(180,160,255,0.35)';
    m.beginPath();
    m.arc(0, 0, Math.max(1, s * 0.035), 0, Math.PI * 2);
    m.fill();
  }
  m.restore();
}

function drawDecor(m: CanvasRenderingContext2D, kind: Theme['decor'][number], x: number, y: number, s: number, r: number): void {
  m.save();
  m.translate(x, y);
  const sc = 0.85 + r * 0.3;
  m.scale(sc, sc);
  // sombra
  m.fillStyle = 'rgba(0,0,0,0.25)';
  m.beginPath();
  m.ellipse(0, s * 0.3, s * 0.3, s * 0.1, 0, 0, Math.PI * 2);
  m.fill();

  switch (kind) {
    case 'pine':
    case 'snowpine': {
      m.fillStyle = '#4e342e';
      m.fillRect(-s * 0.05, s * 0.12, s * 0.1, s * 0.2);
      m.fillStyle = kind === 'pine' ? '#1b5e20' : '#2e5339';
      for (let i = 0; i < 3; i++) {
        const w = s * (0.34 - i * 0.08);
        const ty = s * (0.12 - i * 0.18);
        m.beginPath();
        m.moveTo(0, ty - s * 0.22);
        m.lineTo(w, ty);
        m.lineTo(-w, ty);
        m.closePath();
        m.fill();
      }
      if (kind === 'snowpine') {
        m.fillStyle = 'rgba(255,255,255,0.85)';
        for (let i = 0; i < 3; i++) {
          const w = s * (0.3 - i * 0.08);
          const ty = s * (0.1 - i * 0.18);
          m.beginPath();
          m.moveTo(0, ty - s * 0.2);
          m.lineTo(w * 0.7, ty - s * 0.06);
          m.lineTo(-w * 0.7, ty - s * 0.06);
          m.closePath();
          m.fill();
        }
      }
      break;
    }
    case 'rock':
    case 'obsidian': {
      m.fillStyle = kind === 'rock' ? '#78716c' : '#1f1a24';
      m.beginPath();
      m.moveTo(-s * 0.28, s * 0.24);
      m.lineTo(-s * 0.3, -s * 0.02);
      m.lineTo(-s * 0.08, -s * 0.24);
      m.lineTo(s * 0.18, -s * 0.18);
      m.lineTo(s * 0.3, s * 0.1);
      m.lineTo(s * 0.16, s * 0.26);
      m.closePath();
      m.fill();
      m.strokeStyle = kind === 'rock' ? 'rgba(255,255,255,0.18)' : 'rgba(160,90,255,0.35)';
      m.lineWidth = Math.max(1, s * 0.03);
      m.stroke();
      break;
    }
    case 'flower': {
      m.strokeStyle = '#33691e';
      m.lineWidth = Math.max(1, s * 0.04);
      m.beginPath();
      m.moveTo(0, s * 0.25);
      m.lineTo(0, -s * 0.05);
      m.stroke();
      m.fillStyle = r < 0.5 ? '#f06292' : '#ffd54f';
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        m.beginPath();
        m.arc(Math.cos(a) * s * 0.09, -s * 0.08 + Math.sin(a) * s * 0.09, s * 0.06, 0, Math.PI * 2);
        m.fill();
      }
      m.fillStyle = '#fff59d';
      m.beginPath();
      m.arc(0, -s * 0.08, s * 0.05, 0, Math.PI * 2);
      m.fill();
      break;
    }
    case 'cactus': {
      m.fillStyle = '#2e7d32';
      roundRect(m, -s * 0.08, -s * 0.3, s * 0.16, s * 0.58, s * 0.08);
      m.fill();
      roundRect(m, -s * 0.28, -s * 0.14, s * 0.14, s * 0.1, s * 0.05);
      m.fill();
      roundRect(m, -s * 0.28, -s * 0.22, s * 0.1, s * 0.18, s * 0.05);
      m.fill();
      roundRect(m, s * 0.14, -s * 0.02, s * 0.14, s * 0.1, s * 0.05);
      m.fill();
      roundRect(m, s * 0.18, -s * 0.12, s * 0.1, s * 0.18, s * 0.05);
      m.fill();
      break;
    }
    case 'skull': {
      m.fillStyle = '#e8e2d0';
      m.beginPath();
      m.arc(0, -s * 0.02, s * 0.18, 0, Math.PI * 2);
      m.fill();
      m.fillRect(-s * 0.12, s * 0.05, s * 0.24, s * 0.12);
      m.fillStyle = '#3a2e1e';
      m.beginPath();
      m.arc(-s * 0.07, -s * 0.04, s * 0.05, 0, Math.PI * 2);
      m.arc(s * 0.07, -s * 0.04, s * 0.05, 0, Math.PI * 2);
      m.fill();
      break;
    }
    case 'snowman': {
      m.fillStyle = '#f4f8fc';
      m.beginPath();
      m.arc(0, s * 0.1, s * 0.2, 0, Math.PI * 2);
      m.arc(0, -s * 0.15, s * 0.14, 0, Math.PI * 2);
      m.fill();
      m.fillStyle = '#10141c';
      m.beginPath();
      m.arc(-s * 0.05, -s * 0.18, s * 0.02, 0, Math.PI * 2);
      m.arc(s * 0.05, -s * 0.18, s * 0.02, 0, Math.PI * 2);
      m.fill();
      m.fillStyle = '#ff7043';
      m.beginPath();
      m.moveTo(0, -s * 0.14);
      m.lineTo(s * 0.14, -s * 0.11);
      m.lineTo(0, -s * 0.09);
      m.closePath();
      m.fill();
      break;
    }
    case 'lavacrack': {
      m.strokeStyle = '#ff6d00';
      m.lineWidth = Math.max(1.5, s * 0.06);
      m.shadowColor = '#ff9e40';
      m.shadowBlur = s * 0.15;
      m.beginPath();
      m.moveTo(-s * 0.3, s * 0.1);
      m.lineTo(-s * 0.1, 0);
      m.lineTo(0, s * 0.14);
      m.lineTo(s * 0.14, -s * 0.06);
      m.lineTo(s * 0.3, 0);
      m.stroke();
      m.shadowBlur = 0;
      break;
    }
    case 'crystal': {
      const cols = ['#7c4dff', '#40c4ff', '#b388ff'];
      for (let i = -1; i <= 1; i++) {
        m.fillStyle = cols[(i + 1) % 3];
        m.beginPath();
        m.moveTo(i * s * 0.14, s * 0.24);
        m.lineTo(i * s * 0.14 - s * 0.08, s * 0.05);
        m.lineTo(i * s * 0.14, -s * 0.28 + Math.abs(i) * s * 0.12);
        m.lineTo(i * s * 0.14 + s * 0.08, s * 0.05);
        m.closePath();
        m.fill();
      }
      m.fillStyle = 'rgba(255,255,255,0.35)';
      m.beginPath();
      m.moveTo(0, -s * 0.26);
      m.lineTo(s * 0.04, -s * 0.05);
      m.lineTo(-s * 0.02, -s * 0.05);
      m.closePath();
      m.fill();
      break;
    }
    case 'mushroom': {
      m.fillStyle = '#e1bee7';
      m.fillRect(-s * 0.04, -s * 0.02, s * 0.08, s * 0.24);
      m.fillStyle = '#7b1fa2';
      m.beginPath();
      m.arc(0, -s * 0.02, s * 0.16, Math.PI, 0);
      m.closePath();
      m.fill();
      m.fillStyle = 'rgba(255,255,255,0.6)';
      m.beginPath();
      m.arc(-s * 0.06, -s * 0.09, s * 0.03, 0, Math.PI * 2);
      m.arc(s * 0.05, -s * 0.07, s * 0.025, 0, Math.PI * 2);
      m.fill();
      break;
    }
  }
  m.restore();
}

function drawPortalBase(m: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  m.fillStyle = 'rgba(10,6,20,0.9)';
  m.beginPath();
  m.ellipse(x, y, s * 0.42, s * 0.42, 0, 0, Math.PI * 2);
  m.fill();
  m.strokeStyle = '#7c4dff';
  m.lineWidth = Math.max(1.5, s * 0.06);
  m.stroke();
}

function drawCastle(m: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  m.save();
  m.translate(x, y);
  // muros
  m.fillStyle = '#8d99ae';
  m.fillRect(-s * 0.42, -s * 0.28, s * 0.84, s * 0.62);
  m.fillStyle = '#6c7689';
  m.fillRect(-s * 0.42, s * 0.14, s * 0.84, s * 0.2);
  // torres laterales
  m.fillStyle = '#aab4c5';
  m.fillRect(-s * 0.52, -s * 0.42, s * 0.22, s * 0.76);
  m.fillRect(s * 0.3, -s * 0.42, s * 0.22, s * 0.76);
  // almenas
  m.fillStyle = '#c3ccd9';
  for (let i = 0; i < 4; i++) m.fillRect(-s * 0.38 + i * s * 0.2, -s * 0.36, s * 0.1, s * 0.1);
  for (const tx of [-s * 0.52, s * 0.3]) {
    for (let i = 0; i < 2; i++) m.fillRect(tx + i * s * 0.12, -s * 0.5, s * 0.08, s * 0.1);
  }
  // puerta
  m.fillStyle = '#3e2723';
  m.beginPath();
  m.arc(0, s * 0.16, s * 0.16, Math.PI, 0);
  m.rect(-s * 0.16, s * 0.16, s * 0.32, s * 0.18);
  m.fill();
  m.strokeStyle = 'rgba(0,0,0,0.4)';
  m.lineWidth = Math.max(1, s * 0.02);
  m.strokeRect(-s * 0.42, -s * 0.28, s * 0.84, s * 0.62);
  m.restore();
}

// animaciones sobre la capa estática: espiral del portal y bandera del castillo
function drawMapAnimations(map: MapDef, now: number): void {
  const s = view.scale;
  const t = now / 1000;
  for (const path of map.paths) {
    const [sc, sr] = path[0];
    const x = toX(sc + 0.5);
    const y = toY(sr + 0.5);
    g.save();
    g.translate(x, y);
    g.rotate(t * 1.8);
    for (let i = 0; i < 3; i++) {
      g.strokeStyle = i % 2 ? 'rgba(179,136,255,0.8)' : 'rgba(124,77,255,0.8)';
      g.lineWidth = Math.max(1.5, s * 0.05);
      g.beginPath();
      g.arc(0, 0, s * (0.12 + i * 0.09), i * 2.1, i * 2.1 + Math.PI * 1.2);
      g.stroke();
    }
    g.restore();
    // pulso exterior
    const pulse = (t * 0.7 + sc * 0.3) % 1;
    g.strokeStyle = `rgba(149,117,205,${0.5 * (1 - pulse)})`;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(x, y, s * (0.42 + pulse * 0.25), 0, Math.PI * 2);
    g.stroke();
  }
  const exits = new Set(map.paths.map((p) => p[p.length - 1].join(',')));
  for (const e of exits) {
    const [ec, er] = e.split(',').map(Number);
    const x = toX(ec + 0.5);
    const y = toY(er + 0.5);
    // mástil + bandera ondeante
    g.strokeStyle = '#4e342e';
    g.lineWidth = Math.max(1, s * 0.03);
    g.beginPath();
    g.moveTo(x, y - s * 0.28);
    g.lineTo(x, y - s * 0.62);
    g.stroke();
    g.fillStyle = '#ef5350';
    g.beginPath();
    g.moveTo(x, y - s * 0.62);
    const wav = Math.sin(t * 5) * s * 0.03;
    g.quadraticCurveTo(x + s * 0.12, y - s * 0.6 + wav, x + s * 0.24, y - s * 0.58 - wav);
    g.lineTo(x + s * 0.22, y - s * 0.48 - wav);
    g.quadraticCurveTo(x + s * 0.11, y - s * 0.5 + wav, x, y - s * 0.5);
    g.closePath();
    g.fill();
  }
}

// ---------- partículas ambientales ----------

function spawnAmbient(map: MapDef, dt: number): void {
  const theme = THEMES[map.theme];
  const rate = theme.ambient === 'snow' ? 14 : theme.ambient === 'embers' ? 9 : 4;
  if (ambient.length < 60 && Math.random() < rate * dt) {
    const x = Math.random() * map.gridW;
    const kind = theme.ambient;
    if (kind === 'snow' || kind === 'leaves' || kind === 'sand') {
      ambient.push({
        x, y: -0.5,
        vx: kind === 'sand' ? 1.6 + Math.random() : 0.2 + Math.random() * 0.4,
        vy: kind === 'sand' ? 0.25 : 0.55 + Math.random() * 0.4,
        life: 0, max: 30, size: 0.04 + Math.random() * 0.05, kind,
      });
    } else if (kind === 'embers') {
      ambient.push({
        x, y: map.gridH + 0.5,
        vx: (Math.random() - 0.5) * 0.3,
        vy: -(0.4 + Math.random() * 0.5),
        life: 0, max: 30, size: 0.03 + Math.random() * 0.04, kind,
      });
    } else {
      ambient.push({
        x, y: Math.random() * map.gridH,
        vx: 0, vy: -0.05,
        life: 0, max: 2.2, size: 0.03 + Math.random() * 0.05, kind,
      });
    }
  }
  for (let i = ambient.length - 1; i >= 0; i--) {
    const p = ambient[i];
    p.life += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.kind === 'snow' || p.kind === 'leaves') p.x += Math.sin(p.life * 2 + i) * dt * 0.4;
    if (p.life > p.max || p.y > map.gridH + 1 || p.y < -1 || p.x > map.gridW + 1) ambient.splice(i, 1);
  }
}

function drawAmbient(now: number): void {
  const s = view.scale;
  for (const p of ambient) {
    const px = toX(p.x);
    const py = toY(p.y);
    switch (p.kind) {
      case 'snow':
        g.fillStyle = 'rgba(255,255,255,0.75)';
        break;
      case 'leaves':
        g.fillStyle = 'rgba(139,195,74,0.55)';
        break;
      case 'sand':
        g.fillStyle = 'rgba(230,205,150,0.4)';
        break;
      case 'embers':
        g.fillStyle = Math.sin(now / 90 + p.x * 9) > 0 ? 'rgba(255,145,60,0.9)' : 'rgba(255,200,90,0.9)';
        break;
      case 'sparkles': {
        const a = Math.sin((p.life / p.max) * Math.PI);
        g.fillStyle = `rgba(200,180,255,${0.8 * a})`;
        break;
      }
    }
    g.beginPath();
    g.arc(px, py, Math.max(1, p.size * s), 0, Math.PI * 2);
    g.fill();
  }
}

// ---------- pings cooperativos ----------

function drawPings(dt: number): void {
  const s = view.scale;
  const now = performance.now();
  for (let i = pings.length - 1; i >= 0; i--) {
    const p = pings[i];
    p.life -= dt;
    if (p.life <= 0) {
      pings.splice(i, 1);
      continue;
    }
    if (p.towerType) {
      drawSuggestionPing(p, s, now);
      continue;
    }
    const age = 1 - p.life / PING_LIFE;
    const x = toX(p.x);
    const y = toY(p.y);
    const alpha = Math.min(1, p.life / 0.5);

    // ondas que se expanden (tres, desfasadas)
    g.strokeStyle = p.color;
    g.lineWidth = Math.max(2, s * 0.06);
    for (let k = 0; k < 3; k++) {
      const ph = (age * 2 + k * 0.33) % 1;
      g.globalAlpha = alpha * (1 - ph) * 0.8;
      g.beginPath();
      g.arc(x, y, s * (0.2 + ph * 0.9), 0, Math.PI * 2);
      g.stroke();
    }
    g.globalAlpha = alpha;

    // marcador tipo "gota" con signo de exclamación
    const bob = Math.sin(age * Math.PI * 6) * s * 0.05;
    const my = y - s * 0.5 + bob;
    g.fillStyle = p.color;
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.lineWidth = Math.max(1, s * 0.03);
    g.beginPath();
    g.arc(x, my, s * 0.22, 0, Math.PI * 2);
    g.moveTo(x - s * 0.12, my + s * 0.16);
    g.lineTo(x, y - s * 0.02);
    g.lineTo(x + s * 0.12, my + s * 0.16);
    g.fill();
    g.stroke();
    g.fillStyle = '#10141c';
    g.font = `bold ${Math.max(9, s * 0.26)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('!', x, my);

    // nombre de quien lo lanzó
    g.fillStyle = '#fff';
    g.font = `bold ${Math.max(9, s * 0.22)}px system-ui, sans-serif`;
    g.textBaseline = 'bottom';
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 3;
    g.strokeText(p.name, x, my - s * 0.28);
    g.fillText(p.name, x, my - s * 0.28);
    g.globalAlpha = 1;
  }
}

// Sugerencia de torre: fantasma semitransparente de la torre en la celda + una
// etiqueta "nombre sugiere: NombreTorre". La celda es floor(x),floor(y).
function drawSuggestionPing(p: Ping, s: number, now: number): void {
  const type = p.towerType!;
  const cx = Math.floor(p.x);
  const cy = Math.floor(p.y);
  const alpha = Math.min(1, p.life / 0.6); // fade out al final
  const pulse = 0.5 + Math.sin(now / 260) * 0.12;

  // anillo de sugerencia (celeste) bajo el fantasma
  g.globalAlpha = alpha;
  g.strokeStyle = p.color;
  g.lineWidth = Math.max(1.5, s * 0.05);
  g.setLineDash([s * 0.16, s * 0.1]);
  g.beginPath();
  g.arc(toX(cx + 0.5), toY(cy + 0.5), s * (0.42 + pulse * 0.06), 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([]);

  // fantasma de la torre (arte real, semitransparente) centrado en la celda
  g.save();
  g.globalAlpha = alpha * 0.72;
  g.translate(toX(cx) + s / 2, toY(cy) + s / 2);
  drawTowerArt(type, s, 1, now / 1000, { angle: -Math.PI / 2, recoil: 0, flash: 0 }, p.color, false);
  g.restore();

  // etiqueta "nombre sugiere: NombreTorre"
  g.globalAlpha = alpha;
  const label = `${p.name} sugiere: ${TOWERS[type].name}`;
  const ty = toY(cy) - s * 0.28;
  const tx = toX(cx + 0.5);
  g.font = `bold ${Math.max(9, s * 0.2)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'bottom';
  g.strokeStyle = 'rgba(0,0,0,0.65)';
  g.lineWidth = 3;
  g.strokeText(label, tx, ty);
  g.fillStyle = '#fff';
  g.fillText(label, tx, ty);
  g.globalAlpha = 1;
}

// ---------- interpolación ----------

interface InterpResult {
  enemies: { id: number; typeIdx: number; x: number; y: number; hpFrac: number; flags: number; affix: number }[];
  projs: { id: number; kindIdx: number; x: number; y: number; towerTypeIdx: number }[];
}

function interpolate(gs: GameStore, rt: number): InterpResult | null {
  const frames = gs.frames;
  if (frames.length === 0) return null;

  let a: SnapFrame = frames[frames.length - 1];
  let b: SnapFrame = a;
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].time <= rt) {
      a = frames[i];
      b = frames[Math.min(i + 1, frames.length - 1)];
      break;
    }
    a = frames[i];
    b = frames[i];
  }
  const span = b.time - a.time;
  const alpha = span > 0 ? Math.min(1, Math.max(0, (rt - a.time) / span)) : 1;

  const aEnemies = new Map<number, SnapEnemy>();
  for (const e of a.snap.enemies) aEnemies.set(e[0], e);

  const enemies: InterpResult['enemies'] = [];
  for (const e of b.snap.enemies) {
    const prev = aEnemies.get(e[0]);
    if (prev) {
      enemies.push({
        id: e[0],
        typeIdx: e[1],
        x: prev[2] + (e[2] - prev[2]) * alpha,
        y: prev[3] + (e[3] - prev[3]) * alpha,
        hpFrac: prev[4] + (e[4] - prev[4]) * alpha,
        flags: e[5],
        affix: e[6] ?? 0,
      });
    } else {
      enemies.push({ id: e[0], typeIdx: e[1], x: e[2], y: e[3], hpFrac: e[4], flags: e[5], affix: e[6] ?? 0 });
    }
  }

  const aProjs = new Map<number, [number, number, number, number, number]>();
  for (const p of a.snap.projs) aProjs.set(p[0], p);
  const projs: InterpResult['projs'] = [];
  for (const p of b.snap.projs) {
    const prev = aProjs.get(p[0]);
    projs.push({
      id: p[0],
      kindIdx: p[1],
      x: prev ? prev[2] + (p[2] - prev[2]) * alpha : p[2],
      y: prev ? prev[3] + (p[3] - prev[3]) * alpha : p[3],
      towerTypeIdx: p[4],
    });
  }

  return { enemies, projs };
}

// ---------- torres ----------

function nearestEnemyAngle(interp: InterpResult | null, cx: number, cy: number, range: number, type: TowerTypeId, canAir: boolean): number | null {
  if (!interp) return null;
  const def = TOWERS[type];
  let best: number | null = null;
  let bestD = range + 0.4;
  for (const e of interp.enemies) {
    const edef = ENEMIES[ENEMY_ORDER[e.typeIdx]];
    if (edef.flying && !canAir) continue;
    if (!edef.flying && !def.targetsGround) continue;
    const d = Math.hypot(e.x - cx, e.y - cy);
    if (d < bestD) {
      bestD = d;
      best = Math.atan2(e.y - cy, e.x - cx);
    }
  }
  return best;
}

// Refuerzo de un Estandarte sobre una torre, calculado en el CLIENTE a partir del
// snapshot (posiciones + activeStats) — NO cambia el protocolo. Espeja la lógica
// de `computeAuras` de la sim: mejor de cada tipo, sin apilar; cubre a torres de
// cualquier dueño; no buffea a estandartes ni a la mina.
export interface ClientAura {
  dmg: number;
  haste: number;
}

// Stats de una torre del snapshot TENIENDO EN CUENTA su fusión (F4.3): si la
// tupla trae índice de fusión, mandan los stats de la receta; espeja `statsOf`.
function tupleStats(tw: SnapTower): TowerLevelDef {
  const f = fusionByIndex(tw[13] ?? -1);
  return f ? f.stats : activeStats(TOWER_ORDER[tw[1]], tw[4], tw[9] ?? -1);
}

export function computeBannerAuras(snap: Snap): Map<number, ClientAura> {
  const out = new Map<number, ClientAura>();
  for (const banner of snap.towers) {
    const blvl = tupleStats(banner);
    const dmg = blvl.auraDamage ?? 0;
    const haste = blvl.auraHaste ?? 0;
    if (dmg <= 0 && haste <= 0) continue; // no es estandarte (o aura nula)
    const bx = banner[2] + 0.5;
    const by = banner[3] + 0.5;
    for (const tw of snap.towers) {
      if (tw[0] === banner[0]) continue;
      const twType = TOWER_ORDER[tw[1]];
      const tlvl = tupleStats(tw);
      // un estandarte puro no recibe auras; el Señor de la Guerra (alsoFires) sí
      if ((tlvl.auraDamage !== undefined || tlvl.auraHaste !== undefined) && !tlvl.alsoFires) continue;
      if (tlvl.incomePerWave) continue; // la mina
      if (tlvl.auraBounty !== undefined) continue; // el Alquimista (no dispara)
      if (TOWERS[twType].onPathOnly) continue; // la Trampa de púas
      if (Math.hypot(bx - (tw[2] + 0.5), by - (tw[3] + 0.5)) > blvl.range) continue;
      let a = out.get(tw[0]);
      if (!a) {
        a = { dmg: 0, haste: 0 };
        out.set(tw[0], a);
      }
      if (dmg > a.dmg) a.dmg = dmg;
      if (haste > a.haste) a.haste = haste;
    }
  }
  return out;
}

// Cuenta cuántas torres (no estandartes, no minas) hay dentro del aura de un
// Estandarte concreto (o fusión con aura). Usado por el panel del HUD.
export function countBannerTargets(snap: Snap, bannerId: number): number {
  const banner = snap.towers.find((t) => t[0] === bannerId);
  if (!banner) return 0;
  const blvl = tupleStats(banner);
  if (blvl.auraDamage === undefined && blvl.auraHaste === undefined) return 0;
  const bx = banner[2] + 0.5;
  const by = banner[3] + 0.5;
  let n = 0;
  for (const tw of snap.towers) {
    if (tw[0] === bannerId) continue;
    const twType = TOWER_ORDER[tw[1]];
    const tlvl = tupleStats(tw);
    if ((tlvl.auraDamage !== undefined || tlvl.auraHaste !== undefined) && !tlvl.alsoFires) continue;
    if (tlvl.incomePerWave) continue;
    if (tlvl.auraBounty !== undefined) continue;
    if (TOWERS[twType].onPathOnly) continue;
    if (Math.hypot(bx - (tw[2] + 0.5), by - (tw[3] + 0.5)) > blvl.range) continue;
    n++;
  }
  return n;
}

function drawTowers(gs: GameStore, interp: InterpResult | null, now: number, dt: number): void {
  const snap = gs.latest;
  if (!snap) return;
  const auras = computeBannerAuras(snap);
  const s = view.scale;
  const t = now / 1000;
  // Lote 4 · la selección puede ser UNA torre o un GRUPO (doble click): todas
  // llevan el glow. Con grupos grandes el círculo de alcance se pinta TENUE
  // (solo contorno) para no embarrar el tablero con N discos superpuestos.
  const selSet = new Set<number>();
  if (gs.selection?.kind === 'tower') selSet.add(gs.selection.id);
  else if (gs.selection?.kind === 'towers') for (const sid of gs.selection.ids) selSet.add(sid);
  const faintRange = selSet.size > 3;
  // posiciones interpoladas por id (vínculo 🎯 de las torres con focus seleccionadas)
  let interpById: Map<number, InterpResult['enemies'][number]> | null = null;
  if (selSet.size > 0 && interp) {
    interpById = new Map();
    for (const e of interp.enemies) interpById.set(e.id, e);
  }
  const alive = new Set<number>();

  for (const tw of snap.towers) {
    const [id, typeIdx, cx, cy, level, ownerIdx] = tw;
    const spec = tw[9] ?? -1;
    const fusionIdx = tw[13] ?? -1;
    const fusion = fusionByIndex(fusionIdx);
    const type = TOWER_ORDER[typeIdx];
    const owner = gs.init.players[ownerIdx];
    const x = toX(cx);
    const y = toY(cy);
    alive.add(id);

    let anim = towerAnim.get(id);
    if (!anim) {
      anim = { angle: -Math.PI / 2, recoil: 0, flash: 0 };
      towerAnim.set(id, anim);
    }
    const lvl = tupleStats(tw);
    const canAir = fusion ? fusion.targetsAir : towerTargetsAir(type, spec);
    const target = nearestEnemyAngle(interp, cx + 0.5, cy + 0.5, lvl.range, type, canAir);
    if (target !== null) anim.angle = lerpAngle(anim.angle, target, Math.min(1, dt * 10));
    anim.recoil = Math.max(0, anim.recoil - dt * 5);
    anim.flash = Math.max(0, anim.flash - dt * 8);

    // aura pasiva (Escarcha Eterna): solo visible con la torre SELECCIONADA
    // (como el círculo de alcance de las demás torres)
    if (lvl.slowAura && selSet.has(id)) {
      const pulse = 0.5 + Math.sin(t * 2.4) * 0.12;
      g.fillStyle = `rgba(79,195,247,${0.07 + pulse * 0.05})`;
      g.strokeStyle = `rgba(129,212,250,${0.4 + pulse * 0.2})`;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(toX(cx + 0.5), toY(cy + 0.5), lvl.slowAura.radius * s, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }

    // aura del Alquimista: anillo verde en el suelo (como el dorado del Estandarte).
    // solo visible con la torre SELECCIONADA.
    if (lvl.auraBounty !== undefined && lvl.auraBounty > 0 && selSet.has(id)) {
      const pulse = 0.5 + Math.sin(t * 2.4) * 0.12;
      g.fillStyle = `rgba(76,175,80,${0.05 + pulse * 0.05})`;
      g.strokeStyle = `rgba(129,199,132,${0.4 + pulse * 0.2})`;
      g.lineWidth = 1.5;
      g.setLineDash([s * 0.18, s * 0.12]);
      g.beginPath();
      g.arc(toX(cx + 0.5), toY(cy + 0.5), lvl.range * s, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.setLineDash([]);
    }

    // aura del Estandarte: anillo cálido en el suelo, solo visible con la torre
    // SELECCIONADA. El tono vira a celeste si el aura es de celeridad (hastebanner).
    if ((lvl.auraDamage !== undefined || lvl.auraHaste !== undefined) && selSet.has(id)) {
      const pulse = 0.5 + Math.sin(t * 2.4) * 0.12;
      const haste = (lvl.auraHaste ?? 0) > 0;
      const fill = haste ? `rgba(79,195,247,${0.05 + pulse * 0.05})` : `rgba(255,202,40,${0.05 + pulse * 0.05})`;
      const stroke = haste ? `rgba(129,212,250,${0.35 + pulse * 0.2})` : `rgba(255,213,79,${0.4 + pulse * 0.2})`;
      g.fillStyle = fill;
      g.strokeStyle = stroke;
      g.lineWidth = 1.5;
      g.setLineDash([s * 0.18, s * 0.12]);
      g.beginPath();
      g.arc(toX(cx + 0.5), toY(cy + 0.5), lvl.range * s, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.setLineDash([]);
    }

    // brillito en las torres reforzadas por algún Estandarte (barato: un anillo)
    const buff = auras.get(id);
    if (buff && (buff.dmg > 0 || buff.haste > 0)) {
      const pulse = 0.55 + Math.sin(t * 3.5 + id) * 0.45;
      const both = buff.dmg > 0 && buff.haste > 0;
      // dorado = daño, celeste = celeridad; si ambos, se dibujan los dos anillos
      const rings: string[] = [];
      if (buff.dmg > 0) rings.push(`rgba(255,213,79,${0.35 * pulse})`);
      if (buff.haste > 0) rings.push(`rgba(129,212,250,${0.35 * pulse})`);
      for (let ri = 0; ri < rings.length; ri++) {
        g.strokeStyle = rings[ri];
        g.lineWidth = Math.max(1.5, s * 0.05);
        g.beginPath();
        g.arc(toX(cx + 0.5), toY(cy + 0.5), s * (0.4 + (both ? ri * 0.06 : 0)), 0, Math.PI * 2);
        g.stroke();
      }
    }

    // Lote 3 · Sentry: radio de DETECCIÓN (azul, discontinuo) solo al SELECCIONARLO,
    // como las auras. Reemplaza el círculo de alcance dorado genérico para el Sentry.
    if (TOWERS[type].detects && selSet.has(id)) {
      const pulse = 0.5 + Math.sin(t * 2.4) * 0.12;
      g.fillStyle = `rgba(41,182,246,${0.05 + pulse * 0.05})`;
      g.strokeStyle = `rgba(129,212,250,${0.45 + pulse * 0.25})`;
      g.lineWidth = 1.5;
      g.setLineDash([s * 0.18, s * 0.12]);
      g.beginPath();
      g.arc(toX(cx + 0.5), toY(cy + 0.5), lvl.range * s, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.setLineDash([]);
    }

    // rango de la torre seleccionada (la Gran Bertha alcanza TODO el mapa:
    // se omite el círculo, que taparía el mapa entero; el Sentry usa su propio anillo).
    // Lote 4 · en un GRUPO grande (>3) el círculo va TENUE y sin relleno: se sigue
    // leyendo la cobertura sin apilar N discos blancos encima del tablero.
    if (selSet.has(id) && lvl.range < 90 && !TOWERS[type].detects) {
      const pulse = 0.5 + Math.sin(t * 4) * 0.08;
      g.strokeStyle = faintRange ? 'rgba(255,213,79,0.22)' : `rgba(255,213,79,${pulse})`;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(toX(cx + 0.5), toY(cy + 0.5), lvl.range * s, 0, Math.PI * 2);
      if (!faintRange) {
        g.fillStyle = 'rgba(255,255,255,0.07)';
        g.fill();
      }
      g.stroke();
      if (lvl.minRange && !faintRange) {
        g.strokeStyle = 'rgba(240,100,100,0.45)';
        g.beginPath();
        g.arc(toX(cx + 0.5), toY(cy + 0.5), lvl.minRange * s, 0, Math.PI * 2);
        g.stroke();
      }
    }

    // Lote 4 · vínculo de FOCUS: torre SELECCIONADA con objetivo fijado → línea
    // punteada sutil hasta la posición interpolada del enemigo + retícula pequeña.
    const focusId = tw[18] ?? 0;
    if (selSet.has(id) && focusId > 0 && interpById) {
      const fe = interpById.get(focusId);
      if (fe) {
        const ex = toX(fe.x);
        const ey = toY(fe.y);
        const pulse = 0.45 + Math.sin(t * 5 + id) * 0.2;
        g.strokeStyle = `rgba(255,110,90,${pulse})`;
        g.lineWidth = Math.max(1, s * 0.04);
        g.setLineDash([s * 0.22, s * 0.16]);
        g.beginPath();
        g.moveTo(toX(cx + 0.5), toY(cy + 0.5));
        g.lineTo(ex, ey);
        g.stroke();
        g.setLineDash([]);
        // retícula sobre el enemigo enfocado
        g.beginPath();
        g.arc(ex, ey, s * 0.32, 0, Math.PI * 2);
        g.stroke();
        g.beginPath();
        g.moveTo(ex - s * 0.44, ey);
        g.lineTo(ex - s * 0.24, ey);
        g.moveTo(ex + s * 0.24, ey);
        g.lineTo(ex + s * 0.44, ey);
        g.moveTo(ex, ey - s * 0.44);
        g.lineTo(ex, ey - s * 0.24);
        g.moveTo(ex, ey + s * 0.24);
        g.lineTo(ex, ey + s * 0.44);
        g.stroke();
      }
    }

    g.save();
    g.translate(x + s / 2, y + s / 2);
    // sprite real si existe (torres base, no fusiones); si no, arte vectorial.
    const sprite = fusionIdx < 0 ? getTowerSprite(type, level, spec) : null;
    if (sprite) {
      // la base ocupa ~1.15 celdas (antes 1.55 = desbordaba); la estructura sube.
      const w = s * SPRITE_W;
      const h = (sprite.naturalHeight / sprite.naturalWidth) * w;
      const rx = Math.cos(anim.angle) * anim.recoil * s * 0.12;
      const ry = Math.sin(anim.angle) * anim.recoil * s * 0.12;
      // marca de dueño: con sprites ya no se distingue de quién es cada torre (el
      // arte vectorial pintaba el color del dueño en la base, el sprite lo tapa).
      // Elipse sutil en el suelo, bajo el sprite, para no ensuciar el tablero.
      const oc = owner?.color ?? '#888888';
      g.save();
      g.shadowColor = oc;
      g.shadowBlur = s * 0.12;
      g.fillStyle = `${oc}30`;
      g.strokeStyle = `${oc}b0`;
      g.lineWidth = Math.max(1.5, s * 0.045);
      g.beginPath();
      g.ellipse(0, s * 0.44, s * 0.3, s * 0.1, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.restore();
      if (selSet.has(id)) {
        g.shadowColor = 'rgba(255,213,79,0.85)';
        g.shadowBlur = s * 0.28;
      }
      // ancla: la base se apoya cerca del borde inferior de la celda
      g.drawImage(sprite, -w / 2 - rx, s * 0.5 - h - ry, w, h);
      g.shadowBlur = 0;
    } else {
      drawTowerArt(type, s, level, t, anim, owner?.color ?? '#888', selSet.has(id), spec, fusionIdx);
    }
    // Trampa de púas: contador de cargas restantes + barra de desgaste bajo la placa.
    const charges = tw[11] ?? 0;
    if (type === 'trap' && charges > 0) {
      const frac = Math.max(0, Math.min(1, charges / 20));
      // barra de desgaste
      const bw = s * 0.56;
      const by = s * 0.28;
      g.fillStyle = 'rgba(6,8,14,0.7)';
      roundRect(g, -bw / 2 - 1, by - 1, bw + 2, s * 0.09 + 2, s * 0.045);
      g.fill();
      g.fillStyle = frac > 0.5 ? '#cfd8dc' : frac > 0.25 ? '#ffb300' : '#ef5350';
      roundRect(g, -bw / 2, by, Math.max(2, bw * frac), s * 0.09, s * 0.045);
      g.fill();
      // contador numérico
      g.fillStyle = '#eceff1';
      g.font = `bold ${Math.max(8, s * 0.24)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.strokeStyle = 'rgba(0,0,0,0.7)';
      g.lineWidth = 3;
      g.strokeText(String(charges), 0, -s * 0.3);
      g.fillText(String(charges), 0, -s * 0.3);
    }
    // Lote 4 · DETENIDA (⏸ por su dueño): badge de pausa flotando sobre la torre
    // + tinte gris suave, visible para TODOS (comunica por qué no dispara).
    const halted = (tw[17] ?? 0) === 1;
    if (halted) {
      g.fillStyle = 'rgba(90,100,120,0.30)';
      g.beginPath();
      g.arc(0, 0, s * 0.4, 0, Math.PI * 2);
      g.fill();
      const bob = Math.sin(t * 2 + id) * s * 0.03;
      const by = -s * 0.58 + bob;
      const br = s * 0.17;
      g.fillStyle = 'rgba(8,12,20,0.85)';
      g.beginPath();
      g.arc(0, by, br, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(255,213,79,0.9)';
      g.lineWidth = Math.max(1, s * 0.03);
      g.stroke();
      // las dos barras del ⏸
      g.fillStyle = '#ffd54f';
      const bw = br * 0.26;
      const bh = br * 0.95;
      g.fillRect(-bw * 1.4, by - bh / 2, bw, bh);
      g.fillRect(bw * 0.4, by - bh / 2, bw, bh);
    }
    // ATURDIDA (Zapador / Behemot): estrellitas girando sobre la torre + tinte gris
    const stunned = (tw[10] ?? 0) === 1;
    if (stunned) {
      g.fillStyle = 'rgba(120,130,150,0.35)';
      g.beginPath();
      g.arc(0, 0, s * 0.4, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffe082';
      g.font = `${Math.max(8, s * 0.28)}px serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (let si = 0; si < 3; si++) {
        const a = t * 4 + (si * Math.PI * 2) / 3 + id;
        g.fillText('✦', Math.cos(a) * s * 0.34, -s * 0.42 + Math.sin(a) * s * 0.1);
      }
    }
    g.restore();
  }

  for (const id of towerAnim.keys()) if (!alive.has(id)) towerAnim.delete(id);
}

// Arte vectorial de cada torre, dibujado centrado en (0,0), celda de tamaño s.
// `fusionIdx` >= 0: torre fusionada (F4.3) — arte combinado propio de la receta.
function drawTowerArt(
  type: TowerTypeId,
  s: number,
  level: number,
  t: number,
  anim: { angle: number; recoil: number; flash: number },
  ownerColor: string,
  selected: boolean,
  spec = -1,
  fusionIdx = -1,
): void {
  const def = TOWERS[type];
  const fusion = fusionByIndex(fusionIdx);
  const specialized = spec >= 0;
  // sube de tamaño con el nivel; especializaciones y fusiones son más grandes
  const grow = fusion ? 1.3 : (1 + (level - 1) * 0.07) * (specialized ? 1.22 : 1);

  // halo de poder de las torres especializadas/fusionadas (palpita en su color)
  if (specialized || fusion) {
    const haloColor = fusion ? fusion.color : def.color;
    const pulse = 0.5 + Math.sin(t * 3) * 0.5;
    const halo = g.createRadialGradient(0, 0, s * 0.2, 0, 0, s * 0.6);
    halo.addColorStop(0, `${haloColor}66`);
    halo.addColorStop(1, `${haloColor}00`);
    g.fillStyle = halo;
    g.beginPath();
    g.arc(0, 0, s * (0.5 + pulse * 0.08), 0, Math.PI * 2);
    g.fill();
  }

  // base de piedra común
  const baseR = s * 0.38 * grow;
  const grad = g.createRadialGradient(-baseR * 0.3, -baseR * 0.3, baseR * 0.2, 0, 0, baseR);
  grad.addColorStop(0, '#39445c');
  grad.addColorStop(1, '#1c2433');
  g.fillStyle = grad;
  g.strokeStyle = ownerColor;
  g.lineWidth = Math.max(1.5, s * 0.05);
  g.beginPath();
  g.arc(0, 0, baseR, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  if (selected) {
    g.strokeStyle = 'rgba(255,213,79,0.9)';
    g.lineWidth = Math.max(1, s * 0.03);
    g.beginPath();
    g.arc(0, 0, baseR + s * 0.06, 0, Math.PI * 2);
    g.stroke();
  }

  const rec = anim.recoil * s * 0.08;
  const a = anim.angle;

  // F4.3 · torre FUSIONADA: arte combinado propio + doble anillo arcano giratorio
  // (sustituye rombos de nivel y corona; una fusión no tiene niveles ni spec).
  if (fusion) {
    drawFusionArt(fusion.id, s, t, a, rec, ownerColor, grow);
    const spin = t * 1.2;
    for (let ri = 0; ri < 2; ri++) {
      const rr = baseR + s * (0.1 + ri * 0.08);
      const phase = spin * (ri === 0 ? 1 : -1) + ri * Math.PI * 0.5;
      g.strokeStyle = ri === 0 ? `${fusion.color}cc` : 'rgba(206,147,216,0.75)';
      g.lineWidth = Math.max(1, s * 0.025);
      for (let k = 0; k < 3; k++) {
        const a0 = phase + (k * Math.PI * 2) / 3;
        g.beginPath();
        g.arc(0, 0, rr, a0, a0 + Math.PI * 0.42);
        g.stroke();
      }
    }
    return;
  }

  switch (type) {
    case 'archer': {
      g.save();
      g.rotate(a);
      g.translate(-rec, 0);
      // plataforma de madera
      g.fillStyle = '#6d4c41';
      g.beginPath();
      g.arc(0, 0, s * 0.24 * grow, 0, Math.PI * 2);
      g.fill();
      // arco
      g.strokeStyle = '#d7ccc8';
      g.lineWidth = Math.max(1.5, s * 0.05);
      g.beginPath();
      g.arc(s * 0.1, 0, s * 0.2 * grow, -Math.PI * 0.42, Math.PI * 0.42);
      g.stroke();
      g.strokeStyle = '#f5f5f5';
      g.lineWidth = Math.max(1, s * 0.02);
      g.beginPath();
      g.moveTo(s * 0.1 + Math.cos(-Math.PI * 0.42) * s * 0.2, Math.sin(-Math.PI * 0.42) * s * 0.2);
      g.lineTo(s * 0.02 - rec, 0);
      g.lineTo(s * 0.1 + Math.cos(Math.PI * 0.42) * s * 0.2, Math.sin(Math.PI * 0.42) * s * 0.2);
      g.stroke();
      // flecha lista
      g.strokeStyle = '#8d6e63';
      g.lineWidth = Math.max(1, s * 0.03);
      g.beginPath();
      g.moveTo(-s * 0.06, 0);
      g.lineTo(s * 0.26, 0);
      g.stroke();
      g.fillStyle = '#eceff1';
      g.beginPath();
      g.moveTo(s * 0.3, 0);
      g.lineTo(s * 0.2, -s * 0.05);
      g.lineTo(s * 0.2, s * 0.05);
      g.fill();
      g.restore();
      break;
    }
    case 'cannon': {
      g.save();
      g.rotate(a);
      // cañón
      g.fillStyle = '#263238';
      roundRect(g, -s * 0.08 - rec, -s * 0.11, s * 0.42 * grow, s * 0.22, s * 0.08);
      g.fill();
      g.strokeStyle = '#546e7a';
      g.lineWidth = Math.max(1, s * 0.03);
      g.stroke();
      // boca
      g.fillStyle = '#10141c';
      g.beginPath();
      g.arc(s * 0.34 * grow - rec, 0, s * 0.09, 0, Math.PI * 2);
      g.fill();
      // cubo central
      g.fillStyle = '#455a64';
      g.beginPath();
      g.arc(-rec * 0.5, 0, s * 0.14 * grow, 0, Math.PI * 2);
      g.fill();
      if (anim.flash > 0) muzzleFlash(s * 0.4 * grow, s, anim.flash);
      g.restore();
      break;
    }
    case 'frost': {
      const pulse = 1 + Math.sin(t * 3) * 0.05;
      // halo helado
      const halo = g.createRadialGradient(0, 0, 0, 0, 0, s * 0.34 * pulse);
      halo.addColorStop(0, 'rgba(129,212,250,0.5)');
      halo.addColorStop(1, 'rgba(129,212,250,0)');
      g.fillStyle = halo;
      g.beginPath();
      g.arc(0, 0, s * 0.34 * pulse, 0, Math.PI * 2);
      g.fill();
      // cristal central (rombos superpuestos)
      for (let i = 0; i < 3; i++) {
        g.save();
        g.rotate((i * Math.PI) / 3 + t * 0.4);
        g.fillStyle = i === 1 ? '#b3e5fc' : '#4fc3f7';
        g.globalAlpha = 0.9;
        g.beginPath();
        g.moveTo(0, -s * 0.26 * grow * pulse);
        g.lineTo(s * 0.09, 0);
        g.lineTo(0, s * 0.26 * grow * pulse);
        g.lineTo(-s * 0.09, 0);
        g.closePath();
        g.fill();
        g.restore();
      }
      g.globalAlpha = 1;
      break;
    }
    case 'poison': {
      // caldero
      g.fillStyle = '#37474f';
      g.beginPath();
      g.ellipse(0, s * 0.04, s * 0.26 * grow, s * 0.2 * grow, 0, 0, Math.PI * 2);
      g.fill();
      // líquido burbujeante
      g.fillStyle = '#7cb342';
      g.beginPath();
      g.ellipse(0, -s * 0.05, s * 0.2 * grow, s * 0.08, 0, 0, Math.PI * 2);
      g.fill();
      for (let i = 0; i < 3; i++) {
        const ph = ((t * (0.7 + i * 0.23) + i * 0.37) % 1);
        g.fillStyle = `rgba(174,213,129,${0.9 - ph * 0.9})`;
        g.beginPath();
        g.arc((i - 1) * s * 0.09, -s * 0.06 - ph * s * 0.22, s * (0.03 + 0.02 * (1 - ph)), 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'tesla': {
      // bobina
      g.fillStyle = '#4e342e';
      roundRect(g, -s * 0.09, -s * 0.16, s * 0.18, s * 0.28, s * 0.04);
      g.fill();
      g.strokeStyle = '#ff8f00';
      g.lineWidth = Math.max(1, s * 0.025);
      for (let i = 0; i < 3; i++) {
        g.beginPath();
        g.moveTo(-s * 0.09, -s * 0.1 + i * s * 0.08);
        g.lineTo(s * 0.09, -s * 0.1 + i * s * 0.08);
        g.stroke();
      }
      // orbe eléctrico
      const flick = 0.75 + Math.sin(t * 17) * 0.25;
      const orb = g.createRadialGradient(0, -s * 0.24, 0, 0, -s * 0.24, s * 0.16 * grow);
      orb.addColorStop(0, `rgba(255,251,178,${flick})`);
      orb.addColorStop(0.6, 'rgba(255,238,88,0.8)');
      orb.addColorStop(1, 'rgba(255,238,88,0)');
      g.fillStyle = orb;
      g.beginPath();
      g.arc(0, -s * 0.24, s * 0.16 * grow, 0, Math.PI * 2);
      g.fill();
      // chispas
      g.strokeStyle = `rgba(255,241,118,${flick})`;
      g.lineWidth = Math.max(1, s * 0.02);
      for (let i = 0; i < level; i++) {
        const ang = t * 6 + (i * Math.PI * 2) / 3;
        g.beginPath();
        g.moveTo(Math.cos(ang) * s * 0.06, -s * 0.24 + Math.sin(ang) * s * 0.06);
        g.lineTo(Math.cos(ang) * s * 0.15, -s * 0.24 + Math.sin(ang) * s * 0.15);
        g.stroke();
      }
      break;
    }
    case 'sniper': {
      // torre de vigilancia
      g.fillStyle = '#5d4037';
      g.beginPath();
      g.moveTo(-s * 0.2, s * 0.3);
      g.lineTo(-s * 0.13, -s * 0.12);
      g.lineTo(s * 0.13, -s * 0.12);
      g.lineTo(s * 0.2, s * 0.3);
      g.closePath();
      g.fill();
      g.fillStyle = '#795548';
      roundRect(g, -s * 0.17, -s * 0.24, s * 0.34, s * 0.16, s * 0.03);
      g.fill();
      // cañón largo giratorio
      g.save();
      g.translate(0, -s * 0.16);
      g.rotate(a);
      g.strokeStyle = '#b0bec5';
      g.lineWidth = Math.max(2, s * 0.06);
      g.beginPath();
      g.moveTo(-rec, 0);
      g.lineTo(s * 0.42 * grow - rec, 0);
      g.stroke();
      // mira brillante cada pocos segundos
      const glint = (t % 3.1) < 0.18;
      if (glint) {
        g.strokeStyle = 'rgba(255,255,255,0.95)';
        g.lineWidth = Math.max(1, s * 0.02);
        g.beginPath();
        g.moveTo(s * 0.2, -s * 0.06);
        g.lineTo(s * 0.28, s * 0.06);
        g.stroke();
      }
      if (anim.flash > 0) muzzleFlash(s * 0.44 * grow, s, anim.flash);
      g.restore();
      break;
    }
    case 'mortar': {
      // plataforma reforzada
      g.fillStyle = '#4e342e';
      g.beginPath();
      g.arc(0, 0, s * 0.26 * grow, 0, Math.PI * 2);
      g.fill();
      g.save();
      g.rotate(a);
      // tubo corto y gordo
      g.strokeStyle = '#6d4c41';
      g.lineWidth = Math.max(3, s * 0.16 * grow);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(-s * 0.06 - rec, 0);
      g.lineTo(s * 0.2 * grow - rec, 0);
      g.stroke();
      g.fillStyle = '#10141c';
      g.beginPath();
      g.arc(s * 0.2 * grow - rec, 0, s * 0.08 * grow, 0, Math.PI * 2);
      g.fill();
      if (anim.flash > 0) muzzleFlash(s * 0.26 * grow, s, anim.flash);
      g.restore();
      break;
    }
    case 'bank': {
      // choza minera
      g.fillStyle = '#5d4037';
      roundRect(g, -s * 0.24, -s * 0.08, s * 0.48, s * 0.3, s * 0.05);
      g.fill();
      g.fillStyle = '#8d6e63';
      g.beginPath();
      g.moveTo(-s * 0.3, -s * 0.06);
      g.lineTo(0, -s * 0.3);
      g.lineTo(s * 0.3, -s * 0.06);
      g.closePath();
      g.fill();
      // monedas apiladas
      for (let i = 0; i < level + 1; i++) {
        g.fillStyle = '#ffd54f';
        g.beginPath();
        g.ellipse(s * 0.12, s * 0.12 - i * s * 0.06, s * 0.1, s * 0.04, 0, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#f9a825';
        g.lineWidth = Math.max(1, s * 0.015);
        g.stroke();
      }
      // destello
      const tw = (t % 2.3) < 0.2;
      if (tw) {
        g.strokeStyle = 'rgba(255,255,255,0.9)';
        g.lineWidth = Math.max(1, s * 0.02);
        g.beginPath();
        g.moveTo(s * 0.12 - s * 0.05, s * 0.0);
        g.lineTo(s * 0.12 + s * 0.05, s * 0.0);
        g.moveTo(s * 0.12, -s * 0.05);
        g.lineTo(s * 0.12, s * 0.05);
        g.stroke();
      }
      break;
    }
    case 'banner': {
      // mástil de madera clavado en la base
      g.strokeStyle = '#5d4037';
      g.lineWidth = Math.max(2, s * 0.06 * grow);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(0, s * 0.26);
      g.lineTo(0, -s * 0.4 * grow);
      g.stroke();
      // remate dorado en la punta
      g.fillStyle = '#ffd54f';
      g.beginPath();
      g.arc(0, -s * 0.42 * grow, s * 0.045 * grow, 0, Math.PI * 2);
      g.fill();
      // bandera ondeante en el color del dueño (adaptado de la del castillo)
      const top = -s * 0.4 * grow;
      const wav = Math.sin(t * 5) * s * 0.035;
      const flagW = s * 0.34 * grow;
      const flagH = s * 0.22 * grow;
      g.fillStyle = ownerColor;
      g.beginPath();
      g.moveTo(0, top);
      g.quadraticCurveTo(flagW * 0.5, top + s * 0.02 + wav, flagW, top + s * 0.03 - wav);
      g.lineTo(flagW, top + flagH - wav);
      g.quadraticCurveTo(flagW * 0.5, top + flagH - s * 0.02 + wav, 0, top + flagH);
      g.closePath();
      g.fill();
      // pliegue sombreado para dar volumen a la tela
      g.strokeStyle = 'rgba(0,0,0,0.18)';
      g.lineWidth = Math.max(1, s * 0.02);
      g.beginPath();
      g.moveTo(flagW * 0.5, top + s * 0.04 + wav * 0.5);
      g.quadraticCurveTo(flagW * 0.5, top + flagH * 0.5, flagW * 0.5, top + flagH - s * 0.02 + wav * 0.5);
      g.stroke();
      break;
    }
    case 'trap': {
      // placa metálica hundida en el suelo del camino + hilera de púas triangulares.
      // El desgaste (cargas restantes) lo pinta drawTowers con un contador aparte.
      g.fillStyle = '#4e342e';
      roundRect(g, -s * 0.3, -s * 0.18, s * 0.6, s * 0.36, s * 0.05);
      g.fill();
      g.fillStyle = '#3a2a24';
      roundRect(g, -s * 0.26, -s * 0.14, s * 0.52, s * 0.28, s * 0.04);
      g.fill();
      // púas metálicas
      const spikeShine = 0.6 + Math.sin(t * 6) * 0.2;
      g.fillStyle = `rgba(207,216,220,${spikeShine})`;
      g.strokeStyle = '#78909c';
      g.lineWidth = Math.max(1, s * 0.015);
      for (let row = -1; row <= 1; row++) {
        for (let col = -2; col <= 2; col++) {
          const sx = col * s * 0.11;
          const sy = row * s * 0.11;
          g.beginPath();
          g.moveTo(sx - s * 0.035, sy + s * 0.03);
          g.lineTo(sx, sy - s * 0.06);
          g.lineTo(sx + s * 0.035, sy + s * 0.03);
          g.closePath();
          g.fill();
          g.stroke();
        }
      }
      break;
    }
    case 'alchemist': {
      // pedestal + matraz burbujeante verde; el anillo de aura lo pinta drawTowers.
      g.fillStyle = '#37474f';
      roundRect(g, -s * 0.18, s * 0.02, s * 0.36, s * 0.22, s * 0.05);
      g.fill();
      // matraz (cuerpo triangular con cuello)
      g.fillStyle = 'rgba(200,230,201,0.35)';
      g.strokeStyle = '#a5d6a7';
      g.lineWidth = Math.max(1.2, s * 0.03);
      g.beginPath();
      g.moveTo(-s * 0.05, -s * 0.24 * grow);
      g.lineTo(-s * 0.05, -s * 0.08 * grow);
      g.lineTo(-s * 0.2 * grow, s * 0.08 * grow);
      g.lineTo(s * 0.2 * grow, s * 0.08 * grow);
      g.lineTo(s * 0.05, -s * 0.08 * grow);
      g.lineTo(s * 0.05, -s * 0.24 * grow);
      g.closePath();
      g.stroke();
      // líquido verde
      g.fillStyle = '#66bb6a';
      g.beginPath();
      g.moveTo(-s * 0.16 * grow, s * 0.02 * grow);
      g.lineTo(s * 0.16 * grow, s * 0.02 * grow);
      g.lineTo(s * 0.2 * grow, s * 0.08 * grow);
      g.lineTo(-s * 0.2 * grow, s * 0.08 * grow);
      g.closePath();
      g.fill();
      // burbujas ascendentes
      for (let i = 0; i < 3; i++) {
        const ph = (t * (0.8 + i * 0.25) + i * 0.4) % 1;
        g.fillStyle = `rgba(197,225,165,${0.9 - ph * 0.9})`;
        g.beginPath();
        g.arc((i - 1) * s * 0.07, s * 0.05 - ph * s * 0.24, s * (0.03 + 0.015 * (1 - ph)), 0, Math.PI * 2);
        g.fill();
      }
      // destello dorado (oro) sobre el matraz
      g.fillStyle = `rgba(255,213,79,${0.5 + Math.sin(t * 4) * 0.4})`;
      g.beginPath();
      g.arc(s * 0.14, -s * 0.2, s * 0.035, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'boom': {
      // Barril de pólvora sobre el camino: cuerpo de madera con flejes metálicos,
      // calavera de aviso y mecha encendida con chispa parpadeante.
      const bw = s * 0.44;
      const bh = s * 0.5;
      // cuerpo (ligero abombado con dos tonos de duela)
      g.fillStyle = '#6d4c41';
      roundRect(g, -bw / 2, -bh / 2 + s * 0.06, bw, bh, s * 0.1);
      g.fill();
      g.fillStyle = 'rgba(0,0,0,0.18)';
      roundRect(g, -bw / 2 + bw * 0.6, -bh / 2 + s * 0.06, bw * 0.4, bh, s * 0.1);
      g.fill();
      // duelas verticales
      g.strokeStyle = 'rgba(62,39,35,0.9)';
      g.lineWidth = Math.max(1, s * 0.02);
      for (let i = -1; i <= 1; i++) {
        g.beginPath();
        g.moveTo(i * bw * 0.25, -bh / 2 + s * 0.08);
        g.lineTo(i * bw * 0.25, bh / 2 + s * 0.04);
        g.stroke();
      }
      // flejes metálicos
      g.strokeStyle = '#90a4ae';
      g.lineWidth = Math.max(1.5, s * 0.045);
      for (const fy of [-bh * 0.24, bh * 0.24]) {
        g.beginPath();
        g.moveTo(-bw / 2, fy + s * 0.06);
        g.lineTo(bw / 2, fy + s * 0.06);
        g.stroke();
      }
      // calavera de aviso
      g.fillStyle = '#eceff1';
      g.beginPath();
      g.arc(0, s * 0.06, s * 0.075, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#37474f';
      g.beginPath();
      g.arc(-s * 0.027, s * 0.045, s * 0.02, 0, Math.PI * 2);
      g.arc(s * 0.027, s * 0.045, s * 0.02, 0, Math.PI * 2);
      g.fill();
      // mecha con chispa parpadeante (¡está armado!)
      const fx = bw * 0.12;
      const fy = -bh / 2 + s * 0.06;
      g.strokeStyle = '#8d6e63';
      g.lineWidth = Math.max(1, s * 0.03);
      g.beginPath();
      g.moveTo(fx, fy);
      g.quadraticCurveTo(fx + s * 0.1, fy - s * 0.12, fx + s * 0.03, fy - s * 0.2);
      g.stroke();
      const sparkle = 0.55 + Math.sin(t * 9) * 0.45;
      g.fillStyle = `rgba(255,213,79,${sparkle})`;
      g.beginPath();
      g.arc(fx + s * 0.03, fy - s * 0.22, s * (0.045 + 0.02 * sparkle), 0, Math.PI * 2);
      g.fill();
      g.fillStyle = `rgba(255,112,67,${sparkle * 0.8})`;
      g.beginPath();
      g.arc(fx + s * 0.03, fy - s * 0.22, s * 0.022, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'sentry': {
      // Lote 3 · OJO azul brillante sobre un pequeño trípode: esfera con iris
      // celeste, glow y parpadeo sutil. El radio de detección lo pinta drawTowers
      // (solo al seleccionar), como las auras.
      // trípode / poste
      g.strokeStyle = '#455a64';
      g.lineWidth = Math.max(1.5, s * 0.05);
      g.lineCap = 'round';
      for (const dx of [-s * 0.14, 0, s * 0.14]) {
        g.beginPath();
        g.moveTo(0, s * 0.02);
        g.lineTo(dx, s * 0.3);
        g.stroke();
      }
      // parpadeo: cada ~3.3 s el ojo se cierra un instante
      const blink = (t % 3.3) < 0.12 ? 0.12 : 1;
      const eyeR = s * 0.26;
      // glow celeste
      const glow = g.createRadialGradient(0, -s * 0.06, eyeR * 0.3, 0, -s * 0.06, eyeR * 1.9);
      glow.addColorStop(0, 'rgba(79,195,247,0.55)');
      glow.addColorStop(1, 'rgba(79,195,247,0)');
      g.fillStyle = glow;
      g.beginPath();
      g.arc(0, -s * 0.06, eyeR * 1.9, 0, Math.PI * 2);
      g.fill();
      // esclerótica (globo del ojo)
      g.fillStyle = '#e3f2fd';
      g.beginPath();
      g.ellipse(0, -s * 0.06, eyeR, eyeR * blink, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#0277bd';
      g.lineWidth = Math.max(1, s * 0.03);
      g.stroke();
      if (blink > 0.5) {
        // iris celeste
        g.fillStyle = '#29b6f6';
        g.beginPath();
        g.arc(0, -s * 0.06, eyeR * 0.55, 0, Math.PI * 2);
        g.fill();
        // pupila
        g.fillStyle = '#01579b';
        g.beginPath();
        g.arc(0, -s * 0.06, eyeR * 0.28, 0, Math.PI * 2);
        g.fill();
        // destello
        const spark = 0.6 + Math.sin(t * 3) * 0.4;
        g.fillStyle = `rgba(255,255,255,${spark})`;
        g.beginPath();
        g.arc(-eyeR * 0.2, -s * 0.06 - eyeR * 0.2, eyeR * 0.16, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
  }
  void def;

  // adornos de la especialización (encima del arte base)
  if (specialized) drawSpecFlourish(type, spec, s, t, grow);

  // nivel: rombos dorados bajo la torre
  g.fillStyle = '#ffd54f';
  for (let i = 0; i < level; i++) {
    const px = (i - (level - 1) / 2) * s * 0.14;
    g.beginPath();
    g.moveTo(px, s * 0.32);
    g.lineTo(px + s * 0.04, s * 0.38);
    g.lineTo(px, s * 0.44);
    g.lineTo(px - s * 0.04, s * 0.38);
    g.closePath();
    g.fill();
  }
  if (level >= 3 && !specialized) {
    g.strokeStyle = 'rgba(255,213,79,0.6)';
    g.lineWidth = Math.max(1, s * 0.02);
    g.beginPath();
    g.arc(0, 0, baseR + s * 0.02, 0, Math.PI * 2);
    g.stroke();
  }
  // corona de especialización
  if (specialized) {
    const rank2 = level >= 4;
    g.fillStyle = '#ffd54f';
    g.strokeStyle = 'rgba(0,0,0,0.4)';
    g.lineWidth = Math.max(1, s * 0.015);
    const cw = s * 0.26;
    const cy = -baseR - s * 0.16;
    g.beginPath();
    g.moveTo(-cw / 2, cy + s * 0.08);
    g.lineTo(-cw / 2, cy);
    g.lineTo(-cw / 4, cy + s * 0.05);
    g.lineTo(0, cy - s * 0.04);
    g.lineTo(cw / 4, cy + s * 0.05);
    g.lineTo(cw / 2, cy);
    g.lineTo(cw / 2, cy + s * 0.08);
    g.closePath();
    g.fill();
    g.stroke();
    // Rango II (nivel 4): gema roja incrustada en la corona + halo palpitante extra
    if (rank2) {
      const gemPulse = 0.6 + Math.sin(t * 4) * 0.4;
      g.fillStyle = `rgba(239,83,80,${0.85})`;
      g.beginPath();
      g.moveTo(0, cy - s * 0.02);
      g.lineTo(s * 0.05, cy + s * 0.03);
      g.lineTo(0, cy + s * 0.08);
      g.lineTo(-s * 0.05, cy + s * 0.03);
      g.closePath();
      g.fill();
      g.strokeStyle = `rgba(255,205,210,${gemPulse})`;
      g.lineWidth = Math.max(1, s * 0.02);
      g.stroke();
      // pequeñas gemas laterales para marcar el segundo rango
      g.fillStyle = `rgba(255,215,120,${gemPulse})`;
      for (const gx of [-cw / 2 + s * 0.03, cw / 2 - s * 0.03]) {
        g.beginPath();
        g.arc(gx, cy + s * 0.02, s * 0.025, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
}

// F4.3 · Arte combinado de cada FUSIÓN, centrado en (0,0), celda de tamaño s.
// Reconocible: mezcla los motivos de sus dos ingredientes.
function drawFusionArt(
  id: FusionId,
  s: number,
  t: number,
  a: number, // ángulo de puntería (para las que disparan)
  rec: number, // retroceso
  ownerColor: string,
  grow: number,
): void {
  switch (id) {
    case 'glacialplague': {
      // caldero con nube gélida-tóxica: vapores verde/celeste orbitando
      g.fillStyle = '#263238';
      roundRect(g, -s * 0.2, -s * 0.02, s * 0.4, s * 0.22, s * 0.06);
      g.fill();
      g.fillStyle = '#4dd0b1';
      g.beginPath();
      g.ellipse(0, -s * 0.02, s * 0.17, s * 0.05, 0, 0, Math.PI * 2);
      g.fill();
      for (let i = 0; i < 5; i++) {
        const ph = (t * 0.5 + i / 5) % 1;
        const ang = t * 0.9 + (i * Math.PI * 2) / 5;
        const rr = s * (0.12 + ph * 0.22);
        g.fillStyle = i % 2 === 0 ? `rgba(156,204,101,${0.55 - ph * 0.5})` : `rgba(129,212,250,${0.55 - ph * 0.5})`;
        g.beginPath();
        g.arc(Math.cos(ang) * rr, -s * 0.1 - ph * s * 0.22 + Math.sin(ang) * rr * 0.3, s * (0.09 - ph * 0.04) * grow, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'railstorm': {
      // doble riel largo con arcos eléctricos serpenteando entre las guías
      g.save();
      g.rotate(a);
      g.translate(-rec, 0);
      g.fillStyle = '#37474f';
      roundRect(g, -s * 0.1, -s * 0.11, s * 0.2, s * 0.22, s * 0.05);
      g.fill();
      g.strokeStyle = '#b0bec5';
      g.lineWidth = Math.max(1.5, s * 0.05);
      for (const off of [-0.07, 0.07]) {
        g.beginPath();
        g.moveTo(0, s * off);
        g.lineTo(s * 0.46 * grow, s * off);
        g.stroke();
      }
      // arco eléctrico zigzag entre los rieles
      g.strokeStyle = `rgba(255,238,88,${0.55 + Math.sin(t * 18) * 0.4})`;
      g.lineWidth = Math.max(1, s * 0.03);
      g.beginPath();
      g.moveTo(s * 0.06, 0);
      for (let i = 1; i <= 4; i++) {
        g.lineTo(s * (0.06 + i * 0.1), (i % 2 === 0 ? 1 : -1) * s * 0.055);
      }
      g.stroke();
      g.restore();
      break;
    }
    case 'bigbertha': {
      // obús descomunal: tubo grueso con refuerzos y boca enorme
      g.save();
      g.rotate(a);
      g.fillStyle = '#1c262e';
      roundRect(g, -s * 0.14 - rec, -s * 0.16, s * 0.58 * grow, s * 0.32, s * 0.1);
      g.fill();
      g.strokeStyle = '#546e7a';
      g.lineWidth = Math.max(1, s * 0.03);
      g.stroke();
      // anillos de refuerzo
      g.strokeStyle = '#78909c';
      g.lineWidth = Math.max(1.5, s * 0.045);
      for (const bx of [0.05, 0.2, 0.35]) {
        g.beginPath();
        g.moveTo(s * bx - rec, -s * 0.16);
        g.lineTo(s * bx - rec, s * 0.16);
        g.stroke();
      }
      // boca gigante
      g.fillStyle = '#0a0e14';
      g.beginPath();
      g.arc(s * 0.44 * grow - rec, 0, s * 0.13, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#ff8a65';
      g.lineWidth = Math.max(1, s * 0.03);
      g.stroke();
      g.restore();
      break;
    }
    case 'warlord': {
      // arco de guerra que apunta + estandarte plantado (dispara Y buffea)
      g.save();
      g.rotate(a);
      g.translate(-rec, 0);
      g.strokeStyle = '#d7ccc8';
      g.lineWidth = Math.max(1.5, s * 0.05);
      g.beginPath();
      g.arc(s * 0.08, 0, s * 0.22 * grow, -Math.PI * 0.42, Math.PI * 0.42);
      g.stroke();
      g.strokeStyle = '#8d6e63';
      g.lineWidth = Math.max(1, s * 0.03);
      g.beginPath();
      g.moveTo(-s * 0.06, 0);
      g.lineTo(s * 0.3, 0);
      g.stroke();
      g.fillStyle = '#eceff1';
      g.beginPath();
      g.moveTo(s * 0.34, 0);
      g.lineTo(s * 0.24, -s * 0.05);
      g.lineTo(s * 0.24, s * 0.05);
      g.fill();
      g.restore();
      // mástil con bandera del dueño (detrás del arco)
      g.strokeStyle = '#5d4037';
      g.lineWidth = Math.max(2, s * 0.05);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(-s * 0.16, s * 0.24);
      g.lineTo(-s * 0.16, -s * 0.42 * grow);
      g.stroke();
      const wav = Math.sin(t * 5) * s * 0.03;
      g.fillStyle = ownerColor;
      g.beginPath();
      g.moveTo(-s * 0.16, -s * 0.42 * grow);
      g.quadraticCurveTo(s * 0.02, -s * 0.4 * grow + wav, s * 0.12, -s * 0.38 * grow - wav);
      g.lineTo(s * 0.12, -s * 0.24 * grow - wav);
      g.quadraticCurveTo(s * 0.0, -s * 0.26 * grow + wav, -s * 0.16, -s * 0.24 * grow);
      g.closePath();
      g.fill();
      break;
    }
    case 'philostone': {
      // matraz alquímico con la PIEDRA dorada dentro y vapores de veneno
      g.fillStyle = '#37474f';
      roundRect(g, -s * 0.18, s * 0.04, s * 0.36, s * 0.2, s * 0.05);
      g.fill();
      g.fillStyle = 'rgba(156,204,101,0.3)';
      g.strokeStyle = '#a5d6a7';
      g.lineWidth = Math.max(1.2, s * 0.03);
      g.beginPath();
      g.moveTo(-s * 0.06, -s * 0.28 * grow);
      g.lineTo(-s * 0.06, -s * 0.06);
      g.lineTo(-s * 0.22 * grow, s * 0.1);
      g.lineTo(s * 0.22 * grow, s * 0.1);
      g.lineTo(s * 0.06, -s * 0.06);
      g.lineTo(s * 0.06, -s * 0.28 * grow);
      g.closePath();
      g.fill();
      g.stroke();
      // la piedra: gema dorada palpitante en el corazón del matraz
      const glow = 0.6 + Math.sin(t * 3.2) * 0.4;
      g.fillStyle = `rgba(255,213,79,${glow})`;
      g.beginPath();
      g.moveTo(0, -s * 0.08);
      g.lineTo(s * 0.09, 0);
      g.lineTo(0, s * 0.08);
      g.lineTo(-s * 0.09, 0);
      g.closePath();
      g.fill();
      g.strokeStyle = `rgba(255,241,118,${glow})`;
      g.lineWidth = Math.max(1, s * 0.02);
      g.stroke();
      // vapores tóxicos con monedas: burbujas verdes que suben y "doran"
      for (let i = 0; i < 3; i++) {
        const ph = (t * (0.7 + i * 0.2) + i * 0.37) % 1;
        g.fillStyle = ph < 0.5 ? `rgba(156,204,101,${0.8 - ph})` : `rgba(255,213,79,${1.2 - ph})`;
        g.beginPath();
        g.arc((i - 1) * s * 0.08, -s * 0.12 - ph * s * 0.26, s * 0.035, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'winterheart': {
      // corazón de cristal helado + copos orbitando (aura doble)
      const beat = 1 + Math.sin(t * 2.6) * 0.06;
      g.save();
      g.scale(beat, beat);
      g.fillStyle = 'rgba(129,212,250,0.85)';
      g.strokeStyle = '#e1f5fe';
      g.lineWidth = Math.max(1.2, s * 0.03);
      g.beginPath();
      g.moveTo(0, s * 0.16 * grow);
      g.bezierCurveTo(-s * 0.3 * grow, -s * 0.08 * grow, -s * 0.14 * grow, -s * 0.3 * grow, 0, -s * 0.1 * grow);
      g.bezierCurveTo(s * 0.14 * grow, -s * 0.3 * grow, s * 0.3 * grow, -s * 0.08 * grow, 0, s * 0.16 * grow);
      g.closePath();
      g.fill();
      g.stroke();
      // grieta de cristal
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      g.lineWidth = Math.max(1, s * 0.02);
      g.beginPath();
      g.moveTo(-s * 0.03, -s * 0.16);
      g.lineTo(s * 0.02, -s * 0.04);
      g.lineTo(-s * 0.02, s * 0.06);
      g.stroke();
      g.restore();
      // copos de nieve orbitando (el aura de hielo) en el color del dueño el asta
      g.fillStyle = '#e1f5fe';
      g.font = `${Math.max(7, s * 0.16)}px serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (let i = 0; i < 3; i++) {
        const ang = t * 1.4 + (i * Math.PI * 2) / 3;
        g.fillText('❄', Math.cos(ang) * s * 0.34, Math.sin(ang) * s * 0.34 * 0.6 - s * 0.05);
      }
      void ownerColor;
      break;
    }

    // ---------- issue #7 · arte de las 5 recetas nuevas ----------
    case 'toxicstorm': {
      // bobina Tesla con núcleo palpitante y arcos VERDES tóxicos irradiando
      g.fillStyle = '#33421f';
      roundRect(g, -s * 0.16, -s * 0.02, s * 0.32, s * 0.2, s * 0.05);
      g.fill();
      const core = 0.6 + Math.sin(t * 6) * 0.4;
      g.fillStyle = `rgba(174,213,129,${0.5 + core * 0.5})`;
      g.beginPath();
      g.arc(0, -s * 0.08, s * 0.12 * grow, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = `rgba(124,179,66,${core})`;
      g.lineWidth = Math.max(1, s * 0.03);
      g.stroke();
      g.strokeStyle = `rgba(197,225,165,${0.5 + Math.sin(t * 20) * 0.4})`;
      g.lineWidth = Math.max(1, s * 0.025);
      for (let k = 0; k < 4; k++) {
        const base = t * 1.2 + (k * Math.PI * 2) / 4;
        g.beginPath();
        g.moveTo(Math.cos(base) * s * 0.12, -s * 0.08 + Math.sin(base) * s * 0.12);
        for (let j = 1; j <= 3; j++) {
          const rr = s * (0.12 + j * 0.1);
          const jit = (j % 2 === 0 ? 1 : -1) * s * 0.05;
          g.lineTo(Math.cos(base) * rr - Math.sin(base) * jit, -s * 0.08 + Math.sin(base) * rr + Math.cos(base) * jit);
        }
        g.stroke();
      }
      break;
    }
    case 'shredder': {
      // autocañón de metralla: tres cañones cortos en abanico con bocas naranjas
      g.save();
      g.rotate(a);
      g.translate(-rec, 0);
      g.fillStyle = '#3e2723';
      roundRect(g, -s * 0.12, -s * 0.13, s * 0.2, s * 0.26, s * 0.05);
      g.fill();
      g.strokeStyle = '#8d6e63';
      g.lineWidth = Math.max(1.5, s * 0.05);
      g.lineCap = 'round';
      for (const off of [-0.11, 0, 0.11]) {
        g.beginPath();
        g.moveTo(s * 0.02, s * off);
        g.lineTo(s * 0.34 * grow, s * off);
        g.stroke();
      }
      g.fillStyle = '#ff8f00';
      for (const off of [-0.11, 0, 0.11]) {
        g.beginPath();
        g.arc(s * 0.34 * grow, s * off, s * 0.04, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
      break;
    }
    case 'siegeeye': {
      // cañón largo de precisión + retícula de "ojo" que todo lo ve
      g.save();
      g.rotate(a);
      g.translate(-rec, 0);
      g.fillStyle = '#263238';
      roundRect(g, -s * 0.1, -s * 0.055, s * 0.55 * grow, s * 0.11, s * 0.04);
      g.fill();
      g.strokeStyle = '#607d8b';
      g.lineWidth = Math.max(1, s * 0.025);
      g.stroke();
      g.fillStyle = '#10161a';
      g.beginPath();
      g.arc(s * 0.45 * grow, 0, s * 0.05, 0, Math.PI * 2);
      g.fill();
      g.restore();
      // retícula fija sobre la torre (no rota con el cañón)
      g.strokeStyle = '#cfd8dc';
      g.lineWidth = Math.max(1, s * 0.025);
      g.beginPath();
      g.arc(0, -s * 0.02, s * 0.14 * grow, 0, Math.PI * 2);
      g.stroke();
      const iris = 0.5 + Math.sin(t * 2) * 0.5;
      g.fillStyle = `rgba(144,164,174,${0.6 + iris * 0.4})`;
      g.beginPath();
      g.arc(0, -s * 0.02, s * 0.05, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.6)';
      g.lineWidth = Math.max(1, s * 0.015);
      g.beginPath();
      g.moveTo(-s * 0.14, -s * 0.02);
      g.lineTo(s * 0.14, -s * 0.02);
      g.moveTo(0, -s * 0.16);
      g.lineTo(0, s * 0.12);
      g.stroke();
      break;
    }
    case 'alchemyvault': {
      // cofre/bóveda dorada con matraz alquímico y monedas subiendo (no dispara)
      g.fillStyle = '#5d4037';
      roundRect(g, -s * 0.22, -s * 0.02, s * 0.44, s * 0.24, s * 0.05);
      g.fill();
      g.fillStyle = '#ffd54f';
      roundRect(g, -s * 0.22, -s * 0.02, s * 0.44, s * 0.08, s * 0.03);
      g.fill();
      g.fillStyle = '#8d6e63';
      g.beginPath();
      g.arc(0, s * 0.07, s * 0.04, 0, Math.PI * 2);
      g.fill();
      // matraz burbujeante encima de la tapa
      g.strokeStyle = '#a5d6a7';
      g.fillStyle = 'rgba(129,199,132,0.4)';
      g.lineWidth = Math.max(1, s * 0.025);
      g.beginPath();
      g.moveTo(-s * 0.05, -s * 0.2 * grow);
      g.lineTo(-s * 0.05, -s * 0.08);
      g.lineTo(-s * 0.12, -s * 0.02);
      g.lineTo(s * 0.12, -s * 0.02);
      g.lineTo(s * 0.05, -s * 0.08);
      g.lineTo(s * 0.05, -s * 0.2 * grow);
      g.closePath();
      g.fill();
      g.stroke();
      for (let i = 0; i < 3; i++) {
        const ph = (t * (0.6 + i * 0.2) + i * 0.4) % 1;
        g.fillStyle = `rgba(255,213,79,${1 - ph})`;
        g.beginPath();
        g.arc((i - 1) * s * 0.13, -s * 0.22 * grow - ph * s * 0.2, s * 0.035, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'icelance': {
      // lanza de cristal helado larga con punta gélida + copos (dispara)
      g.save();
      g.rotate(a);
      g.translate(-rec, 0);
      g.fillStyle = 'rgba(77,208,225,0.85)';
      g.strokeStyle = '#e0f7fa';
      g.lineWidth = Math.max(1, s * 0.02);
      g.beginPath();
      g.moveTo(-s * 0.1, -s * 0.05);
      g.lineTo(s * 0.34 * grow, -s * 0.03);
      g.lineTo(s * 0.48 * grow, 0);
      g.lineTo(s * 0.34 * grow, s * 0.03);
      g.lineTo(-s * 0.1, s * 0.05);
      g.closePath();
      g.fill();
      g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.lineWidth = Math.max(1, s * 0.015);
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(s * 0.4 * grow, 0);
      g.stroke();
      g.restore();
      g.fillStyle = '#b3e5fc';
      g.font = `${Math.max(6, s * 0.13)}px serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (let i = 0; i < 2; i++) {
        const ang = t * 1.6 + i * Math.PI;
        g.fillText('❄', Math.cos(ang) * s * 0.3, Math.sin(ang) * s * 0.18 - s * 0.14);
      }
      break;
    }
  }
}

// Detalles distintivos de cada especialización, dibujados sobre el arte base.
function drawSpecFlourish(type: TowerTypeId, spec: number, s: number, t: number, grow: number): void {
  const key = TOWERS[type].specs[spec]?.key ?? '';
  switch (key) {
    case 'repeater': {
      // tres saetas en abanico
      g.strokeStyle = '#8d6e63';
      g.lineWidth = Math.max(1, s * 0.025);
      for (const off of [-0.16, 0, 0.16]) {
        g.save();
        g.rotate(off);
        g.beginPath();
        g.moveTo(s * 0.1, 0);
        g.lineTo(s * 0.34 * grow, 0);
        g.stroke();
        g.restore();
      }
      break;
    }
    case 'flak': {
      // chispas de metralla al frente
      g.fillStyle = `rgba(255,171,64,${0.5 + Math.sin(t * 20) * 0.3})`;
      for (let i = 0; i < 5; i++) {
        const a = -0.5 + i * 0.25;
        g.beginPath();
        g.arc(Math.cos(a) * s * 0.34, Math.sin(a) * s * 0.34, s * 0.03, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'glacier': {
      // escarcha girando
      g.strokeStyle = 'rgba(179,229,252,0.9)';
      g.lineWidth = Math.max(1, s * 0.03);
      for (let i = 0; i < 6; i++) {
        const a = t * 0.6 + (i * Math.PI) / 3;
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(Math.cos(a) * s * 0.32 * grow, Math.sin(a) * s * 0.32 * grow);
        g.stroke();
      }
      break;
    }
    case 'plague':
    case 'corrosion': {
      // burbujas tóxicas ascendentes
      for (let i = 0; i < 4; i++) {
        const ph = (t * 0.9 + i * 0.3) % 1;
        g.fillStyle = `rgba(174,213,129,${(1 - ph) * 0.8})`;
        g.beginPath();
        g.arc((i - 1.5) * s * 0.12, -ph * s * 0.4, s * 0.05 * (1 - ph * 0.5), 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'storm': {
      // arcos eléctricos alrededor
      g.strokeStyle = `rgba(255,241,118,${0.6 + Math.sin(t * 22) * 0.4})`;
      g.lineWidth = Math.max(1, s * 0.025);
      for (let i = 0; i < 3; i++) {
        const a = t * 4 + (i * Math.PI * 2) / 3;
        g.beginPath();
        g.moveTo(Math.cos(a) * s * 0.2, Math.sin(a) * s * 0.2);
        g.lineTo(Math.cos(a) * s * 0.42 * grow, Math.sin(a) * s * 0.42 * grow);
        g.stroke();
      }
      break;
    }
    case 'railgun':
    case 'railcannon': {
      // núcleo de energía cargándose
      const glow = 0.5 + Math.sin(t * 6) * 0.5;
      g.fillStyle = `rgba(129,212,250,${glow})`;
      g.beginPath();
      g.arc(0, 0, s * 0.1 * grow, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'barrage': {
      g.fillStyle = 'rgba(255,138,101,0.9)';
      for (const off of [-0.14, 0, 0.14]) {
        g.beginPath();
        g.arc(off * s, -s * 0.02, s * 0.06, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'napalm': {
      // llamas
      for (let i = 0; i < 5; i++) {
        const ph = (t * 1.4 + i * 0.2) % 1;
        g.fillStyle = `rgba(255,${100 + ph * 100},40,${(1 - ph) * 0.9})`;
        g.beginPath();
        g.arc((i - 2) * s * 0.09, -ph * s * 0.35, s * 0.05 * (1 - ph * 0.6), 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'treasury':
    case 'mint': {
      // destellos dorados
      g.fillStyle = `rgba(255,213,79,${0.6 + Math.sin(t * 5) * 0.4})`;
      for (let i = 0; i < 3; i++) {
        const a = t * 1.5 + (i * Math.PI * 2) / 3;
        g.beginPath();
        g.arc(Math.cos(a) * s * 0.3, Math.sin(a) * s * 0.3 - s * 0.1, s * 0.04, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'warbanner': {
      // gallardete rojo extra ondeando bajo la bandera + destellos marciales
      const top = -s * 0.4 * grow;
      const wav = Math.sin(t * 5 + 1) * s * 0.04;
      g.fillStyle = '#e53935';
      g.beginPath();
      g.moveTo(0, top + s * 0.24 * grow);
      g.quadraticCurveTo(s * 0.18 * grow, top + s * 0.26 * grow + wav, s * 0.34 * grow, top + s * 0.24 * grow - wav);
      g.lineTo(s * 0.24 * grow, top + s * 0.34 * grow - wav);
      g.quadraticCurveTo(s * 0.14 * grow, top + s * 0.3 * grow + wav, 0, top + s * 0.34 * grow);
      g.closePath();
      g.fill();
      g.fillStyle = `rgba(255,138,101,${0.5 + Math.sin(t * 12) * 0.4})`;
      for (let i = 0; i < 4; i++) {
        const a = t * 2 + (i * Math.PI) / 2;
        g.beginPath();
        g.arc(Math.cos(a) * s * 0.28, Math.sin(a) * s * 0.28 - s * 0.05, s * 0.035, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'hastebanner': {
      // estelas celestes de velocidad girando alrededor
      g.strokeStyle = `rgba(129,212,250,${0.55 + Math.sin(t * 10) * 0.35})`;
      g.lineWidth = Math.max(1.5, s * 0.03);
      g.lineCap = 'round';
      for (let i = 0; i < 4; i++) {
        const a = t * 3.2 + (i * Math.PI) / 2;
        g.beginPath();
        g.arc(0, -s * 0.02, s * 0.3 * grow, a, a + Math.PI * 0.4);
        g.stroke();
      }
      break;
    }
  }
}

function muzzleFlash(dist: number, s: number, f: number): void {
  g.fillStyle = `rgba(255,224,130,${f})`;
  g.beginPath();
  g.moveTo(dist, 0);
  g.lineTo(dist + s * 0.22 * f, -s * 0.09 * f);
  g.lineTo(dist + s * 0.3 * f, 0);
  g.lineTo(dist + s * 0.22 * f, s * 0.09 * f);
  g.closePath();
  g.fill();
}

// ---------- enemigos ----------

function drawEnemies(interp: InterpResult, now: number): void {
  const s = view.scale;
  const t = now / 1000;
  let boss: { hpFrac: number; name: string } | null = null;

  for (const e of interp.enemies) {
    // Lote 3 · INVISIBLE no detectado: NO se dibuja NADA (ni sombra ni barra de
    // vida) — desaparece de verdad, para que el Sentry importe. Detectado: se pinta
    // semitransparente con un shimmer (más abajo).
    const isInvisible = (e.flags & 64) !== 0;
    const isDetected = (e.flags & 128) !== 0;
    if (isInvisible && !isDetected) continue;
    const stealth = isInvisible && isDetected;
    const type = ENEMY_ORDER[e.typeIdx];
    const def = ENEMIES[type];
    const isBoss = (e.flags & 4) !== 0;
    const isElite = (e.flags & 8) !== 0;
    const isImmune = (e.flags & 16) !== 0;
    const affixes = isElite ? affixesFromMask(e.affix) : [];
    if (stealth) g.globalAlpha = 0.5;
    const x = toX(e.x);
    let y = toY(e.y);
    const r = Math.max(4, def.radius * s * (isElite ? 1.3 : 1));
    const bob = Math.sin(t * def.speed * 6 + e.id * 1.7);

    // sombra
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.beginPath();
    g.ellipse(x, toY(e.y) + r * (def.flying ? 1.15 : 0.82), r * 0.72, r * 0.28, 0, 0, Math.PI * 2);
    g.fill();

    if (def.flying) y += bob * s * 0.06 - s * 0.18;

    // aura de élite (palpita en el color del primer afijo)
    if (isElite) {
      const auraColor = affixes[0] ? AFFIXES[affixes[0]].color : '#ffd54f';
      const pulse = 0.5 + Math.sin(t * 4 + e.id) * 0.5;
      const halo = g.createRadialGradient(x, y, r * 0.6, x, y, r * 2);
      halo.addColorStop(0, `${auraColor}55`);
      halo.addColorStop(1, `${auraColor}00`);
      g.fillStyle = halo;
      g.beginPath();
      g.arc(x, y, r * (1.6 + pulse * 0.3), 0, Math.PI * 2);
      g.fill();
    }

    g.save();
    g.translate(x, y);
    drawEnemyArt(type, def.color, r, t, e.id, bob, s);

    // Lote 3 · DETECTADO (invisible revelado por un Sentry): shimmer sutil —
    // anillo celeste discontinuo que gira, para leer "esto solo lo ves por el Sentry".
    if (stealth) {
      const shim = 0.45 + Math.sin(t * 6 + e.id) * 0.3;
      g.strokeStyle = `rgba(120,200,255,${shim})`;
      g.lineWidth = Math.max(1, r * 0.1);
      g.setLineDash([r * 0.3, r * 0.3]);
      g.beginPath();
      g.arc(0, 0, r * 1.12, t + e.id, t + e.id + Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }

    // INMUNE a magia: tinte azulado + escudo runado giratorio. Marca visual clara
    // de que hielo/veneno/execute/tesla no le hacen mella (solo daño físico).
    if (isImmune) {
      g.fillStyle = 'rgba(96,165,250,0.32)';
      g.beginPath();
      g.arc(0, 0, r * 1.02, 0, Math.PI * 2);
      g.fill();
      // escudo runado: anillo de trazos claros que rota lentamente
      const rot = t * 0.8 + e.id;
      g.strokeStyle = 'rgba(191,219,254,0.95)';
      g.lineWidth = Math.max(1.5, r * 0.14);
      g.setLineDash([r * 0.32, r * 0.28]);
      g.beginPath();
      g.arc(0, 0, r * 1.32, rot, rot + Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
      // pequeñas runas (puntos) en el anillo
      g.fillStyle = 'rgba(147,197,253,0.9)';
      for (let ri = 0; ri < 4; ri++) {
        const a = rot + (ri * Math.PI) / 2;
        g.beginPath();
        g.arc(Math.cos(a) * r * 1.32, Math.sin(a) * r * 1.32, Math.max(1, r * 0.1), 0, Math.PI * 2);
        g.fill();
      }
    }

    // anillo de élite
    if (isElite) {
      const auraColor = affixes[0] ? AFFIXES[affixes[0]].color : '#ffd54f';
      g.strokeStyle = auraColor;
      g.lineWidth = Math.max(1.5, r * 0.12);
      g.setLineDash([r * 0.5, r * 0.35]);
      g.beginPath();
      g.arc(0, 0, r * 1.18, t % (Math.PI * 2), t % (Math.PI * 2) + Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }

    // estado: hielo / veneno
    if (e.flags & 1) {
      g.strokeStyle = 'rgba(129,212,250,0.95)';
      g.lineWidth = Math.max(2, r * 0.2);
      g.beginPath();
      g.arc(0, 0, r * 1.02, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = 'rgba(200,240,255,0.9)';
      for (let i = 0; i < 3; i++) {
        const a = t * 1.3 + (i * Math.PI * 2) / 3 + e.id;
        g.beginPath();
        g.arc(Math.cos(a) * r * 1.15, Math.sin(a) * r * 1.15, Math.max(1, r * 0.12), 0, Math.PI * 2);
        g.fill();
      }
    }
    if (e.flags & 2) {
      const ph = (t * 1.4 + e.id * 0.31) % 1;
      g.fillStyle = `rgba(156,204,101,${0.9 - ph * 0.9})`;
      g.beginPath();
      g.arc(r * 0.3, -r - ph * r * 0.9, Math.max(1.5, r * 0.16 * (1 - ph * 0.5)), 0, Math.PI * 2);
      g.fill();
    }
    // SHRED de armadura (Obús/Metralla II): grietas naranjas girando alrededor —
    // marca que su armadura efectiva está a la mitad.
    if (e.flags & 32) {
      const rot = t * 1.6 + e.id;
      g.strokeStyle = `rgba(255,152,0,${0.6 + Math.sin(t * 8 + e.id) * 0.3})`;
      g.lineWidth = Math.max(1.2, r * 0.14);
      for (let i = 0; i < 4; i++) {
        const a = rot + (i * Math.PI) / 2;
        g.beginPath();
        g.moveTo(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9);
        g.lineTo(Math.cos(a + 0.35) * r * 1.25, Math.sin(a + 0.35) * r * 1.25);
        g.stroke();
      }
    }
    g.restore();

    // barra de vida
    if (e.hpFrac < 1) {
      const bw = Math.max(16, r * 2.2);
      const bh = Math.max(3, s * 0.08);
      const bx = x - bw / 2;
      const by = y - r - bh - Math.max(3, s * 0.08);
      g.fillStyle = 'rgba(6,8,14,0.75)';
      roundRect(g, bx - 1, by - 1, bw + 2, bh + 2, bh / 2);
      g.fill();
      g.fillStyle = isElite
        ? '#ce93d8'
        : e.hpFrac > 0.5 ? '#66bb6a' : e.hpFrac > 0.25 ? '#ffb300' : '#ef5350';
      roundRect(g, bx, by, Math.max(bh, bw * Math.max(0, e.hpFrac)), bh, bh / 2);
      g.fill();
    }

    // corona + iconos de afijos sobre los élites
    if (isElite && s > 22) {
      const iconY = y - r - (e.hpFrac < 1 ? s * 0.34 : s * 0.22);
      g.font = `${Math.max(9, s * 0.34)}px serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const total = affixes.length;
      affixes.forEach((a, i) => {
        g.fillText(AFFIXES[a].icon, x + (i - (total - 1) / 2) * s * 0.32, iconY);
      });
    }

    if (isBoss && (!boss || e.hpFrac > boss.hpFrac)) {
      boss = { hpFrac: e.hpFrac, name: def.name };
    }
    if (stealth) g.globalAlpha = 1; // restablecer antes del siguiente enemigo
  }

  g.globalAlpha = 1;
  if (boss) drawBossBar(boss);
}

// Arte vectorial de cada enemigo, centrado en (0,0) con radio r.
function drawEnemyArt(type: EnemyTypeId, color: string, r: number, t: number, id: number, bob: number, s: number): void {
  const dark = shade(color, 0.55);
  const lite = shade(color, 1.35);

  const eyes = (dx: number, dy: number, er: number, angry = false) => {
    g.fillStyle = '#10141c';
    g.beginPath();
    g.arc(-dx, dy, er, 0, Math.PI * 2);
    g.arc(dx, dy, er, 0, Math.PI * 2);
    g.fill();
    if (angry) {
      g.strokeStyle = '#10141c';
      g.lineWidth = Math.max(1, er * 0.7);
      g.beginPath();
      g.moveTo(-dx - er, dy - er * 1.6);
      g.lineTo(-dx + er, dy - er * 0.7);
      g.moveTo(dx + er, dy - er * 1.6);
      g.lineTo(dx - er, dy - er * 0.7);
      g.stroke();
    }
  };
  const bodyCircle = (rr: number) => {
    const grad = g.createRadialGradient(-rr * 0.35, -rr * 0.35, rr * 0.2, 0, 0, rr);
    grad.addColorStop(0, lite);
    grad.addColorStop(1, color);
    g.fillStyle = grad;
    g.strokeStyle = dark;
    g.lineWidth = Math.max(1.2, rr * 0.12);
    g.beginPath();
    g.arc(0, 0, rr, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  };

  switch (type) {
    case 'goblin': {
      // orejas puntiagudas
      g.fillStyle = color;
      g.strokeStyle = dark;
      g.lineWidth = Math.max(1, r * 0.1);
      for (const side of [-1, 1]) {
        g.beginPath();
        g.moveTo(side * r * 0.5, -r * 0.3);
        g.lineTo(side * r * 1.35, -r * 0.9 + bob * r * 0.06);
        g.lineTo(side * r * 0.75, r * 0.05);
        g.closePath();
        g.fill();
        g.stroke();
      }
      bodyCircle(r);
      eyes(r * 0.32, -r * 0.14, Math.max(1, r * 0.14));
      // sonrisa pícara
      g.strokeStyle = '#10141c';
      g.lineWidth = Math.max(1, r * 0.09);
      g.beginPath();
      g.arc(0, r * 0.18, r * 0.42, Math.PI * 0.15, Math.PI * 0.85);
      g.stroke();
      break;
    }
    case 'runner': {
      // cuerpo inclinado con estelas de velocidad
      g.save();
      g.rotate(bob * 0.06);
      g.strokeStyle = `rgba(255,202,40,0.4)`;
      g.lineWidth = Math.max(1, r * 0.14);
      for (let i = 0; i < 2; i++) {
        g.beginPath();
        g.moveTo(-r * (1.3 + i * 0.5), -r * 0.25 + i * r * 0.5);
        g.lineTo(-r * 0.6, -r * 0.25 + i * r * 0.5);
        g.stroke();
      }
      const grad = g.createRadialGradient(-r * 0.2, -r * 0.3, r * 0.2, 0, 0, r);
      grad.addColorStop(0, lite);
      grad.addColorStop(1, color);
      g.fillStyle = grad;
      g.strokeStyle = dark;
      g.lineWidth = Math.max(1.2, r * 0.12);
      g.beginPath();
      g.ellipse(0, 0, r * 1.05, r * 0.85, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      // piernas al trote
      g.strokeStyle = dark;
      g.lineWidth = Math.max(1.5, r * 0.16);
      g.beginPath();
      g.moveTo(-r * 0.2, r * 0.6);
      g.lineTo(-r * 0.2 + bob * r * 0.35, r * 1.1);
      g.moveTo(r * 0.25, r * 0.6);
      g.lineTo(r * 0.25 - bob * r * 0.35, r * 1.1);
      g.stroke();
      eyes(r * 0.3, -r * 0.15, Math.max(1, r * 0.13));
      g.restore();
      break;
    }
    case 'brute': {
      // cuernos
      g.fillStyle = '#efebe9';
      for (const side of [-1, 1]) {
        g.beginPath();
        g.moveTo(side * r * 0.5, -r * 0.6);
        g.quadraticCurveTo(side * r * 1.1, -r * 1.15, side * r * 0.75, -r * 1.35);
        g.lineTo(side * r * 0.45, -r * 0.85);
        g.closePath();
        g.fill();
      }
      // cuerpo cuadradote
      const grad = g.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.2, 0, 0, r * 1.2);
      grad.addColorStop(0, lite);
      grad.addColorStop(1, color);
      g.fillStyle = grad;
      g.strokeStyle = dark;
      g.lineWidth = Math.max(1.5, r * 0.12);
      roundRect(g, -r * 0.95, -r * 0.85, r * 1.9, r * 1.7, r * 0.4);
      g.fill();
      g.stroke();
      // puños que se balancean
      g.fillStyle = color;
      g.beginPath();
      g.arc(-r * 1.05, bob * r * 0.15, r * 0.32, 0, Math.PI * 2);
      g.arc(r * 1.05, -bob * r * 0.15, r * 0.32, 0, Math.PI * 2);
      g.fill();
      eyes(r * 0.34, -r * 0.2, Math.max(1, r * 0.15), true);
      // dientes
      g.fillStyle = '#efebe9';
      for (let i = -1; i <= 1; i += 2) {
        g.beginPath();
        g.moveTo(i * r * 0.25, r * 0.4);
        g.lineTo(i * r * 0.15, r * 0.62);
        g.lineTo(i * r * 0.05, r * 0.4);
        g.fill();
      }
      break;
    }
    case 'bat': {
      const flap = Math.sin(t * 16 + id);
      // alas
      g.fillStyle = dark;
      for (const side of [-1, 1]) {
        g.save();
        g.scale(side, 1);
        g.beginPath();
        g.moveTo(r * 0.3, 0);
        g.quadraticCurveTo(r * 1.5, -r * (0.9 + flap * 0.55), r * 1.9, flap * r * 0.35);
        g.quadraticCurveTo(r * 1.3, r * 0.2 - flap * r * 0.2, r * 0.3, r * 0.3);
        g.closePath();
        g.fill();
        g.restore();
      }
      bodyCircle(r * 0.8);
      // orejitas
      g.fillStyle = color;
      for (const side of [-1, 1]) {
        g.beginPath();
        g.moveTo(side * r * 0.2, -r * 0.6);
        g.lineTo(side * r * 0.45, -r * 1.05);
        g.lineTo(side * r * 0.55, -r * 0.5);
        g.closePath();
        g.fill();
      }
      eyes(r * 0.25, -r * 0.1, Math.max(1, r * 0.12));
      break;
    }
    case 'armored': {
      bodyCircle(r);
      // casco metálico
      g.fillStyle = '#cfd8dc';
      g.strokeStyle = '#78909c';
      g.lineWidth = Math.max(1, r * 0.08);
      g.beginPath();
      g.arc(0, -r * 0.05, r * 0.95, Math.PI, 0);
      g.closePath();
      g.fill();
      g.stroke();
      // visera
      g.fillStyle = '#10141c';
      g.fillRect(-r * 0.65, -r * 0.25, r * 1.3, Math.max(2, r * 0.18));
      // remaches
      g.fillStyle = '#90a4ae';
      for (let i = 0; i < 4; i++) {
        const a = Math.PI + (i + 0.5) * (Math.PI / 4);
        g.beginPath();
        g.arc(Math.cos(a) * r * 0.72, -r * 0.05 + Math.sin(a) * r * 0.72, Math.max(1, r * 0.08), 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'shaman': {
      // aura curativa
      const ph = (t * 0.9 + id * 0.4) % 1;
      g.strokeStyle = `rgba(102,187,106,${0.5 * (1 - ph)})`;
      g.lineWidth = Math.max(1, r * 0.1);
      g.beginPath();
      g.arc(0, 0, r * (1.1 + ph * 0.8), 0, Math.PI * 2);
      g.stroke();
      bodyCircle(r);
      // capucha
      g.fillStyle = dark;
      g.beginPath();
      g.moveTo(-r * 0.85, -r * 0.05);
      g.quadraticCurveTo(0, -r * 1.6, r * 0.85, -r * 0.05);
      g.quadraticCurveTo(0, -r * 0.5, -r * 0.85, -r * 0.05);
      g.fill();
      // bastón con orbe
      g.strokeStyle = '#6d4c41';
      g.lineWidth = Math.max(1.5, r * 0.12);
      g.beginPath();
      g.moveTo(r * 0.75, r * 0.9);
      g.lineTo(r * 0.95, -r * 0.7);
      g.stroke();
      const glow = 0.7 + Math.sin(t * 4 + id) * 0.3;
      g.fillStyle = `rgba(129,199,132,${glow})`;
      g.beginPath();
      g.arc(r * 0.97, -r * 0.8, r * 0.22, 0, Math.PI * 2);
      g.fill();
      eyes(r * 0.26, 0, Math.max(1, r * 0.12));
      break;
    }
    case 'larva': {
      // tres segmentos que serpentean
      for (let i = 2; i >= 0; i--) {
        const off = Math.sin(t * 8 + id + i * 1.2) * r * 0.25;
        const rr = r * (1 - i * 0.22);
        const grad = g.createRadialGradient(-rr * 0.3, -rr * 0.3 - i * r * 0.0, rr * 0.2, -i * r * 0.75, off, rr);
        grad.addColorStop(0, lite);
        grad.addColorStop(1, color);
        g.fillStyle = grad;
        g.strokeStyle = dark;
        g.lineWidth = Math.max(1, rr * 0.12);
        g.beginPath();
        g.arc(-i * r * 0.75, off, rr, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
      eyes(r * 0.3, -r * 0.15, Math.max(1, r * 0.14));
      break;
    }
    case 'troll': {
      bodyCircle(r);
      // musgo
      g.fillStyle = 'rgba(46,125,50,0.55)';
      g.beginPath();
      g.arc(-r * 0.4, -r * 0.5, r * 0.3, 0, Math.PI * 2);
      g.arc(r * 0.5, -r * 0.25, r * 0.22, 0, Math.PI * 2);
      g.fill();
      // regeneración: cruces verdes que suben
      const ph = (t * 1.1 + id * 0.7) % 1;
      g.strokeStyle = `rgba(129,199,132,${0.9 - ph * 0.9})`;
      g.lineWidth = Math.max(1.5, r * 0.1);
      const hy = -r - ph * r * 0.8;
      g.beginPath();
      g.moveTo(-r * 0.4 - r * 0.12, hy);
      g.lineTo(-r * 0.4 + r * 0.12, hy);
      g.moveTo(-r * 0.4, hy - r * 0.12);
      g.lineTo(-r * 0.4, hy + r * 0.12);
      g.stroke();
      // mandíbula con colmillos
      g.fillStyle = dark;
      g.beginPath();
      g.arc(0, r * 0.35, r * 0.5, 0, Math.PI);
      g.fill();
      g.fillStyle = '#efebe9';
      for (const side of [-1, 1]) {
        g.beginPath();
        g.moveTo(side * r * 0.35, r * 0.45);
        g.lineTo(side * r * 0.25, r * 0.1);
        g.lineTo(side * r * 0.15, r * 0.45);
        g.closePath();
        g.fill();
      }
      eyes(r * 0.3, -r * 0.2, Math.max(1, r * 0.13), true);
      break;
    }
    case 'slime':
    case 'slimelet': {
      const sq = 1 + Math.sin(t * 6 + id) * 0.12;
      const grad = g.createRadialGradient(-r * 0.3, -r * 0.4, r * 0.15, 0, 0, r * 1.1);
      grad.addColorStop(0, lite);
      grad.addColorStop(1, color);
      g.fillStyle = grad;
      g.strokeStyle = dark;
      g.lineWidth = Math.max(1.2, r * 0.1);
      g.globalAlpha = 0.92;
      g.beginPath();
      g.ellipse(0, r * (1 - 1 / sq) * 0.4, r * sq, r / sq, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.globalAlpha = 1;
      // brillo gelatinoso
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.beginPath();
      g.ellipse(-r * 0.35, -r * 0.35 / sq, r * 0.22, r * 0.12, -0.6, 0, Math.PI * 2);
      g.fill();
      eyes(r * 0.3, -r * 0.05, Math.max(1, r * 0.13));
      break;
    }
    case 'ghost': {
      g.globalAlpha = 0.68 + Math.sin(t * 2.5 + id) * 0.1;
      const grad = g.createRadialGradient(-r * 0.3, -r * 0.4, r * 0.2, 0, 0, r * 1.15);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(1, color);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(0, -r * 0.15, r, Math.PI, 0);
      // flecos ondulantes
      const n = 4;
      for (let i = 0; i <= n; i++) {
        const fx = r - (i * 2 * r) / n;
        const fy = r * 0.55 + Math.sin(t * 7 + i * 2 + id) * r * 0.16;
        g.quadraticCurveTo(fx + r / n, fy + r * 0.25, fx, fy);
      }
      g.closePath();
      g.fill();
      // ojos huecos
      g.fillStyle = 'rgba(20,20,35,0.85)';
      g.beginPath();
      g.ellipse(-r * 0.3, -r * 0.25, r * 0.14, r * 0.2, 0, 0, Math.PI * 2);
      g.ellipse(r * 0.3, -r * 0.25, r * 0.14, r * 0.2, 0, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
      break;
    }
    case 'golem': {
      // roca irregular
      const grad = g.createRadialGradient(-r * 0.4, -r * 0.4, r * 0.3, 0, 0, r * 1.3);
      grad.addColorStop(0, lite);
      grad.addColorStop(1, shade(color, 0.8));
      g.fillStyle = grad;
      g.strokeStyle = dark;
      g.lineWidth = Math.max(2, r * 0.1);
      g.beginPath();
      const pts: [number, number][] = [
        [-0.95, 0.5], [-1.0, -0.25], [-0.55, -0.85], [0.1, -1.0], [0.7, -0.75], [1.0, -0.1], [0.85, 0.6], [0.25, 0.95], [-0.5, 0.9],
      ];
      g.moveTo(pts[0][0] * r, pts[0][1] * r);
      for (const [px, py] of pts.slice(1)) g.lineTo(px * r, py * r);
      g.closePath();
      g.fill();
      g.stroke();
      // grietas incandescentes
      const glow = 0.6 + Math.sin(t * 3) * 0.4;
      g.strokeStyle = `rgba(255,110,64,${glow})`;
      g.lineWidth = Math.max(1.5, r * 0.07);
      g.beginPath();
      g.moveTo(-r * 0.5, r * 0.4);
      g.lineTo(-r * 0.2, r * 0.05);
      g.lineTo(-r * 0.35, -r * 0.35);
      g.moveTo(r * 0.3, r * 0.5);
      g.lineTo(r * 0.45, r * 0.05);
      g.lineTo(r * 0.25, -r * 0.3);
      g.stroke();
      // ojos ardientes
      g.fillStyle = `rgba(255,171,64,${0.7 + glow * 0.3})`;
      g.beginPath();
      g.arc(-r * 0.28, -r * 0.35, r * 0.14, 0, Math.PI * 2);
      g.arc(r * 0.28, -r * 0.35, r * 0.14, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'sapper': {
      // gnomo con un gran martillo que golpea (bob impulsa el swing)
      bodyCircle(r * 0.9);
      eyes(r * 0.3, -r * 0.1, Math.max(1, r * 0.13), true);
      // casco
      g.fillStyle = shade(color, 0.7);
      g.beginPath();
      g.arc(0, -r * 0.25, r * 0.95, Math.PI, 0);
      g.fill();
      // martillo al hombro, oscilando
      g.save();
      g.rotate(-0.5 + Math.sin(t * 4 + id) * 0.35);
      g.strokeStyle = '#6d4c41';
      g.lineWidth = Math.max(2, r * 0.18);
      g.beginPath();
      g.moveTo(r * 0.5, r * 0.2);
      g.lineTo(r * 1.3, -r * 0.9);
      g.stroke();
      g.fillStyle = '#9e9e9e';
      roundRect(g, r * 1.05, -r * 1.35, r * 0.7, r * 0.55, r * 0.1);
      g.fill();
      g.restore();
      break;
    }
    case 'thief': {
      // silueta encapuchada con una bolsa de oro; leve inclinación al correr
      g.save();
      g.rotate(bob * 0.05);
      const grad = g.createRadialGradient(-r * 0.2, -r * 0.3, r * 0.2, 0, 0, r);
      grad.addColorStop(0, lite);
      grad.addColorStop(1, color);
      g.fillStyle = grad;
      g.strokeStyle = dark;
      g.lineWidth = Math.max(1.2, r * 0.12);
      // capucha puntiaguda
      g.beginPath();
      g.moveTo(0, -r * 1.25);
      g.lineTo(r * 0.9, r * 0.4);
      g.quadraticCurveTo(0, r * 0.85, -r * 0.9, r * 0.4);
      g.closePath();
      g.fill();
      g.stroke();
      // ojos brillantes en la sombra de la capucha
      g.fillStyle = '#ffe082';
      g.beginPath();
      g.arc(-r * 0.22, -r * 0.1, r * 0.1, 0, Math.PI * 2);
      g.arc(r * 0.22, -r * 0.1, r * 0.1, 0, Math.PI * 2);
      g.fill();
      // bolsa de oro
      g.fillStyle = '#ffca28';
      g.strokeStyle = '#8d6e63';
      g.lineWidth = Math.max(1, r * 0.08);
      g.beginPath();
      g.arc(r * 0.75, r * 0.35, r * 0.32, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = '#7a5c00';
      g.font = `bold ${Math.max(6, r * 0.5)}px serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('$', r * 0.75, r * 0.37);
      g.restore();
      break;
    }
    case 'berserker': {
      // jabalí furioso; enrojece y "vibra" cuando está herido (lo lee el render por bob)
      const rage = 0.5 + Math.abs(Math.sin(t * 12 + id)) * 0.5;
      const grad = g.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.2, 0, 0, r * 1.15);
      grad.addColorStop(0, lite);
      grad.addColorStop(1, color);
      g.fillStyle = grad;
      g.strokeStyle = dark;
      g.lineWidth = Math.max(1.5, r * 0.12);
      g.beginPath();
      g.ellipse(0, 0, r * 1.1, r * 0.9, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      // colmillos
      g.fillStyle = '#efebe9';
      for (const side of [-1, 1]) {
        g.beginPath();
        g.moveTo(side * r * 0.55, r * 0.25);
        g.quadraticCurveTo(side * r * 0.95, r * 0.05, side * r * 0.7, -r * 0.3);
        g.lineTo(side * r * 0.45, r * 0.05);
        g.closePath();
        g.fill();
      }
      // ojos rojos furiosos
      g.fillStyle = `rgba(255,60,30,${0.6 + rage * 0.4})`;
      g.beginPath();
      g.arc(-r * 0.32, -r * 0.2, r * 0.13, 0, Math.PI * 2);
      g.arc(r * 0.32, -r * 0.2, r * 0.13, 0, Math.PI * 2);
      g.fill();
      // vaho de las fosas nasales
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.beginPath();
      g.arc(-r * 0.15, r * 0.35, r * 0.1, 0, Math.PI * 2);
      g.arc(r * 0.15, r * 0.35, r * 0.1, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'skywhale': {
      // ballena voladora rechoncha con alas que baten lento
      const flap = Math.sin(t * 4 + id);
      g.fillStyle = shade(color, 0.85);
      for (const side of [-1, 1]) {
        g.save();
        g.rotate(side * flap * 0.2);
        g.beginPath();
        g.moveTo(side * r * 0.7, -r * 0.1);
        g.quadraticCurveTo(side * r * 2.0, -r * 0.7, side * r * 1.7, r * 0.5);
        g.quadraticCurveTo(side * r * 1.1, r * 0.3, side * r * 0.7, r * 0.3);
        g.closePath();
        g.fill();
        g.restore();
      }
      const grad = g.createRadialGradient(-r * 0.3, -r * 0.4, r * 0.2, 0, 0, r * 1.2);
      grad.addColorStop(0, lite);
      grad.addColorStop(1, color);
      g.fillStyle = grad;
      g.strokeStyle = dark;
      g.lineWidth = Math.max(1.5, r * 0.1);
      g.beginPath();
      g.ellipse(0, 0, r * 1.2, r * 0.9, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      // vientre claro
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.beginPath();
      g.ellipse(0, r * 0.35, r * 0.8, r * 0.4, 0, 0, Math.PI * 2);
      g.fill();
      eyes(r * 0.45, -r * 0.15, Math.max(1, r * 0.12));
      break;
    }
    case 'wraith': {
      // espectro mayor: como el fantasma pero más grande, oscuro y semitransparente
      g.globalAlpha = 0.5 + Math.sin(t * 2 + id) * 0.12;
      const grad = g.createRadialGradient(-r * 0.3, -r * 0.4, r * 0.2, 0, 0, r * 1.3);
      grad.addColorStop(0, lite);
      grad.addColorStop(1, shade(color, 0.6));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(0, -r * 0.15, r * 1.05, Math.PI, 0);
      const n = 5;
      for (let i = 0; i <= n; i++) {
        const fx = r * 1.05 - (i * 2 * r * 1.05) / n;
        const fy = r * 0.6 + Math.sin(t * 5 + i * 2 + id) * r * 0.2;
        g.quadraticCurveTo(fx + (r * 1.05) / n, fy + r * 0.25, fx, fy);
      }
      g.closePath();
      g.fill();
      // guadaña espectral
      g.globalAlpha = 0.75;
      g.strokeStyle = 'rgba(220,220,255,0.9)';
      g.lineWidth = Math.max(1.5, r * 0.1);
      g.beginPath();
      g.moveTo(r * 0.7, -r * 1.0);
      g.lineTo(r * 0.9, r * 0.6);
      g.stroke();
      g.beginPath();
      g.arc(r * 0.7, -r * 1.0, r * 0.5, Math.PI * 1.1, Math.PI * 1.8);
      g.stroke();
      // ojos vacíos brillantes
      g.fillStyle = 'rgba(200,220,255,0.95)';
      g.beginPath();
      g.ellipse(-r * 0.28, -r * 0.25, r * 0.13, r * 0.19, 0, 0, Math.PI * 2);
      g.ellipse(r * 0.28, -r * 0.25, r * 0.13, r * 0.19, 0, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
      break;
    }
    case 'chimera': {
      // jefe volador: cabeza leonina + alas grandes que baten
      const flap = Math.sin(t * 5 + id);
      g.fillStyle = shade(color, 0.8);
      for (const side of [-1, 1]) {
        g.save();
        g.rotate(side * (0.3 + flap * 0.3));
        g.beginPath();
        g.moveTo(side * r * 0.6, -r * 0.2);
        g.lineTo(side * r * 2.1, -r * 1.1);
        g.lineTo(side * r * 1.9, r * 0.1);
        g.lineTo(side * r * 2.0, r * 0.9);
        g.lineTo(side * r * 0.7, r * 0.3);
        g.closePath();
        g.fill();
        g.restore();
      }
      // cuerpo
      const grad = g.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.2, 0, 0, r * 1.2);
      grad.addColorStop(0, lite);
      grad.addColorStop(1, color);
      g.fillStyle = grad;
      g.strokeStyle = dark;
      g.lineWidth = Math.max(2, r * 0.1);
      g.beginPath();
      g.arc(0, 0, r * 1.05, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      // melena
      g.fillStyle = shade(color, 0.7);
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        g.beginPath();
        g.moveTo(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9);
        g.lineTo(Math.cos(a) * r * 1.5, Math.sin(a) * r * 1.5);
        g.lineTo(Math.cos(a + 0.3) * r * 0.9, Math.sin(a + 0.3) * r * 0.9);
        g.closePath();
        g.fill();
      }
      bodyCircle(r * 0.9);
      eyes(r * 0.32, -r * 0.1, Math.max(1.5, r * 0.15), true);
      // fauces
      g.fillStyle = '#3a0d18';
      g.beginPath();
      g.arc(0, r * 0.3, r * 0.35, 0, Math.PI);
      g.fill();
      break;
    }
    case 'behemoth': {
      // jefe terrestre colosal: mole rocosa acorazada con placas
      const grad = g.createRadialGradient(-r * 0.4, -r * 0.4, r * 0.3, 0, 0, r * 1.4);
      grad.addColorStop(0, lite);
      grad.addColorStop(1, shade(color, 0.7));
      g.fillStyle = grad;
      g.strokeStyle = dark;
      g.lineWidth = Math.max(2, r * 0.1);
      roundRect(g, -r * 1.1, -r * 0.95, r * 2.2, r * 1.9, r * 0.35);
      g.fill();
      g.stroke();
      // placas de armadura
      g.strokeStyle = shade(color, 0.5);
      g.lineWidth = Math.max(1.5, r * 0.08);
      for (let i = -1; i <= 1; i++) {
        g.beginPath();
        g.moveTo(i * r * 0.5, -r * 0.9);
        g.lineTo(i * r * 0.5, r * 0.9);
        g.stroke();
      }
      // cuernos gruesos
      g.fillStyle = '#efebe9';
      for (const side of [-1, 1]) {
        g.beginPath();
        g.moveTo(side * r * 0.6, -r * 0.8);
        g.quadraticCurveTo(side * r * 1.4, -r * 1.5, side * r * 1.0, -r * 1.7);
        g.lineTo(side * r * 0.5, -r * 1.0);
        g.closePath();
        g.fill();
      }
      // ojos brillantes de furia
      const glow = 0.6 + Math.sin(t * 3 + id) * 0.4;
      g.fillStyle = `rgba(255,120,60,${0.7 + glow * 0.3})`;
      g.beginPath();
      g.arc(-r * 0.35, -r * 0.25, r * 0.16, 0, Math.PI * 2);
      g.arc(r * 0.35, -r * 0.25, r * 0.16, 0, Math.PI * 2);
      g.fill();
      break;
    }
  }
  void s;
}

function drawBossBar(boss: { hpFrac: number; name: string }): void {
  const w = Math.min(canvas.clientWidth * 0.5, 420);
  const x = (canvas.clientWidth - w) / 2;
  const y = 50;
  g.fillStyle = 'rgba(10,12,18,0.85)';
  roundRect(g, x - 10, y - 8, w + 20, 32, 10);
  g.fill();
  g.strokeStyle = 'rgba(239,83,80,0.5)';
  g.lineWidth = 1;
  g.stroke();
  g.fillStyle = '#33121a';
  roundRect(g, x, y, w, 9, 4.5);
  g.fill();
  const grad = g.createLinearGradient(x, y, x, y + 9);
  grad.addColorStop(0, '#ff7043');
  grad.addColorStop(1, '#d32f2f');
  g.fillStyle = grad;
  roundRect(g, x, y, Math.max(9, w * boss.hpFrac), 9, 4.5);
  g.fill();
  g.fillStyle = '#ffcdd2';
  g.font = 'bold 12px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'top';
  g.fillText(`☠ ${boss.name}`, x + w / 2, y + 12);
}

// ---------- proyectiles ----------

function drawProjectiles(interp: InterpResult): void {
  const s = view.scale;
  const aliveIds = new Set<number>();

  for (const p of interp.projs) {
    aliveIds.add(p.id);
    const type = TOWER_ORDER[p.towerTypeIdx];
    const color = TOWERS[type]?.color ?? '#fff';
    const x = toX(p.x);
    const y = toY(p.y);

    // fogonazo en la torre al aparecer un proyectil nuevo
    if (!projSeen.has(p.id)) {
      projSeen.add(p.id);
      towerFired(p.x, p.y);
      fx(p.x, p.y, 'glow', color, 0.55, 0.13, { add: true });
    }
    const prev = projPrev.get(p.id);
    const ang = prev ? Math.atan2(p.y - prev.y, p.x - prev.x) : 0;
    projPrev.set(p.id, { x: p.x, y: p.y });

    // sprite real del proyectil (rotado hacia su dirección; apunta al norte en el PNG);
    // si no hay sprite, cae al dibujo vectorial de siempre.
    const pn = PROJ_BY_TYPE[type];
    const psprite = pn ? getProjSprite(pn) : null;
    if (psprite) {
      const ph = s * PROJ_H;
      const pw = (psprite.naturalWidth / psprite.naturalHeight) * ph;
      g.save();
      g.translate(x, y);
      g.rotate(ang + Math.PI / 2);
      g.drawImage(psprite, -pw / 2, -ph / 2, pw, ph);
      g.restore();
      continue;
    }

    if (p.kindIdx === 2) {
      // bomba de mortero girando con estela de humo
      g.fillStyle = 'rgba(120,120,120,0.25)';
      g.beginPath();
      g.arc(x - Math.cos(ang) * s * 0.2, y - Math.sin(ang) * s * 0.2, Math.max(2, s * 0.09), 0, Math.PI * 2);
      g.fill();
      g.save();
      g.translate(x, y);
      g.rotate(ang + performance.now() / 200);
      g.fillStyle = '#3e2723';
      g.beginPath();
      g.arc(0, 0, Math.max(3, s * 0.14), 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = color;
      g.lineWidth = 1.5;
      g.stroke();
      g.fillStyle = '#ffab40';
      g.beginPath();
      g.arc(Math.max(2, s * 0.1), 0, Math.max(1, s * 0.04), 0, Math.PI * 2);
      g.fill();
      g.restore();
    } else if (p.kindIdx === 1) {
      // bala de cañón
      g.fillStyle = 'rgba(80,80,90,0.3)';
      g.beginPath();
      g.arc(x - Math.cos(ang) * s * 0.16, y - Math.sin(ang) * s * 0.16, Math.max(2, s * 0.07), 0, Math.PI * 2);
      g.fill();
      const grad = g.createRadialGradient(x - s * 0.03, y - s * 0.03, 0, x, y, Math.max(2.5, s * 0.11));
      grad.addColorStop(0, '#78909c');
      grad.addColorStop(1, '#263238');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, Math.max(2.5, s * 0.11), 0, Math.PI * 2);
      g.fill();
    } else {
      // dardo alargado en la dirección del vuelo, con estela
      g.save();
      g.translate(x, y);
      g.rotate(ang);
      const grad = g.createLinearGradient(-s * 0.3, 0, s * 0.1, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(1, color);
      g.strokeStyle = grad;
      g.lineWidth = Math.max(1.5, s * 0.06);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(-s * 0.3, 0);
      g.lineTo(s * 0.06, 0);
      g.stroke();
      g.fillStyle = color;
      g.beginPath();
      g.ellipse(s * 0.05, 0, Math.max(2, s * 0.09), Math.max(1.5, s * 0.05), 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }

  // limpiar rastros de proyectiles que ya no existen
  for (const id of projPrev.keys()) {
    if (!aliveIds.has(id)) {
      projPrev.delete(id);
      projSeen.delete(id);
    }
  }
}

// ---------- colocación ----------

function drawPlacement(gs: GameStore, now: number): void {
  if (gs.selection?.kind !== 'placing' || !gs.latest) return;
  const s = view.scale;
  const map = gs.map;
  const ctx = getPlacementCtx(map);
  const towerSet = new Set(gs.latest.towers.map((t) => `${t[2]},${t[3]}`));

  // rejilla + celdas construibles
  g.strokeStyle = 'rgba(255,255,255,0.06)';
  g.lineWidth = 1;
  for (let cx = 0; cx <= map.gridW; cx++) {
    g.beginPath();
    g.moveTo(toX(cx), toY(0));
    g.lineTo(toX(cx), toY(map.gridH));
    g.stroke();
  }
  for (let cy = 0; cy <= map.gridH; cy++) {
    g.beginPath();
    g.moveTo(toX(0), toY(cy));
    g.lineTo(toX(map.gridW), toY(cy));
    g.stroke();
  }
  const type = gs.selection.towerType;
  // la Trampa se coloca SOBRE el camino; el resto, fuera. Resalta las celdas
  // construibles según el tipo elegido.
  const onPathOnly = TOWERS[type].onPathOnly === true;
  g.fillStyle = onPathOnly ? 'rgba(255,120,120,0.09)' : 'rgba(129,255,150,0.07)';
  for (let cy = 0; cy < map.gridH; cy++) {
    for (let cx = 0; cx < map.gridW; cx++) {
      const key = `${cx},${cy}`;
      if (towerSet.has(key)) continue;
      if (onPathOnly) {
        if (!ctx.paths.has(key)) continue; // la Trampa solo resalta el camino
      } else if (ctx.paths.has(key) || ctx.blocked.has(key)) {
        continue;
      }
      g.fillRect(toX(cx) + 1, toY(cy) + 1, s - 2, s - 2);
    }
  }

  // celda objetivo: pendiente (táctil) o bajo el cursor
  const cell = gs.pendingPlace ?? gs.hoverCell;
  if (!cell) return;
  const { cx, cy } = cell;
  const lvl = TOWERS[type].levels[0];
  const key = `${cx},${cy}`;
  const inGrid = cx >= 0 && cy >= 0 && cx < map.gridW && cy < map.gridH;
  const ok = inGrid && !towerSet.has(key) && (
    onPathOnly ? ctx.paths.has(key) : !ctx.paths.has(key) && !ctx.blocked.has(key)
  );

  // rango
  g.fillStyle = ok ? 'rgba(120,220,120,0.08)' : 'rgba(240,80,80,0.08)';
  g.strokeStyle = ok ? 'rgba(120,220,120,0.55)' : 'rgba(240,80,80,0.55)';
  g.lineWidth = 1.5;
  g.setLineDash([6, 4]);
  g.beginPath();
  g.arc(toX(cx + 0.5), toY(cy + 0.5), lvl.range * s, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.setLineDash([]);
  if (lvl.minRange) {
    g.strokeStyle = 'rgba(240,100,100,0.4)';
    g.beginPath();
    g.arc(toX(cx + 0.5), toY(cy + 0.5), lvl.minRange * s, 0, Math.PI * 2);
    g.stroke();
  }

  // celda
  const pulse = 0.3 + Math.sin(now / 180) * 0.1;
  g.fillStyle = ok ? `rgba(120,220,120,${pulse})` : `rgba(240,80,80,${pulse})`;
  g.fillRect(toX(cx), toY(cy), s, s);

  // torre fantasma (arte real, semitransparente)
  g.save();
  g.globalAlpha = 0.75;
  g.translate(toX(cx) + s / 2, toY(cy) + s / 2);
  drawTowerArt(type, s, 1, now / 1000, { angle: -Math.PI / 2, recoil: 0, flash: 0 }, ok ? '#a5d6a7' : '#ef9a9a', false);
  g.restore();
}

// ---------- premovimientos (fantasmas de acciones encoladas) ----------

// Dibuja los premovimientos del jugador: colocaciones pendientes (marco celeste
// punteado + torre fantasma + ⏳) y mejoras pendientes (anillo dorado sobre la
// torre). Se disparan solos al alcanzar el coste (ver hud.ts).
function drawPremoves(gs: GameStore, now: number): void {
  const pms = gs.premoves;
  if (!pms || pms.length === 0) return;
  const s = view.scale;
  const pulse = 0.5 + Math.sin(now / 240) * 0.3;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const pm of pms) {
    if (pm.kind === 'place') {
      const { cx, cy, towerType } = pm;
      g.strokeStyle = `rgba(79,195,247,${0.55 + pulse * 0.35})`;
      g.lineWidth = 2;
      g.setLineDash([5, 4]);
      g.strokeRect(toX(cx) + 2, toY(cy) + 2, s - 4, s - 4);
      g.setLineDash([]);
      // torre fantasma (arte real, muy tenue) en celeste
      g.save();
      g.globalAlpha = 0.4;
      g.translate(toX(cx) + s / 2, toY(cy) + s / 2);
      drawTowerArt(towerType, s, 1, now / 1000, { angle: -Math.PI / 2, recoil: 0, flash: 0 }, '#4fc3f7', false);
      g.restore();
      g.fillStyle = '#4fc3f7';
      g.font = `bold ${Math.max(11, s * 0.34)}px system-ui, sans-serif`;
      g.fillText('⏳', toX(cx) + s / 2, toY(cy) + s / 2);
    } else {
      const t = gs.latest?.towers.find((tt) => tt[0] === pm.towerId);
      if (!t) continue;
      const cx = t[2];
      const cy = t[3];
      g.strokeStyle = `rgba(255,213,79,${0.55 + pulse * 0.35})`;
      g.lineWidth = 2.5;
      g.setLineDash([5, 4]);
      g.beginPath();
      g.arc(toX(cx + 0.5), toY(cy + 0.5), s * 0.55, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#ffd54f';
      g.font = `bold ${Math.max(10, s * 0.3)}px system-ui, sans-serif`;
      g.fillText('⏳⬆', toX(cx + 0.5), toY(cy) - s * 0.12);
    }
  }
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
}

// posiciona la burbuja de confirmación (DOM) sobre la celda pendiente
let bubbleEl: HTMLElement | null = null;
function syncPlaceBubble(gs: GameStore): void {
  if (!bubbleEl) bubbleEl = document.getElementById('place-confirm');
  if (!bubbleEl) return;
  const show = gs.selection?.kind === 'placing' && gs.pendingPlace !== null;
  bubbleEl.hidden = !show;
  if (show && gs.pendingPlace) {
    const x = toX(gs.pendingPlace.cx + 0.5);
    const y = toY(gs.pendingPlace.cy) - 8;
    bubbleEl.style.left = `${x}px`;
    bubbleEl.style.top = `${y}px`;
  }
}

// ---------- minimapa in-game ----------

// ¿debe mostrarse el minimapa ahora? oculto en pantallas muy bajas.
function minimapVisible(map: MapDef): boolean {
  if (!miniOn) return false;
  if (canvas.clientHeight < 500) return false;
  return zoom > 1.15 || map.gridW > 24 || map.gridH > 16;
}

// Dibuja el minimapa como overlay en la esquina superior derecha, en
// coordenadas de pantalla (NO afectado por cámara/zoom). Barato: un drawImage
// del mapLayer ya cacheado + puntos + rectángulo del viewport. Actualiza
// miniRect para el hit-test de input.ts.
function drawMiniMap(gs: GameStore, now: number): void {
  miniRect = null;
  const map = gs.map;
  if (!minimapVisible(map)) return;

  const w = canvas.clientWidth;
  const compact = w < 560;
  const boxMax = compact ? 100 : 140;
  const s = boxMax / Math.max(map.gridW, map.gridH); // px por celda en el mini
  const mw = map.gridW * s;
  const mh = map.gridH * s;
  const margin = 10;
  const bx = w - mw - margin;
  const by = PAD_TOP + 6;
  miniRect = { x: bx, y: by, w: mw, h: mh, s };

  g.save();
  // marco + fondo sutil
  g.globalAlpha = 0.92;
  g.fillStyle = 'rgba(10,12,20,0.9)';
  roundRect(g, bx - 4, by - 4, mw + 8, mh + 8, 6);
  g.fill();

  // terreno cacheado escalado al recuadro
  if (mapLayer) {
    g.save();
    roundRect(g, bx, by, mw, mh, 3);
    g.clip();
    g.drawImage(mapLayer, bx, by, mw, mh);
    g.restore();
  }

  const snap = gs.latest;
  if (snap) {
    // torres: punto del color del dueño
    for (const t of snap.towers) {
      const owner = gs.init.players[t[5]];
      g.fillStyle = owner?.color ?? '#ccc';
      g.beginPath();
      g.arc(bx + (t[2] + 0.5) * s, by + (t[3] + 0.5) * s, Math.max(1.2, s * 0.35), 0, Math.PI * 2);
      g.fill();
    }
    // enemigos: rojo normal, morado si élite (flag 8)
    for (const e of snap.enemies) {
      // Lote 3 · invisible no detectado: tampoco en el minimapa (solo los detectados)
      if ((e[5] & 64) !== 0 && (e[5] & 128) === 0) continue;
      const elite = (e[5] & 8) !== 0;
      g.fillStyle = elite ? '#c77dff' : '#ff5252';
      g.beginPath();
      g.arc(bx + e[2] * s, by + e[3] * s, Math.max(1.2, s * (elite ? 0.42 : 0.32)), 0, Math.PI * 2);
      g.fill();
    }
  }

  // pings cooperativos: también visibles en el minimapa, como anillo/punto
  // pulsante del color de quien los lanzó, mientras el ping viva.
  for (const p of pings) {
    const alpha = Math.min(1, p.life / 0.5);
    const pulse = 0.5 + Math.sin(now / 160 + p.x * 3) * 0.5;
    const mx = bx + p.x * s;
    const my = by + p.y * s;
    g.globalAlpha = alpha;
    g.strokeStyle = p.color;
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(mx, my, Math.max(2, s * (0.35 + pulse * 0.25)), 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = p.color;
    g.beginPath();
    g.arc(mx, my, Math.max(1.3, s * 0.2), 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;

  // rectángulo del viewport: qué parte del mapa se ve en pantalla ahora.
  // world visible = [(0-ox)/scale .. (W-ox)/scale] × [(0-oy)/scale .. (H-oy)/scale]
  const vx0 = (0 - view.ox) / view.scale;
  const vy0 = (0 - view.oy) / view.scale;
  const vx1 = (w - view.ox) / view.scale;
  const vy1 = (canvas.clientHeight - view.oy) / view.scale;
  const rx0 = bx + Math.max(0, vx0) * s;
  const ry0 = by + Math.max(0, vy0) * s;
  const rx1 = bx + Math.min(map.gridW, vx1) * s;
  const ry1 = by + Math.min(map.gridH, vy1) * s;
  g.globalAlpha = 1;
  g.strokeStyle = 'rgba(255,255,255,0.95)';
  g.lineWidth = 1.5;
  g.strokeRect(rx0 + 0.5, ry0 + 0.5, Math.max(2, rx1 - rx0), Math.max(2, ry1 - ry0));

  // marco exterior
  g.strokeStyle = 'rgba(255,255,255,0.28)';
  g.lineWidth = 1;
  roundRect(g, bx - 4, by - 4, mw + 8, mh + 8, 6);
  g.stroke();
  g.restore();
  void now;
}

// Hit-test para input.ts: si (px,py) en coords de pantalla cae dentro del
// minimapa, devuelve la coordenada de MUNDO (celdas) correspondiente; si no, null.
export function minimapHit(px: number, py: number): { x: number; y: number } | null {
  const r = miniRect;
  if (!r) return null;
  if (px < r.x || py < r.y || px > r.x + r.w || py > r.y + r.h) return null;
  return { x: (px - r.x) / r.s, y: (py - r.y) / r.s };
}

// ---------- viñeta ----------

let vignette: CanvasGradient | null = null;
let vignetteKey = '';
function drawVignette(): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const key = `${w}x${h}`;
  if (vignetteKey !== key || !vignette) {
    vignetteKey = key;
    vignette = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.max(w, h) * 0.72);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,10,0.32)');
  }
  g.fillStyle = vignette;
  g.fillRect(0, 0, w, h);
}

// ---------- loop principal ----------

function loop(): void {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;

  updateParticles(dt);

  const gs = store.game;
  if (store.screen !== 'game' || !gs) return;
  if (!ensureCanvasSize()) return;

  computeView(gs.map);
  buildMapLayer(gs.map);
  spawnAmbient(gs.map, dt);

  const theme = THEMES[gs.map.theme];
  g.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  g.fillStyle = theme.sky;
  g.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

  // sacudida de pantalla
  g.save();
  if (shake > 0.2) {
    g.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    shake *= Math.exp(-dt * 5);
  } else {
    shake = 0;
  }

  if (mapLayer) {
    g.drawImage(mapLayer, view.ox, view.oy, gs.map.gridW * view.scale, gs.map.gridH * view.scale);
  }
  // marco del mapa
  g.strokeStyle = 'rgba(0,0,0,0.45)';
  g.lineWidth = 3;
  g.strokeRect(view.ox, view.oy, gs.map.gridW * view.scale, gs.map.gridH * view.scale);

  drawMapAnimations(gs.map, now);
  drawOrcs(gs, now);

  const interp = interpolate(gs, now - INTERP_DELAY_MS);
  drawTowers(gs, interp, now, dt);
  if (interp) {
    drawEnemies(interp, now);
    drawProjectiles(interp);
  }
  drawParticles(g, toX, toY, view.scale);
  drawAmbient(now);
  drawPings(dt);
  drawPlacement(gs, now);
  drawPremoves(gs, now);

  g.restore();

  drawVignette();
  drawMiniMap(gs, now);
  syncPlaceBubble(gs);
}
