import {
  activeStats,
  CALL_WAVE_GOLD_PER_SEC,
  ENEMIES,
  ENEMY_ORDER,
  HORDE_CAP,
  SELL_REFUND,
  TARGET_MODES,
  TOWERS,
  TOWER_ORDER,
  towerTotalCost,
  type Snap,
  type TargetMode,
  type TowerLevelDef,
  type TowerTypeId,
} from '@td/shared';
import { net } from './net.js';
import { myGold, store } from './store.js';
import { countBannerTargets, ENEMY_ICONS, TOWER_ICONS } from './renderer.js';
import { setPlacing } from './input.js';

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

export function buildTowerBar(): void {
  const bar = $('hud-towers');
  bar.innerHTML = '';
  for (const type of TOWER_ORDER) {
    const def = TOWERS[type];
    const card = document.createElement('button');
    card.className = 'tcard';
    card.dataset.type = type;
    card.title = `${def.name} — ${def.desc}`;
    card.innerHTML = `
      <span class="thk">${def.hotkey}</span>
      <span class="ticon">${TOWER_ICONS[type]}</span>
      <span class="tname">${def.name}</span>
      <span class="tcost">🪙${def.levels[0].cost}</span>
    `;
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
  const isBanner = lvl.auraDamage !== undefined || lvl.auraHaste !== undefined;
  if (lvl.damage > 0) parts.push(`Daño <b>${lvl.damage}</b>`);
  if (lvl.auraDamage !== undefined && lvl.auraDamage > 0) parts.push(`Aura de daño <b>+${Math.round(lvl.auraDamage * 100)}%</b>`);
  if (lvl.auraHaste !== undefined && lvl.auraHaste > 0) parts.push(`Aura de cadencia <b>+${Math.round(lvl.auraHaste * 100)}%</b>`);
  if (lvl.range > 0) parts.push(`${isBanner ? 'Radio' : 'Alcance'} <b>${lvl.range}</b>`);
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
}

// Los botones del panel se recrean al refrescar; con delegación en el contenedor
// (que es estable) el click no se pierde aunque el refresco caiga entre el
// pointerdown y el pointerup de un toque lento.
let panelWired = false;
let lastPanelHtml = '';

function wirePanel(): void {
  if (panelWired) return;
  panelWired = true;
  $('hud-panel').addEventListener('click', (e) => {
    const gs = store.game;
    if (!gs || gs.selection?.kind !== 'tower') return;
    const towerId = gs.selection.id;
    const target = e.target as HTMLElement;
    const upgrade = target.closest<HTMLButtonElement>('#panel-upgrade');
    const sell = target.closest<HTMLButtonElement>('#panel-sell');
    const specBtn = target.closest<HTMLButtonElement>('.spec-btn');
    const mode = target.closest<HTMLElement>('.tmode')?.dataset.mode;
    if (upgrade && !upgrade.disabled) {
      net.send({ type: 'cmd', cmd: { kind: 'upgrade', towerId } });
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

// líneas de stats de un bloque activo (con vista previa opcional del siguiente nivel)
function statBlock(lvl: TowerLevelDef, next: TowerLevelDef | null): string[] {
  const stat = (label: string, cur: number | string, nxt?: number | string | null, suffix = '') => {
    const upgrade = nxt !== undefined && nxt !== null && nxt !== cur ? ` <span class="up">→ ${nxt}${suffix}</span>` : '';
    return `${label}: <b>${cur}${suffix}</b>${upgrade}`;
  };
  const lines: string[] = [];
  if (lvl.damage > 0) {
    lines.push(stat('Daño', lvl.damage, next?.damage));
    if (lvl.cooldown > 0) {
      const dps = ((lvl.damage * (lvl.shots ?? 1)) / lvl.cooldown).toFixed(1);
      const nextDps = next && next.cooldown > 0 ? ((next.damage * (next.shots ?? 1)) / next.cooldown).toFixed(1) : null;
      lines.push(stat('DPS', dps, nextDps));
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
  if ((lvl.auraDamage !== undefined || lvl.auraHaste !== undefined) && lvl.range > 0) {
    lines.push(stat('Radio', lvl.range, next?.range));
  } else if (lvl.range > 0) {
    lines.push(stat('Alcance', lvl.range, next?.range));
  }
  if (lvl.cooldown > 0) lines.push(stat('Cadencia', lvl.cooldown, next?.cooldown, 's'));
  if (lvl.splash) lines.push(stat('Área', lvl.splash, next?.splash));
  if (lvl.slow) lines.push(stat('Congela al', `${Math.round(lvl.slow.factor * 100)}%`, next?.slow ? `${Math.round(next.slow.factor * 100)}%` : null));
  if (lvl.slowAura) lines.push(`Aura de hielo <b>${lvl.slowAura.radius}</b> (${Math.round(lvl.slowAura.factor * 100)}%)`);
  if (lvl.poison) lines.push(stat('Veneno', `${lvl.poison.dps}/s`, next?.poison ? `${next.poison.dps}/s` : null));
  if (lvl.chain) lines.push(stat('Salta a', lvl.chain.targets, next?.chain?.targets));
  if (lvl.execute) lines.push(`Remata por debajo del <b>${Math.round(lvl.execute * 100)}%</b>`);
  if (lvl.incomePerWave) lines.push(stat('Ingreso', `🪙${lvl.incomePerWave}${lvl.incomeToAll ? ' a todos' : ''}`, next?.incomePerWave ? `🪙${next.incomePerWave}` : null));
  if (lvl.pierceArmor) lines.push('Perfora armadura');
  return lines;
}

export function refreshPanel(): void {
  const gs = store.game;
  const panel = $('hud-panel');
  if (!gs || gs.selection?.kind !== 'tower' || !gs.latest) {
    panel.hidden = true;
    return;
  }
  const selectedId = gs.selection.id;
  const data = gs.latest.towers.find((t) => t[0] === selectedId);
  if (!data) {
    panel.hidden = true;
    gs.selection = null;
    return;
  }
  const [id, typeIdx, , , level, ownerIdx, modeIdx, kills, damage] = data;
  const spec = data[9] ?? -1;
  const type = TOWER_ORDER[typeIdx];
  const def = TOWERS[type];
  const specialized = spec >= 0;
  const lvl = activeStats(type, level, spec);
  const next = !specialized && level < 3 ? def.levels[level] : null;
  const owner = gs.init.players[ownerIdx];
  const isMine = owner?.id === store.playerId;
  const gold = myGold(gs);
  const sellValue = Math.floor(towerTotalCost(type, level, spec) * SELL_REFUND);
  const canSpecialize = level >= 3 && !specialized;

  const statLines = statBlock(lvl, next);
  // Estandarte: cuántas torres está reforzando ahora mismo (contado en el cliente)
  if (lvl.auraDamage !== undefined || lvl.auraHaste !== undefined) {
    const n = countBannerTargets(gs.latest, id);
    statLines.push(`Reforzando <b>${n}</b> ${n === 1 ? 'torre' : 'torres'}`);
  } else {
    statLines.push(`Bajas: <b>${kills}</b> · Daño total: <b>${damage.toLocaleString()}</b>`);
  }
  statLines.push(`Dueño: <b style="color:${owner?.color}">${escapeHtml(owner?.name ?? '?')}</b>`);

  // cabecera: nombre (+ especialización) y nivel/estrella
  const title = specialized
    ? `${TOWER_ICONS[type]} ${def.specs[spec].name}`
    : `${TOWER_ICONS[type]} ${def.name}`;
  const levelTag = specialized ? '★ Élite' : `Nv. ${level}${level >= 3 ? ' (máx)' : ''}`;

  // acciones del dueño
  let actions = '';
  if (isMine) {
    if (canSpecialize) {
      actions = `
        <div class="spec-title">Elige especialización</div>
        <div class="spec-choices">
          ${def.specs
            .map(
              (sp, i) => `
            <button class="spec-btn" data-spec="${i}" ${gold < sp.cost ? 'disabled' : ''}>
              <span class="spec-name">${sp.name}</span>
              <span class="spec-desc">${sp.desc}</span>
              <span class="spec-cost">🪙${sp.cost}</span>
            </button>`,
            )
            .join('')}
        </div>
        <div class="prow"><button id="panel-sell" class="btn ghost">💸 Vender ${sellValue}</button></div>`;
    } else {
      const nextCost = next?.cost ?? null;
      actions = `
        <div class="prow">
          <button id="panel-upgrade" class="btn primary" ${nextCost === null || gold < nextCost ? 'disabled' : ''}>
            ${nextCost === null ? 'Máximo' : `⬆ Mejorar 🪙${nextCost}`}
          </button>
          <button id="panel-sell" class="btn ghost">💸 ${sellValue}</button>
        </div>
        ${
          def.projectileKind !== 'none' && lvl.range > 0
            ? `<div class="tmodes">${TARGET_MODES.map(
                (m, i) =>
                  `<button class="tmode ${i === modeIdx ? 'active' : ''}" data-mode="${m}">${TARGET_LABELS[m]}</button>`,
              ).join('')}</div>`
            : ''
        }`;
    }
  } else {
    actions = `<p class="hint">Torre de ${escapeHtml(owner?.name ?? 'otro jugador')}</p>`;
  }

  const html = `
    <h3><span>${title}</span><span class="lvl">${levelTag}</span></h3>
    <div class="pstats">${statLines.join('<br>')}</div>
    ${actions}
  `;
  wirePanel();
  // solo tocar el DOM si algo cambió: reescribir innerHTML destruye los botones
  // y puede tragarse un click a mitad de pulsación
  if (html !== lastPanelHtml) {
    lastPanelHtml = html;
    panel.innerHTML = html;
  }
  panel.hidden = false;
  void id;
}

// ---------- barra superior y jugadores ----------

let lastPanelSync = 0;

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

  $('hud-wave').textContent =
    snap.totalWaves > 0 ? `Oleada ${snap.wave}/${snap.totalWaves}` : `Oleada ${snap.wave} ∞`;
  $('hud-gold').textContent = `🪙 ${myGold(gs)}`;

  // botón de llamar oleada, con el bonus de oro que ganarías ahora mismo
  // (los espectadores no llaman oleadas: nunca lo ven)
  const btn = $('btn-callwave');
  if (!store.spectator && !snap.active && snap.over === 0) {
    btn.hidden = false;
    const bonus = snap.interludeSec * CALL_WAVE_GOLD_PER_SEC;
    $('callwave-timer').textContent = `${snap.interludeSec}s +🪙${bonus}`;
  } else {
    btn.hidden = true;
  }

  // chips de jugadores
  const chips = $('hud-players');
  chips.innerHTML = snap.players
    .map((p) => {
      const info = gs.init.players.find((ip) => ip.id === p.id);
      return `<div class="pchip ${p.connected ? '' : 'offline'}">
        <span class="player-dot" style="background:${info?.color};color:${info?.color}"></span>
        <span>${escapeHtml(info?.name ?? p.id)}</span><span class="pgold">🪙${p.gold}</span>
      </div>`;
    })
    .join('');

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

  // refrescar el panel de torre (máx 4 veces por segundo para no perder clicks)
  const now = performance.now();
  if (gs.selection?.kind === 'tower' && now - lastPanelSync > 250) {
    lastPanelSync = now;
    refreshPanel();
  }
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
  }
}
