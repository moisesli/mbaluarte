import {
  AFFIX_ORDER,
  AFFIXES,
  ARMOR_TYPE_INFO,
  ATTACK_TYPE_INFO,
  attackMult,
  attackTypeOf,
  CALL_WAVE_GOLD_PER_SEC,
  CRIT_MULT,
  ENEMIES,
  ENEMY_ORDER,
  findFusion,
  fusionByIndex,
  FUSION_ORDER,
  FUSIONS,
  hasRank2,
  HORDE_CAP,
  nextEliteLevelCost,
  placementError,
  rank2Cost,
  SELL_REFUND,
  SENTRY_DURATION_SEC,
  statsOf,
  TARGET_MODES,
  TICK_RATE,
  TOWERS,
  TOWER_ORDER,
  towerFires,
  towerLevel,
  ORC_RATES,
  ORC_UPGRADE_COSTS,
  VITAL_LIVES_MIN,
  WOOD_COST_RANK2,
  WOOD_COST_SPEC,
  WOOD_LOT,
  WOOD_SELL_SPREAD,
  type ArmorTypeId,
  type AttackTypeId,
  type Snap,
  type SnapTower,
  type TargetMode,
  type TowerDef,
  type TowerLevelDef,
  type TowerTypeId,
} from '@td/shared';
import { net } from './net.js';
import { myGold, myWood, store, type GameStore, type Premove } from './store.js';
import { computeBannerAuras, countBannerTargets, ENEMY_ICONS, getPlacementCtx, TOWER_ICONS, type ClientAura } from './renderer.js';
import { clearSelection, setPlacing } from './input.js';
import { keyLabel } from './keymap.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const TARGET_LABELS: Record<TargetMode, string> = {
  first: 'Primero',
  last: 'Último',
  strong: 'Fuerte',
  weak: 'Débil',
  near: 'Cercano',
};

// los nombres de jugador son datos del usuario: SIEMPRE escapar antes de innerHTML
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---------- F5.1 · matriz ataque × armadura (helpers de presentación) ----------
// Orden canónico de columnas/filas de la matriz (identidad de rol/silueta), fijo
// para que la tabla de la Guía y las líneas del panel lean igual en todos lados.
export const ARMOR_ORDER: ArmorTypeId[] = ['ligera', 'media', 'blindada', 'colosal'];
export const ATTACK_ORDER: AttackTypeId[] = ['fisico', 'perforante', 'asedio', 'magico'];

// Umbrales de lectura (fuerte ≥1.25, débil ≤0.8) — los mismos que pide la fase 2.
// Devuelve las armaduras contra las que este tipo de ataque brilla o falla.
export function attackMatchup(attack: AttackTypeId): { strong: ArmorTypeId[]; weak: ArmorTypeId[] } {
  const strong: ArmorTypeId[] = [];
  const weak: ArmorTypeId[] = [];
  for (const armor of ARMOR_ORDER) {
    const m = attackMult(attack, armor);
    if (m >= 1.25) strong.push(armor);
    else if (m <= 0.8) weak.push(armor);
  }
  return { strong, weak };
}

// etiqueta compacta de una armadura (icono + nombre) para las líneas "fuerte/débil vs …"
export function armorLabel(a: ArmorTypeId): string {
  return `${ARMOR_TYPE_INFO[a].icon} ${ARMOR_TYPE_INFO[a].name}`;
}

// Línea compacta del panel: «⚔ Perforante · fuerte vs 🏰 Colosal · débil vs 🦾 Blindada».
// Usa attackTypeOf (fusion-aware): en una torre fusionada manda el rol de la receta.
function attackMatrixLine(t: { type: TowerTypeId; fusion: number }): string {
  const at = attackTypeOf(t);
  const info = ATTACK_TYPE_INFO[at];
  const { strong, weak } = attackMatchup(at);
  const parts = [`⚔ <b>${info.name}</b>`];
  if (strong.length) parts.push(`fuerte vs ${strong.map(armorLabel).join(', ')}`);
  if (weak.length) parts.push(`débil vs ${weak.map(armorLabel).join(', ')}`);
  if (!strong.length && !weak.length) parts.push('parejo contra todo');
  return `<span class="pmatrix" title="${escapeHtml(info.desc)}">${parts.join(' · ')}</span>`;
}

// ¿la torre hace daño DIRECTO (y por tanto su tipo de ataque significa algo en la
// matriz)? Las de apoyo/economía (mina/estandarte/alquimista/sentry) llevan un
// attackType nominal que NUNCA se usa: no deben lucir badge ni línea de tipo.
function towerDealsDamage(def: TowerDef): boolean {
  const has = (l: TowerLevelDef | undefined): boolean => !!l && (l.damage ?? 0) > 0;
  if (def.levels.some(has)) return true;
  return def.specs.some((s) => has(s) || (s.rank2 ? has({ ...s, ...s.rank2 } as TowerLevelDef) : false));
}

// ---------- premovimientos (estilo Hikaru / chess.com) ----------
// Una acción encolada (plantar o mejorar) que se dispara sola en cuanto el
// jugador tiene el oro (y madera) necesarios. Todo es local; el servidor valida
// el comando resultante como cualquier otro. Ver Premove en store.ts.

const MAX_PREMOVES = 20;

// coste de la próxima mejora de una torre del snapshot, o null si no se puede
// mejorar (fusión, torre de camino, nivel máximo, o hace falta especializar).
// v17 · el Sentry SÍ es mejorable en la sim, pero se EXCLUYE aquí a propósito del
// sistema de premovimientos: mejorar un Sentry además REFRESCA su duración (ward), y
// un premove que se auto-disparara al alcanzar el oro renovaría el ward en un momento
// inesperado. Se mejora a mano desde su panel; su botón no usa premove.
function premoveUpgradeCost(snap: Snap, towerId: number): { gold: number; wood: number } | null {
  const t = snap.towers.find((tt) => tt[0] === towerId);
  if (!t) return null;
  const type = TOWER_ORDER[t[1]];
  const level = t[4];
  const spec = t[9] ?? -1;
  const fusion = t[13] ?? -1;
  if (fusion >= 0 || TOWERS[type].onPathOnly || TOWERS[type].detects) return null;
  if (spec >= 0) {
    if (level >= 4 || !hasRank2(type, spec)) return null;
    return { gold: rank2Cost(type, spec) ?? 0, wood: WOOD_COST_RANK2 };
  }
  if (level >= 3) return null; // nivel máximo sin especializar: hay que especializar, no mejorar
  return { gold: towerLevel(type, level + 1).cost, wood: 0 };
}

// ¿hay un premovimiento de mejora encolado para esta torre?
export function hasUpgradePremove(towerId: number): boolean {
  return store.game?.premoves.some((pm) => pm.kind === 'upgrade' && pm.towerId === towerId) ?? false;
}

// HTML del botón de mejora en modo premovimiento (sin oro suficiente): refleja si
// ya está encolado (para poder cancelarlo). El click lo maneja wirePanel.
function premoveUpgradeBtn(towerId: number, label: string): string {
  const active = hasUpgradePremove(towerId);
  return `<button id="panel-upgrade" class="btn primary premove${active ? ' active' : ''}">${
    active ? '⏳ Cancelar premovimiento' : label
  }</button>`;
}

// alterna (encola/cancela) un premovimiento de mejora para la torre seleccionada
export function toggleUpgradePremove(towerId: number): void {
  const gs = store.game;
  if (!gs) return;
  const idx = gs.premoves.findIndex((pm) => pm.kind === 'upgrade' && pm.towerId === towerId);
  if (idx >= 0) {
    gs.premoves.splice(idx, 1);
    toast('⏳ Premovimiento de mejora cancelado', 'info');
  } else if (gs.premoves.length < MAX_PREMOVES) {
    gs.premoves.push({ kind: 'upgrade', towerId });
    toast('⏳ Premovimiento: se mejorará al alcanzar el oro', 'info');
  } else {
    toast('Demasiados premovimientos en cola');
  }
  refreshPanel();
}

// encola (o cancela, si ya existe en esa celda) un premovimiento de colocación.
export function queuePlacePremove(towerType: TowerTypeId, cx: number, cy: number): void {
  const gs = store.game;
  if (!gs) return;
  const idx = gs.premoves.findIndex((pm) => pm.kind === 'place' && pm.cx === cx && pm.cy === cy);
  if (idx >= 0) {
    gs.premoves.splice(idx, 1);
    toast('⏳ Premovimiento cancelado', 'info');
    return;
  }
  if (gs.premoves.length >= MAX_PREMOVES) {
    toast('Demasiados premovimientos en cola');
    return;
  }
  gs.premoves.push({ kind: 'place', towerType, cx, cy });
  toast(`⏳ Premovimiento: se plantará al alcanzar 🪙${TOWERS[towerType].levels[0].cost}`, 'info');
}

// cancela cualquier premovimiento de colocación en una celda (al tocarla). true si canceló.
export function cancelPremoveAt(cx: number, cy: number): boolean {
  const gs = store.game;
  if (!gs) return false;
  const idx = gs.premoves.findIndex((pm) => pm.kind === 'place' && pm.cx === cx && pm.cy === cy);
  if (idx < 0) return false;
  gs.premoves.splice(idx, 1);
  toast('⏳ Premovimiento cancelado', 'info');
  return true;
}

// Se llama en cada tick: dispara los premovimientos cuyo coste ya se alcanzó y
// descarta los que dejaron de ser válidos (torre vendida, celda ocupada…).
function processPremoves(snap: Snap): void {
  const gs = store.game;
  if (!gs) return;
  if (store.spectator || store.replay) {
    gs.premoves = [];
    return;
  }
  if (gs.premoves.length === 0) return;
  // presupuesto disponible que vamos consumiendo al disparar varios en un mismo
  // tick (evita comprometer más oro/madera del que hay antes de que el servidor
  // refleje el gasto en el siguiente snapshot).
  let availGold = myGold(gs);
  let availWood = myWood(gs);
  const towerCells = snap.towers.map((t) => ({ cx: t[2], cy: t[3] }));
  const keep: Premove[] = [];
  for (const pm of gs.premoves) {
    if (pm.kind === 'place') {
      const err = placementError(gs.map, getPlacementCtx(gs.map), towerCells, pm.cx, pm.cy, pm.towerType);
      if (err) {
        toast('⏳ Premovimiento cancelado: la casilla ya no está libre');
        continue; // deja de ser válido → descartar
      }
      // F9a · el Barril usa el precio EFECTIVO del snapshot (escala por compra);
      // si otro compró entre medias, el server re-valida igual (reject visible).
      const cost = TOWERS[pm.towerType].detonates
        ? snap.boomCost
        : TOWERS[pm.towerType].levels[0].cost;
      if (availGold >= cost) {
        net.send({ type: 'cmd', cmd: { kind: 'place', towerType: pm.towerType, cx: pm.cx, cy: pm.cy } });
        availGold -= cost;
        continue; // disparado → sacar de la cola
      }
      keep.push(pm);
    } else {
      const cost = premoveUpgradeCost(snap, pm.towerId);
      if (!cost) continue; // torre vendida o ya no mejorable → descartar en silencio
      if (availGold >= cost.gold && availWood >= cost.wood) {
        net.send({ type: 'cmd', cmd: { kind: 'upgrade', towerId: pm.towerId } });
        availGold -= cost.gold;
        availWood -= cost.wood;
        continue; // disparado
      }
      keep.push(pm);
    }
  }
  gs.premoves = keep;
}

// ---------- barra de torres ----------

// Orden de PRESENTACIÓN de la barra, agrupado por rol (no toca TOWER_ORDER, que
// es el orden compacto de los snapshots): ataque · apoyo/economía · camino.
// Una torre nueva que no esté aquí cae en un grupo extra al final (red de seguridad).
const BAR_GROUPS: TowerTypeId[][] = [
  ['archer', 'cannon', 'frost', 'poison', 'tesla', 'sniper', 'mortar', 'flak'],
  ['banner', 'bank', 'alchemist'],
  ['trap', 'boom', 'sentry'],
];

export function buildTowerBar(): void {
  const bar = $('hud-towers');
  bar.innerHTML = '';
  const flat = BAR_GROUPS.flat();
  // el Sentry vive en el grupo de camino de la barra Y sigue estando en la 🛒
  // Tienda (accesible en ambos sitios). La red de seguridad de "extras" recoge
  // cualquier torre nueva que aún no se haya agrupado a mano.
  const extras = TOWER_ORDER.filter((t) => !flat.includes(t));
  const groups = extras.length > 0 ? [...BAR_GROUPS, extras] : BAR_GROUPS;
  for (let gi = 0; gi < groups.length; gi++)
  for (let ti = 0; ti < groups[gi].length; ti++) {
    const type = groups[gi][ti];
    const def = TOWERS[type];
    const card = document.createElement('button');
    card.className = 'tcard';
    if (gi > 0 && ti === 0) card.classList.add('group-start');
    card.dataset.type = type;
    card.title = `${def.name} — ${def.desc}`;
    // F5.1 · badge del tipo de ataque en la esquina (solo torres que dañan: las de
    // apoyo/economía llevan attackType nominal y no deben mostrarlo). No roba clics
    // (pointer-events:none) ni rompe el layout móvil (emoji diminuto en la esquina).
    const at = attackTypeOf({ type, fusion: -1 });
    const badge = towerDealsDamage(def)
      ? `<span class="tbadge" title="Ataque ${ATTACK_TYPE_INFO[at].name}">${ATTACK_TYPE_INFO[at].icon}</span>`
      : '';
    card.innerHTML = `
      ${badge}
      <span class="thk">${keyLabel(`tower:${type}`)}</span>
      <img class="tsprite" alt="" src="/sprites/tower_${type}_l1.png" />
      <span class="ticon">${TOWER_ICONS[type]}</span>
      <span class="tname">${def.name}</span>
      <span class="tcost">🪙${def.levels[0].cost}</span>
    `;
    // usa el sprite real si existe; si el PNG falta (Mina/Alquimista) deja el emoji
    const spr = card.querySelector<HTMLImageElement>('.tsprite')!;
    const emo = card.querySelector<HTMLElement>('.ticon')!;
    spr.addEventListener('load', () => {
      spr.style.display = 'block';
      emo.style.display = 'none';
    });
    spr.addEventListener('error', () => spr.remove());
    card.addEventListener('click', () => {
      // espectador: la barra funciona en "modo sugerencia" — no coloca; arma el
      // siguiente toque en el mapa como sugerencia de torre (map_ping + towerType)
      if (store.spectator) {
        store.suggestType = store.suggestType === type ? null : type;
        // sugerir y pinear son excluyentes; desarmar el ping si estaba armado
        if (store.suggestType) {
          store.pingArmed = false;
          $('btn-ping').classList.remove('armed');
        }
        syncTowerBar();
        return;
      }
      const sel = store.game?.selection;
      setPlacing(sel?.kind === 'placing' && sel.towerType === type ? null : type);
    });
    bar.appendChild(card);
  }
}

// Refresca en caliente las teclas visibles cuando el jugador remapea un atajo
// desde la Guía: el badge `.thk` de cada tarjeta de torre y (si hay panel abierto)
// los khints [stop]/[focus]. El mercado se rehace solo en el próximo tick.
export function syncHotkeyLabels(): void {
  for (const card of document.querySelectorAll<HTMLElement>('.tcard')) {
    const type = card.dataset.type as TowerTypeId;
    const thk = card.querySelector<HTMLElement>('.thk');
    if (thk) thk.textContent = keyLabel(`tower:${type}`);
  }
  refreshPanel();
}

// resumen de las propiedades especiales de un nivel de torre
function specialStats(lvl: TowerLevelDef): string[] {
  const out: string[] = [];
  if (lvl.splash) out.push(`Área ${lvl.splash}`);
  if (lvl.slow) out.push(`Congela ${Math.round(lvl.slow.factor * 100)}%`);
  if (lvl.poison) out.push(`Veneno ${lvl.poison.dps}/s`);
  if (lvl.chain) out.push(`Salta a ${lvl.chain.targets}`);
  if (lvl.incomePerWave) out.push(`+🪙${lvl.incomePerWave}/oleada`);
  if (lvl.auraBounty) out.push(`+${Math.round(lvl.auraBounty * 100)}% oro por baja`);
  if (lvl.charges && lvl.charges > 1) out.push(`${lvl.charges} cargas`);
  if (lvl.shots && lvl.shots > 1) out.push(`${lvl.shots} disparos`);
  if (lvl.airBonus && lvl.airBonus > 1) out.push(`×${lvl.airBonus} a voladores`);
  if (lvl.pierceArmor) out.push('Antiarmadura');
  if (lvl.minRange) out.push(`Mín. ${lvl.minRange}`);
  return out;
}

function syncPlacingInfo(): void {
  const gs = store.game;
  const strip = $('hud-placing');
  if (!gs || gs.selection?.kind !== 'placing') {
    strip.hidden = true;
    return;
  }
  const type = gs.selection.towerType;
  const def = TOWERS[type];
  const lvl = def.levels[0];
  // F9a (v19) · el Barril muestra su precio EFECTIVO de equipo (snap.boomCost)
  const placeCost = def.detonates ? (gs.latest?.boomCost ?? lvl.cost) : lvl.cost;
  const parts: string[] = [`${TOWER_ICONS[type]} <b>${def.name}</b> 🪙${placeCost}`];
  const isAura = lvl.auraDamage !== undefined || lvl.auraHaste !== undefined || lvl.auraBounty !== undefined;
  if (lvl.damage > 0 && !def.onPathOnly) parts.push(`Daño <b>${lvl.damage}</b>`);
  if (def.onPathOnly) parts.push(def.detonates ? `💥 Detona al pisarlo: <b>borra la morralla</b> terrestre del área (con tope — tanques/élites gordos sobreviven; jefes: ${lvl.damage} de daño)` : `Daño por golpe <b>${lvl.damage}</b>`);
  if (def.detects) parts.push(`👁 <b>Revela invisibles</b> en su radio · ⏳ dura <b>${SENTRY_DURATION_SEC[0] / 60} min</b> (mejorable)`);
  if (lvl.auraDamage !== undefined && lvl.auraDamage > 0) parts.push(`Aura de daño <b>+${Math.round(lvl.auraDamage * 100)}%</b>`);
  if (lvl.auraHaste !== undefined && lvl.auraHaste > 0) parts.push(`Aura de cadencia <b>+${Math.round(lvl.auraHaste * 100)}%</b>`);
  if (lvl.auraBounty !== undefined && lvl.auraBounty > 0) parts.push(`Aura de oro <b>+${Math.round(lvl.auraBounty * 100)}%</b>`);
  if (lvl.range > 0) parts.push(`${isAura || def.detects ? 'Radio' : 'Alcance'} <b>${lvl.range}</b>`);
  if (lvl.cooldown > 0) parts.push(`Cadencia <b>${lvl.cooldown}s</b>`);
  parts.push(...specialStats(lvl));
  const hint = window.matchMedia('(hover: hover)').matches
    ? 'clic en una celda libre · Shift para varias'
    : 'toca una celda y confirma con ✓';
  strip.innerHTML = `${parts.join('<span class="sep">·</span>')}<br><span class="hint">${hint}</span>`;
  strip.hidden = false;
}

export function syncTowerBar(): void {
  const gs = store.game;
  if (!gs) return;
  const gold = myGold(gs);
  const placing = gs.selection?.kind === 'placing' ? gs.selection.towerType : null;
  for (const card of document.querySelectorAll<HTMLElement>('.tcard')) {
    const type = card.dataset.type as TowerTypeId;
    if (store.spectator) {
      // el espectador no coloca ni gasta: solo "modo sugerencia" (celeste), sin
      // marca de "sin oro"
      card.classList.remove('selected', 'poor');
      card.classList.toggle('suggesting', store.suggestType === type);
    } else {
      // F9a (v19) · el Barril usa su precio EFECTIVO de equipo (escala ×1.3)
      const cost = TOWERS[type].detonates ? (gs.latest?.boomCost ?? TOWERS[type].levels[0].cost) : TOWERS[type].levels[0].cost;
      card.classList.toggle('selected', placing === type);
      card.classList.toggle('poor', gold < cost);
      if (TOWERS[type].detonates) {
        const costEl = card.querySelector<HTMLElement>('.tcost');
        const txt = `🪙${cost}`;
        if (costEl && costEl.textContent !== txt) costEl.textContent = txt;
      }
    }
  }
  if (!store.spectator) syncPlacingInfo();
}

// ---------- modo espectador ----------

// issue #5: en móvil, la barra de torres del espectador (modo sugerencia) roba
// media pantalla y no sirve para construir — empieza ESCONDIDA en cada partida
// (nunca persistida) y un botón flotante 🏗 la muestra/esconde. Solo aplica por
// debajo del breakpoint móvil (CSS); en escritorio la barra sigue como siempre.
let specTowersOpen = false;

function syncSpecTowersToggle(): void {
  const spec = store.spectator;
  $('screen-game').classList.toggle('spectating', spec);
  $('screen-game').classList.toggle('spec-towers-open', spec && specTowersOpen);
  $('btn-towers-toggle').hidden = !spec;
}

// alterna la barra de torres del espectador móvil (botón 🏗)
export function toggleSpectatorTowers(): void {
  specTowersOpen = !specTowersOpen;
  syncSpecTowersToggle();
}

// Aplica (o revierte) el modo espectador de la UI del juego: banner persistente,
// oculta el oro propio, los botones de acción de jugador (llamar oleada, pausa,
// velocidad) y el panel de mejora/venta. La barra de torres se mantiene (en modo
// sugerencia; en móvil, escondida por defecto tras el botón 🏗 — issue #5). Se
// llama al entrar a la partida (jugador o espectador): por eso también es donde
// se reinicia specTowersOpen, para que nunca sobreviva de una partida a otra.
export function applySpectatorUI(): void {
  const spec = store.spectator;
  $('spectator-banner').hidden = !spec;
  $('hud-gold').hidden = spec;
  $('hud-wood').hidden = spec;
  specTowersOpen = false;
  syncSpecTowersToggle();
  if (spec) {
    // un espectador nunca ve estos controles (ya se ocultan por !isHost, pero por
    // si acaso: un espectador jamás es anfitrión)
    $('btn-callwave').hidden = true;
    $('btn-pause').hidden = true;
    $('btn-speed').hidden = true;
    $('btn-resume').hidden = true;
    hidePanel();
    if (store.game) store.game.selection = null;
  }
}

// ---------- panel de torre seleccionada ----------

export function showPanel(): void {
  refreshPanel();
}

export function hidePanel(): void {
  $('hud-panel').hidden = true;
  lastPanelHtml = '';
  // en móvil, la barra de torres vuelve a verse al cerrar el panel (CSS .panel-open)
  $('screen-game').classList.remove('panel-open');
}

// Los botones del panel se recrean al refrescar; con delegación en el contenedor
// (que es estable) el click no se pierde aunque el refresco caiga entre el
// pointerdown y el pointerup de un toque lento.
let panelWired = false;
let lastPanelHtml = '';
// ¿Hay un dedo/botón PRESIONADO sobre el panel ahora mismo? Mientras dure, JAMÁS
// se reescribe el innerHTML: reescribir destruye el botón bajo el dedo y el
// click se pierde (bug real: "tengo que tocar Mejorar muchas veces").
let panelHeld = false;

function wirePanel(): void {
  if (panelWired) return;
  panelWired = true;
  $('hud-panel').addEventListener('pointerdown', () => {
    panelHeld = true;
  });
  const releasePanel = () => {
    panelHeld = false;
  };
  window.addEventListener('pointerup', releasePanel);
  window.addEventListener('pointercancel', releasePanel);
  $('hud-panel').addEventListener('click', (e) => {
    const gs = store.game;
    const sel = gs?.selection;
    if (!gs || !sel || (sel.kind !== 'tower' && sel.kind !== 'towers')) return;
    const target = e.target as HTMLElement;
    // el botón ✕ cierra el panel y deselecciona (imprescindible en móvil, donde
    // el panel es una hoja inferior y "tocar fuera" no siempre es obvio)
    if (target.closest('#panel-close')) {
      clearSelection();
      return;
    }

    // ---- acciones comunes a torre y GRUPO (Lote 4) ----
    // ⏹/▶ stop-reanudar, 🎯 armar focus, ✕ volver al automático. Aplican a todas
    // las torres controlables de la selección (mías y que disparan).
    if (target.closest('#panel-halt')) {
      toggleHaltSelection();
      return;
    }
    if (target.closest('#panel-focus')) {
      armFocus();
      return;
    }
    if (target.closest('#panel-unfocus')) {
      clearFocusSelection();
      return;
    }
    const mode = target.closest<HTMLElement>('.tmode')?.dataset.mode;

    // ---- GRUPO (Lote 4): mejorar todas + modo de objetivo en grupo ----
    if (sel.kind === 'towers') {
      const gUpgrade = target.closest<HTMLButtonElement>('#gpanel-upgrade');
      if (gUpgrade && !gUpgrade.disabled) {
        groupUpgradeAll();
        return;
      }
      if (mode) {
        for (const id of sel.ids) {
          net.send({ type: 'cmd', cmd: { kind: 'target', towerId: id, mode: mode as TargetMode } });
        }
      }
      return;
    }

    // ---- torre individual (flujo clásico) ----
    const towerId = sel.id;
    const upgrade = target.closest<HTMLButtonElement>('#panel-upgrade');
    const sell = target.closest<HTMLButtonElement>('#panel-sell');
    const specBtn = target.closest<HTMLButtonElement>('.spec-btn');
    const fuseBtn = target.closest<HTMLButtonElement>('.fuse-btn');
    if (upgrade && !upgrade.disabled) {
      // botón de mejora en modo premovimiento (sin oro suficiente): encola/cancela
      if (upgrade.classList.contains('premove')) {
        toggleUpgradePremove(towerId);
      } else {
        net.send({ type: 'cmd', cmd: { kind: 'upgrade', towerId } });
      }
    } else if (fuseBtn && !fuseBtn.disabled) {
      // la fusión se queda en la celda de la torre SELECCIONADA (keepId = towerId);
      // para quedarse en la otra celda, selecciona la otra torre y fusiona desde ahí
      net.send({
        type: 'cmd',
        cmd: { kind: 'fuse', towerId, otherId: Number(fuseBtn.dataset.other), keepId: towerId },
      });
    } else if (specBtn && !specBtn.disabled) {
      net.send({ type: 'cmd', cmd: { kind: 'specialize', towerId, spec: Number(specBtn.dataset.spec) } });
    } else if (sell) {
      net.send({ type: 'cmd', cmd: { kind: 'sell', towerId } });
      gs.selection = null;
      hidePanel();
    } else if (mode) {
      net.send({ type: 'cmd', cmd: { kind: 'target', towerId, mode: mode as TargetMode } });
    }
  });
}

// ---------- Lote 4 · control avanzado (stop / focus) sobre la selección ----------

// Tuplas de la selección actual (torre única o grupo) presentes en el snapshot.
function selectedTuples(gs: GameStore): SnapTower[] {
  const snap = gs.latest;
  const sel = gs.selection;
  if (!snap || !sel) return [];
  const ids = sel.kind === 'tower' ? [sel.id] : sel.kind === 'towers' ? sel.ids : [];
  const out: SnapTower[] = [];
  for (const id of ids) {
    const t = snap.towers.find((tt) => tt[0] === id);
    if (t) out.push(t);
  }
  return out;
}

// ¿La torre de esta tupla DISPARA? (mismo criterio que la sim: comparte towerFires)
function tupleFires(t: SnapTower): boolean {
  return towerFires({ type: TOWER_ORDER[t[1]], level: t[4], spec: t[9] ?? -1, fusion: t[13] ?? -1 });
}

// Ids de las torres CONTROLABLES de la selección: MÍAS y que DISPARAN (stop y
// focus no significan nada en auras/economía; la sim los rechazaría igual).
// La usan los botones del panel, las hotkeys X/F y el tap del modo focus.
export function controllableSelectedIds(): number[] {
  const gs = store.game;
  if (!gs || store.spectator || store.replay) return [];
  return selectedTuples(gs)
    .filter((t) => gs.init.players[t[5]]?.id === store.playerId && tupleFires(t))
    .map((t) => t[0]);
}

// ⏹/▶ (botón del panel y tecla X): si ALGUNA torre controlable de la selección
// está detenida → reanuda TODAS; si no, las detiene todas. Así el botón "mixto"
// siempre converge al estado que pide su etiqueta.
export function toggleHaltSelection(): void {
  const gs = store.game;
  const snap = gs?.latest;
  if (!gs || !snap) return;
  const ids = controllableSelectedIds();
  if (ids.length === 0) return;
  const byId = new Map(snap.towers.map((t) => [t[0], t]));
  const anyHalted = ids.some((id) => ((byId.get(id)?.[17] ?? 0) as number) === 1);
  for (const id of ids) net.send({ type: 'cmd', cmd: { kind: 'halt', towerId: id, on: !anyHalted } });
  toast(
    anyHalted
      ? ids.length > 1
        ? '▶ Torres reanudadas'
        : '▶ Torre reanudada'
      : ids.length > 1
        ? '⏹ Torres detenidas'
        : '⏹ Torre detenida',
    'info',
  );
  refreshPanel();
}

// 🎯 (botón del panel y tecla F): arma/desarma el modo focus — el siguiente tap
// sobre un enemigo manda `focus` por cada torre seleccionada (ver input.ts).
export function armFocus(): void {
  const gs = store.game;
  if (!gs) return;
  if (controllableSelectedIds().length === 0) return;
  gs.focusArmed = !gs.focusArmed;
  if (gs.focusArmed) toast('🎯 Toca un enemigo para fijar el objetivo (ESC cancela)', 'info');
  refreshPanel();
}

// ✕ del estado "Atacando: …": quita el focus (vuelta al targetMode automático)
// de todas las torres de la selección que tuvieran uno.
export function clearFocusSelection(): void {
  const gs = store.game;
  const snap = gs?.latest;
  if (!gs || !snap) return;
  const byId = new Map(snap.towers.map((t) => [t[0], t]));
  const ids = controllableSelectedIds().filter((id) => ((byId.get(id)?.[18] ?? 0) as number) > 0);
  if (ids.length === 0) return;
  for (const id of ids) net.send({ type: 'cmd', cmd: { kind: 'focus', towerId: id, enemyId: 0 } });
  toast('🎯 Objetivo liberado: vuelven al modo automático', 'info');
  refreshPanel();
}

// ⬆ Mejorar todas (grupo): manda un `upgrade` por torre EN ORDEN ESTABLE por id,
// descontando un presupuesto local (oro Y madera — el Rango II cuesta ambas); si
// no alcanza para todas, mejora las que alcancen y el toast lo resume. El server
// valida cada comando igualmente.
function groupUpgradeAll(): void {
  const gs = store.game;
  const snap = gs?.latest;
  if (!gs || !snap || gs.selection?.kind !== 'towers') return;
  let gold = myGold(gs);
  let wood = myWood(gs);
  const ids = [...gs.selection.ids].sort((a, b) => a - b);
  let upgradable = 0;
  let sent = 0;
  for (const id of ids) {
    const cost = premoveUpgradeCost(snap, id);
    if (!cost) continue; // al máximo / requiere especializar: no cuenta
    upgradable += 1;
    if (gold >= cost.gold && wood >= cost.wood) {
      net.send({ type: 'cmd', cmd: { kind: 'upgrade', towerId: id } });
      gold -= cost.gold;
      wood -= cost.wood;
      sent += 1;
    }
  }
  if (upgradable === 0) return;
  if (sent === 0) toast('No te alcanzan los recursos para mejorar ninguna');
  else toast(`⬆ Mejoradas ${sent}/${upgradable}`, 'info');
}

// Líneas de stats de un bloque activo (con vista previa opcional del siguiente
// nivel). `aura`: refuerzo de Estandarte ACTIVO sobre esta torre — se muestran
// los valores EFECTIVOS (⚑) junto a los base, para que el aura se VEA (antes el
// panel enseñaba solo los base y parecía que el Estandarte no hacía nada).
function statBlock(lvl: TowerLevelDef, next: TowerLevelDef | null, aura?: ClientAura): string[] {
  const stat = (label: string, cur: number | string, nxt?: number | string | null, suffix = '') => {
    const upgrade = nxt !== undefined && nxt !== null && nxt !== cur ? ` <span class="up">→ ${nxt}${suffix}</span>` : '';
    return `${label}: <b>${cur}${suffix}</b>${upgrade}`;
  };
  const aDmg = aura && aura.dmg > 0 ? aura.dmg : 0;
  const aHaste = aura && aura.haste > 0 ? aura.haste : 0;
  const lines: string[] = [];
  if (lvl.damage > 0) {
    let dmgLine = stat('Daño', lvl.damage, next?.damage);
    if (aDmg > 0) dmgLine += ` <span class="aura">⚑ ${Math.round(lvl.damage * (1 + aDmg))} con aura</span>`;
    lines.push(dmgLine);
    if (lvl.cooldown > 0) {
      const dps = ((lvl.damage * (lvl.shots ?? 1)) / lvl.cooldown).toFixed(1);
      const nextDps = next && next.cooldown > 0 ? ((next.damage * (next.shots ?? 1)) / next.cooldown).toFixed(1) : null;
      let dpsLine = stat('DPS', dps, nextDps);
      if (aDmg > 0 || aHaste > 0) {
        const effDps = ((Math.round(lvl.damage * (1 + aDmg)) * (lvl.shots ?? 1)) / (lvl.cooldown / (1 + aHaste))).toFixed(1);
        dpsLine += ` <span class="aura">⚑ ${effDps}</span>`;
      }
      lines.push(dpsLine);
    }
  }
  if (lvl.shots && lvl.shots > 1) lines.push(`Dispara a <b>${lvl.shots}</b> a la vez`);
  if (lvl.auraDamage !== undefined && lvl.auraDamage > 0) {
    const nxt = next?.auraDamage !== undefined && next.auraDamage > 0 ? `${Math.round(next.auraDamage * 100)}%` : null;
    lines.push(stat('Aura de daño', `+${Math.round(lvl.auraDamage * 100)}%`, nxt));
  }
  if (lvl.auraHaste !== undefined && lvl.auraHaste > 0) {
    const nxt = next?.auraHaste !== undefined && next.auraHaste > 0 ? `${Math.round(next.auraHaste * 100)}%` : null;
    lines.push(stat('Aura de cadencia', `+${Math.round(lvl.auraHaste * 100)}%`, nxt));
  }
  if ((lvl.auraDamage !== undefined || lvl.auraHaste !== undefined) && lvl.range > 0 && !lvl.alsoFires) {
    lines.push(stat('Radio', lvl.range, next?.range));
  } else if (lvl.range > 0) {
    // la Gran Bertha alcanza TODO el mapa (range 99): mostrarlo con palabras
    lines.push(stat('Alcance', lvl.range >= 90 ? 'todo el mapa' : lvl.range, next?.range));
  }
  if (lvl.cooldown > 0) {
    let cdLine = stat('Cadencia', lvl.cooldown, next?.cooldown, 's');
    if (aHaste > 0) cdLine += ` <span class="aura">⚑ ${(lvl.cooldown / (1 + aHaste)).toFixed(2)}s con aura</span>`;
    lines.push(cdLine);
  }
  if (lvl.splash) lines.push(stat('Área', lvl.splash, next?.splash));
  if (lvl.slow) lines.push(stat('Congela al', `${Math.round(lvl.slow.factor * 100)}%`, next?.slow ? `${Math.round(next.slow.factor * 100)}%` : null));
  if (lvl.slowAura) lines.push(`Aura de hielo <b>${lvl.slowAura.radius}</b> (${Math.round(lvl.slowAura.factor * 100)}%)`);
  if (lvl.poison) lines.push(stat('Veneno', `${lvl.poison.dps}/s`, next?.poison ? `${next.poison.dps}/s` : null));
  if (lvl.chain) lines.push(stat('Salta a', lvl.chain.targets, next?.chain?.targets));
  if (lvl.execute) lines.push(`Remata por debajo del <b>${Math.round(lvl.execute * 100)}%</b> de la vida máx`);
  if (lvl.executeCurrent) {
    lines.push(`Remata por debajo del <b>${Math.round(lvl.executeCurrent * 100)}%</b> de la vida ACTUAL`);
    // el remate arranca vida SIN sumar al contador de daño de la torre: su cifra
    // de "Daño total" SIEMPRE infravalora su aporte real (Arpón del Cénit ★★ /
    // Cañón de Riel ★★). Se avisa para que nadie la venda "porque hace poco daño".
    lines.push('<span class="hint">💡 El remate no cuenta en el contador de daño: aporta más de lo que marca</span>');
  }
  if (lvl.shredChance) lines.push(`Shred: <b>${Math.round(lvl.shredChance * 100)}%</b> de partir la armadura en área`);
  if (lvl.growth) lines.push(`Crecimiento: <b>+${lvl.growth}</b> de daño por disparo`);
  // F4.3 · mecánicas de fusión
  if (lvl.lineWidth) lines.push('Rayo <b>perforante</b>: golpea a TODOS los enemigos en línea (a inmunes −70%)');
  if (lvl.poisonBountyMult) lines.push(`Botín <b>×${lvl.poisonBountyMult}</b> por bajas de su veneno`);
  if (lvl.auraBounty) lines.push(stat('Aura de oro', `+${Math.round(lvl.auraBounty * 100)}%`, next?.auraBounty ? `+${Math.round(next.auraBounty * 100)}%` : null));
  if (lvl.incomePerWave) lines.push(stat('Ingreso', `🪙${lvl.incomePerWave}${lvl.incomeToAll ? ' a todos' : ''}`, next?.incomePerWave ? `🪙${next.incomePerWave}` : null));
  if (lvl.airBonus && lvl.airBonus > 1) lines.push(`Antiaérea: <b>×${lvl.airBonus}</b> de daño a voladores`);
  if (lvl.pierceArmor) lines.push('Perfora armadura');
  return lines;
}

// Botones de modo de objetivo (solo para torres que disparan y tienen alcance).
// `projKind` viene resuelto por el llamador (las fusiones usan el de su receta).
function targetModesHtml(projKind: string, lvl: TowerLevelDef, modeIdx: number): string {
  if (projKind === 'none' || lvl.range <= 0) return '';
  return `<div class="tmodes">${TARGET_MODES.map(
    (m, i) => `<button class="tmode ${i === modeIdx ? 'active' : ''}" data-mode="${m}">${TARGET_LABELS[m]}</button>`,
  ).join('')}</div>`;
}

// F6.2 · ¿esta torre DISPARA? (para decidir si mostrarle el contador de próximo
// ataque). Espeja towerFires() de la sim: NO disparan la mina (incomePerWave), el
// aura de hielo/Escarcha Eterna (slowAura), el Estandarte puro (auraDamage/auraHaste
// sin alsoFires), el Alquimista (auraBounty) ni las torres de camino (trampa/barril).
// EXCEPCIÓN: el Señor de la Guerra (alsoFires) tiene aura Y ADEMÁS dispara.
function towerAttacks(lvl: TowerLevelDef, def: TowerDef): boolean {
  if (lvl.alsoFires) return true;
  if (def.onPathOnly) return false;
  if (def.detects) return false; // el Sentry no dispara: solo detecta
  if (lvl.incomePerWave) return false;
  if (lvl.slowAura) return false;
  if (lvl.auraBounty !== undefined) return false;
  if (lvl.auraDamage !== undefined || lvl.auraHaste !== undefined) return false;
  return true;
}

// F6.2 · texto del contador de próximo ataque a partir de la tupla del snapshot.
// El aturdimiento (índice 10) manda sobre el cooldown: una torre aturdida no
// dispara. Lote 4: una torre DETENIDA (índice 17) tampoco — ⏸ manda sobre todo.
// cdTicks (índice 16) son los ticks que faltan para el próximo disparo;
// 0 = lista. Con el juego en PAUSA no llegan ticks, así que el valor se congela
// solo (comportamiento correcto, sin trabajo extra).
function cooldownText(stunned: number, cdTicks: number, halted = 0): string {
  if (halted) return '⏸ Detenida';
  if (stunned) return '💫 Aturdida';
  return cdTicks <= 0 ? '⚔️ listo' : `⚔️ ${(cdTicks / TICK_RATE).toFixed(1)}s`;
}

// v17 · tick de sim del último snapshot (el `t` del mensaje tick, guardado en frames).
// El Sentry temporal calcula su tiempo restante restándolo a su `expiresTick`.
function latestSnapTick(gs: GameStore): number {
  const f = gs.frames;
  return f.length ? f[f.length - 1].t : 0;
}

// v17 · texto del countdown de caducidad del Sentry: "⏳ m:ss" mientras vive.
function expiryText(expiresTick: number, tickNow: number): string {
  const left = Math.max(0, Math.ceil((expiresTick - tickNow) / TICK_RATE));
  const m = Math.floor(left / 60);
  const s = left % 60;
  return `⏳ ${m}:${s.toString().padStart(2, '0')}`;
}

export function refreshPanel(): void {
  const gs = store.game;
  const panel = $('hud-panel');
  const sel = gs?.selection ?? null;
  if (!gs || !gs.latest || !sel || (sel.kind !== 'tower' && sel.kind !== 'towers')) {
    panel.hidden = true;
    $('screen-game').classList.remove('panel-open');
    return;
  }
  // Lote 4: el panel tiene dos formas — torre individual y GRUPO (doble click).
  // Ambas devuelven {html, live} y comparten la escritura anti-robo-de-clicks.
  const built = sel.kind === 'towers' ? buildGroupPanel(gs, sel) : buildTowerPanel(gs, sel.id);
  if (!built) {
    // la selección ya no existe (vendida / trampa agotada / barril detonado)
    panel.hidden = true;
    $('screen-game').classList.remove('panel-open');
    gs.selection = null;
    return;
  }
  const { html, live } = built;
  wirePanel();
  // ESTRUCTURA: solo reescribir si cambió de verdad (los contadores volátiles ya
  // no entran aquí) y NUNCA con un dedo presionando el panel — reescribir
  // destruye el botón bajo el dedo y el click se pierde.
  const structuralChanged = html !== lastPanelHtml;
  if (structuralChanged && !panelHeld) {
    lastPanelHtml = html;
    panel.innerHTML = html;
  }
  // VOLÁTILES: actualizar por textContent (no destruye nada, no roba clicks)
  if (!structuralChanged || !panelHeld) {
    for (const [k, v] of Object.entries(live)) {
      const el = panel.querySelector<HTMLElement>(`[data-lv="${k}"]`);
      if (el && el.textContent !== v) el.textContent = v;
    }
  }
  panel.hidden = false;
  // en móvil el panel es una hoja inferior que SUSTITUYE a la barra de torres
  $('screen-game').classList.add('panel-open');
}

// Lote 4 · panel de GRUPO: cabecera "N× torre" + acciones en lote (mejorar todas,
// modo de objetivo, ⏹/▶, 🎯). SIN vender (evita ventas masivas accidentales:
// véndese de una en una, como siempre). null = el grupo entero desapareció.
function buildGroupPanel(
  gs: GameStore,
  sel: { kind: 'towers'; ids: number[] },
): { html: string; live: Record<string, string> } | null {
  const snap = gs.latest!;
  const byId = new Map(snap.towers.map((t) => [t[0], t]));
  const tuples = sel.ids.map((id) => byId.get(id)).filter((t): t is SnapTower => t !== undefined);
  if (tuples.length === 0) return null;
  // poda: torres del grupo vendidas/consumidas desde la selección
  if (tuples.length !== sel.ids.length) sel.ids = tuples.map((t) => t[0]);
  // el grupo colapsó a una: panel individual completo (más útil que un grupo de 1)
  if (tuples.length === 1) {
    gs.selection = { kind: 'tower', id: tuples[0][0] };
    return buildTowerPanel(gs, tuples[0][0]);
  }
  const head = tuples[0];
  const type = TOWER_ORDER[head[1]];
  const def = TOWERS[type];
  const level = head[4];
  const spec = head[9] ?? -1;
  const fusion = fusionByIndex(head[13] ?? -1);
  // F9a · statsOf aplica también la veteranía (niveles 5→10) del cabecilla
  const lvl = statsOf({ type, level, spec, fusion: head[13] ?? -1 });
  const projKind = fusion ? fusion.projectileKind : def.projectileKind;
  const n = tuples.length;
  const fires = tupleFires(head);
  // el grupo solo muestra acciones si es MÍO y estoy jugando: espectador/replay
  // pueden agrupar torres ajenas para inspeccionarlas (panel en solo lectura)
  const canAct = !store.spectator && !store.replay && gs.init.players[head[5]]?.id === store.playerId;

  const name = fusion
    ? `${fusion.icon} ${fusion.name}`
    : spec >= 0
      ? `${TOWER_ICONS[type]} ${def.specs[spec].name}`
      : `${TOWER_ICONS[type]} ${def.name}`;
  const levelTag =
    level >= 5
      ? `${fusion ? '⚗' : '★★'} Nv. ${level}` // F9a · veteranía
      : fusion
        ? '⚗ Fusión'
        : level >= 4
          ? '★★ Rango II'
          : spec >= 0
            ? '★ Élite'
            : `Nv. ${level}${level >= 3 ? ' (máx)' : ''}`;

  // agregados volátiles del grupo (cambian cada tick: van por data-lv, no al html)
  const live: Record<string, string> = {
    kills: String(tuples.reduce((acc, t) => acc + t[7], 0)),
    damage: tuples.reduce((acc, t) => acc + t[8], 0).toLocaleString(),
  };
  const statLines = [
    `Grupo de <b>${n}</b> torres idénticas (doble click)`,
    'Bajas: <b data-lv="kills"></b> · Daño total: <b data-lv="damage"></b>',
  ];
  // F5.1 · misma línea de tipo de ataque que el panel individual (bajo el nombre),
  // solo si el grupo DISPARA (auras/economía no entran en la matriz).
  if (fires) statLines.unshift(attackMatrixLine({ type, fusion: head[13] ?? -1 }));

  // ⬆ Mejorar todas: coste TOTAL real, sumado por torre (oro Y madera — p. ej. el
  // Rango II cuesta ambas). El grupo nace idéntico, así que el unitario es uniforme;
  // si una mejora parcial lo mezcló, la suma por torre sigue siendo exacta.
  let upBtn = '';
  if (canAct) {
    let totalGold = 0;
    let totalWood = 0;
    let count = 0;
    let minGold = Infinity;
    let minWood = Infinity;
    for (const t of tuples) {
      const cost = premoveUpgradeCost(snap, t[0]);
      if (!cost) continue;
      totalGold += cost.gold;
      totalWood += cost.wood;
      count += 1;
      if (cost.gold < minGold) {
        minGold = cost.gold;
        minWood = cost.wood;
      }
    }
    if (count > 0) {
      // desactivado solo si no alcanza NI para una (si alcanza para algunas,
      // el click mejora esas y el toast resume "Mejoradas X/N")
      const affordOne = myGold(gs) >= minGold && myWood(gs) >= minWood;
      const woodTxt = totalWood > 0 ? ` · 🪵${totalWood}` : '';
      upBtn = `<div class="prow"><button id="gpanel-upgrade" class="btn primary"${affordOne ? '' : ' disabled'}>⬆ Mejorar todas (${count}) 🪙${totalGold}${woodTxt}</button></div>`;
    } else if (!fusion && spec < 0 && level >= 3 && !def.onPathOnly && !def.detects) {
      statLines.push('<span class="hint">Al máximo: especialízalas de una en una (la rama se elige por torre)</span>');
    }
  }

  // ⏹/▶ + 🎯, solo si el grupo es MÍO y DISPARA (auras/economía no se detienen ni apuntan)
  let controls = '';
  if (canAct && fires) {
    const anyHalted = tuples.some((t) => (t[17] ?? 0) === 1);
    const anyFocus = tuples.some((t) => (t[18] ?? 0) > 0);
    const armed = gs.focusArmed;
    controls = `
      <div class="prow">
        <button id="panel-halt" class="btn ghost">${anyHalted ? '▶ Reanudar todas' : '⏹ Detener todas'}</button>
        <button id="panel-focus" class="btn ghost${armed ? ' armed' : ''}">${armed ? '🎯 Toca un enemigo…' : '🎯 Atacar objetivo…'}</button>
      </div>
      ${anyFocus ? '<div class="focus-line">🎯 Objetivo fijado <button id="panel-unfocus" class="btn small ghost">✕ automático</button></div>' : ''}`;
  }

  const html = `
    <h3><span>${n}× ${name}</span><span class="lvl">${levelTag}</span><button id="panel-close" aria-label="Cerrar">✕</button></h3>
    <div class="pstats">${statLines.join('<br>')}</div>
    ${upBtn}
    ${controls}
    ${canAct && fires ? targetModesHtml(projKind, lvl, modeIdx4(tuples)) : ''}
    ${canAct ? '<p class="hint" style="padding:4px 4px 0">💸 Vender no está disponible en grupo: véndelas de una en una</p>' : ''}
  `;
  return { html, live };
}

// modo de objetivo del grupo: el común si TODAS coinciden; −1 (ninguno resaltado)
// si está mezclado — pulsar uno lo unifica.
function modeIdx4(tuples: SnapTower[]): number {
  const first = tuples[0][6];
  return tuples.every((t) => t[6] === first) ? first : -1;
}

// panel clásico de UNA torre: html + valores volátiles. null = ya no existe.
function buildTowerPanel(gs: GameStore, selectedId: number): { html: string; live: Record<string, string> } | null {
  const data = gs.latest!.towers.find((t) => t[0] === selectedId);
  if (!data) return null;
  const [id, typeIdx, , , level, ownerIdx, modeIdx, kills, damage] = data;
  const snap = gs.latest!;
  const spec = data[9] ?? -1;
  const stunned = data[10] ?? 0; // F6.2 · aturdida: no dispara (manda sobre el cooldown)
  const charges = data[11] ?? 0;
  const cdTicks = data[16] ?? 0; // F6.2 · ticks hasta el próximo disparo (0 = lista)
  const halted = data[17] ?? 0; // Lote 4 · detenida por su dueño (⏸)
  const focusId = data[18] ?? 0; // Lote 4 · enemigo enfocado (0 = automático)
  // F4.3: índice de fusión e inversión total (para el valor de venta de fusiones)
  const fusionIdx = data[13] ?? -1;
  const invested = data[14] ?? 0;
  const fusion = fusionByIndex(fusionIdx);
  const type = TOWER_ORDER[typeIdx];
  const def = TOWERS[type];
  const specialized = spec >= 0;
  const isRank2 = level >= 4;
  // F9a (v19) · statsOf es fusion-aware Y veteranía-aware (niveles 5→10):
  // el panel muestra los stats REALES con los +8%/+4% compuestos aplicados.
  const lvl = statsOf({ type, level, spec, fusion: fusionIdx });
  const projKind = fusion ? fusion.projectileKind : def.projectileKind;
  const next = !fusion && !specialized && level < 3 ? def.levels[level] : null;
  const owner = gs.init.players[ownerIdx];
  // espectador y replay NUNCA actúan: en la replay de tu propia partida tu id SÍ
  // coincide con un slot — sin este gate saldrían botones sobre una red muerta.
  const isMine = !store.spectator && !store.replay && owner?.id === store.playerId;
  const gold = myGold(gs);
  const wood = myWood(gs);
  // F9a · el `invested` real del snapshot vale para TODO (fusiones, veteranía,
  // barril con precio escalado…): es el oro que de verdad entró en la torre.
  const sellValue = Math.floor(invested * SELL_REFUND);
  const canSpecialize = !fusion && level >= 3 && !specialized && !def.onPathOnly && !def.detects;
  // ¿puede subir al Rango II? torre especializada, aún en nivel 3, cuya spec tenga rank2
  const canRank2 = !fusion && specialized && level === 3 && hasRank2(type, spec);
  const r2cost = canRank2 ? rank2Cost(type, spec) : null;
  // F9a (v19) · ¿puede comprar su SIGUIENTE nivel de veteranía (5→10)? La misma
  // función que valida el server (cúspide, tope del clásico, torres que disparan).
  const eliteNext = nextEliteLevelCost({ type, level, spec, fusion: fusionIdx }, gs.init.mode);

  // aura de Estandarte activa SOBRE esta torre → el panel muestra stats efectivos
  const auraBuff = computeBannerAuras(snap).get(id);
  const statLines = statBlock(lvl, next, auraBuff);
  // F5.1 · línea de tipo de ataque + fuerte/débil vs (bajo el nombre): solo para
  // torres que hacen daño directo (las de apoyo/economía no entran en la matriz).
  if (towerAttacks(lvl, def)) statLines.unshift(attackMatrixLine({ type, fusion: fusionIdx }));
  // F9a (v19) · Poder Vital: indicador ENCENDIDO/APAGADO según las vidas del equipo
  // (se refresca con el panel; el umbral y el estado salen del snapshot — honesto).
  if ((lvl.vitalPower ?? 0) > 0) {
    const vitalOn = snap.lives >= VITAL_LIVES_MIN;
    statLines.unshift(
      vitalOn
        ? `<span style="color:#81c784">⚡ Poder Vital <b>ACTIVO</b>: +${Math.round((lvl.vitalPower ?? 0) * 100)}% de daño (vidas ${snap.lives} ≥ ${VITAL_LIVES_MIN})</span>`
        : `<span style="color:#ef5350">💤 Poder Vital <b>apagado</b>: vidas ${snap.lives} &lt; ${VITAL_LIVES_MIN}</span>`,
    );
  }
  // F9a (v19) · el Estandarte del Vencedor sobre ESTA torre: crítico + certeza
  if (auraBuff && auraBuff.crit > 0) {
    statLines.push(
      `<span style="color:#ffd700">👑 Bajo el Vencedor: +${Math.round(auraBuff.crit * 100)}% de CRÍTICO (×${CRIT_MULT}) y CERTEZA (nada esquiva)</span>`,
    );
  }
  // el propio Vencedor: describe su aura (no dispara, no tiene línea de matriz)
  if ((lvl.auraCrit ?? 0) > 0) {
    statLines.push(
      `Aura de gloria: <b>+${Math.round((lvl.auraCrit ?? 0) * 100)}% de crítico</b> (golpe ×${CRIT_MULT}) y <b>Certeza</b> para las torres en rango`,
    );
  }
  // F6.2 · contador de PRÓXIMO ATAQUE, solo para torres que disparan (las de apoyo
  // y las de camino no lo muestran). Va en un span con id estable para poder
  // refrescarlo en CADA tick desde onTick (a 15/s) sin re-renderizar el panel
  // entero (que solo se rehace 4/s). Ver la actualización directa en onTick.
  if (towerAttacks(lvl, def)) {
    statLines.push(`Próximo disparo: <span id="panel-cd" class="pcd">${cooldownText(stunned, cdTicks, halted)}</span>`);
  }
  // Valores VOLÁTILES (cambian cada tick en combate: bajas/daño/cargas/oro…):
  // van en spans estables `data-lv` y se actualizan por textContent, FUERA del
  // dirty-check estructural. Si entraran al innerHTML, el panel se reescribiría
  // 4 veces por segundo en pleno combate y se tragaría los toques.
  const live: Record<string, string> = {};
  const combatLine = 'Bajas: <b data-lv="kills"></b> · Daño total: <b data-lv="damage"></b>';
  live.kills = String(kills);
  live.damage = damage.toLocaleString();
  // Estandarte (y fusiones con aura; F9a: también el Vencedor): torres reforzadas
  if (lvl.auraDamage !== undefined || lvl.auraHaste !== undefined || lvl.auraCrit !== undefined) {
    const n = countBannerTargets(snap, id);
    live.targets = `${n} ${n === 1 ? 'torre' : 'torres'}`;
    statLines.push('Reforzando <b data-lv="targets"></b>');
    // el Señor de la Guerra además dispara: muestra también su historial de combate
    if (lvl.alsoFires) statLines.push(combatLine);
  } else if (lvl.auraBounty !== undefined && lvl.auraBounty > 0) {
    // Alquimista: el oro EXTRA acumulado demuestra si su posición está pagando
    // (las bajas deben MORIR dentro de su anillo verde)
    const goldGen = data[15] ?? 0;
    live.goldgen = `🪙${goldGen.toLocaleString()}`;
    statLines.push('Oro extra generado: <b data-lv="goldgen"></b>');
    if (goldGen === 0) statLines.push('<span class="hint">Aún nada: los enemigos deben MORIR dentro de su anillo</span>');
  } else if (def.detects) {
    // Sentry (v17): no acumula bajas/daño; explica su función, su radio y su TIEMPO
    // RESTANTE (temporal). El countdown va en un span estable, refrescado cada tick
    // desde onTick (como el de cadencia), sin re-renderizar el panel.
    statLines.push('👁 Revela a los monstruos invisibles (aéreos y terrestres) dentro de su radio.');
    const expiresTick = data[19] ?? 0;
    statLines.push(
      `Tiempo restante: <span id="panel-expiry" class="pcd">${expiryText(expiresTick, latestSnapTick(gs))}</span>`,
    );
  } else if (def.onPathOnly) {
    if (def.detonates) {
      // Barril explosivo: se consume al detonar (no tiene cargas que contar)
      statLines.push('💥 Detona <b>una sola vez</b> al ser pisado: <b>borra la morralla</b> terrestre del área — con TOPE de daño: tanques, élites gordos, campeones y jefes <b>sobreviven</b>');
    } else {
      // Trampa de púas: cargas restantes (no acumula kills/daño clásicos)
      live.charges = String(charges);
      statLines.push('Cargas: <b data-lv="charges"></b>');
    }
    statLines.push(combatLine);
  } else {
    statLines.push(combatLine);
  }
  // F4.4 · descubribilidad de las fusiones: toda torre con receta muestra con qué
  // se combina (y qué sale), aunque aún no haya vecina candidata.
  if (!fusion && !def.onPathOnly) {
    const recipes = FUSION_ORDER.map((fid) => FUSIONS[fid]).filter((f) => f.ingredients.includes(type));
    if (recipes.length > 0) {
      const partners = recipes
        .map((f) => {
          const other = f.ingredients[0] === type ? f.ingredients[1] : f.ingredients[0];
          return `${TOWER_ICONS[other]} ${TOWERS[other].name} → <b>${f.icon} ${f.name}</b>`;
        })
        .join(' · ');
      statLines.push(`⚗ Se fusiona con: ${partners} <span class="fuse-req">(ambas ★ especializadas y pegadas)</span>`);
    }
  }
  statLines.push(`Dueño: <b style="color:${owner?.color}">${escapeHtml(owner?.name ?? '?')}</b>`);

  // cabecera: nombre (fusión > especialización > tipo) y nivel/estrella
  const title = fusion
    ? `${fusion.icon} ${fusion.name}`
    : specialized
      ? `${TOWER_ICONS[type]} ${def.specs[spec].name}`
      : `${TOWER_ICONS[type]} ${def.name}`;
  // F9a (v19) · nivel 5+ = VETERANÍA (post-élite): la etiqueta muestra el nivel real
  const levelTag =
    level >= 5
      ? `${fusion ? '⚗' : '★★'} Nv. ${level}`
      : fusion
        ? '⚗ Fusión'
        : isRank2
          ? '★★ Rango II'
          : specialized
            ? '★ Élite'
            : `Nv. ${level}${level >= 3 ? ' (máx)' : ''}`;

  // F4.3 · candidatos de fusión: la torre seleccionada está especializada y tiene
  // vecinas (Chebyshev 1) especializadas del mismo dueño con receta. Un botón por
  // receta (si hay dos vecinas del mismo tipo se usa la primera del snapshot).
  // La fusión SE QUEDA en la celda de la torre seleccionada; para elegir la otra
  // celda, selecciona la otra torre y fusiona desde su panel.
  let fuseHtml = '';
  if (isMine && !fusion && specialized) {
    const seen = new Set<string>();
    const btns: string[] = [];
    for (const other of snap.towers) {
      if (other[0] === id) continue;
      if ((other[9] ?? -1) < 0 || (other[13] ?? -1) >= 0) continue; // especializada y sin fusionar
      if (other[5] !== ownerIdx) continue; // mismo dueño
      if (Math.max(Math.abs(other[2] - data[2]), Math.abs(other[3] - data[3])) !== 1) continue; // adyacente
      const recipe = findFusion(type, TOWER_ORDER[other[1]]);
      if (!recipe || seen.has(recipe.id)) continue;
      seen.add(recipe.id);
      btns.push(`
        <button class="spec-btn fuse-btn" data-other="${other[0]}">
          <span class="spec-name">⚗ Fusionar → ${recipe.icon} ${recipe.name}</span>
          <span class="spec-desc">${recipe.desc} Consume ambas torres; la fusión se queda AQUÍ.</span>
        </button>`);
    }
    if (btns.length > 0) {
      fuseHtml = `<div class="spec-title">Fusión</div><div class="spec-choices">${btns.join('')}</div>`;
    }
  }

  // Lote 4 · fila de CONTROL (⏹/▶ stop + 🎯 focus) para torres propias que
  // DISPARAN, con el estado "Atacando a…" y su ✕ (vuelta al automático). Las
  // torres de apoyo/economía no la muestran (no disparan; la sim lo rechaza).
  let controlRow = '';
  if (isMine && tupleFires(data)) {
    let focusLine = '';
    if (focusId > 0) {
      const fe = snap.enemies.find((e) => e[0] === focusId);
      const ficon = fe ? ENEMY_ICONS[ENEMY_ORDER[fe[1]]] : '';
      const fname = fe ? ENEMIES[ENEMY_ORDER[fe[1]]].name : 'objetivo fuera de vista';
      focusLine = `<div class="focus-line">🎯 Atacando: ${ficon} ${fname} <button id="panel-unfocus" class="btn small ghost">✕ automático</button></div>`;
    }
    const armed = gs.focusArmed;
    controlRow = `
      <div class="prow">
        <button id="panel-halt" class="btn ghost">${halted ? `▶ Reanudar <span class="khint">[${keyLabel('stop')}]</span>` : `⏹ Detener <span class="khint">[${keyLabel('stop')}]</span>`}</button>
        <button id="panel-focus" class="btn ghost${armed ? ' armed' : ''}">${armed ? '🎯 Toca un enemigo…' : `🎯 Objetivo <span class="khint">[${keyLabel('focus')}]</span>`}</button>
      </div>${focusLine}`;
  }

  // F9a (v19) · botón de VETERANÍA (niveles 5→10): compartido por fusiones y
  // Rango II. El paso al nivel 10 cuesta como una fusión; en clásico es la cima
  // (nivel 10); en infinito/horda sigue abierto con curva más dura.
  const eliteBtn = (): string => {
    if (!eliteNext) {
      // en la cima del clásico (o torre que no gana nada): botón informativo
      return level >= 5
        ? `<button id="panel-upgrade" class="btn primary" disabled>Nv. ${level} — la cima</button>`
        : '';
    }
    const targetLevel = level < 4 ? 5 : level + 1;
    const afford = gold >= eliteNext.gold && wood >= eliteNext.wood;
    return `<button id="panel-upgrade" class="btn primary"${afford ? '' : ' disabled'}>⬆ Veteranía Nv. ${targetLevel} (+8%⚔ +4%⏱) 🪙${eliteNext.gold} · 🪵${eliteNext.wood}</button>`;
  };

  // acciones del dueño
  let actions = '';
  if (isMine) {
    if (fusion) {
      // una fusión no se especializa; desde F9a SÍ mejora: niveles de veteranía
      actions = `
        <p class="spec-desc" style="padding:0 4px 6px">${fusion.desc}</p>
        <div class="prow">${eliteBtn()}<button id="panel-sell" class="btn ghost">💸 Vender ${sellValue}</button></div>
        ${targetModesHtml(projKind, lvl, modeIdx)}
        ${controlRow}`;
    } else if (def.onPathOnly) {
      // Trampa/Barril: no se mejoran ni especializan; solo se pueden vender.
      actions = `<div class="prow"><button id="panel-sell" class="btn ghost">💸 Vender ${sellValue}</button></div>`;
    } else if (def.detects) {
      // Sentry (v17): MEJORABLE (más radio) pero sin especialización, sin fusión y sin
      // premove. Mejorar además RENUEVA la duración al total del nuevo nivel. Botón
      // manual (id panel-upgrade, cableado como el resto) + venta.
      let upBtn: string;
      if (!next) {
        upBtn = '<button id="panel-upgrade" class="btn primary" disabled>Radio máximo</button>';
      } else if (gold >= next.cost) {
        upBtn = `<button id="panel-upgrade" class="btn primary">⬆ Más radio 🪙${next.cost}</button>`;
      } else {
        upBtn = `<button id="panel-upgrade" class="btn primary" disabled>⬆ Más radio 🪙${next.cost}</button>`;
      }
      actions = `
        <p class="hint" style="padding:0 4px 4px">Mejorar sube el radio de detección y RENUEVA la duración al total del nuevo nivel.</p>
        <div class="prow">
          ${upBtn}
          <button id="panel-sell" class="btn ghost">💸 Vender ${sellValue}</button>
        </div>`;
    } else if (canSpecialize) {
      // descubrimiento contextual: si lo que te frena es la madera, el panel te
      // manda directo al mercado (el mejor momento para aprender que existe)
      const woodHint = wood < WOOD_COST_SPEC
        ? '<p class="hint" style="padding:2px 4px 0">💡 Te falta madera: toca el chip 🪵 de arriba para comprarla o mejorar a tu orco</p>'
        : '';
      actions = `
        <div class="spec-title">Elige especialización <span class="spec-woodreq">(cuesta 🪵 madera además del oro)</span></div>${woodHint}
        <div class="spec-choices">
          ${def.specs
            .map(
              // F9a · las specs nuevas (índice 2) pueden costar MÁS madera (woodCost)
              (sp, i) => {
                const wc = sp.woodCost ?? WOOD_COST_SPEC;
                return `
            <button class="spec-btn" data-spec="${i}" ${gold < sp.cost || wood < wc ? 'disabled' : ''}>
              <span class="spec-name">${sp.name}</span>
              <span class="spec-desc">${sp.desc}</span>
              <span class="spec-cost">🪙${sp.cost}<br>🪵${wc}</span>
            </button>`;
              },
            )
            .join('')}
        </div>
        <div class="prow"><button id="panel-sell" class="btn ghost">💸 Vender ${sellValue}</button></div>
        ${controlRow}`;
    } else if (canRank2 && r2cost !== null) {
      // Rango II: mejora identidad de la especialización (reutiliza el comando upgrade)
      const r2desc = def.specs[spec].rank2?.desc ?? 'Mejora de Rango II';
      const affordR2 = gold >= r2cost && wood >= WOOD_COST_RANK2;
      const r2btn = affordR2
        ? `<button id="panel-upgrade" class="btn primary">★★ Rango II 🪙${r2cost} · 🪵${WOOD_COST_RANK2}</button>`
        : premoveUpgradeBtn(id, `⏳ Premover Rango II ★★ 🪙${r2cost} · 🪵${WOOD_COST_RANK2}`);
      actions = `
        <div class="spec-title">Rango II</div>
        <p class="spec-desc" style="padding:0 4px 6px">${escapeHtml(r2desc)}</p>
        ${fuseHtml}
        <div class="prow">
          ${r2btn}
          <button id="panel-sell" class="btn ghost">💸 ${sellValue}</button>
        </div>
        ${targetModesHtml(projKind, lvl, modeIdx)}
        ${controlRow}`;
    } else {
      const nextCost = next?.cost ?? null;
      const maxedLabel = isRank2 ? 'Máximo (Rango II)' : 'Máximo';
      let upBtn: string;
      if (isRank2) {
        // F9a (v19) · Rango II alcanzado: la ruta de mejora continúa por la
        // VETERANÍA (niveles 5→10) — o muestra la cima si ya no puede más.
        upBtn = eliteBtn() || `<button id="panel-upgrade" class="btn primary" disabled>${maxedLabel}</button>`;
      } else if (nextCost === null) {
        upBtn = `<button id="panel-upgrade" class="btn primary" disabled>${maxedLabel}</button>`;
      } else if (gold >= nextCost) {
        upBtn = `<button id="panel-upgrade" class="btn primary">⬆ Mejorar 🪙${nextCost}</button>`;
      } else {
        upBtn = premoveUpgradeBtn(id, `⏳ Premover mejora 🪙${nextCost}`);
      }
      actions = `
        ${fuseHtml}
        <div class="prow">
          ${upBtn}
          <button id="panel-sell" class="btn ghost">💸 ${sellValue}</button>
        </div>
        ${targetModesHtml(projKind, lvl, modeIdx)}
        ${controlRow}`;
    }
  } else {
    actions = `<p class="hint">Torre de ${escapeHtml(owner?.name ?? 'otro jugador')}</p>`;
  }

  const html = `
    <h3><span>${title}</span><span class="lvl">${levelTag}</span><button id="panel-close" aria-label="Cerrar">✕</button></h3>
    <div class="pstats">${statLines.join('<br>')}</div>
    ${actions}
  `;
  return { html, live };
}

// ---------- barra superior y jugadores ----------

let lastPanelSync = 0;

// F5.2 · métricas en vivo (minimalistas): DPS propio con ventana móvil de 3 s +
// oro ganado y vidas perdidas de la OLEADA actual (se reinician al empezar otra).
const dpsWindow: { t: number; dmg: number }[] = [];
let liveWave = -1;
let liveGoldBase = 0;
let liveLivesBase = 0;

function liveStatsHtml(snap: Snap): string {
  const me = snap.players.find((p) => p.id === store.playerId);
  if (!me) return ''; // espectador: sin métricas propias
  const now = performance.now();
  dpsWindow.push({ t: now, dmg: me.damage });
  while (dpsWindow.length > 1 && now - dpsWindow[0].t > 3000) dpsWindow.shift();
  if (snap.wave !== liveWave) {
    liveWave = snap.wave;
    liveGoldBase = me.goldEarned;
    liveLivesBase = snap.lives;
  }
  const span = (now - dpsWindow[0].t) / 1000;
  const dps = span > 0.4 ? Math.max(0, Math.round((me.damage - dpsWindow[0].dmg) / span)) : 0;
  const goldWave = me.goldEarned - liveGoldBase;
  const livesLost = Math.max(0, liveLivesBase - snap.lives);
  const parts = [`⚔️ ${dps}/s`, `🪙 +${goldWave}`];
  if (livesLost > 0) parts.push(`<span class="live-bad">💔 −${livesLost}</span>`);
  return `<div class="sb-live" title="Tu daño por segundo · oro ganado esta oleada · vidas perdidas esta oleada">${parts.join(' · ')}</div>`;
}

export function onTick(snap: Snap): void {
  const gs = store.game;
  if (!gs) return;

  const horde = gs.init.mode === 'horde';
  const lives = $('hud-lives');
  const aliveChip = $('hud-alive');
  // MODO TURBO ⚡ (issue #14): distintivo junto al contador de oleada mientras dura
  // una partida turbo (viaja en el GameInit, no cambia entre ticks)
  $('hud-turbo').hidden = !gs.init.turbo;

  if (horde) {
    // En horda no hay vidas: se pierde por SATURACIÓN. El chip 👾 pasa a ser la
    // "vida" — enemigos vivos / cap. Amarillo desde 70%, rojo desde 90% (pulso).
    // F9a (v19) · Reparar suma aforo: cap efectivo = HORDE_CAP + repairsBought.
    lives.hidden = true;
    const cap = (HORDE_CAP[gs.init.difficulty] ?? HORDE_CAP.normal) + (snap.repairsBought ?? 0);
    const alive = snap.enemies.length;
    aliveChip.hidden = false;
    aliveChip.textContent = `👾 ${alive}/${cap}`;
    const frac = alive / cap;
    aliveChip.classList.toggle('warn', frac >= 0.7 && frac < 0.9);
    aliveChip.classList.toggle('danger', frac >= 0.9);
  } else {
    lives.hidden = false;
    lives.textContent = `❤️ ${snap.lives}`;
    lives.classList.toggle('danger', snap.lives <= 5);
    aliveChip.classList.remove('warn', 'danger');
    // enemigos vivos durante la oleada
    if (snap.active && snap.enemies.length > 0) {
      aliveChip.hidden = false;
      aliveChip.textContent = `👾 ${snap.enemies.length}`;
    } else {
      aliveChip.hidden = true;
    }
  }

  // la etiqueta lleva sus dos formas (palabra en escritorio, 🌊 en móvil) y el
  // CSS muestra una u otra según el ancho de pantalla
  const waveLabel = '<span class="wv-word">Oleada</span><span class="wv-icon" aria-hidden="true">🌊</span>';
  $('hud-wave').innerHTML =
    snap.totalWaves > 0 ? `${waveLabel} ${snap.wave}/${snap.totalWaves}` : `${waveLabel} ${snap.wave} ∞`;
  $('hud-gold').textContent = `🪙 ${myGold(gs)}`;
  $('hud-wood').textContent = `🪵 ${myWood(gs)}`;

  // botón de llamar oleada, con el bonus de oro que ganarías ahora mismo
  // (los espectadores no llaman oleadas: nunca lo ven)
  const btn = $('btn-callwave');
  if (!store.spectator && !snap.active && snap.over === 0) {
    btn.hidden = false;
    const bonus = snap.interludeSec * CALL_WAVE_GOLD_PER_SEC;
    // el bonus va en su propio span: en móvil se oculta por CSS para que el
    // botón no estruje la fila de stats (dejaría el chip 🪵 fuera de pantalla).
    // Solo reescribir si CAMBIÓ (cambia 1 vez/s, no 15): reescribir cada tick
    // destruía el span bajo el dedo y el click en «¡Ya!» se perdía a veces.
    const timerEl = $('callwave-timer');
    const timerHtml = `${snap.interludeSec}s <span class="cw-bonus">+🪙${bonus}</span>`;
    if (timerEl.dataset.h !== timerHtml) {
      timerEl.dataset.h = timerHtml;
      timerEl.innerHTML = timerHtml;
    }
  } else {
    btn.hidden = true;
  }

  // (los chips de jugadores de la esquina fueron REEMPLAZADOS por la tabla 📊,
  //  que ahora vive fija en esa esquina; ver renderScoreboard/syncScoreboard)

  // vista previa de la próxima oleada
  const preview = $('hud-preview');
  if (!snap.active && snap.nextWave.length > 0) {
    preview.hidden = false;
    // etiquetas de tipo (telegrafía Green TD): 🛡 inmune · ⭐ bendecida · 🦅 aérea · ☠ jefe
    const tags: string[] = [];
    if (snap.nextImmune) tags.push('<span class="wave-tag immune" title="Inmune a la magia: solo daño físico">🛡 inmune</span>');
    if (snap.nextBlessed) tags.push('<span class="wave-tag blessed" title="¡Oleada bendecida: doble botín!">⭐ bendecida</span>');
    if (snap.nextInvisible) tags.push('<span class="wave-tag invisible" title="Oleada INVISIBLE: sin un Sentry (🛒 Tienda) no puedes ver ni apuntar a los enemigos">👁 invisible</span>');
    // F9a (v19) · CAMPEONES 👑: pocos mini-jefes gordos y lentos, fuga carísima
    if (snap.nextChampion) tags.push('<span class="wave-tag boss" title="CAMPEONES: 3-6 mini-jefes con muchísima vida, lentos, botín ×5 — si uno escapa cuesta MUCHAS vidas">👑 campeones</span>');
    if (snap.nextBossType >= 0) {
      const bossType = ENEMY_ORDER[snap.nextBossType];
      const bossFlying = ENEMIES[bossType]?.flying;
      // F9a (v19) · afijo del jefe telegrafiado: "☠ Gólem · Adaptativo 🧬"
      const affix = snap.nextBossAffix >= 0 ? AFFIXES[AFFIX_ORDER[snap.nextBossAffix]] : null;
      const bossName = ENEMIES[bossType]?.name ?? 'jefe';
      const label = affix ? `${bossName} · ${affix.name} ${affix.icon}` : bossName;
      const title = affix ? `${bossName} — ${affix.name}: ${affix.desc}` : bossName;
      tags.push(`<span class="wave-tag boss" title="${title}">${bossFlying ? '🦅' : '☠'} ${label}</span>`);
    } else if (snap.nextFlying) {
      tags.push('<span class="wave-tag flying" title="Domina lo aéreo: necesitas anti-aire">🦅 aérea</span>');
    }
    $('hud-preview-tags').innerHTML = tags.join('');
    $('hud-preview-list').innerHTML = snap.nextWave
      .map(([typeIdx, count]) => {
        const type = ENEMY_ORDER[typeIdx];
        return `<span class="preview-chip" title="${ENEMIES[type].name}">${ENEMY_ICONS[type]}×${count}</span>`;
      })
      .join('');
  } else {
    preview.hidden = true;
  }

  syncTowerBar();
  syncMarket(snap);
  processPremoves(snap); // dispara los premovimientos cuyo coste ya se alcanzó

  // refrescar el panel de torre o de GRUPO (máx 4 veces por segundo para no perder clicks)
  const now = performance.now();
  if ((gs.selection?.kind === 'tower' || gs.selection?.kind === 'towers') && now - lastPanelSync > 250) {
    lastPanelSync = now;
    refreshPanel();
  }

  // tabla de jugadores en vivo (F7.1): refresca daño/bajas mientras esté abierta
  syncScoreboard(now);
  // tienda (Lote 3): refresca costes/estado de compra mientras esté abierta
  syncShop(now);

  // F6.2 · el contador de próximo ataque baja FLUIDO: se refresca en CADA tick
  // (15/s), no solo cuando el panel se rehace (4/s). Solo tocamos el span si
  // existe —refreshPanel lo crea únicamente para torres que disparan— y por
  // textContent, así que no re-renderizamos nada ni robamos clicks (mismo criterio
  // que los volátiles data-lv). Sin rAF ni timers nuevos.
  const sel = gs.selection;
  if (sel?.kind === 'tower') {
    const t = snap.towers.find((tt) => tt[0] === sel.id);
    const cdEl = document.getElementById('panel-cd');
    if (cdEl && t) {
      const txt = cooldownText(t[10] ?? 0, t[16] ?? 0, t[17] ?? 0);
      if (cdEl.textContent !== txt) cdEl.textContent = txt;
    }
    // v17 · countdown ⏳ del Sentry: baja fluido (15/s) como el de cadencia, por
    // textContent sobre el span estable (no re-renderiza ni roba clicks).
    const expEl = document.getElementById('panel-expiry');
    if (expEl && t) {
      const txt = expiryText(t[19] ?? 0, latestSnapTick(gs));
      if (expEl.textContent !== txt) expEl.textContent = txt;
    }
  }
}

// ---------- mercado global de madera (F5.4) ----------

// Refresca el panel del mercado con el precio del snapshot y el estado propio
// (costes exactos de la próxima operación; botones desactivados si no alcanza).
function syncMarket(snap: Snap): void {
  const panel = $('market-panel');
  if (panel.hidden) return;
  const gs = store.game;
  if (!gs) return;
  const price = snap.woodPrice;
  // no tocar el DOM si el texto no cambió (se llama en cada tick con el panel abierto)
  const setText = (el: HTMLElement, v: string) => {
    if (el.textContent !== v) el.textContent = v;
  };
  setText($('market-price'), price.toFixed(2));
  const cost = Math.ceil(price * WOOD_LOT);
  const gain = Math.floor(price * WOOD_SELL_SPREAD * WOOD_LOT);
  const buy = $<HTMLButtonElement>('market-buy');
  const sell = $<HTMLButtonElement>('market-sell');
  // el atajo va en el propio botón: es donde el jugador mira al operar (keymap)
  setText(buy, `[${keyLabel('market_buy')}] Comprar ${WOOD_LOT} 🪵 — 🪙${cost}`);
  setText(sell, `[${keyLabel('market_sell')}] Vender ${WOOD_LOT} 🪵 — +🪙${gain}`);
  buy.disabled = myGold(gs) < cost;
  sell.disabled = myWood(gs) < WOOD_LOT;

  // mejora del orco (F5.5): nivel/tala propios + coste del siguiente nivel
  const me = snap.players.find((p) => p.id === store.playerId);
  const lvl = me?.orcLevel ?? 1;
  setText($('orc-level'), `nv ${lvl}`);
  setText($('orc-rate'), `+${ORC_RATES[Math.min(lvl, ORC_RATES.length) - 1]}🪵/s`);
  const orcBtn = $<HTMLButtonElement>('orc-upgrade');
  if (lvl >= ORC_RATES.length) {
    setText(orcBtn, 'Al máximo 🏆');
    orcBtn.disabled = true;
  } else {
    const upCost = ORC_UPGRADE_COSTS[lvl - 1];
    setText(orcBtn, `Mejorar (+${ORC_RATES[lvl]}🪵/s) — 🪙${upCost}`);
    orcBtn.disabled = myGold(gs) < upCost;
  }
}

// Cablea el mercado: el chip 🪵 lo abre/cierra; clic fuera lo cierra.
export function initMarket(): void {
  const panel = $('market-panel');
  $('hud-wood').addEventListener('click', (e) => {
    e.stopPropagation();
    if (store.spectator || store.replay) return; // mirones: sin trading
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      // vive en la misma esquina que 📊 y 🛒: abrir el mercado cierra los otros
      $('scoreboard-panel').hidden = true;
      $('shop-panel').hidden = true;
      // descubierto: apagar la llamada de atención para siempre
      localStorage.setItem('td_market_seen', '1');
      $('hud-wood').classList.remove('attn');
      if (store.game?.latest) syncMarket(store.game.latest);
    }
  });
  panel.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => {
    if (!panel.hidden) panel.hidden = true;
  });
  // MANTENER PULSADO repite la operación (~4/s): comprar 50 de madera ya no son
  // 5 toques — dejas el dedo puesto. El primer disparo es inmediato (= un click).
  const repeatOnHold = (btn: HTMLButtonElement, fire: () => void): void => {
    let t: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (t) {
        clearInterval(t);
        t = null;
      }
    };
    btn.addEventListener('pointerdown', () => {
      fire();
      stop();
      t = setInterval(() => {
        if (!btn.disabled) fire(); // syncMarket lo desactiva si ya no alcanza
      }, 230);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel'] as const) {
      btn.addEventListener(ev, stop);
    }
  };
  repeatOnHold($<HTMLButtonElement>('market-buy'), () => net.send({ type: 'cmd', cmd: { kind: 'buy_wood' } }));
  repeatOnHold($<HTMLButtonElement>('market-sell'), () => net.send({ type: 'cmd', cmd: { kind: 'sell_wood' } }));
  repeatOnHold($<HTMLButtonElement>('orc-upgrade'), () => net.send({ type: 'cmd', cmd: { kind: 'upgrade_orc' } }));
}

// ---------- tienda de items (Lote 3) ----------
// Panel 🛒 con una rejilla de items. Estructura lista para más items: array de defs.
// Por ahora 1 item: el Sentry (revela invisibles). Comprar = entrar en MODO COLOCACIÓN
// (setPlacing) — el flujo de pago/colocación ya existe vía el comando `place`.

interface ShopItem {
  towerType: TowerTypeId;
  icon: string;
  name: string;
  desc: string;
}

const SHOP_ITEMS: ShopItem[] = [
  {
    towerType: 'sentry',
    icon: '👁',
    name: 'Sentry',
    desc: `Revela monstruos invisibles (terrestres y aéreos) en su radio. Colócalo cubriendo el camino en las oleadas 👁. ⏳ Dura ${SENTRY_DURATION_SEC[0] / 60} min; mejorable: más radio y hasta ${SENTRY_DURATION_SEC[SENTRY_DURATION_SEC.length - 1] / 60} min.`,
  },
];

let lastShopSync = 0;

// Construye la rejilla UNA sola vez (estructura estática) y en cada sync solo
// actualiza clases EN SITIO. Antes reescribía el innerHTML cada 250ms con la
// tienda abierta: el botón se destruía bajo el dedo y el click se perdía (bug
// real reportado: "hay que hacer varios clics para comprar el Sentry").
// F9a (v19) · la tienda gana REPARAR FORTALEZA (solo infinito/horda): compra
// directa (comando `repair`, sin colocación) con precio de EQUIPO escalado que
// viaja en el snapshot (snap.repairCost) — el server valida el precio real.
export function renderShop(): void {
  const gs = store.game;
  if (!gs) return;
  const snap = gs.latest;
  const grid = $('shop-grid');
  const mode = gs.init.mode;
  const wantRepair = true; // disponible en todos los modos
  const wantCount = SHOP_ITEMS.length + (wantRepair ? 1 : 0);
  if (grid.childElementCount !== wantCount) {
    const repairHtml = wantRepair
      ? `<button class="shop-item" data-action="repair">
        <span class="shop-icon">🏰</span>
        <span class="shop-info"><b>Reparar fortaleza</b><span class="shop-desc">${
          mode === 'horde'
            ? 'Refuerza las murallas: +1 de AFORO de saturación. El precio sube ×1.25 con cada compra.'
            : 'Compra vidas en lote: 3→5→7→10 (máx). El precio sube ×1.25 por compra del equipo.'
        }</span></span>
        <span class="shop-cost" data-repair-cost>🪙…</span>
      </button>`
      : '';
    grid.innerHTML =
      SHOP_ITEMS.map((it) => {
        const cost = TOWERS[it.towerType].levels[0].cost;
        return `<button class="shop-item" data-item="${it.towerType}">
        <span class="shop-icon">${it.icon}</span>
        <span class="shop-info"><b>${it.name}</b><span class="shop-desc">${it.desc}</span></span>
        <span class="shop-cost">🪙${cost}</span>
      </button>`;
      }).join('') + repairHtml;
  }
  const gold = myGold(gs);
  for (const el of grid.querySelectorAll<HTMLElement>('[data-item]')) {
    const type = el.dataset.item as TowerTypeId;
    el.classList.toggle('poor', gold < TOWERS[type].levels[0].cost);
    el.classList.toggle('selected', gs.selection?.kind === 'placing' && gs.selection.towerType === type);
  }
  // reparación: precio vivo del snapshot + estado sin oro
  const repairBtn = grid.querySelector<HTMLButtonElement>('[data-action="repair"]');
  if (repairBtn && snap) {
    const cost = snap.repairCost;
    const costEl = repairBtn.querySelector<HTMLElement>('[data-repair-cost]');
    if (costEl) costEl.textContent = `🪙${cost}`;
    repairBtn.classList.toggle('poor', gold < cost);
  }
}

function syncShop(now: number): void {
  if ($('shop-panel').hidden) return;
  if (now - lastShopSync < 250) return;
  lastShopSync = now;
  renderShop();
}

// Constante de compilación inyectada por Vite (vite.config.ts).
declare const __BUILD_VER__: string;

// Muestra la versión de compilación en la esquina inferior izquierda.
// También se llama desde el home.
export function initVersion(): void {
  const el = $('hud-version');
  if (el) {
    el.textContent = typeof __BUILD_VER__ !== 'undefined' ? __BUILD_VER__ : 'dev';
  }
  // También en el home si existe
  const homeEl = document.getElementById('home-version');
  if (homeEl) {
    homeEl.textContent = typeof __BUILD_VER__ !== 'undefined' ? __BUILD_VER__ : 'dev';
  }
}

// Cablea la tienda: 🛒 la abre/cierra; ✕ o un toque fuera la cierran; comprar un
// item entra en modo colocación (como tocar la barra de torres).
export function initShop(): void {
  const panel = $('shop-panel');
  const btn = $('btn-shop');
  const setOpen = (v: boolean): void => {
    panel.hidden = !v;
    btn.setAttribute('aria-expanded', String(v));
    if (v) {
      // vive en la misma esquina que 📊 y 🪵: abrir uno cierra los otros
      $('scoreboard-panel').hidden = true;
      $('market-panel').hidden = true;
      renderShop();
    }
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (store.spectator || store.replay) return; // los mirones no compran
    setOpen(panel.hidden);
  });
  $('shop-close').addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(false);
  });
  // clic dentro no cierra; un toque fuera sí (mismo patrón que mercado/tabla)
  panel.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => {
    if (!panel.hidden) setOpen(false);
  });
  // comprar = armar la colocación del item; el pago se hace al plantar (comando place)
  $('shop-grid').addEventListener('click', (e) => {
    // F9a (v19) · Reparar fortaleza: compra DIRECTA (sin colocación) — manda el
    // comando y el server valida modo/precio/vidas. La tienda queda abierta para
    // encadenar reparaciones (el precio sube solo en el snapshot siguiente).
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action="repair"]');
    if (action) {
      net.send({ type: 'cmd', cmd: { kind: 'repair' } });
      return;
    }
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-item]');
    if (!el) return;
    const type = el.dataset.item as TowerTypeId;
    const cur = store.game?.selection;
    setPlacing(cur?.kind === 'placing' && cur.towerType === type ? null : type);
    setOpen(false);
  });
}

// ---------- tabla de jugadores en vivo (F7.1) ----------
// Los chips de arriba quedan compactos (nombre · oro); el botón 📊 expande esta
// tabla flotante con oro/madera + DAÑO y BAJAS de la partida (reutiliza los stats
// por jugador del snapshot), y el botón 🎁 para REGALAR recursos a un aliado.

let lastScoreboardSync = 0;
let giveTarget: string | null = null; // playerId al que se va a regalar (null = sin formulario)

// daño compacto: 12345 → "12.3k", 999 → "999"
function fmtDmg(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// entero ≥0 y acotado a partir de un valor de input (defensa; el server revalida)
function clampInt(v: string): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 99999);
}

// (re)construye la tabla; se llama en cada snapshot con el panel abierto (throttle
// en onTick). El mini-formulario de regalo vive en otro contenedor, así que
// refrescar la tabla NO pisa lo que el jugador está escribiendo.
// ¿Hay un dedo/botón presionado sobre la tabla? Mientras dure, NO se reescribe la
// estructura (destruiría el 🎁 bajo el dedo — mismo bug de clicks comidos que tenía
// la tienda). Los NÚMEROS se actualizan por textContent, que no destruye nada.
let sbStructure = '';
let sbHeld = false;
let sbHoldWired = false;

export function renderScoreboard(): void {
  const gs = store.game;
  const snap = gs?.latest;
  if (!gs || !snap) return;
  if (!sbHoldWired) {
    sbHoldWired = true;
    $('scoreboard-panel').addEventListener('pointerdown', () => {
      sbHeld = true;
    });
    const release = () => {
      sbHeld = false;
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  }
  const meId = store.playerId;
  const canGive = !store.spectator && !store.replay && snap.players.some((p) => p.id === meId);
  const body = $('scoreboard-body');

  // ESTRUCTURA (roster/nombres/conexión/permisos): solo se reescribe si cambió de
  // verdad, y nunca con un dedo presionado. Antes se reescribía TODO cada 250ms
  // con la tabla abierta y los clicks caían en botones recién destruidos.
  const structure =
    snap.players
      .map((p) => {
        const info = gs.init.players.find((ip) => ip.id === p.id);
        return `${p.id}:${info?.name ?? ''}:${info?.color ?? ''}:${p.connected ? 1 : 0}`;
      })
      .join('|') + `|give:${canGive ? 1 : 0}|me:${meId}`;
  if (structure !== sbStructure) {
    if (sbHeld) return; // reintenta en el próximo sync (250ms)
    sbStructure = structure;
    const rows = snap.players
      .map((p) => {
        const info = gs.init.players.find((ip) => ip.id === p.id);
        const isMe = p.id === meId;
        const name = escapeHtml(info?.name ?? p.id); // nombre de usuario: SIEMPRE escapado
        const give =
          canGive && !isMe
            ? `<button class="btn small ghost sb-give" data-give="${escapeHtml(p.id)}" aria-label="Enviar recursos a ${name}" title="Enviar oro/madera a ${name}">🎁</button>`
            : '';
        return `<tr class="${isMe ? 'sb-me' : ''}${p.connected ? '' : ' offline'}">
        <td class="sb-name"><span class="sb-dot" style="background:${info?.color};color:${info?.color}"></span>${name}</td>
        <td data-sb="gold:${p.id}"></td>
        <td data-sb="wood:${p.id}"></td>
        <td class="sb-dmg" data-sb="dmg:${p.id}"></td>
        <td class="sb-kills" data-sb="kills:${p.id}"></td>
        <td>${give}</td>
      </tr>`;
      })
      .join('');
    body.innerHTML = `<table>
    <thead><tr>
      <th class="sb-name">Jugador</th><th>🪙</th><th>🪵</th>
      <th title="Daño total de la partida">⚔️</th><th title="Bajas totales">💀</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table><div id="sb-live-slot"></div>`;
  }

  // VOLÁTILES (cambian cada tick en combate): por textContent, sin destruir nodos.
  const setCell = (k: string, v: string): void => {
    const el = body.querySelector<HTMLElement>(`[data-sb="${k}"]`);
    if (el && el.textContent !== v) el.textContent = v;
  };
  for (const p of snap.players) {
    setCell(`gold:${p.id}`, `🪙${p.gold}`);
    setCell(`wood:${p.id}`, `🪵${p.wood}`);
    setCell(`dmg:${p.id}`, fmtDmg(p.damage));
    setCell(`kills:${p.id}`, String(p.kills));
  }
  // pie con las métricas en vivo propias (dps · oro de la oleada · vidas): vive en
  // su propio slot — reescribirlo no toca ningún botón.
  const slot = body.querySelector<HTMLElement>('#sb-live-slot');
  const live = liveStatsHtml(snap);
  if (slot && slot.innerHTML !== live) slot.innerHTML = live;
}

// dibuja (o limpia) el mini-formulario de regalo según `giveTarget`. Solo se llama
// al elegir/cambiar de aliado o al enviar/cancelar — nunca en el refresco de la
// tabla, para no perder el foco ni los valores mientras se escribe.
function renderGiveForm(): void {
  const box = $('scoreboard-give');
  const gs = store.game;
  if (!giveTarget || !gs) {
    box.innerHTML = '';
    return;
  }
  const info = gs.init.players.find((ip) => ip.id === giveTarget);
  const name = escapeHtml(info?.name ?? giveTarget);
  box.innerHTML = `
    <div class="sb-give-title">🎁 Enviar a <b>${name}</b></div>
    <div class="sb-give-row">
      <span class="sb-give-lbl">🪙</span>
      <input id="give-gold" type="number" inputmode="numeric" min="0" step="10" value="0" aria-label="Oro a enviar" />
      <button class="btn small ghost sb-quick" data-add-gold="10">+10</button>
      <button class="btn small ghost sb-quick" data-add-gold="50">+50</button>
      <button class="btn small ghost sb-quick" data-add-gold="100">+100</button>
      <button class="btn small ghost sb-quick" data-max-gold="1">Máx</button>
    </div>
    <div class="sb-give-row">
      <span class="sb-give-lbl">🪵</span>
      <input id="give-wood" type="number" inputmode="numeric" min="0" step="5" value="0" aria-label="Madera a enviar" />
      <button class="btn small ghost sb-quick" data-add-wood="5">+5</button>
      <button class="btn small ghost sb-quick" data-add-wood="25">+25</button>
      <button class="btn small ghost sb-quick" data-max-wood="1">Máx</button>
    </div>
    <div class="sb-give-actions">
      <button id="give-send" class="btn small primary">Enviar</button>
      <button id="give-cancel" class="btn small ghost">Cancelar</button>
    </div>`;
}

// valida en cliente (feedback inmediato) y manda el comando; el server revalida.
function submitGive(): void {
  const gs = store.game;
  if (!gs || !giveTarget) return;
  const gEl = document.getElementById('give-gold') as HTMLInputElement | null;
  const wEl = document.getElementById('give-wood') as HTMLInputElement | null;
  const gold = clampInt(gEl?.value ?? '0');
  const wood = clampInt(wEl?.value ?? '0');
  if (gold <= 0 && wood <= 0) {
    toast('Pon una cantidad de 🪙 o 🪵 para enviar');
    return;
  }
  if (gold > myGold(gs) || wood > myWood(gs)) {
    toast('No te alcanzan los recursos para enviar');
    return;
  }
  net.send({ type: 'cmd', cmd: { kind: 'give', to: giveTarget, gold, wood } });
  giveTarget = null;
  renderGiveForm();
}

// Cablea el panel: el botón 📊 lo abre/cierra (estado recordado en localStorage);
// ✕ o un toque fuera lo cierran; delegación para 🎁, atajos rápidos y enviar.
export function initScoreboard(): void {
  const panel = $('scoreboard-panel');
  const btn = $('btn-scoreboard');
  // La tabla REEMPLAZA a los chips de jugadores de la esquina: en escritorio nace
  // ABIERTA (es el marcador titular); en móvil, cerrada (espacio). El usuario manda
  // después: su última elección queda en localStorage.
  const stored = localStorage.getItem('td_scoreboard');
  const open = stored === null ? window.innerWidth > 700 : stored === '1';
  panel.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));

  const setOpen = (v: boolean): void => {
    panel.hidden = !v;
    btn.setAttribute('aria-expanded', String(v));
    localStorage.setItem('td_scoreboard', v ? '1' : '0');
    if (v) {
      $('market-panel').hidden = true; // los tres viven arriba: abrir uno cierra los demás
      $('shop-panel').hidden = true;
      if (store.game?.latest) renderScoreboard();
    } else {
      giveTarget = null;
      renderGiveForm();
    }
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(panel.hidden);
  });
  $('scoreboard-close').addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(false);
  });
  // clic dentro no cierra. A diferencia del mercado/tienda, la tabla es un
  // componente PERSISTENTE del HUD (reemplaza a los chips): tocar el mapa NO la
  // cierra — solo 📊, ✕… salvo que el formulario de regalo esté abierto, que sí
  // se cancela al tocar fuera (comportamiento de formulario).
  panel.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => {
    if (!panel.hidden && giveTarget) {
      giveTarget = null;
      renderGiveForm();
    }
  });

  // delegación de acciones dentro del panel (la tabla se re-renderiza a menudo)
  panel.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const giveEl = t.closest<HTMLElement>('[data-give]');
    if (giveEl) {
      giveTarget = giveEl.dataset.give ?? null;
      renderGiveForm();
      (document.getElementById('give-gold') as HTMLInputElement | null)?.focus();
      return;
    }
    const gEl = document.getElementById('give-gold') as HTMLInputElement | null;
    const wEl = document.getElementById('give-wood') as HTMLInputElement | null;
    const gs = store.game;
    const addGold = t.closest<HTMLElement>('[data-add-gold]');
    if (addGold && gEl) {
      gEl.value = String(clampInt(gEl.value) + Number(addGold.dataset.addGold));
      return;
    }
    const addWood = t.closest<HTMLElement>('[data-add-wood]');
    if (addWood && wEl) {
      wEl.value = String(clampInt(wEl.value) + Number(addWood.dataset.addWood));
      return;
    }
    if (t.closest('[data-max-gold]') && gEl && gs) {
      gEl.value = String(myGold(gs));
      return;
    }
    if (t.closest('[data-max-wood]') && wEl && gs) {
      wEl.value = String(myWood(gs));
      return;
    }
    if (t.closest('#give-cancel')) {
      giveTarget = null;
      renderGiveForm();
      return;
    }
    if (t.closest('#give-send')) submitGive();
  });

  // Enter dentro del formulario = enviar
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).closest('#scoreboard-give')) {
      e.preventDefault();
      submitGive();
    }
  });
}

// llamado desde onTick (throttle) para mantener la tabla viva mientras está abierta
function syncScoreboard(now: number): void {
  if ($('scoreboard-panel').hidden) return;
  if (now - lastScoreboardSync < 250) return;
  lastScoreboardSync = now;
  renderScoreboard();
}

// ---------- velocidad ----------

export function syncSpeedButton(): void {
  const speed = store.game?.speed ?? 1;
  $('btn-speed').textContent = speed === 1 ? '▶ x1' : `⏩ x${speed}`;
}

// ---------- toasts y chat ----------

export function toast(text: string, kind: 'error' | 'info' = 'error'): void {
  const box = $('toasts');
  // el mismo texto NO se apila: refresca la píldora existente (reinicia sus
  // animaciones y su temporizador). Antes, repetir una acción llenaba la
  // pantalla con hasta 4 copias del mismo aviso.
  const dup = [...box.children].find((c): c is HTMLElement => c.textContent === text);
  const el = dup ?? document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  if (dup) {
    el.style.animation = 'none';
    void el.offsetWidth; // reflow: reinicia la animación de entrada/salida
    el.style.animation = '';
  } else {
    box.appendChild(el);
  }
  clearTimeout(Number(el.dataset.timer));
  el.dataset.timer = String(setTimeout(() => el.remove(), 2400));
  while (box.children.length > 3) box.firstChild?.remove();
}

export function addChat(from: string, color: string, text: string): void {
  // Los avisos de SISTEMA (sin autor: "llamó la oleada", tala del orco, jefes…)
  // son feedback EFÍMERO del juego: van solo al killfeed in-game (donde se
  // desvanecen) y NUNCA al chat de la sala, que queda reservado a mensajes
  // reales de jugadores. Sin esto, el lobby-chat se llenaba de spam de partida.
  for (const logId of from ? ['lobby-chat', 'game-chat-log'] : ['game-chat-log']) {
    const log = document.getElementById(logId);
    if (!log) continue;
    const el = document.createElement('div');
    el.className = from ? 'msg' : 'msg sys';
    if (from) {
      const b = document.createElement('b');
      b.style.color = color;
      b.textContent = from + ':';
      el.appendChild(b);
    }
    el.appendChild(document.createTextNode(text));
    log.appendChild(el);
    while (log.children.length > 60) log.firstChild?.remove();
    log.scrollTop = log.scrollHeight;
    // feed del juego: el mensaje se desvanece solo (killfeed); con el chat
    // abierto el CSS los mantiene visibles para leer el historial
    if (logId === 'game-chat-log') {
      setTimeout(() => el.classList.add('faded'), 7000);
    }
  }
}
