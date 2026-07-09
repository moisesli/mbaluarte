// Guía del juego: bestiario de monstruos + élites/afijos/oleadas especiales +
// recetas de fusión. Solo cliente. Las descripciones son texto curado; los RASGOS,
// los afijos y las recetas se derivan de los datos reales de balance (@td/shared)
// para no desincronizarse nunca de la mecánica.
import {
  AFFIX_ORDER,
  AFFIXES,
  ASSIST_MIN_DMG_FRAC,
  ASSIST_SHARE,
  ENEMY_ORDER,
  ENEMIES,
  FUSION_ORDER,
  FUSIONS,
  TOWER_ORDER,
  TOWERS,
  WOOD_COST_RANK2,
  WOOD_COST_SPEC,
} from '@td/shared';
import type { EnemyDef, EnemyTypeId, TowerDef, TowerLevelDef, TowerTypeId } from '@td/shared';
import { ENEMY_ICONS, TOWER_ICONS } from './renderer.js';
import {
  CONTROL_ACTIONS,
  keyLabel,
  MARKET_ACTIONS,
  resetKeys,
  setKey,
  towerTypeForAction,
  type KeymapAction,
} from './keymap.js';
import { syncHotkeyLabels } from './hud.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// Descripción curada por enemigo (fiel a la simulación).
const DESC: Record<EnemyTypeId, string> = {
  goblin: 'Tropa básica. Sin sorpresas: llega en número y desgasta tus defensas.',
  runner: 'Muy rápido y frágil. Se cuela si tus torres son lentas o dejas huecos.',
  brute: 'Aguanta golpes y lleva algo de armadura. Cuesta 2 vidas si se escapa.',
  bat: 'Vuela: solo lo alcanzan las torres con anti-aire (arquero, hielo, veneno, tesla, francotirador).',
  armored: 'Mucha armadura: reduce el daño físico plano. Usa perforación o daño mágico.',
  shaman: 'Cura a los enemigos cercanos con su aura. Mátalo primero o mantendrá viva a la horda.',
  larva: 'Diminuta, rapidísima y muy débil. Viene en enjambres para saturar tus torres.',
  troll: 'Regenera vida sin parar. Necesita daño sostenido o un golpe que lo mate de una.',
  slime: 'Al morir se divide en 2 Babosines. El daño en área ayuda a limpiar los restos.',
  slimelet: 'La cría del Baboso: débil y rápida. Aparece en pares al reventar a su padre.',
  ghost: 'Esquiva el 30% de los proyectiles. Los disparos instantáneos (francotirador, tesla) siempre aciertan.',
  golem: 'Jefe. Enorme y acorazado; al morir suelta 3 Brutos. Aparece cada 10 oleadas.',
  sapper:
    'Se detiene junto a una torre que DISPARE y la ATURDE mientras viva. Los zapadores se reparten: nunca aturden dos la misma torre — si todas las cercanas ya están tomadas, sigue caminando hacia otra. Prioriza matarlo.',
  thief: 'No quita vidas: si escapa, ROBA oro del equipo. Rápido y frágil; no lo dejes pasar.',
  berserker:
    'Al bajar del 40% de vida se ENFURECE y corre un 50% más rápido. Remátalo de golpe antes de que acelere.',
  skywhale:
    'Volador TANQUE: enorme cantidad de vida por el aire. La respuesta dura es la METRALLA (spec del cañón): le hace ×1.5 de daño.',
  wraith:
    'Esquiva el 45% e INMUNE a la magia (hielo, veneno y ejecución; el tesla le pega reducido). Usa daño físico o el disparo certero del francotirador.',
  chimera: 'Jefe VOLADOR (oleadas 15/25/35). Obliga a tener anti-aire: el cañón y el mortero no la alcanzan.',
  behemoth: 'Jefe demoledor. Al cruzar cada esquina ATURDE todas las torres a su alrededor. Vida descomunal.',
};

interface Trait {
  icon: string;
  label: string;
  cls?: string;
}

// Rasgos derivados de los flags REALES del EnemyDef (nunca se desincronizan).
function traitsOf(def: EnemyDef): Trait[] {
  const t: Trait[] = [];
  if (def.boss) t.push({ icon: '💀', label: 'Jefe', cls: 'boss' });
  if (def.flying) t.push({ icon: '🦅', label: 'Volador', cls: 'air' });
  if (def.spellImmune) t.push({ icon: '🛡', label: 'Inmune a magia', cls: 'immune' });
  if (def.sapper) t.push({ icon: '🔨', label: 'Aturde torres' });
  if (def.stunOnCorner) t.push({ icon: '💥', label: 'Aturde al girar' });
  if (typeof def.stealGold === 'number' && def.stealGold > 0) t.push({ icon: '💰', label: 'Roba oro' });
  if (typeof def.berserkBelow === 'number') t.push({ icon: '🐗', label: 'Se enfurece' });
  if (typeof def.dodge === 'number' && def.dodge > 0)
    t.push({ icon: '🌫', label: `Esquiva ${Math.round(def.dodge * 100)}%` });
  if (typeof def.regen === 'number' && def.regen > 0) t.push({ icon: '♻️', label: 'Regenera' });
  if (def.healAura) t.push({ icon: '✨', label: 'Cura aliados' });
  if (def.spawnOnDeath) t.push({ icon: '🔁', label: 'Se divide' });
  if (def.armor >= 6) t.push({ icon: '🩹', label: 'Muy blindado' });
  if (!def.boss && def.speed >= 2.2) t.push({ icon: '💨', label: 'Rápido' });
  return t;
}

function speedLabel(s: number): string {
  if (s < 0.7) return 'Muy lento';
  if (s < 1.0) return 'Lento';
  if (s < 1.6) return 'Normal';
  if (s < 2.2) return 'Rápido';
  return 'Muy rápido';
}

// ---------- pestaña 1: enemigos ----------

function buildEnemies(): void {
  // enemigos normales primero, jefes al final
  const order = [...ENEMY_ORDER].sort(
    (a, b) => Number(ENEMIES[a].boss ?? false) - Number(ENEMIES[b].boss ?? false),
  );
  $('bestiary-grid').innerHTML = order
    .map((type) => {
      const def = ENEMIES[type];
      const chips = traitsOf(def)
        .map((tr) => `<span class="etrait ${tr.cls ?? ''}">${tr.icon} ${tr.label}</span>`)
        .join('');
      const armorStat = def.armor > 0 ? ` <span>🛡 ${def.armor}</span>` : '';
      return `<div class="enemy-card${def.boss ? ' boss' : ''}">
        <div class="ecard-head">
          <span class="eicon">${ENEMY_ICONS[type]}</span>
          <span class="ename">${def.name}</span>
        </div>
        <div class="etraits">${chips}</div>
        <p class="edesc">${DESC[type]}</p>
        <div class="estats"><span>❤️ ${def.hp}</span> <span>🦶 ${speedLabel(def.speed)}</span> <span>🪙 ${def.bounty}</span>${armorStat}</div>
      </div>`;
    })
    .join('');
}

// ---------- pestaña 2: élites, afijos y oleadas especiales ----------
// Cualquier monstruo puede aparecer MODIFICADO: la corona 👑 marca a los élites y
// los iconos que flotan sobre un enemigo son sus afijos (esta tabla los explica).

function buildElites(): void {
  const affixCards = AFFIX_ORDER.map((id) => {
    const a = AFFIXES[id];
    return `<div class="enemy-card">
      <div class="ecard-head"><span class="eicon">${a.icon}</span><span class="ename" style="color:${a.color}">${a.name}</span></div>
      <p class="edesc">${a.desc}.</p>
    </div>`;
  }).join('');

  $('guide-elites').innerHTML = `
    <div class="guide-intro">
      <h3>👑 Élites — monstruos modificados</h3>
      <p class="edesc">Desde la oleada 4, algunos enemigos nacen <b>ÉLITE</b>: llevan corona 👑, son más grandes,
      tienen <b>×2.6 de vida</b> y pagan <b>botín ×3</b> (pero cuestan <b>1 vida extra</b> si escapan).
      Desde la oleada 10 llevan <b>2 afijos</b> a la vez.</p>
      <p class="edesc">Los iconos que flotan <b>sobre el enemigo</b> en el mapa son sus afijos — esto es lo que significa cada uno:</p>
    </div>
    <div class="bestiary-grid">${affixCards}</div>
    <div class="guide-intro">
      <h3>🤝 Oro de asistencia (co-op)</h3>
      <p class="edesc">Si haces <b>mucho daño</b> a un enemigo pero otro jugador se lleva la baja, no te vas
      de vacío: el que aportó <b>al menos el ${Math.round(ASSIST_MIN_DMG_FRAC * 100)}%</b> de su vida y NO dio el golpe final
      cobra un extra de <b>${Math.round(ASSIST_SHARE * 100)}% del botín</b> (el matador conserva el suyo completo).
      Solo cuenta en equipo — en solitario nunca salta.</p>
    </div>
    <div class="guide-intro">
      <h3>🌊 Oleadas especiales (mira las etiquetas de "Próxima oleada")</h3>
    </div>
    <div class="bestiary-grid">
      <div class="enemy-card">
        <div class="ecard-head"><span class="eicon">🛡</span><span class="ename">Oleada INMUNE</span></div>
        <p class="edesc">Múltiplos de 5 desde la 10 (10, 20, 30…). Toda la oleada es <b>inmune a la magia</b>:
        el hielo no congela, el veneno no gotea, la ejecución no remata y el Tesla pega −70%.
        Ten <b>daño físico</b> de reserva (arquero, cañón, francotirador, mortero, Trampa, Barril).</p>
      </div>
      <div class="enemy-card">
        <div class="ecard-head"><span class="eicon">⭐</span><span class="ename">Oleada BENDECIDA</span></div>
        <p class="edesc">Aparece al azar desde la oleada 6. Toda la oleada gana <b>un afijo común</b> (sin la vida extra de élite),
        pero paga <b>botín ×1.5</b> y el bono de fin de oleada también sube ×1.5. Riesgo y recompensa.</p>
      </div>
      <div class="enemy-card">
        <div class="ecard-head"><span class="eicon">🦅</span><span class="ename">Oleada AÉREA</span></div>
        <p class="edesc">Dominada por voladores: el cañón y el mortero no llegan. Necesitas anti-aire
        (arquero, hielo, veneno, tesla, francotirador o la Metralla).</p>
      </div>
      <div class="enemy-card">
        <div class="ecard-head"><span class="eicon">👁</span><span class="ename">Oleada INVISIBLE</span></div>
        <p class="edesc">Cada 6 oleadas desde la 12 (12, 18, 24, 36…), toda la oleada es <b>invisible</b>:
        las torres <b>no pueden verla ni apuntarle</b> y desaparece del mapa. Compra un <b>👁 Sentry</b> en la
        <b>🛒 Tienda</b> y colócalo cubriendo el camino: revela a los monstruos (terrestres y aéreos) dentro de su radio,
        volviéndolos targeteables para todo el equipo. Las trampas de camino (Trampa/Barril) y el daño de ÁREA
        también los golpean aunque no estén detectados.</p>
      </div>
      <div class="enemy-card boss">
        <div class="ecard-head"><span class="eicon">☠</span><span class="ename">JEFES</span></div>
        <p class="edesc">Llegan cada 10 oleadas; la <b>Quimera voladora</b> en la 15/25/35 del clásico.
        Consulta su ficha en la pestaña Enemigos.</p>
      </div>
    </div>`;
}

// ---------- pestaña 3: recetas de fusión ----------

function buildFusions(): void {
  const cards = FUSION_ORDER.map((fid) => {
    const f = FUSIONS[fid];
    const [a, b] = f.ingredients;
    return `<div class="fusion-card" style="border-color:${f.color}55">
      <div class="fusion-recipe">
        <span class="fpart">${TOWER_ICONS[a]} ${TOWERS[a].name}</span>
        <span class="fplus">+</span>
        <span class="fpart">${TOWER_ICONS[b]} ${TOWERS[b].name}</span>
        <span class="fplus">=</span>
        <span class="fresult" style="color:${f.color}">${f.icon} ${f.name}</span>
      </div>
      <p class="edesc">${f.desc}</p>
    </div>`;
  }).join('');

  $('guide-fusions').innerHTML = `
    <div class="guide-intro">
      <h3>⚗ Cómo fusionar</h3>
      <p class="edesc">Dos torres <b>TUYAS</b>, ambas <b>★ especializadas</b> (nivel máximo + rama elegida) y
      <b>pegadas</b> (también en diagonal), cuyos tipos formen una receta. Toca una de las dos y pulsa
      <b>⚗ Fusionar</b> en su panel: la fusión es <b>gratis</b>, consume ambas torres y se queda en la celda
      de la torre desde la que fusionas. Una fusión ya no se mejora ni se especializa (solo se vende).</p>
      <p class="edesc">🪵 <b>Madera</b>: tu orco leñador la tala solo, sin construir nada. Especializar (★)
      cuesta madera además de oro, y el Rango II (★★) también — el oro compra torres; la madera, poder.</p>
      <p class="edesc">💡 El panel de cada torre te recuerda con qué se combina.</p>
    </div>
    <div class="fusion-list">${cards}</div>`;
}

// ---------- pestaña 4: atajos de teclado editables ----------
// Cada acción remapeable muestra su tecla como BOTÓN; al pulsarlo se captura el
// siguiente keydown (Escape cancela). La anticolisión y la persistencia viven en
// keymap.ts; aquí solo va la UI y el feedback.

// texto estático de la app, pero escapamos por norma antes de innerHTML
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ¿el dispositivo tiene teclado físico? (el atajo global «?» solo tiene sentido ahí)
const desktopKeyboard = (): boolean =>
  window.matchMedia('(hover: hover) and (pointer: fine)').matches;

// filas informativas (gestos/sistema): NO editables
const INFO_ROWS: [string, string, string][] = [
  ['👆', 'Doble clic / doble toque', 'Selecciona el GRUPO de torres idénticas (o reencuadra la cámara)'],
  ['⇧', 'Shift + clic', 'Coloca varias torres del mismo tipo seguidas'],
  ['⎇', 'Alt + clic', 'Lanza un ping cooperativo en el punto del mapa'],
  ['⏎', 'Enter', 'Abre / envía el chat del equipo'],
  ['⎋', 'Escape', 'Cancela el modo actual (focus, colocación…) o cierra el panel'],
];

// una fila editable: nombre de la acción + botón con su tecla actual
function keyRow(id: KeymapAction, icon: string, label: string): string {
  return `<div class="key-row">
    <span class="key-name">${icon} ${escapeHtml(label)}</span>
    <button class="key-btn" type="button" data-remap="${id}" aria-label="Reasignar ${escapeHtml(label)}">${keyLabel(id)}</button>
  </div>`;
}

function shortcutsHtml(): string {
  const towerRows = TOWER_ORDER.map((t) => keyRow(`tower:${t}`, TOWER_ICONS[t], TOWERS[t].name)).join('');
  const controlRows = CONTROL_ACTIONS.map((a) => keyRow(a.id, a.icon, a.label)).join('');
  const marketRows = MARKET_ACTIONS.map((a) => keyRow(a.id, a.icon, a.label)).join('');
  const infoRows = INFO_ROWS.map(
    ([icon, name, desc]) =>
      `<div class="key-row info"><span class="key-name">${icon} ${escapeHtml(name)}</span><span class="key-static">${escapeHtml(desc)}</span></div>`,
  ).join('');
  return `
    <div class="guide-intro">
      <h3>⌨️ Atajos de teclado</h3>
      <p class="edesc">Pulsa la tecla de cualquier acción para <b>reasignarla</b>: entra en modo
      «pulsa una tecla…» y captura la siguiente que aprietes (Escape cancela). Solo se admiten teclas
      <b>a–z</b> y <b>0–9</b>; Enter, Escape, Shift, Alt, Ctrl, espacio y flechas están <b>reservadas</b>.
      Si la tecla ya está en uso, se avisa y no se pisa nada. Los atajos aplican al <b>teclado</b> —
      en móvil se juega con gestos (ver la sección General).</p>
      <div class="key-actions">
        <button class="btn ghost small" type="button" data-reset>↩ Restaurar por defecto</button>
        <span id="shortcut-msg" class="shortcut-msg" role="status" aria-live="polite"></span>
      </div>
    </div>
    <div class="key-group"><div class="key-group-title">🏰 Torres</div>${towerRows}</div>
    <div class="key-group"><div class="key-group-title">🎮 Control de torres</div>${controlRows}</div>
    <div class="key-group"><div class="key-group-title">🛒 Mercado</div>${marketRows}</div>
    <div class="key-group"><div class="key-group-title">🧭 General — gestos y sistema (no editables)</div>${infoRows}</div>`;
}

function renderShortcuts(): void {
  $('guide-shortcuts').innerHTML = shortcutsHtml();
}

function setMsg(text: string): void {
  const el = document.getElementById('shortcut-msg');
  if (el) el.textContent = text;
}

// nombre legible de una acción (icono + etiqueta) para los avisos
function actionDisplay(a: KeymapAction): string {
  const t = towerTypeForAction(a);
  if (t) return `${TOWER_ICONS[t]} ${TOWERS[t].name}`;
  const meta = [...CONTROL_ACTIONS, ...MARKET_ACTIONS].find((m) => m.id === a);
  return meta ? `${meta.icon} ${meta.label}` : a;
}

// ---- captura de una tecla nueva ----
let capturing: KeymapAction | null = null;
let captureBtn: HTMLElement | null = null;

function endCapture(): void {
  if (captureBtn && capturing) {
    captureBtn.classList.remove('capturing');
    captureBtn.textContent = keyLabel(capturing);
  }
  document.removeEventListener('keydown', onCaptureKey, true);
  capturing = null;
  captureBtn = null;
}

function onCaptureKey(e: KeyboardEvent): void {
  if (!capturing) return;
  // un modificador suelto no cuenta: esperamos a la tecla real
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
  // capturamos en fase de captura y cortamos la propagación: ni cierra el overlay
  // (Escape) ni dispara input de juego detrás.
  e.preventDefault();
  e.stopPropagation();
  const action = capturing;
  endCapture();
  if (e.key === 'Escape') {
    setMsg('Reasignación cancelada.');
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) {
    setMsg('❌ Las combinaciones con Ctrl/Alt/⌘ están reservadas.');
    return;
  }
  const k = e.key.length === 1 ? e.key.toLowerCase() : '';
  const res = setKey(action, k);
  if (res.ok) {
    renderShortcuts();
    syncHotkeyLabels();
    setMsg(`✅ ${actionDisplay(action)} → «${k.toUpperCase()}»`);
  } else if ('conflict' in res) {
    setMsg(`❌ «${k.toUpperCase()}» ya la usa ${actionDisplay(res.conflict)}`);
  } else {
    const shown = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    setMsg(`❌ «${shown}» está reservada — usa una tecla a–z / 0–9.`);
  }
}

function startCapture(action: KeymapAction, btn: HTMLElement): void {
  if (capturing) endCapture(); // solo una reasignación a la vez
  capturing = action;
  captureBtn = btn;
  btn.classList.add('capturing');
  btn.textContent = 'pulsa una tecla…';
  setMsg(`Pulsa la tecla nueva para ${actionDisplay(action)} (Escape cancela).`);
  document.addEventListener('keydown', onCaptureKey, true);
}

// ---------- pestaña 4: TORRES ----------
// Una tarjeta por torre de TOWER_ORDER (incluye Trampa/Barril/Sentry). TODO se
// deriva de los datos REALES de TOWERS y FUSIONS: rasgos, costes, especializaciones,
// Rango II y con qué se fusiona. Cero hardcode que pueda desincronizarse.

// ¿Algún nivel o especialización (incl. Rango II) de la torre cumple el predicado?
function anyStat(def: TowerDef, pred: (l: TowerLevelDef) => boolean): boolean {
  if (def.levels.some(pred)) return true;
  for (const s of def.specs) {
    if (pred(s)) return true;
    if (s.rank2 && pred({ ...s, ...s.rank2 } as TowerLevelDef)) return true;
  }
  return false;
}

// Rasgos derivados de los CAMPOS reales del TowerDef (nunca se desincronizan).
function towerTraits(def: TowerDef): Trait[] {
  const t: Trait[] = [];
  if (def.detects) t.push({ icon: '👁', label: 'Detector', cls: 'immune' });
  if (def.onPathOnly) t.push({ icon: '🛣', label: 'Sobre el camino' });
  if (def.targetsAir) t.push({ icon: '🦅', label: 'Anti-aire', cls: 'air' });
  else if (def.targetsGround && !def.onPathOnly && !def.detects) t.push({ icon: '🚶', label: 'Solo tierra' });
  if (anyStat(def, (l) => (l.splash ?? 0) > 0)) t.push({ icon: '💥', label: 'Área' });
  if (anyStat(def, (l) => !!l.slow || !!l.slowAura)) t.push({ icon: '❄', label: 'Ralentiza', cls: 'immune' });
  if (anyStat(def, (l) => !!l.poison)) t.push({ icon: '☠', label: 'Veneno' });
  if (anyStat(def, (l) => !!l.chain)) t.push({ icon: '⚡', label: 'Cadena' });
  if (anyStat(def, (l) => (l.shots ?? 1) > 1)) t.push({ icon: '🎯', label: 'Multidisparo' });
  if (anyStat(def, (l) => !!l.pierceArmor)) t.push({ icon: '🗡', label: 'Perfora armadura' });
  if (anyStat(def, (l) => (l.auraDamage ?? 0) > 0)) t.push({ icon: '🚩', label: 'Aura de daño' });
  if (anyStat(def, (l) => (l.auraHaste ?? 0) > 0)) t.push({ icon: '🚩', label: 'Aura de cadencia' });
  if (anyStat(def, (l) => (l.auraBounty ?? 0) > 0)) t.push({ icon: '⚗', label: 'Aura de oro' });
  if (anyStat(def, (l) => (l.incomePerWave ?? 0) > 0)) t.push({ icon: '💰', label: 'Economía' });
  return t;
}

// Las torres de camino (Trampa/Barril) y el Sentry no se mejoran ni especializan.
function isSimpleTower(def: TowerDef): boolean {
  return def.onPathOnly === true || def.detects === true;
}

function buildTowers(): void {
  const cards = TOWER_ORDER.map((type) => {
    const def = TOWERS[type];
    const chips = towerTraits(def)
      .map((tr) => `<span class="etrait ${tr.cls ?? ''}">${tr.icon} ${tr.label}</span>`)
      .join('');

    // costes por nivel (incrementales). Las torres simples tienen un único coste.
    const costLine = isSimpleTower(def)
      ? `<div class="tcosts">🪙 ${def.levels[0].cost} <span class="tdim">· no se mejora</span></div>`
      : `<div class="tcosts">🪙 Niveles: ${def.levels.map((l) => l.cost).join(' → ')}</div>`;

    // especializaciones (★) + Rango II (★★), con coste en 🪙 y 🪵
    let specHtml: string;
    if (isSimpleTower(def)) {
      specHtml = `<div class="tspec"><p class="edesc tdim">No se mejora ni especializa.</p></div>`;
    } else {
      specHtml = def.specs
        .map((s) => {
          const r2 = s.rank2
            ? `<div class="tspec-r2">★★ ${s.rank2.desc ?? `${s.name} II`} <span class="tspec-cost">🪙 ${s.rank2.cost} · 🪵 ${WOOD_COST_RANK2}</span></div>`
            : '';
          return `<div class="tspec">
            <div class="tspec-head">★ <b>${s.name}</b> <span class="tspec-cost">🪙 ${s.cost} · 🪵 ${WOOD_COST_SPEC}</span></div>
            <p class="edesc">${s.desc}</p>
            ${r2}
          </div>`;
        })
        .join('');
    }

    // con qué se fusiona (derivado de FUSIONS)
    const recipes = FUSION_ORDER.map((fid) => FUSIONS[fid]).filter((f) => f.ingredients.includes(type));
    const fuseHtml =
      recipes.length > 0
        ? `<div class="tfuse">⚗ <b>Fusiona con:</b> ${recipes
            .map((f) => {
              const other = f.ingredients[0] === type ? f.ingredients[1] : f.ingredients[0];
              return `${TOWER_ICONS[other]} ${TOWERS[other].name} → <b style="color:${f.color}">${f.icon} ${f.name}</b>`;
            })
            .join(' · ')}</div>`
        : `<div class="tfuse tdim">⚗ No se fusiona.</div>`;

    // icono: sprite real si existe, con FALLBACK al emoji (igual que la barra de torres)
    return `<div class="enemy-card tower-card">
      <div class="ecard-head">
        <span class="ticon-wrap"><img class="tsprite2" alt="" src="/sprites/tower_${type}_l1.png" /><span class="eicon">${TOWER_ICONS[type]}</span></span>
        <span class="ename">${def.name}</span>
      </div>
      <div class="etraits">${chips}</div>
      <p class="edesc">${def.desc}</p>
      ${costLine}
      <div class="tspec-list">${specHtml}</div>
      ${fuseHtml}
    </div>`;
  }).join('');

  $('guide-towers').innerHTML = `
    <div class="guide-intro">
      <h3>🏰 Torres</h3>
      <p class="edesc">Toda torre sube a <b>nivel 3</b> y ahí elige una de <b>dos ★ especializaciones</b>
      (cuestan 🪙 oro y 🪵 madera). Cada especialización puede subir una vez más al <b>★★ Rango II</b>.
      Dos torres ★ especializadas y pegadas del mismo dueño pueden <b>⚗ fusionarse</b> (ver la pestaña Fusiones).</p>
    </div>
    <div class="bestiary-grid">${cards}</div>`;

  // sprite real con fallback al emoji (mismo truco que buildTowerBar en hud.ts):
  // si el PNG carga, mostramos el sprite y ocultamos el emoji; si falta (404), lo quitamos.
  for (const img of Array.from(document.querySelectorAll<HTMLImageElement>('#guide-towers .tsprite2'))) {
    const emo = img.nextElementSibling as HTMLElement | null;
    img.addEventListener('load', () => {
      img.style.display = 'inline-block';
      if (emo) emo.style.display = 'none';
    });
    img.addEventListener('error', () => img.remove());
  }
}

// ---------- construcción + pestañas ----------

let built = false;
function build(): void {
  if (built) return;
  built = true;
  buildEnemies();
  buildElites();
  buildFusions();
  buildTowers();
  renderShortcuts();
}

const TABS: [string, string][] = [
  ['guide-tab-enemies', 'bestiary-grid'],
  ['guide-tab-elites', 'guide-elites'],
  ['guide-tab-towers', 'guide-towers'],
  ['guide-tab-fusions', 'guide-fusions'],
  ['guide-tab-shortcuts', 'guide-shortcuts'],
];

function showTab(tabId: string): void {
  for (const [btn, pane] of TABS) {
    document.getElementById(btn)?.classList.toggle('active', btn === tabId);
    const el = document.getElementById(pane);
    if (el) el.hidden = btn !== tabId;
  }
}

export function openBestiary(tab: 'enemies' | 'elites' | 'towers' | 'fusions' | 'shortcuts' = 'enemies'): void {
  build();
  showTab(`guide-tab-${tab}`);
  $('overlay-bestiary').hidden = false;
}

function closeBestiary(): void {
  endCapture(); // cerrar cancela cualquier reasignación en curso
  $('overlay-bestiary').hidden = true;
}

// Cablea los botones que abren la guía (home + pausa + HUD del juego) y el cierre.
export function initBestiary(): void {
  build();
  showTab('guide-tab-enemies');
  const overlay = $('overlay-bestiary');
  for (const id of ['btn-bestiary', 'btn-bestiary-pause', 'btn-guide']) {
    const b = document.getElementById(id);
    if (b)
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        openBestiary();
      });
  }
  for (const [btn] of TABS) {
    document.getElementById(btn)?.addEventListener('click', () => showTab(btn));
  }
  $('bestiary-close').addEventListener('click', closeBestiary);
  // clic en el fondo (no en la tarjeta) cierra
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeBestiary();
  });

  // pestaña Atajos: delegación (el pane se rehace en cada reasignación). Un clic
  // en el botón de una acción arma la captura; en «Restaurar» reinicia todo.
  $('guide-shortcuts').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const remap = target.closest<HTMLElement>('[data-remap]');
    if (remap?.dataset.remap) {
      startCapture(remap.dataset.remap as KeymapAction, remap);
      return;
    }
    if (target.closest('[data-reset]')) {
      if (confirm('¿Restaurar TODOS los atajos a sus valores por defecto?')) {
        endCapture();
        resetKeys();
        renderShortcuts();
        syncHotkeyLabels();
        setMsg('↩ Atajos restaurados por defecto.');
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) {
      // durante una captura, onCaptureKey (fase de captura) consume el Escape
      // antes de llegar aquí, así que este solo cierra el overlay «en reposo».
      closeBestiary();
      return;
    }
    // atajo global (desktop): «?» abre la Guía directa en Atajos, fuera de inputs
    if (e.key === '?' && overlay.hidden && desktopKeyboard()) {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      openBestiary('shortcuts');
    }
  });
}
