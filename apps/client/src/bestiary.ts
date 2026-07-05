// Guía del juego: bestiario de monstruos + élites/afijos/oleadas especiales +
// recetas de fusión. Solo cliente. Las descripciones son texto curado; los RASGOS,
// los afijos y las recetas se derivan de los datos reales de balance (@td/shared)
// para no desincronizarse nunca de la mecánica.
import { AFFIX_ORDER, AFFIXES, ENEMY_ORDER, ENEMIES, FUSION_ORDER, FUSIONS, TOWERS } from '@td/shared';
import type { EnemyDef, EnemyTypeId } from '@td/shared';
import { ENEMY_ICONS, TOWER_ICONS } from './renderer.js';

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

// ---------- construcción + pestañas ----------

let built = false;
function build(): void {
  if (built) return;
  built = true;
  buildEnemies();
  buildElites();
  buildFusions();
}

const TABS: [string, string][] = [
  ['guide-tab-enemies', 'bestiary-grid'],
  ['guide-tab-elites', 'guide-elites'],
  ['guide-tab-fusions', 'guide-fusions'],
];

function showTab(tabId: string): void {
  for (const [btn, pane] of TABS) {
    document.getElementById(btn)?.classList.toggle('active', btn === tabId);
    const el = document.getElementById(pane);
    if (el) el.hidden = btn !== tabId;
  }
}

export function openBestiary(tab: 'enemies' | 'elites' | 'fusions' = 'enemies'): void {
  build();
  showTab(`guide-tab-${tab}`);
  $('overlay-bestiary').hidden = false;
}

function closeBestiary(): void {
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) closeBestiary();
  });
}
