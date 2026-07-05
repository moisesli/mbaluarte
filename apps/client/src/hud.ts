import {
  activeStats,
  CALL_WAVE_GOLD_PER_SEC,
  ENEMIES,
  ENEMY_ORDER,
  findFusion,
  fusionByIndex,
  FUSION_ORDER,
  FUSIONS,
  hasRank2,
  HORDE_CAP,
  rank2Cost,
  SELL_REFUND,
  TARGET_MODES,
  TOWERS,
  TOWER_ORDER,
  towerTotalCost,
  ORC_RATES,
  ORC_UPGRADE_COSTS,
  WOOD_COST_RANK2,
  WOOD_COST_SPEC,
  WOOD_LOT,
  WOOD_SELL_SPREAD,
  type Snap,
  type TargetMode,
  type TowerLevelDef,
  type TowerTypeId,
} from '@td/shared';
import { net } from './net.js';
import { myGold, myWood, store } from './store.js';
import { computeBannerAuras, countBannerTargets, ENEMY_ICONS, TOWER_ICONS, type ClientAura } from './renderer.js';
import { clearSelection, setPlacing } from './input.js';

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

// ---------- barra de torres ----------

// Orden de PRESENTACIÓN de la barra, agrupado por rol (no toca TOWER_ORDER, que
// es el orden compacto de los snapshots): ataque · apoyo/economía · camino.
// Una torre nueva que no esté aquí cae en un grupo extra al final (red de seguridad).
const BAR_GROUPS: TowerTypeId[][] = [
  ['archer', 'cannon', 'frost', 'poison', 'tesla', 'sniper', 'mortar'],
  ['banner', 'bank', 'alchemist'],
  ['trap', 'boom'],
];

export function buildTowerBar(): void {
  const bar = $('hud-towers');
  bar.innerHTML = '';
  const flat = BAR_GROUPS.flat();
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
    card.innerHTML = `
      <span class="thk">${def.hotkey}</span>
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
  const parts: string[] = [`${TOWER_ICONS[type]} <b>${def.name}</b> 🪙${lvl.cost}`];
  const isAura = lvl.auraDamage !== undefined || lvl.auraHaste !== undefined || lvl.auraBounty !== undefined;
  if (lvl.damage > 0 && !def.onPathOnly) parts.push(`Daño <b>${lvl.damage}</b>`);
  if (def.onPathOnly) parts.push(def.detonates ? `💥 Detona al pisarlo: <b>ELIMINA</b> a los terrestres del área (jefes: ${lvl.damage} de daño)` : `Daño por golpe <b>${lvl.damage}</b>`);
  if (lvl.auraDamage !== undefined && lvl.auraDamage > 0) parts.push(`Aura de daño <b>+${Math.round(lvl.auraDamage * 100)}%</b>`);
  if (lvl.auraHaste !== undefined && lvl.auraHaste > 0) parts.push(`Aura de cadencia <b>+${Math.round(lvl.auraHaste * 100)}%</b>`);
  if (lvl.auraBounty !== undefined && lvl.auraBounty > 0) parts.push(`Aura de oro <b>+${Math.round(lvl.auraBounty * 100)}%</b>`);
  if (lvl.range > 0) parts.push(`${isAura ? 'Radio' : 'Alcance'} <b>${lvl.range}</b>`);
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
      card.classList.toggle('selected', placing === type);
      card.classList.toggle('poor', gold < TOWERS[type].levels[0].cost);
    }
  }
  if (!store.spectator) syncPlacingInfo();
}

// ---------- modo espectador ----------

// Aplica (o revierte) el modo espectador de la UI del juego: banner persistente,
// oculta el oro propio, los botones de acción de jugador (llamar oleada, pausa,
// velocidad) y el panel de mejora/venta. La barra de torres se mantiene (en modo
// sugerencia). Se llama al entrar a la partida (jugador o espectador).
export function applySpectatorUI(): void {
  const spec = store.spectator;
  $('spectator-banner').hidden = !spec;
  $('hud-gold').hidden = spec;
  $('hud-wood').hidden = spec;
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
    if (!gs || gs.selection?.kind !== 'tower') return;
    const towerId = gs.selection.id;
    const target = e.target as HTMLElement;
    // el botón ✕ cierra el panel y deselecciona (imprescindible en móvil, donde
    // el panel es una hoja inferior y "tocar fuera" no siempre es obvio)
    if (target.closest('#panel-close')) {
      clearSelection();
      return;
    }
    const upgrade = target.closest<HTMLButtonElement>('#panel-upgrade');
    const sell = target.closest<HTMLButtonElement>('#panel-sell');
    const specBtn = target.closest<HTMLButtonElement>('.spec-btn');
    const mode = target.closest<HTMLElement>('.tmode')?.dataset.mode;
    const fuseBtn = target.closest<HTMLButtonElement>('.fuse-btn');
    if (upgrade && !upgrade.disabled) {
      net.send({ type: 'cmd', cmd: { kind: 'upgrade', towerId } });
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
  if (lvl.executeCurrent) lines.push(`Remata por debajo del <b>${Math.round(lvl.executeCurrent * 100)}%</b> de la vida ACTUAL`);
  if (lvl.shredChance) lines.push(`Shred: <b>${Math.round(lvl.shredChance * 100)}%</b> de partir la armadura en área`);
  if (lvl.growth) lines.push(`Crecimiento: <b>+${lvl.growth}</b> de daño por disparo`);
  // F4.3 · mecánicas de fusión
  if (lvl.lineWidth) lines.push('Rayo <b>perforante</b>: golpea a TODOS los enemigos en línea (a inmunes −70%)');
  if (lvl.poisonBountyMult) lines.push(`Botín <b>×${lvl.poisonBountyMult}</b> por bajas de su veneno`);
  if (lvl.auraBounty) lines.push(stat('Aura de oro', `+${Math.round(lvl.auraBounty * 100)}%`, next?.auraBounty ? `+${Math.round(next.auraBounty * 100)}%` : null));
  if (lvl.incomePerWave) lines.push(stat('Ingreso', `🪙${lvl.incomePerWave}${lvl.incomeToAll ? ' a todos' : ''}`, next?.incomePerWave ? `🪙${next.incomePerWave}` : null));
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

export function refreshPanel(): void {
  const gs = store.game;
  const panel = $('hud-panel');
  if (!gs || gs.selection?.kind !== 'tower' || !gs.latest) {
    panel.hidden = true;
    $('screen-game').classList.remove('panel-open');
    return;
  }
  const selectedId = gs.selection.id;
  const data = gs.latest.towers.find((t) => t[0] === selectedId);
  if (!data) {
    // la torre ya no existe (vendida / trampa agotada / barril detonado)
    panel.hidden = true;
    $('screen-game').classList.remove('panel-open');
    gs.selection = null;
    return;
  }
  const [id, typeIdx, , , level, ownerIdx, modeIdx, kills, damage] = data;
  const spec = data[9] ?? -1;
  const charges = data[11] ?? 0;
  // F4.3: índice de fusión e inversión total (para el valor de venta de fusiones)
  const fusionIdx = data[13] ?? -1;
  const invested = data[14] ?? 0;
  const fusion = fusionByIndex(fusionIdx);
  const type = TOWER_ORDER[typeIdx];
  const def = TOWERS[type];
  const specialized = spec >= 0;
  const isRank2 = level >= 4;
  const lvl = fusion ? fusion.stats : activeStats(type, level, spec);
  const projKind = fusion ? fusion.projectileKind : def.projectileKind;
  const next = !fusion && !specialized && level < 3 ? def.levels[level] : null;
  const owner = gs.init.players[ownerIdx];
  const isMine = owner?.id === store.playerId;
  const gold = myGold(gs);
  // la inversión de una fusión (suma de sus dos ingredientes) no se puede
  // reconstruir desde type/level/spec: usa el `invested` real del snapshot
  const sellValue = Math.floor((fusion ? invested : towerTotalCost(type, level, spec)) * SELL_REFUND);
  const canSpecialize = !fusion && level >= 3 && !specialized && !def.onPathOnly;
  // ¿puede subir al Rango II? torre especializada, aún en nivel 3, cuya spec tenga rank2
  const canRank2 = !fusion && specialized && level === 3 && hasRank2(type, spec);
  const r2cost = canRank2 ? rank2Cost(type, spec) : null;

  // aura de Estandarte activa SOBRE esta torre → el panel muestra stats efectivos
  const auraBuff = computeBannerAuras(gs.latest).get(id);
  const statLines = statBlock(lvl, next, auraBuff);
  // Valores VOLÁTILES (cambian cada tick en combate: bajas/daño/cargas/oro…):
  // van en spans estables `data-lv` y se actualizan por textContent, FUERA del
  // dirty-check estructural. Si entraran al innerHTML, el panel se reescribiría
  // 4 veces por segundo en pleno combate y se tragaría los toques.
  const live: Record<string, string> = {};
  const combatLine = 'Bajas: <b data-lv="kills"></b> · Daño total: <b data-lv="damage"></b>';
  live.kills = String(kills);
  live.damage = damage.toLocaleString();
  // Estandarte (y fusiones con aura): cuántas torres está reforzando ahora mismo
  if (lvl.auraDamage !== undefined || lvl.auraHaste !== undefined) {
    const n = countBannerTargets(gs.latest, id);
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
  } else if (def.onPathOnly) {
    if (def.detonates) {
      // Barril explosivo: se consume al detonar (no tiene cargas que contar)
      statLines.push('💥 Detona <b>una sola vez</b> al ser pisado: <b>ELIMINA</b> a los terrestres del área (los jefes solo reciben daño)');
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
  const levelTag = fusion
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
    for (const other of gs.latest.towers) {
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

  // acciones del dueño
  let actions = '';
  if (isMine) {
    if (fusion) {
      // una fusión no se mejora ni se especializa: solo venta (+ modo de objetivo)
      actions = `
        <p class="spec-desc" style="padding:0 4px 6px">${fusion.desc}</p>
        <div class="prow"><button id="panel-sell" class="btn ghost">💸 Vender ${sellValue}</button></div>
        ${targetModesHtml(projKind, lvl, modeIdx)}`;
    } else if (def.onPathOnly) {
      // Trampa de púas: no se mejora ni especializa; solo se puede vender.
      actions = `<div class="prow"><button id="panel-sell" class="btn ghost">💸 Vender ${sellValue}</button></div>`;
    } else if (canSpecialize) {
      const wood = myWood(gs);
      // descubrimiento contextual: si lo que te frena es la madera, el panel te
      // manda directo al mercado (el mejor momento para aprender que existe)
      const woodHint = wood < WOOD_COST_SPEC
        ? '<p class="hint" style="padding:2px 4px 0">💡 Te falta madera: toca el chip 🪵 de arriba para comprarla o mejorar a tu orco</p>'
        : '';
      actions = `
        <div class="spec-title">Elige especialización <span class="spec-woodreq">(cuesta 🪵${WOOD_COST_SPEC} de madera)</span></div>${woodHint}
        <div class="spec-choices">
          ${def.specs
            .map(
              (sp, i) => `
            <button class="spec-btn" data-spec="${i}" ${gold < sp.cost || wood < WOOD_COST_SPEC ? 'disabled' : ''}>
              <span class="spec-name">${sp.name}</span>
              <span class="spec-desc">${sp.desc}</span>
              <span class="spec-cost">🪙${sp.cost}<br>🪵${WOOD_COST_SPEC}</span>
            </button>`,
            )
            .join('')}
        </div>
        <div class="prow"><button id="panel-sell" class="btn ghost">💸 Vender ${sellValue}</button></div>`;
    } else if (canRank2 && r2cost !== null) {
      // Rango II: mejora identidad de la especialización (reutiliza el comando upgrade)
      const r2desc = def.specs[spec].rank2?.desc ?? 'Mejora de Rango II';
      const wood = myWood(gs);
      actions = `
        <div class="spec-title">Rango II</div>
        <p class="spec-desc" style="padding:0 4px 6px">${escapeHtml(r2desc)}</p>
        ${fuseHtml}
        <div class="prow">
          <button id="panel-upgrade" class="btn primary" ${gold < r2cost || wood < WOOD_COST_RANK2 ? 'disabled' : ''}>
            ★★ Rango II 🪙${r2cost} · 🪵${WOOD_COST_RANK2}
          </button>
          <button id="panel-sell" class="btn ghost">💸 ${sellValue}</button>
        </div>
        ${targetModesHtml(projKind, lvl, modeIdx)}`;
    } else {
      const nextCost = next?.cost ?? null;
      const maxedLabel = isRank2 ? 'Máximo (Rango II)' : 'Máximo';
      actions = `
        ${fuseHtml}
        <div class="prow">
          <button id="panel-upgrade" class="btn primary" ${nextCost === null || gold < nextCost ? 'disabled' : ''}>
            ${nextCost === null ? maxedLabel : `⬆ Mejorar 🪙${nextCost}`}
          </button>
          <button id="panel-sell" class="btn ghost">💸 ${sellValue}</button>
        </div>
        ${targetModesHtml(projKind, lvl, modeIdx)}`;
    }
  } else {
    actions = `<p class="hint">Torre de ${escapeHtml(owner?.name ?? 'otro jugador')}</p>`;
  }

  const html = `
    <h3><span>${title}</span><span class="lvl">${levelTag}</span><button id="panel-close" aria-label="Cerrar">✕</button></h3>
    <div class="pstats">${statLines.join('<br>')}</div>
    ${actions}
  `;
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
  void id;
}

// ---------- barra superior y jugadores ----------

let lastPanelSync = 0;

// F5.2 · métricas en vivo (minimalistas): DPS propio con ventana móvil de 3 s +
// oro ganado y vidas perdidas de la OLEADA actual (se reinician al empezar otra).
const dpsWindow: { t: number; dmg: number }[] = [];
let liveWave = -1;
let liveGoldBase = 0;
let liveLivesBase = 0;

function liveChipHtml(snap: Snap): string {
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
  return `<div class="pchip live-chip" title="Tu daño por segundo · oro ganado esta oleada · vidas perdidas esta oleada">${parts.join(' · ')}</div>`;
}

export function onTick(snap: Snap): void {
  const gs = store.game;
  if (!gs) return;

  const horde = gs.init.mode === 'horde';
  const lives = $('hud-lives');
  const aliveChip = $('hud-alive');

  if (horde) {
    // En horda no hay vidas: se pierde por SATURACIÓN. El chip 👾 pasa a ser la
    // "vida" — enemigos vivos / cap. Amarillo desde 70%, rojo desde 90% (pulso).
    lives.hidden = true;
    const cap = HORDE_CAP[gs.init.difficulty] ?? HORDE_CAP.normal;
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
    // botón no estruje la fila de stats (dejaría el chip 🪵 fuera de pantalla)
    $('callwave-timer').innerHTML = `${snap.interludeSec}s <span class="cw-bonus">+🪙${bonus}</span>`;
  } else {
    btn.hidden = true;
  }

  // chips de jugadores + métricas en vivo propias (última "chip" de la columna)
  const chips = $('hud-players');
  chips.innerHTML =
    snap.players
      .map((p) => {
        const info = gs.init.players.find((ip) => ip.id === p.id);
        return `<div class="pchip ${p.connected ? '' : 'offline'}">
        <span class="player-dot" style="background:${info?.color};color:${info?.color}"></span>
        <span>${escapeHtml(info?.name ?? p.id)}</span><span class="pgold">🪙${p.gold}</span>
      </div>`;
      })
      .join('') + liveChipHtml(snap);

  // vista previa de la próxima oleada
  const preview = $('hud-preview');
  if (!snap.active && snap.nextWave.length > 0) {
    preview.hidden = false;
    // etiquetas de tipo (telegrafía Green TD): 🛡 inmune · ⭐ bendecida · 🦅 aérea · ☠ jefe
    const tags: string[] = [];
    if (snap.nextImmune) tags.push('<span class="wave-tag immune" title="Inmune a la magia: solo daño físico">🛡 inmune</span>');
    if (snap.nextBlessed) tags.push('<span class="wave-tag blessed" title="¡Oleada bendecida: doble botín!">⭐ bendecida</span>');
    if (snap.nextBossType >= 0) {
      const bossType = ENEMY_ORDER[snap.nextBossType];
      const bossFlying = ENEMIES[bossType]?.flying;
      tags.push(`<span class="wave-tag boss" title="${ENEMIES[bossType]?.name ?? 'Jefe'}">${bossFlying ? '🦅' : '☠'} ${ENEMIES[bossType]?.name ?? 'jefe'}</span>`);
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

  // refrescar el panel de torre (máx 4 veces por segundo para no perder clicks)
  const now = performance.now();
  if (gs.selection?.kind === 'tower' && now - lastPanelSync > 250) {
    lastPanelSync = now;
    refreshPanel();
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
  setText(buy, `Comprar ${WOOD_LOT} 🪵 — 🪙${cost}`);
  setText(sell, `Vender ${WOOD_LOT} 🪵 — +🪙${gain}`);
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

// ---------- velocidad ----------

export function syncSpeedButton(): void {
  const speed = store.game?.speed ?? 1;
  $('btn-speed').textContent = speed === 1 ? '▶ x1' : `⏩ x${speed}`;
}

// ---------- toasts y chat ----------

export function toast(text: string, kind: 'error' | 'info' = 'error'): void {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => el.remove(), 2400);
  while (box.children.length > 4) box.firstChild?.remove();
}

export function addChat(from: string, color: string, text: string): void {
  for (const logId of ['lobby-chat', 'game-chat-log']) {
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
