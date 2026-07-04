// Reproductor de repeticiones (replays) en el cliente.
//
// Corre la sim determinista LOCALMENTE (motor puro de @td/shared: replayInit +
// replayStep + replayTo) sin red, y alimenta EL MISMO pipeline de render que la red
// (pushFrame + buildSnap + onTick + processEvents). Reusa el renderer tal cual. Todo
// el input de juego se desactiva mientras dura (store.replay != null); la cámara sí
// se mueve. La barra de reproductor da ▶/⏸, velocidad x1/x2/x4, y una barra de
// progreso con SEEK (al soltar, replayTo(targetTick) reconstruye desde 0).

import {
  BALANCE_VERSION,
  TICK_MS,
  buildSnap,
  replayInit,
  replayStep,
  MAPS,
  type GameEvent,
  type GameInit,
  type ReplayData,
  type ReplaySim,
} from '@td/shared';
import { store } from './store.js';
import { startGameStore, pushFrame } from './store.js';
import { onTick, applySpectatorUI, buildTowerBar, hidePanel } from './hud.js';
import { resetRenderer } from './renderer.js';
import { clearParticles } from './particles.js';
import { hideEnd, switchScreen } from './screens.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// pipeline de eventos de la sim (lo provee main.ts para no duplicar la lógica de
// partículas/sonido). Se inyecta al arrancar la app.
let processEvents: (events: GameEvent[]) => void = () => {};
export function setReplayEventSink(fn: (events: GameEvent[]) => void): void {
  processEvents = fn;
}

const REPLAY_SPEEDS = [1, 2, 4] as const;

let sim: ReplaySim | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

// Construye un GameInit falso a partir de la ReplayData (el reproductor no tiene
// red; el render solo necesita mapId/mode/difficulty y el roster para colorear).
function initFromReplay(data: ReplayData): GameInit {
  return {
    mapId: data.mapId,
    mode: data.mode,
    difficulty: data.difficulty,
    players: data.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
    youAre: '', // nadie: el espectador de un replay no controla nada
  };
}

// alimenta un tick reconstruido al render: mismo pipeline que la red
function feedTick(events: GameEvent[]): void {
  if (!sim) return;
  const gs = store.game;
  if (!gs) return;
  const snap = buildSnap(sim.state);
  pushFrame(gs, sim.state.tick, snap);
  onTick(snap);
  processEvents(events);
}

// Entra en modo replay: monta la partida "espectada", coloca el reproductor y
// arranca en pausa en el tick 0. Guard de versión: avisa si el balance difiere.
export function startReplay(data: ReplayData): void {
  stopReplayTimer();

  store.replay = { data, playing: false, tick: 0, speed: 1 };
  store.spectator = true; // reusar la UI de espectador (oculta oro/acciones de jugador)

  // montar el store de juego como si empezara una partida (el render lo consume)
  startGameStore(initFromReplay(data));
  clearParticles();
  resetRenderer();
  buildTowerBar();
  hidePanel();
  hideEnd();
  $('overlay-pause').hidden = true;
  $('overlay-reconnect').hidden = true;
  switchScreen('game');
  applySpectatorUI();

  // ocultar controles de anfitrión/jugador que no aplican al reproductor
  $('btn-pause').hidden = true;
  $('btn-speed').hidden = true;
  $('btn-callwave').hidden = true;
  $('spectator-banner').hidden = true; // el banner de espectador de red no aplica

  // sim en el tick 0 y primer frame para que se vea algo antes de darle a ▶
  sim = replayInit(data);
  feedTick([]);

  showReplayBar(data);
  syncReplayBar();

  // guard de versión: repetición de una versión anterior del balance
  if (data.v !== BALANCE_VERSION) {
    const warn = $('replay-warn');
    warn.hidden = false;
  }
}

// Sale del modo replay y vuelve al inicio.
export function exitReplay(): void {
  stopReplayTimer();
  sim = null;
  store.replay = null;
  store.spectator = false;
  store.game = null;
  hideReplayBar();
  $('spectator-banner').hidden = true;
  $('hud-gold').hidden = false;
  history.replaceState(null, '', location.pathname);
  switchScreen('home');
  renderReplayList(); // refrescar la lista de la home por si acaba de guardarse
}

function stopReplayTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// avanza un tick del reproductor (llamado por el propio loop)
function tickReplay(): void {
  const rp = store.replay;
  if (!rp || !sim) return;
  if (sim.state.tick >= rp.data.finalTick || sim.state.over) {
    // fin de la reproducción: pausa en el último frame
    rp.playing = false;
    stopReplayTimer();
    syncReplayBar();
    return;
  }
  const events = replayStep(sim, rp.data, sim.state.tick);
  rp.tick = sim.state.tick;
  feedTick(events);
  syncReplayBar();
}

function play(): void {
  const rp = store.replay;
  if (!rp) return;
  if (rp.tick >= rp.data.finalTick) return; // ya terminó: no reproducir de nuevo sin seek
  rp.playing = true;
  stopReplayTimer();
  // el reproductor corre a TICK_MS / speed (la sim es 1 tick por intervalo)
  timer = setInterval(tickReplay, TICK_MS / rp.speed);
  syncReplayBar();
}

function pause(): void {
  const rp = store.replay;
  if (!rp) return;
  rp.playing = false;
  stopReplayTimer();
  syncReplayBar();
}

function togglePlay(): void {
  const rp = store.replay;
  if (!rp) return;
  rp.playing ? pause() : play();
}

function cycleSpeed(): void {
  const rp = store.replay;
  if (!rp) return;
  const idx = REPLAY_SPEEDS.indexOf(rp.speed as (typeof REPLAY_SPEEDS)[number]);
  rp.speed = REPLAY_SPEEDS[(idx + 1) % REPLAY_SPEEDS.length];
  if (rp.playing) play(); // reprograma el intervalo a la nueva velocidad
  syncReplayBar();
}

// SEEK: reconstruye desde 0 hasta el tick destino (sin render intermedio) y
// muestra ese frame. Es rapidísimo (~180k ticks/s medido). Deja el ReplaySim en
// ese punto para poder seguir reproduciendo desde ahí.
function seekTo(targetTick: number): void {
  const rp = store.replay;
  if (!rp) return;
  const t = Math.max(0, Math.min(targetTick, rp.data.finalTick));
  const wasPlaying = rp.playing;
  pause();
  // sim fresco y avanzado al tick destino (equivale a replayTo pero conservando el
  // sim para reanudar). Los eventos intermedios se descartan: solo pintamos el
  // frame destino.
  sim = replayInit(rp.data);
  while (sim.state.tick < t && !sim.state.over) replayStep(sim, rp.data, sim.state.tick);
  rp.tick = sim.state.tick;
  if (store.game) store.game.frames.length = 0; // descartar interpolación vieja
  feedTick([]);
  if (wasPlaying && rp.tick < rp.data.finalTick) play();
  else syncReplayBar();
}

// ---------- barra del reproductor (DOM) ----------

let barWired = false;

function showReplayBar(data: ReplayData): void {
  const bar = $('replay-bar');
  bar.hidden = false;
  $('replay-warn').hidden = true;
  const range = $<HTMLInputElement>('replay-seek');
  range.max = String(data.finalTick);
  range.value = '0';
  wireReplayBar();
}

function hideReplayBar(): void {
  $('replay-bar').hidden = true;
}

function fmtTime(tick: number): string {
  const sec = Math.floor(tick / 15); // TICK_RATE = 15
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function syncReplayBar(): void {
  const rp = store.replay;
  if (!rp) return;
  $('replay-play').textContent = rp.playing ? '⏸' : '▶';
  $('replay-speed').textContent = `x${rp.speed}`;
  const range = $<HTMLInputElement>('replay-seek');
  if (document.activeElement !== range) range.value = String(rp.tick);
  $('replay-time').textContent = `${fmtTime(rp.tick)} / ${fmtTime(rp.data.finalTick)}`;
}

function wireReplayBar(): void {
  if (barWired) return;
  barWired = true;
  $('replay-play').addEventListener('click', togglePlay);
  $('replay-speed').addEventListener('click', cycleSpeed);
  $('replay-exit').addEventListener('click', exitReplay);

  const range = $<HTMLInputElement>('replay-seek');
  // mientras se arrastra: pausar y previsualizar el número (sin re-simular en cada
  // input para no petar; la reconstrucción real ocurre al soltar)
  range.addEventListener('input', () => {
    const rp = store.replay;
    if (!rp) return;
    if (rp.playing) pause();
    $('replay-time').textContent = `${fmtTime(Number(range.value))} / ${fmtTime(rp.data.finalTick)}`;
  });
  // al soltar: reconstruir hasta el tick destino
  range.addEventListener('change', () => seekTo(Number(range.value)));
}

// ---------- persistencia local de repeticiones (máx. 10) ----------

const STORE_KEY = 'td_replays';
const MAX_SAVED = 10;

export interface SavedReplay {
  id: string; // id local
  date: string; // ISO
  mapId: string;
  victory: boolean;
  wave: number;
  data: ReplayData;
}

export function loadSavedReplays(): SavedReplay[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as SavedReplay[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeSavedReplays(list: SavedReplay[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, MAX_SAVED)));
  } catch {
    // localStorage lleno o no disponible: ignorar (las repeticiones son opcionales)
  }
}

// Guarda una repetición recién terminada (la más nueva primero, máx. 10).
export function saveReplay(data: ReplayData): SavedReplay {
  const entry: SavedReplay = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    date: new Date().toISOString(),
    mapId: data.mapId,
    victory: data.victory,
    wave: data.wave,
    data,
  };
  const list = loadSavedReplays();
  list.unshift(entry);
  writeSavedReplays(list);
  return entry;
}

export function deleteReplay(id: string): void {
  writeSavedReplays(loadSavedReplays().filter((r) => r.id !== id));
  renderReplayList();
}

// descarga una repetición como .json
export function downloadReplay(entry: SavedReplay): void {
  const blob = new Blob([JSON.stringify(entry.data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = entry.date.slice(0, 16).replace(/[:T]/g, '-');
  a.download = `fortaleza-replay-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- lista de repeticiones en la home ----------

// valida mínimamente un .json cargado como ReplayData
function isReplayData(x: unknown): x is ReplayData {
  if (!x || typeof x !== 'object') return false;
  const d = x as Record<string, unknown>;
  return (
    typeof d.seed === 'number' &&
    typeof d.mapId === 'string' &&
    Array.isArray(d.players) &&
    Array.isArray(d.log) &&
    typeof d.finalTick === 'number'
  );
}

const MAP_NAMES = new Map<string, string>(MAPS.map((m) => [m.id, m.name]));

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function renderReplayList(): void {
  const section = $('home-replays');
  const list = loadSavedReplays();
  if (list.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const ul = $('home-replays-list');
  ul.innerHTML = list
    .map((r) => {
      const mapName = MAP_NAMES.get(r.mapId) ?? r.mapId;
      const result = r.victory ? '🎉 Victoria' : '💀 Derrota';
      return `<li data-id="${r.id}">
        <div class="replay-info">
          <b>${result}</b> · Oleada ${r.wave}
          <span class="hint">${escapeHtml(mapName)} · ${fmtDate(r.date)}</span>
        </div>
        <div class="replay-actions">
          <button class="btn small primary" data-act="play" data-id="${r.id}">🎬 Ver</button>
          <button class="btn small ghost" data-act="dl" data-id="${r.id}" title="Descargar .json">⬇</button>
          <button class="btn small ghost" data-act="del" data-id="${r.id}" title="Borrar">🗑</button>
        </div>
      </li>`;
    })
    .join('');
}

let listWired = false;

export function initReplayHome(): void {
  renderReplayList();

  if (listWired) return;
  listWired = true;

  $('home-replays-list').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id!;
    const entry = loadSavedReplays().find((r) => r.id === id);
    if (!entry) return;
    if (btn.dataset.act === 'play') startReplay(entry.data);
    else if (btn.dataset.act === 'dl') downloadReplay(entry);
    else if (btn.dataset.act === 'del') deleteReplay(id);
  });

  // cargar un .json de repetición desde el disco
  const fileInput = $<HTMLInputElement>('replay-file');
  $('btn-load-replay').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = ''; // permitir recargar el mismo archivo
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!isReplayData(data)) {
        alert('Ese archivo no es una repetición válida de Fortaleza.');
        return;
      }
      startReplay(data as ReplayData);
    } catch {
      alert('No se pudo leer el archivo.');
    }
  });
}
