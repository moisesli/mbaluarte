import { placementError, TOWER_ORDER, TOWERS, type PlacementError, type TowerTypeId } from '@td/shared';
import { net } from './net.js';
import { myGold, store } from './store.js';
import { centerOn, getPlacementCtx, getView, minimapHit, panBy, resetCamera, zoomAt } from './renderer.js';
import {
  armFocus,
  cancelPremoveAt,
  controllableSelectedIds,
  hidePanel,
  queuePlacePremove,
  refreshPanel,
  showPanel,
  syncTowerBar,
  toast,
  toggleHaltSelection,
} from './hud.js';
import { installAudioUnlock } from './audio.js';

// ¿el dispositivo tiene puntero con hover (ratón)? controla el fantasma bajo el
// cursor; el flujo de colocación se decide por gesto con e.pointerType, para que
// en un portátil táctil el dedo use dos toques y el ratón el clic directo
const hasHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

const PLACE_ERRORS: Record<Exclude<PlacementError, null>, string> = {
  fuera: 'Fuera del mapa',
  camino: 'No se puede construir sobre el camino',
  bloqueado: 'Esa celda está bloqueada',
  ocupado: 'Ya hay una torre en esa celda',
  fuera_camino: 'Esta torre solo se coloca SOBRE el camino',
};

function cellFromPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): { cx: number; cy: number } | null {
  const gs = store.game;
  if (!gs) return null;
  const rect = canvas.getBoundingClientRect();
  const view = getView();
  const cx = Math.floor((clientX - rect.left - view.ox) / view.scale);
  const cy = Math.floor((clientY - rect.top - view.oy) / view.scale);
  if (cx < 0 || cy < 0 || cx >= gs.map.gridW || cy >= gs.map.gridH) return null;
  return { cx, cy };
}

// coordenadas de mundo (celdas, fraccionarias) de un punto de pantalla
function worldFromPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const view = getView();
  return {
    x: (clientX - rect.left - view.ox) / view.scale,
    y: (clientY - rect.top - view.oy) / view.scale,
  };
}

// envía un ping cooperativo en el punto de pantalla dado; devuelve true si se envió.
// Si `towerType` viene dado, es una sugerencia de torre (map_ping con towerType).
function sendPing(canvas: HTMLCanvasElement, clientX: number, clientY: number, towerType?: TowerTypeId): boolean {
  const gs = store.game;
  if (!gs || store.replay) return false; // sin pings durante una repetición
  const w = worldFromPoint(canvas, clientX, clientY);
  if (w.x < -0.5 || w.y < -0.5 || w.x > gs.map.gridW + 0.5 || w.y > gs.map.gridH + 0.5) return false;
  net.send({ type: 'map_ping', x: w.x, y: w.y, ...(towerType ? { towerType } : {}) });
  if (navigator.vibrate) navigator.vibrate(15);
  return true;
}

export function setPlacing(towerType: TowerTypeId | null): void {
  const gs = store.game;
  if (!gs) return;
  gs.selection = towerType ? { kind: 'placing', towerType } : null;
  gs.pendingPlace = null;
  gs.focusArmed = false;
  hidePanel();
  syncTowerBar();
}

export function clearSelection(): void {
  const gs = store.game;
  if (!gs) return;
  gs.selection = null;
  gs.pendingPlace = null;
  gs.focusArmed = false;
  hidePanel();
  syncTowerBar();
}

// Lote 4 · hit-test de ENEMIGO para el modo focus: el más cercano al tap dentro
// de un radio generoso (~0.6 celdas), contra el último snapshot. IGNORA a los
// invisibles no detectados (no los ves — coherente con el render y con la sim,
// que además rechaza el comando).
function enemyAtPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): number | null {
  const gs = store.game;
  if (!gs?.latest) return null;
  const w = worldFromPoint(canvas, clientX, clientY);
  let best: number | null = null;
  let bestD = 0.6;
  for (const e of gs.latest.enemies) {
    if ((e[5] & 64) !== 0 && (e[5] & 128) === 0) continue; // invisible sin detectar
    const d = Math.hypot(e[2] - w.x, e[3] - w.y);
    if (d < bestD) {
      bestD = d;
      best = e[0];
    }
  }
  return best;
}

// Lote 4 · doble tap/click sobre una torre PROPIA: selecciona el GRUPO de todas
// mis torres IDÉNTICAS (mismo tipo+nivel+spec+fusión exactos — así el coste de la
// mejora en grupo es uniforme). Devuelve true si consumió el gesto.
function selectTowerGroupAt(canvas: HTMLCanvasElement, clientX: number, clientY: number): boolean {
  const gs = store.game;
  if (!gs?.latest || store.spectator || store.replay) return false;
  const cell = cellFromPoint(canvas, clientX, clientY);
  if (!cell) return false;
  const t = gs.latest.towers.find((tw) => tw[2] === cell.cx && tw[3] === cell.cy);
  if (!t) return false;
  if (gs.init.players[t[5]]?.id !== store.playerId) return false; // solo torres propias
  const ids = gs.latest.towers
    .filter(
      (tw) =>
        tw[5] === t[5] &&
        tw[1] === t[1] &&
        tw[4] === t[4] &&
        (tw[9] ?? -1) === (t[9] ?? -1) &&
        (tw[13] ?? -1) === (t[13] ?? -1),
    )
    .map((tw) => tw[0])
    .sort((a, b) => a - b); // orden estable por id (mejora en grupo, focus…)
  gs.focusArmed = false;
  // única en su clase: se queda como selección individual (panel completo)
  gs.selection = ids.length > 1 ? { kind: 'towers', ids } : { kind: 'tower', id: t[0] };
  showPanel();
  if (navigator.vibrate) navigator.vibrate(12);
  return true;
}

// Validación local antes de enviar: si la celda es inválida avisa y NO saca al
// jugador del modo construcción (el servidor valida igualmente).
function sendPlace(cx: number, cy: number, keepPlacing: boolean): void {
  const gs = store.game;
  if (!gs || gs.selection?.kind !== 'placing' || !gs.latest) return;
  const towers = gs.latest.towers.map((t) => ({ cx: t[2], cy: t[3] }));
  const err = placementError(gs.map, getPlacementCtx(gs.map), towers, cx, cy, gs.selection.towerType);
  if (err) {
    toast(PLACE_ERRORS[err]);
    return;
  }
  // sin oro suficiente: en vez de rechazar, encola un PREMOVIMIENTO — se plantará
  // sola en cuanto el jugador alcance el coste (estilo Hikaru en chess.com).
  const cost = TOWERS[gs.selection.towerType].levels[0].cost;
  if (myGold(gs) < cost) {
    queuePlacePremove(gs.selection.towerType, cx, cy);
    gs.pendingPlace = null;
    if (!keepPlacing) clearSelection();
    return;
  }
  net.send({
    type: 'cmd',
    cmd: { kind: 'place', towerType: gs.selection.towerType, cx, cy },
  });
  gs.pendingPlace = null;
  if (!keepPlacing) clearSelection();
}

function tapSelect(canvas: HTMLCanvasElement, clientX: number, clientY: number, shiftKey: boolean, mouseLike: boolean): void {
  const gs = store.game;
  if (!gs || !gs.latest || gs.over) return;
  // en modo repetición no hay input de juego (ni colocar/pinear/sugerir): solo mirar
  if (store.replay) return;

  // modo sugerencia (torre armada desde la barra): el toque manda una sugerencia
  // de torre (map_ping + towerType) en vez de colocar. Tiene prioridad sobre el
  // ping normal. La sugerencia queda armada para poder sugerir varias.
  if (store.suggestType) {
    sendPing(canvas, clientX, clientY, store.suggestType);
    return;
  }

  // modo ping armado por el botón 📍: el siguiente toque es un ping.
  // solo se desarma si el toque cayó dentro del mapa y se envió de verdad.
  if (store.pingArmed) {
    if (sendPing(canvas, clientX, clientY)) {
      store.pingArmed = false;
      document.getElementById('btn-ping')?.classList.remove('armed');
    }
    return;
  }

  // el espectador no coloca torres ni abre el panel: cualquier otro toque no hace nada
  if (store.spectator) return;

  // Lote 4 · modo FOCUS armado (🎯 / tecla F): este tap intenta fijar un enemigo
  // como objetivo de TODAS las torres seleccionadas. Tap en vacío = cancelar.
  if (gs.focusArmed) {
    const ids = controllableSelectedIds();
    const enemyId = enemyAtPoint(canvas, clientX, clientY);
    gs.focusArmed = false;
    if (enemyId !== null && ids.length > 0) {
      for (const id of ids) net.send({ type: 'cmd', cmd: { kind: 'focus', towerId: id, enemyId } });
      toast(ids.length > 1 ? `🎯 ${ids.length} torres atacando a ese objetivo` : '🎯 Objetivo fijado', 'info');
      if (navigator.vibrate) navigator.vibrate(12);
    } else {
      toast('🎯 Cancelado', 'info');
    }
    refreshPanel();
    return;
  }

  const cell = cellFromPoint(canvas, clientX, clientY);
  if (!cell) {
    clearSelection();
    return;
  }

  if (gs.selection?.kind === 'placing') {
    if (mouseLike) {
      // ratón: clic coloca directamente; con Shift se encadena
      gs.hoverCell = cell;
      sendPlace(cell.cx, cell.cy, shiftKey);
    } else if (gs.pendingPlace && gs.pendingPlace.cx === cell.cx && gs.pendingPlace.cy === cell.cy) {
      // táctil: segundo toque en la misma celda confirma
      sendPlace(cell.cx, cell.cy, false);
    } else {
      // táctil: primer toque marca la celda (muestra fantasma + burbuja ✓/✕)
      gs.pendingPlace = cell;
    }
    return;
  }

  // tocar una celda con un premovimiento de colocación encolado lo cancela
  if (cancelPremoveAt(cell.cx, cell.cy)) return;

  // ¿hay una torre en esa celda?
  const tower = gs.latest.towers.find((t) => t[2] === cell.cx && t[3] === cell.cy);
  if (tower) {
    gs.selection = { kind: 'tower', id: tower[0] };
    showPanel();
  } else {
    clearSelection();
  }
}

export function initInput(canvas: HTMLCanvasElement): void {
  // Desbloqueo robusto del audio: escucha varios gestos en fase de captura y
  // reintenta resume() hasta que el contexto esté 'running' (ver audio.ts). No
  // usamos `{once}` sobre un único evento porque podía consumirse antes de que
  // el contexto existiera, dejándolo suspended para siempre (silencio total).
  installAudioUnlock();

  // ---------- gestos: tap / arrastre (paneo) / pellizco (zoom) ----------

  interface Ptr { x: number; y: number; startX: number; startY: number; moved: boolean }
  const pointers = new Map<number, Ptr>();
  // id del puntero que está manipulando el minimapa (arrastre = recentrar).
  // Ese gesto se consume: ni coloca torres, ni pinea, ni panea el mapa grande.
  let miniPtr = -1;
  let pinchDist = 0;

  // recentra la cámara a partir de un punto de pantalla dentro del minimapa
  const recenterFromMini = (clientX: number, clientY: number): boolean => {
    const rect = canvas.getBoundingClientRect();
    const hit = minimapHit(clientX - rect.left, clientY - rect.top);
    if (!hit) return false;
    centerOn(hit.x, hit.y);
    return true;
  };
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  const TAP_SLOP = 9; // px de tolerancia antes de considerar arrastre

  // mantener pulsado (sin mover) lanza un ping cooperativo
  let longPress: ReturnType<typeof setTimeout> | null = null;
  let longPressFired = false;
  const cancelLongPress = () => {
    if (longPress) {
      clearTimeout(longPress);
      longPress = null;
    }
  };

  const recalcPinch = () => {
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    } else {
      pinchDist = 0;
    }
  };

  canvas.addEventListener('pointerdown', (e) => {
    // puede lanzar si el puntero ya no está activo (p. ej. se soltó en el mismo tick)
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {}
    // el minimapa manda: si el toque cae dentro, recentra y consume el gesto
    // (antes de cualquier lógica de tap/ping/paneo/colocación).
    if (pointers.size === 0 && recenterFromMini(e.clientX, e.clientY)) {
      miniPtr = e.pointerId;
      cancelLongPress();
      if (navigator.vibrate) navigator.vibrate(8);
      return;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false });
    if (pointers.size >= 2) {
      recalcPinch();
      cancelLongPress();
      // al empezar un gesto multitáctil ya no hay intención de tap: evita taps
      // fantasma del dedo "ancla" que apenas se mueve
      for (const p of pointers.values()) p.moved = true;
    } else {
      // armar el long-press para pinar (se cancela si se mueve o entra otro dedo).
      // NO durante la colocación de torres: ahí el toque marca/confirma la celda.
      cancelLongPress();
      longPressFired = false;
      if (store.game?.selection?.kind !== 'placing') {
        const px = e.clientX;
        const py = e.clientY;
        const pid = e.pointerId;
        longPress = setTimeout(() => {
          longPress = null;
          const p = pointers.get(pid);
          if (!p || p.moved || pointers.size !== 1 || store.pingArmed) return;
          if (store.game?.selection?.kind === 'placing') return; // por si se activó a mitad
          p.moved = true; // que el pointerup no lo trate como tap
          longPressFired = true;
          if (sendPing(canvas, px, py)) return;
          longPressFired = false; // fuera del mapa: no consumir el toque
        }, 450);
      }
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const gs = store.game;

    // arrastre dentro del minimapa: seguir recentrando la cámara
    if (e.pointerId === miniPtr) {
      recenterFromMini(e.clientX, e.clientY);
      return;
    }

    const p = pointers.get(e.pointerId);

    if (!p) {
      // movimiento sin botón: solo actualiza el fantasma en dispositivos con hover
      if (gs && hasHover) gs.hoverCell = cellFromPoint(canvas, e.clientX, e.clientY);
      return;
    }

    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > TAP_SLOP) {
      p.moved = true;
      cancelLongPress();
    }

    if (pointers.size === 2) {
      // pellizco: zoom centrado entre los dos dedos + paneo con el centro
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const rect = canvas.getBoundingClientRect();
      const cx = (a.x + b.x) / 2 - rect.left;
      const cy = (a.y + b.y) / 2 - rect.top;
      if (pinchDist > 0 && dist > 0) {
        zoomAt(cx, cy, dist / pinchDist);
        panBy(dx / 2, dy / 2);
      }
      pinchDist = dist;
    } else if (pointers.size === 1 && p.moved) {
      // arrastre con un dedo/botón: paneo
      panBy(dx, dy);
      if (gs) gs.hoverCell = null;
    } else if (gs && hasHover) {
      gs.hoverCell = cellFromPoint(canvas, e.clientX, e.clientY);
    }
  });

  const endPointer = (e: PointerEvent) => {
    // fin de un gesto sobre el minimapa: ya se consumió, no generar tap/ping
    if (e.pointerId === miniPtr) {
      miniPtr = -1;
      return;
    }
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    cancelLongPress();
    recalcPinch(); // 3→2 dedos: recalcular con la pareja restante, sin saltos
    if (longPressFired) {
      longPressFired = false;
      return; // el long-press ya lanzó el ping; no procesar como tap
    }
    if (!p || p.moved || pointers.size > 0) return;
    // solo el botón principal genera acciones (el derecho cancela vía contextmenu)
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    // ALT+clic izquierdo (ratón): ping cooperativo directo, sin armar el botón 📍
    if (e.altKey && e.pointerType === 'mouse') {
      sendPing(canvas, e.clientX, e.clientY);
      return;
    }

    // fue un tap limpio
    const gs = store.game;
    const now = performance.now();
    const isDouble =
      now - lastTapTime < 320 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 32;
    lastTapTime = now;
    lastTapX = e.clientX;
    lastTapY = e.clientY;

    // doble tap fuera del modo construcción: sobre una torre PROPIA selecciona su
    // GRUPO de idénticas (Lote 4); en cualquier otro sitio, reencuadra la cámara.
    if (isDouble && gs?.selection?.kind !== 'placing') {
      if (!gs?.focusArmed && selectTowerGroupAt(canvas, e.clientX, e.clientY)) return;
      resetCamera();
      return;
    }
    tapSelect(canvas, e.clientX, e.clientY, e.shiftKey, e.pointerType === 'mouse');
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', (e) => {
    if (e.pointerId === miniPtr) miniPtr = -1;
    pointers.delete(e.pointerId);
    cancelLongPress();
    recalcPinch();
  });

  // rueda del ratón: zoom hacia el cursor
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    },
    { passive: false },
  );

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    clearSelection();
  });

  // ---------- burbuja de confirmación (colocación táctil) ----------

  document.getElementById('place-yes')?.addEventListener('click', () => {
    const gs = store.game;
    if (gs?.pendingPlace) sendPlace(gs.pendingPlace.cx, gs.pendingPlace.cy, false);
  });
  document.getElementById('place-no')?.addEventListener('click', () => {
    const gs = store.game;
    if (gs) gs.pendingPlace = null;
  });

  // ---------- teclado ----------

  window.addEventListener('keydown', (e) => {
    if (store.screen !== 'game' || !store.game) return;
    if (store.replay) return; // en repetición, el teclado de juego está desactivado
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;

    if (e.key === 'Escape') {
      if (store.spectator) {
        store.suggestType = null;
        syncTowerBar();
        return;
      }
      // Lote 4 · ESC con el modo focus armado: solo cancela el modo (la selección
      // se conserva); un segundo ESC ya deselecciona.
      if (store.game.focusArmed) {
        store.game.focusArmed = false;
        refreshPanel();
        return;
      }
      clearSelection();
      return;
    }
    // combinaciones del navegador (Ctrl+C copiar, Ctrl+V pegar, Alt+…): NO son
    // atajos de juego — sin esto, copiar texto compraba madera.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // los atajos no distinguen mayúsculas: con Bloq Mayús puesto, la W de la
    // bomba llegaba como 'W' y no coincidía con la hotkey 'w'.
    const key = e.key.toLowerCase();

    // mercado por teclado (sin abrir el panel): C compra un lote, V lo vende.
    // El toast de la operación (o el rechazo) da el feedback.
    if (!store.spectator && key === 'c') {
      net.send({ type: 'cmd', cmd: { kind: 'buy_wood' } });
      return;
    }
    if (!store.spectator && key === 'v') {
      net.send({ type: 'cmd', cmd: { kind: 'sell_wood' } });
      return;
    }
    // Lote 4 · control de la selección actual (torre o grupo): X = stop/reanudar,
    // F = armar el modo focus. Elegidas por estar LIBRES en el keymap (torres:
    // 1-9/0/q/w/e · mercado: C/V); ambas son no-op sin una selección controlable.
    if (!store.spectator && key === 'x') {
      toggleHaltSelection();
      return;
    }
    if (!store.spectator && key === 'f') {
      armFocus();
      return;
    }
    const type = TOWER_ORDER.find((t) => TOWERS[t].hotkey === key);
    if (type) {
      // espectador: la hotkey arma/desarma el "modo sugerencia" de esa torre
      if (store.spectator) {
        store.suggestType = store.suggestType === type ? null : type;
        if (store.suggestType) {
          store.pingArmed = false;
          document.getElementById('btn-ping')?.classList.remove('armed');
        }
        syncTowerBar();
        return;
      }
      const current = store.game.selection;
      setPlacing(current?.kind === 'placing' && current.towerType === type ? null : type);
    }
  });
}
