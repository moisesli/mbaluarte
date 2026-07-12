// keymap.ts — Atajos de teclado EDITABLES (solo cliente; no toca la sim).
//
// Centraliza TODAS las teclas de acción de juego que hoy estaban repartidas:
//   · torres  → default = TOWERS[type].hotkey (1-9/0/q/w/e), badge `.thk` en las tarjetas
//   · stop/focus (Lote 4) → default 'x' / 'f'
//   · mercado  → default 'c' (comprar) / 'v' (vender)
// El handler de teclado (input.ts) y toda la UI (badges `.thk`, khints del panel,
// botones del mercado) leen de aquí, así una tecla custom se refleja en TODO.
//
// Reglas:
//   · solo teclas de UN carácter imprimible [a-z0-9] (minúsculas; input.ts ya
//     normaliza mayúsculas). Enter/Escape/Shift/Alt/Ctrl/espacio/flechas quedan
//     RESERVADAS por no encajar en [a-z0-9] (se usan para chat/gestos/sistema).
//   · anticolisión: setKey rechaza una tecla ya usada por otra acción y devuelve
//     cuál — nada se pisa en silencio.
//   · persistencia en localStorage ('td_keys', JSON); al cargar se valida y todo
//     lo corrupto/duplicado cae al default.
import { TOWER_ORDER, TOWERS, type TowerTypeId } from '@td/shared';

export type KeymapAction = `tower:${TowerTypeId}` | 'stop' | 'focus' | 'market_buy' | 'market_sell';

// Acciones NO-torre con su icono/etiqueta (las usa la pestaña Atajos).
export const CONTROL_ACTIONS: { id: KeymapAction; icon: string; label: string }[] = [
  { id: 'stop', icon: '⏹', label: 'Detener / reanudar torres' },
  { id: 'focus', icon: '🎯', label: 'Fijar objetivo (focus)' },
];
export const MARKET_ACTIONS: { id: KeymapAction; icon: string; label: string }[] = [
  { id: 'market_buy', icon: '🪵', label: 'Comprar madera' },
  { id: 'market_sell', icon: '💰', label: 'Vender madera' },
];

// Orden estable de todas las acciones remapeables (torres primero, en TOWER_ORDER).
export const ACTION_IDS: KeymapAction[] = [
  ...TOWER_ORDER.map((t) => `tower:${t}` as KeymapAction),
  ...CONTROL_ACTIONS.map((a) => a.id),
  ...MARKET_ACTIONS.map((a) => a.id),
];

// Defaults: torres desde el balance; el resto, las teclas históricas de input.ts.
const DEFAULTS: Record<KeymapAction, string> = (() => {
  const d = {} as Record<KeymapAction, string>;
  for (const t of TOWER_ORDER) d[`tower:${t}`] = TOWERS[t].hotkey.toLowerCase();
  d.stop = 'x';
  d.focus = 'f';
  d.market_buy = 'c';
  d.market_sell = 'v';
  return d;
})();

const STORAGE_KEY = 'td_keys';

// estado vivo (arranca en defaults; load() superpone lo guardado)
const keys: Record<KeymapAction, string> = { ...DEFAULTS };

// una tecla es asignable solo si es un único carácter imprimible [a-z0-9].
// Esto EXCLUYE por construcción Enter/Escape/Shift/Alt/Ctrl/espacio/flechas y
// cualquier signo de puntuación (todos reservados).
function assignable(k: string): boolean {
  return /^[a-z0-9]$/.test(k);
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    /* almacenamiento no disponible: seguimos en memoria */
  }
}

function load(): void {
  let stored: Record<string, unknown> = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p: unknown = JSON.parse(raw);
      if (p && typeof p === 'object') stored = p as Record<string, unknown>;
    }
  } catch {
    /* JSON corrupto → nos quedamos con defaults */
  }
  const next = {} as Record<KeymapAction, string>;
  const used = new Set<string>();
  // pase 1: overrides guardados válidos y sin colisión (el primero gana)
  for (const a of ACTION_IDS) {
    const v = stored[a];
    if (typeof v === 'string' && assignable(v) && !used.has(v)) {
      next[a] = v;
      used.add(v);
    }
  }
  // pase 2: default para lo que falte. F5.1 · CON anticolisión: una acción NUEVA
  // (p. ej. la Balista) puede tener un default que un keymap guardado viejo ya
  // usa para otra cosa — sin este chequeo se pisaba en silencio el atajo del
  // usuario (o la torre nueva quedaba inalcanzable, según el orden). Si el
  // default está ocupado se busca la primera tecla libre [a-z0-9]; si no queda
  // ninguna, la acción queda SIN tecla (la pestaña de Atajos la muestra vacía).
  const POOL = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (const a of ACTION_IDS) {
    if (next[a]) continue;
    let k = DEFAULTS[a];
    if (used.has(k)) {
      k = [...POOL].find((c) => !used.has(c)) ?? '';
    }
    next[a] = k;
    if (k) used.add(k);
  }
  Object.assign(keys, next);
}

// tecla cruda (minúscula) de una acción, p. ej. 'x'
export function getKey(a: KeymapAction): string {
  return keys[a];
}

// etiqueta para mostrar (mayúscula), p. ej. 'X'
export function keyLabel(a: KeymapAction): string {
  return (keys[a] ?? '').toUpperCase();
}

export type SetKeyResult = { ok: true } | { ok: false; conflict: KeymapAction } | { ok: false; reserved: true };

// Asigna `key` a `action`. Rechaza reservadas ({reserved}) y colisiones
// ({conflict: laOtraAcción}); en éxito persiste y devuelve {ok:true}.
export function setKey(action: KeymapAction, key: string): SetKeyResult {
  const k = key.toLowerCase();
  if (!assignable(k)) return { ok: false, reserved: true };
  for (const other of ACTION_IDS) {
    if (other !== action && keys[other] === k) return { ok: false, conflict: other };
  }
  keys[action] = k;
  save();
  return { ok: true };
}

// Restaura TODAS las teclas a su default y persiste.
export function resetKeys(): void {
  Object.assign(keys, DEFAULTS);
  save();
}

// Lookup inverso para el handler de input (tecla ya en minúsculas o no).
export function actionForKey(key: string): KeymapAction | null {
  const k = key.toLowerCase();
  for (const a of ACTION_IDS) if (keys[a] === k) return a;
  return null;
}

// Extrae el tipo de torre de una acción 'tower:<type>' (o null si no lo es).
export function towerTypeForAction(a: KeymapAction): TowerTypeId | null {
  return a.startsWith('tower:') ? (a.slice(6) as TowerTypeId) : null;
}

load();
