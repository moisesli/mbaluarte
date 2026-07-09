import type {
  EnemyState,
  EnemyTypeId,
  GameEvent,
  GameState,
  MapDef,
  PlayerCommand,
  ProjectileState,
  TowerState,
  Vec,
} from '../types.js';
import type { AffixId } from '../types.js';
import { ENEMIES } from '../balance/enemies.js';
import { TOWERS, towerTargetsAir } from '../balance/towers.js';
import { fusionOf, statsOf, towerFires } from '../balance/fusions.js';
import { generateWave, waveBountyMult, waveHpMult } from '../balance/waves.js';
import {
  ASSIST_MIN_DMG_FRAC,
  ASSIST_SHARE,
  BLESSED_BOUNTY_MULT,
  BLESSED_BONUS_MULT,
  ELITE_BOUNTY_MULT,
  ELITE_EXTRA_LIVES,
  ELITE_HP_MULT,
  ELITE_RADIUS_MULT,
  GROWTH_PER_SHOT,
  HORDE_CAP,
  HORDE_LAP_HP_FLOOR,
  HORDE_LAP_HP_LOSS,
  INTERLUDE_SEC,
  LEAK_WAVE_DIV,
  SHRED_DURATION,
  SHRED_RADIUS,
  SPELL_IMMUNE_TESLA_MULT,
  TICK_RATE,
  WAVE_BONUS_BASE,
  WAVE_BONUS_PER_WAVE,
  ORC_RATES,
  WOOD_COST_RANK2,
  WOOD_COST_SPEC,
  WOOD_PER_SEC,
  WOOD_PRICE_BASE,
  WOOD_PRICE_REVERT,
} from '../constants.js';
import { rand } from '../rng.js';
import { dist, pathLength, pathWaypoints, type PlacementContext } from './grid.js';
import { applyCommands } from './commands.js';

export interface SimContext {
  map: MapDef;
  placement: PlacementContext;
  waypoints: Vec[][]; // por camino
  pathLens: number[];
}

export function makeSimContext(map: MapDef, placement: PlacementContext): SimContext {
  return {
    map,
    placement,
    waypoints: map.paths.map((_, i) => pathWaypoints(map, i)),
    pathLens: map.paths.map((_, i) => pathLength(map, i)),
  };
}

function connectedCount(state: GameState): number {
  return Math.max(1, state.players.filter((p) => p.connected).length);
}

function spawnEnemy(
  state: GameState,
  ctx: SimContext,
  type: EnemyTypeId,
  pathIdx: number,
  at?: { x: number; y: number; travelled: number; wpIdx: number },
): EnemyState {
  const def = ENEMIES[type];
  const players = connectedCount(state);
  const hpMult = waveHpMult(Math.max(1, state.wave), state.difficulty, players);
  const start = ctx.waypoints[pathIdx][0];
  const enemy: EnemyState = {
    id: state.nextId++,
    type,
    x: at ? at.x : start.x,
    y: at ? at.y : start.y,
    hp: Math.round(def.hp * hpMult),
    maxHp: Math.round(def.hp * hpMult),
    pathIdx,
    wpIdx: at ? at.wpIdx : 1,
    travelled: at ? at.travelled : 0,
    slowFactor: 1,
    slowUntil: 0,
    poisonDps: 0,
    poisonUntil: 0,
    poisonSrc: 0,
    bountyMult: waveBountyMult(Math.max(1, state.wave)),
    elite: false,
    affixes: [],
    speedMult: 1,
    armorBonus: 0,
    regenBonus: 0,
    dodgeBonus: 0,
    slowResist: 0,
    radiusMult: 1,
    auraRadius: 0,
    auraHps: 0,
    deathSpawn: 0,
    laps: 0,
    spellImmune: def.spellImmune ?? false,
    stunTowerId: 0,
    lastWpIdx: at ? at.wpIdx : 1,
    armorShredUntil: 0,
    invisible: false,
    detected: false,
    dmgBy: {},
  };
  state.enemies.push(enemy);
  return enemy;
}

// Acredita `amount` de daño APLICADO al jugador `ownerId` contra este enemigo (para el
// oro de asistencia). Se guarda por playerId, no por torre: si el dueño vende la torre
// antes de la muerte, su crédito de daño SIGUE contando. Determinista (solo aritmética).
function creditDamage(enemy: EnemyState, ownerId: string, amount: number): void {
  enemy.dmgBy[ownerId] = (enemy.dmgBy[ownerId] ?? 0) + amount;
}

// Aplica SOLO el efecto de un afijo (sin tocar hp/botín/radio). Compartido por
// las élites (×2.6 hp) y la "oleada bendecida" (mismo efecto, sin la subida de hp).
function applyAffixEffect(enemy: EnemyState, a: AffixId): void {
  switch (a) {
    case 'swift':
      enemy.speedMult *= 1.5;
      break;
    case 'armored':
      enemy.armorBonus += 12;
      break;
    case 'regen':
      enemy.regenBonus += Math.max(6, Math.round(enemy.maxHp * 0.02));
      break;
    case 'vampiric':
      enemy.auraRadius = 1.9;
      enemy.auraHps = 22;
      break;
    case 'elusive':
      enemy.dodgeBonus += 0.4;
      break;
    case 'frostward':
      enemy.slowResist = 0.7;
      break;
    case 'explosive':
      enemy.deathSpawn = 3;
      break;
  }
}

// Convierte un enemigo recién generado en élite y le aplica sus afijos.
function makeElite(enemy: EnemyState, affixes: AffixId[]): void {
  enemy.elite = true;
  enemy.affixes = affixes;
  enemy.hp = Math.round(enemy.maxHp * ELITE_HP_MULT);
  enemy.maxHp = enemy.hp;
  enemy.bountyMult *= ELITE_BOUNTY_MULT;
  enemy.radiusMult = ELITE_RADIUS_MULT;
  for (const a of affixes) applyAffixEffect(enemy, a);
}

// Oleada bendecida ("makeElite ligero"): aplica UN afijo común a un enemigo normal
// SIN la subida de hp de élite, con botín ×1.5. No lo marca como élite (no lleva
// corona ni cuesta vida extra al escapar) — es un buff de oleada, no un enemigo raro.
function makeBlessed(enemy: EnemyState, affix: AffixId): void {
  if (!enemy.affixes.includes(affix)) enemy.affixes = [...enemy.affixes, affix];
  enemy.bountyMult *= BLESSED_BOUNTY_MULT;
  applyAffixEffect(enemy, affix);
}

// Multiplicador de bounty del Alquimista para una posición (la del enemigo al
// morir). Escanea las torres tipo Alquimista (con `auraBounty`) cuyo radio cubre
// el punto y toma el MEJOR (+30% base, más en specs) — NO apila. Determinista:
// orden estable de `state.towers`, sin RNG. mult 1 / tower null = sin Alquimista.
// Devuelve también la torre ganadora para acreditarle el oro extra (goldGen).
function bountyMultAt(state: GameState, x: number, y: number): { mult: number; tower: TowerState | null } {
  let best = 1;
  let bestTower: TowerState | null = null;
  for (const t of state.towers) {
    const lvl = statsOf(t);
    const bonus = lvl.auraBounty;
    if (bonus === undefined || bonus <= 0) continue;
    if (dist(t.cx + 0.5, t.cy + 0.5, x, y) > lvl.range) continue;
    const mult = 1 + bonus;
    if (mult > best) {
      best = mult;
      bestTower = t;
    }
  }
  return { mult: best, tower: bestTower };
}

// `viaPoison`: la baja la causó un tick de DoT (veneno) — lo pasa stepEnemies.
// Permite atribuir la mecánica de la Piedra Filosofal (botín ×2 por bajas de SU
// veneno) sin ambigüedad: el dueño del veneno ya viaja en enemy.poisonSrc.
function killEnemy(
  state: GameState,
  ctx: SimContext,
  enemy: EnemyState,
  killerTowerId: number,
  events: GameEvent[],
  viaPoison = false,
): void {
  const def = ENEMIES[enemy.type];
  const tower = state.towers.find((t) => t.id === killerTowerId);
  // Aura del Alquimista: si la posición donde muere el enemigo está cubierta por
  // un Alquimista, su bounty gana +30% (o más en spec). No apila.
  const alch = bountyMultAt(state, enemy.x, enemy.y);
  // Piedra Filosofal (F4.3): las bajas por SU veneno pagan botín multiplicado.
  // Orden de multiplicadores (un solo redondeo al final):
  //   base × bountyMult (oleada/élite/bendición) × aura Alquimista × Piedra Filosofal.
  const poisonMult = viaPoison && tower ? (statsOf(tower).poisonBountyMult ?? 1) : 1;
  const bounty = Math.round(def.bounty * enemy.bountyMult * alch.mult * poisonMult);
  // parte del botín que puso el aura del Alquimista (vs el mismo botín sin ella)
  const alchExtra = alch.tower ? Math.max(0, bounty - Math.round(def.bounty * enemy.bountyMult * poisonMult)) : 0;
  let killerName = '';
  if (tower) {
    tower.kills += 1;
    const owner = state.players.find((p) => p.id === tower.owner);
    if (owner) {
      owner.gold += bounty;
      owner.stats.goldEarned += bounty;
      owner.stats.kills += 1;
      killerName = owner.id;
      // acreditar el EXTRA al Alquimista que cubrió la baja (solo si se pagó)
      if (alch.tower && alchExtra > 0) alch.tower.goldGen += alchExtra;
    }
  }
  events.push({
    e: 'death',
    x: enemy.x,
    y: enemy.y,
    type: enemy.type,
    bounty,
    killer: killerName,
    elite: enemy.elite,
    ...(alchExtra > 0 && killerName ? { alch: alchExtra } : {}),
  });
  // ORO DE ASISTENCIA (co-op): el matador ya cobró su botín completo arriba. Ahora, si
  // el MAYOR dañador acumulado NO es el matador y le hizo ≥ ASSIST_MIN_DMG_FRAC del maxHp,
  // cobra un extra = round(botín × ASSIST_SHARE), mínimo 1. Determinista: el mayor se
  // resuelve con desempate por playerId MENOR, independiente del orden de las claves.
  // Solo paga si hubo matador con dueño (killerName): en solitario el matador es siempre
  // su propio mayor dañador, así que nunca dispara. Las fugas/robos no llaman a killEnemy.
  if (killerName) {
    let topId = '';
    let topDmg = -1;
    for (const pid in enemy.dmgBy) {
      const d = enemy.dmgBy[pid];
      if (d > topDmg || (d === topDmg && pid < topId)) {
        topDmg = d;
        topId = pid;
      }
    }
    if (topId && topId !== killerName && topDmg >= enemy.maxHp * ASSIST_MIN_DMG_FRAC) {
      const assistant = state.players.find((p) => p.id === topId);
      if (assistant) {
        const assistGold = Math.max(1, Math.round(bounty * ASSIST_SHARE));
        assistant.gold += assistGold;
        assistant.stats.goldEarned += assistGold;
        events.push({ e: 'assist', x: enemy.x, y: enemy.y, gold: assistGold, player: topId });
      }
    }
  }
  const spawns: { type: EnemyTypeId; count: number }[] = [];
  if (def.spawnOnDeath) spawns.push(def.spawnOnDeath);
  // afijo explosivo: suelta larvas al morir (además de lo que ya suelte el tipo)
  if (enemy.deathSpawn > 0) spawns.push({ type: 'larva', count: enemy.deathSpawn });
  for (const s of spawns) {
    for (let i = 0; i < s.count; i++) {
      const child = spawnEnemy(state, ctx, s.type, enemy.pathIdx, {
        x: enemy.x + (rand(state) - 0.5) * 0.5,
        y: enemy.y + (rand(state) - 0.5) * 0.5,
        travelled: enemy.travelled,
        wpIdx: enemy.wpIdx,
      });
      // los hijos heredan el escalado de bounty del padre
      child.bountyMult = enemy.bountyMult;
    }
  }
}

// Armadura efectiva de un enemigo: si tiene shred activo (Obús/Metralla II), su
// armadura (plana + bonus de afijo) queda a la MITAD durante la duración.
function effectiveArmor(state: GameState, enemy: EnemyState): number {
  const base = ENEMIES[enemy.type].armor + enemy.armorBonus;
  return enemy.armorShredUntil > state.tick ? base * 0.5 : base;
}

// Aplica daño; devuelve true si el enemigo murió.
// `execute`: si tras el golpe el enemigo queda por debajo de esta fracción de
// vida MÁXIMA, se remata al instante (0 = desactivado).
// `executeCurrent`: Rango II del Cañón de Riel — remata por debajo de esta
// fracción de la vida ACTUAL (anti-tanque). También es daño de hechizo: no
// funciona contra inmunes.
function damageEnemy(
  state: GameState,
  ctx: SimContext,
  enemy: EnemyState,
  amount: number,
  pierceArmor: boolean,
  sourceTowerId: number,
  events: GameEvent[],
  execute = 0,
  executeCurrent = 0,
  shredChance = 0,
): boolean {
  if (enemy.hp <= 0) return false;
  const armor = pierceArmor ? 0 : effectiveArmor(state, enemy);
  const dmg = Math.max(1, amount - armor);
  const hpBefore = enemy.hp;
  enemy.hp -= dmg;
  // execute es daño de HECHIZO: no remata a los inmunes a magia.
  if (execute > 0 && !enemy.spellImmune && enemy.hp > 0 && enemy.hp < enemy.maxHp * execute) {
    enemy.hp = 0; // rematado (umbral sobre la vida MÁX)
  }
  // executeCurrent (Cañón de Riel II): si el golpe hace ≥ 75% de la vida ACTUAL
  // que tenía el objetivo antes del impacto, lo remata. Anti-tanque; no inmunes.
  if (executeCurrent > 0 && !enemy.spellImmune && enemy.hp > 0 && dmg >= hpBefore * executeCurrent) {
    enemy.hp = 0;
  }
  // Shred de armadura (Obús/Metralla II): proc por impacto. Con probabilidad
  // `shredChance` (RNG determinista de la sim), reduce a la mitad la armadura de
  // los enemigos en radio SHRED_RADIUS alrededor del golpeado durante SHRED_DURATION.
  if (shredChance > 0 && rand(state) < shredChance) {
    const until = state.tick + Math.round(SHRED_DURATION * TICK_RATE);
    const n = state.enemies.length; // longitud fija (no shredear crías nacidas ahora)
    for (let i = 0; i < n; i++) {
      const other = state.enemies[i];
      if (other.hp <= 0) continue;
      if (dist(enemy.x, enemy.y, other.x, other.y) <= SHRED_RADIUS) {
        other.armorShredUntil = Math.max(other.armorShredUntil, until);
      }
    }
    events.push({ e: 'shred', x: enemy.x, y: enemy.y, r: SHRED_RADIUS });
  }
  const tower = state.towers.find((t) => t.id === sourceTowerId);
  if (tower) {
    tower.damage += dmg;
    const owner = state.players.find((p) => p.id === tower.owner);
    if (owner) {
      owner.stats.damage += dmg;
      creditDamage(enemy, owner.id, dmg); // crédito para el oro de asistencia
    }
  }
  if (enemy.hp <= 0) {
    killEnemy(state, ctx, enemy, sourceTowerId, events);
    return true;
  }
  return false;
}

function pickTarget(
  state: GameState,
  ctx: SimContext,
  tower: TowerState,
  def: { range: number; minRange?: number },
  canAir: boolean,
  canGround: boolean,
  exclude?: Set<number>,
): EnemyState | null {
  const tx = tower.cx + 0.5;
  const ty = tower.cy + 0.5;

  // Lote 4 · FOCUS: si la torre tiene un enemigo enfocado, ese enemigo MANDA
  // sobre el targetMode… con matices (todos deterministas, solo leen el estado):
  // - muerto/escapado (ya no está en state.enemies o hp<=0) → se LIMPIA el focus
  //   y la torre vuelve a su targetMode normal;
  // - vivo pero FUERA de rango (o aún no targeteable: invisible sin detectar,
  //   aire/tierra que esta torre no alcanza, minRange del mortero) → la torre
  //   ataca normal MIENTRAS TANTO y CONSERVA el focus para cuando vuelva a
  //   entrar en alcance (decisión de UX: perder el focus por un hueco de
  //   cobertura obligaría a re-enfocarlo a mano);
  // - el multidisparo pasa `exclude` con los blancos ya tomados: si el enfocado
  //   ya recibió el primer disparo, los extra se eligen por targetMode normal.
  // El primer salto del Tesla usa este mismo pickTarget → respeta el focus.
  if (tower.focusId > 0) {
    const f = state.enemies.find((e) => e.id === tower.focusId);
    if (!f || f.hp <= 0) {
      tower.focusId = 0; // murió o escapó: volver al automático
    } else if (!exclude || !exclude.has(f.id)) {
      const fdef = ENEMIES[f.type];
      const targetable =
        !(f.invisible && !f.detected) && (fdef.flying ? canAir : canGround);
      if (targetable) {
        const d = dist(tx, ty, f.x, f.y);
        if (d <= def.range && (!def.minRange || d >= def.minRange)) return f;
      }
      // vivo pero fuera de alcance / no visible: seguir con el targetMode normal
    }
  }

  let best: EnemyState | null = null;
  let bestScore = 0;
  for (const e of state.enemies) {
    if (e.hp <= 0) continue;
    if (exclude && exclude.has(e.id)) continue;
    // Lote 3 · un invisible NO detectado no puede ser objetivo DIRECTO de ninguna
    // torre (los efectos de ÁREA sí lo tocan: ver explode/línea perforante/auras).
    if (e.invisible && !e.detected) continue;
    const edef = ENEMIES[e.type];
    if (edef.flying && !canAir) continue;
    if (!edef.flying && !canGround) continue;
    const d = dist(tx, ty, e.x, e.y);
    if (d > def.range) continue;
    if (def.minRange && d < def.minRange) continue;

    let score: number;
    switch (tower.targetMode) {
      case 'first':
        score = -(ctx.pathLens[e.pathIdx] - e.travelled); // menor distancia restante = mayor score
        break;
      case 'last':
        score = ctx.pathLens[e.pathIdx] - e.travelled;
        break;
      case 'strong':
        score = e.hp;
        break;
      case 'weak':
        score = -e.hp;
        break;
      case 'near':
        score = -d;
        break;
    }
    if (best === null || score > bestScore) {
      best = e;
      bestScore = score;
    }
  }
  return best;
}

// Refuerzo que un Estandarte aplica a las torres bajo su aura (fracciones).
export interface AuraBuff {
  dmgMult: number;
  hasteMult: number;
}

// ¿Es esta torre un Estandarte (torre de aura, no dispara)?
function isBanner(lvl: { auraDamage?: number; auraHaste?: number }): boolean {
  return lvl.auraDamage !== undefined || lvl.auraHaste !== undefined;
}

// ¿Esta torre DISPARA? — ahora vive en balance/fusions.ts (Lote 4: la comparten
// fireTower, el Zapador, la validación de focus/halt en commands.ts y el cliente).

// Calcula, por cada torre buffeada, el MEJOR aura de daño y de cadencia de todos
// los Estandartes que la cubren (de CUALQUIER dueño, co-op). No se apila: se toma
// el máximo de cada tipo, no la suma. Solo lee `state`; es determinista (orden
// estable de `state.towers`, sin RNG). Las fusiones con aura (Señor de la Guerra:
// auraDamage; Corazón de Invierno: auraHaste) entran aquí como un Estandarte más.
// Regla de RECEPCIÓN: las torres que DISPARAN reciben auras — por eso el Señor de
// la Guerra (alsoFires) sí las recibe (regla MAX, sin apilar), mientras que un
// estandarte puro nunca recibe la de otro.
export function computeAuras(state: GameState): Map<number, AuraBuff> {
  const buffs = new Map<number, AuraBuff>();
  for (const banner of state.towers) {
    const blvl = statsOf(banner);
    if (!isBanner(blvl)) continue;
    const dmg = blvl.auraDamage ?? 0;
    const haste = blvl.auraHaste ?? 0;
    if (dmg <= 0 && haste <= 0) continue;
    const bx = banner.cx + 0.5;
    const by = banner.cy + 0.5;
    for (const target of state.towers) {
      if (target.id === banner.id) continue;
      const tlvl = statsOf(target);
      if (isBanner(tlvl) && !tlvl.alsoFires) continue; // un estandarte puro no recibe auras; el Señor de la Guerra (dispara) sí
      if (tlvl.incomePerWave) continue; // ni a la mina
      if (tlvl.auraBounty !== undefined) continue; // ni al Alquimista (no dispara)
      if (TOWERS[target.type].onPathOnly) continue; // ni a la Trampa de púas
      if (dist(bx, by, target.cx + 0.5, target.cy + 0.5) > blvl.range) continue;
      let buff = buffs.get(target.id);
      if (!buff) {
        buff = { dmgMult: 0, hasteMult: 0 };
        buffs.set(target.id, buff);
      }
      if (dmg > buff.dmgMult) buff.dmgMult = dmg;
      if (haste > buff.hasteMult) buff.hasteMult = haste;
    }
  }
  return buffs;
}

function fireTower(
  state: GameState,
  ctx: SimContext,
  tower: TowerState,
  events: GameEvent[],
  auras: Map<number, AuraBuff>,
): void {
  const towerDef = TOWERS[tower.type];
  const fusion = fusionOf(tower);
  const lvl = statsOf(tower);
  if (!towerFires(tower)) return;

  // una torre fusionada dispara con el "cuerpo" de su fusión, no el de su tipo base
  const projectileKind = fusion ? fusion.projectileKind : towerDef.projectileKind;
  const color = fusion ? fusion.color : towerDef.color;
  const canAir = fusion ? fusion.targetsAir : towerTargetsAir(tower.type, tower.spec);
  const canGround = fusion ? fusion.targetsGround : towerDef.targetsGround;
  const execute = lvl.execute ?? 0;
  const executeCurrent = lvl.executeCurrent ?? 0;
  const shredChance = lvl.shredChance ?? 0;
  const airBonus = lvl.airBonus ?? 1; // F6.2: multiplicador vs voladores
  const shots = Math.max(1, lvl.shots ?? 1);

  const target = pickTarget(state, ctx, tower, lvl, canAir, canGround);
  if (!target) return;

  // refuerzo del/los Estandarte(s) que cubren esta torre (mejor de cada tipo)
  const buff = auras.get(tower.id);
  const dmgMult = buff ? buff.dmgMult : 0;
  const hasteMult = buff ? buff.hasteMult : 0;
  // Crecimiento permanente (Arco Largo/Explorador II): el bono acumulado se suma al
  // daño base ANTES del aura. Se captura el bono ACTUAL para este disparo y luego se
  // incrementa (una vez POR DISPARO, no por objetivo), de modo que el próximo pega más.
  const growthNow = tower.growthBonus;
  const dmgFor = (base: number) => Math.round((base + growthNow) * (1 + dmgMult));
  const growth = lvl.growth ?? 0;
  if (growth > 0) tower.growthBonus += growth;

  const tx = tower.cx + 0.5;
  const ty = tower.cy + 0.5;
  tower.cooldownLeft = Math.round((lvl.cooldown * TICK_RATE) / (1 + hasteMult));

  // Tormenta de Riel (F4.3): rayo PERFORANTE en línea recta e instantáneo — traza
  // la línea desde la torre a través del objetivo y golpea a TODOS los enemigos
  // cercanos a ella (longitud fija: las crías nacidas de una muerte no lo reciben).
  // El rayo es mágico: a los inmunes les entra −70%, como el Tesla.
  if (lvl.lineWidth) {
    const ddx = target.x - tx;
    const ddy = target.y - ty;
    const len = Math.max(0.001, Math.sqrt(ddx * ddx + ddy * ddy));
    const ux = ddx / len;
    const uy = ddy / len;
    const dmgBase = dmgFor(lvl.damage);
    const lineN = state.enemies.length;
    for (let i = 0; i < lineN; i++) {
      const e = state.enemies[i];
      if (e.hp <= 0) continue;
      const edef = ENEMIES[e.type];
      if (edef.flying && !canAir) continue;
      if (!edef.flying && !canGround) continue;
      const px = e.x - tx;
      const py = e.y - ty;
      const along = px * ux + py * uy; // proyección sobre el rayo
      if (along < -0.2 || along > lvl.range) continue;
      const perp = Math.abs(px * uy - py * ux); // distancia perpendicular a la línea
      if (perp > lvl.lineWidth + edef.radius * e.radiusMult) continue;
      let dmg = e.spellImmune ? Math.max(1, Math.round(dmgBase * SPELL_IMMUNE_TESLA_MULT)) : dmgBase;
      if (edef.flying && airBonus > 1) dmg = Math.round(dmg * airBonus);
      damageEnemy(state, ctx, e, dmg, lvl.pierceArmor ?? false, tower.id, events, execute, executeCurrent, shredChance);
    }
    events.push({ e: 'shot', x: tx, y: ty, tx: tx + ux * lvl.range, ty: ty + uy * lvl.range, kind: 'beam', color });
    return;
  }

  if (projectileKind === 'beam') {
    // Tesla: cadena instantánea (el multidisparo no aplica; se cubre con más saltos)
    const chain = lvl.chain ?? { targets: 1, falloff: 1 };
    const chainN = state.enemies.length; // no encadenar a crías nacidas en esta cadena
    const hitIds = new Set<number>();
    const pts: [number, number][] = [[tx, ty]];
    let current: EnemyState | null = target;
    let dmg = dmgFor(lvl.damage);
    for (let i = 0; i < chain.targets && current; i++) {
      hitIds.add(current.id);
      pts.push([current.x, current.y]);
      // Tempestad Tóxica (issue #7): una cadena con `poison` ENVENENA a cada eslabón
      // por el que salta (mismo criterio que applyPayload: es MAGIA, así que los
      // inmunes quedan exentos). Se aplica antes del daño, como el resto del veneno,
      // y atribuye su fuente a esta torre (poisonSrc) para el crédito de asistencia
      // y la Piedra Filosofal. Ningún Tesla base tiene `poison`, así que esto solo
      // se activa en la Tempestad Tóxica.
      if (lvl.poison && !current.spellImmune) {
        if (lvl.poison.dps >= current.poisonDps) {
          current.poisonDps = lvl.poison.dps;
          current.poisonSrc = tower.id;
        }
        current.poisonUntil = Math.max(current.poisonUntil, state.tick + Math.round(lvl.poison.duration * TICK_RATE));
      }
      // el rayo Tesla es mágico: los inmunes reciben −70% (execute ya se ignora en damageEnemy)
      let linkDmg = current.spellImmune ? Math.max(1, Math.round(dmg * SPELL_IMMUNE_TESLA_MULT)) : dmg;
      if (ENEMIES[current.type].flying && airBonus > 1) linkDmg = Math.round(linkDmg * airBonus);
      damageEnemy(state, ctx, current, linkDmg, lvl.pierceArmor ?? false, tower.id, events, execute, executeCurrent, shredChance);
      dmg = Math.max(1, Math.round(dmg * chain.falloff));
      // buscar el siguiente eslabón cerca del último golpeado
      let next: EnemyState | null = null;
      let nextD = 1.9;
      for (let bi = 0; bi < chainN; bi++) {
        const e = state.enemies[bi];
        if (e.hp <= 0 || hitIds.has(e.id)) continue;
        if (e.invisible && !e.detected) continue; // el rayo no salta a un invisible no detectado
        const edef = ENEMIES[e.type];
        if (edef.flying && !canAir) continue;
        const d = dist(current.x, current.y, e.x, e.y);
        if (d < nextD) {
          next = e;
          nextD = d;
        }
      }
      current = next;
    }
    events.push({ e: 'chain', pts, color });
    return;
  }

  // objetivos para el multidisparo (el primero ya está elegido)
  const targets: EnemyState[] = [target];
  if (shots > 1) {
    const exclude = new Set<number>([target.id]);
    for (let i = 1; i < shots; i++) {
      const t = pickTarget(state, ctx, tower, lvl, canAir, canGround, exclude);
      if (!t) break;
      exclude.add(t.id);
      targets.push(t);
    }
    // RÁFAGA COMPLETA: si hay menos enemigos a tiro que disparos, los sobrantes
    // se reparten entre los objetivos ya elegidos (round-robin). Un Bombardeo de
    // 4 bombas lanza SIEMPRE sus 4 bombas aunque solo quede un enemigo.
    const distinct = targets.length;
    for (let i = 0; targets.length < shots; i++) targets.push(targets[i % distinct]);
  }

  if (projectileKind === 'snipe') {
    // Francotirador: impacto instantáneo, ignora esquiva
    for (const t of targets) {
      events.push({ e: 'shot', x: tx, y: ty, tx: t.x, ty: t.y, kind: 'snipe', color });
      let dmg = dmgFor(lvl.damage);
      if (ENEMIES[t.type].flying && airBonus > 1) dmg = Math.round(dmg * airBonus);
      damageEnemy(state, ctx, t, dmg, lvl.pierceArmor ?? false, tower.id, events, execute, executeCurrent, shredChance);
    }
    return;
  }

  // Proyectil físico (arquero, cañón, hielo, veneno, mortero)
  for (const t of targets) {
    const proj: ProjectileState = {
      id: state.nextId++,
      kind: projectileKind === 'bomb' ? 'bomb' : projectileKind === 'shell' ? 'shell' : 'bullet',
      x: tx,
      y: ty,
      targetId: projectileKind === 'bomb' ? 0 : t.id,
      tx: t.x,
      ty: t.y,
      speed: (lvl.projectileSpeed ?? 12) / TICK_RATE,
      towerId: tower.id,
      owner: tower.owner,
      damage: dmgFor(lvl.damage),
      splash: lvl.splash ?? 0,
      slow: lvl.slow
        ? { factor: lvl.slow.factor, durationTicks: Math.round(lvl.slow.duration * TICK_RATE) }
        : undefined,
      poison: lvl.poison
        ? { dps: lvl.poison.dps, durationTicks: Math.round(lvl.poison.duration * TICK_RATE) }
        : undefined,
      pierceArmor: lvl.pierceArmor ?? false,
      execute,
      color,
      groundOnly: !canAir,
      executeCurrent,
      shredChance,
      airBonus,
    };
    state.projectiles.push(proj);
  }
}

// factor de hielo tras la resistencia del enemigo (frostward). 1 = sin efecto.
function resolvedSlow(factor: number, resist: number): number {
  return factor + (1 - factor) * resist;
}

function applyPayload(
  state: GameState,
  ctx: SimContext,
  proj: ProjectileState,
  enemy: EnemyState,
  events: GameEvent[],
): void {
  // los inmunes a magia ignoran el slow del hielo y el veneno (DoT); solo reciben
  // el daño físico del proyectil.
  if (proj.slow && !enemy.spellImmune) {
    const factor = resolvedSlow(proj.slow.factor, enemy.slowResist);
    if (factor < 1) {
      if (factor < enemy.slowFactor) enemy.slowFactor = factor;
      enemy.slowUntil = Math.max(enemy.slowUntil, state.tick + proj.slow.durationTicks);
    }
  }
  if (proj.poison && !enemy.spellImmune) {
    if (proj.poison.dps >= enemy.poisonDps) {
      enemy.poisonDps = proj.poison.dps;
      enemy.poisonSrc = proj.towerId;
    }
    enemy.poisonUntil = Math.max(enemy.poisonUntil, state.tick + proj.poison.durationTicks);
  }
  // F6.2 · bonus antiaéreo (Metralla): se resuelve AQUÍ, por enemigo golpeado —
  // en un splash mixto solo los voladores reciben el extra.
  const dmgAmount =
    proj.airBonus > 1 && ENEMIES[enemy.type].flying ? Math.round(proj.damage * proj.airBonus) : proj.damage;
  damageEnemy(state, ctx, enemy, dmgAmount, proj.pierceArmor, proj.towerId, events, proj.execute, proj.executeCurrent, proj.shredChance);
}

function explode(
  state: GameState,
  ctx: SimContext,
  proj: ProjectileState,
  x: number,
  y: number,
  events: GameEvent[],
): void {
  events.push({ e: 'hit', x, y, r: Math.max(0.25, proj.splash), kind: proj.splash > 0 ? 'splash' : 'impact' });
  if (proj.splash > 0) {
    // longitud fija: si una muerte genera crías (push a state.enemies) NO deben
    // recibir este mismo golpe de área (nacen en la posición del padre)
    const n = state.enemies.length;
    for (let i = 0; i < n; i++) {
      const e = state.enemies[i];
      if (e.hp <= 0) continue;
      if (proj.groundOnly && ENEMIES[e.type].flying) continue;
      if (dist(x, y, e.x, e.y) <= proj.splash + ENEMIES[e.type].radius * e.radiusMult) {
        applyPayload(state, ctx, proj, e, events);
      }
    }
  }
}

function stepProjectiles(state: GameState, ctx: SimContext, events: GameEvent[]): void {
  const alive: ProjectileState[] = [];
  for (const proj of state.projectiles) {
    // actualizar destino si el objetivo sigue vivo (homing)
    if (proj.targetId !== 0) {
      const target = state.enemies.find((e) => e.id === proj.targetId && e.hp > 0);
      if (target) {
        proj.tx = target.x;
        proj.ty = target.y;
      } else {
        proj.targetId = 0; // sigue hasta el último punto conocido
      }
    }
    const d = dist(proj.x, proj.y, proj.tx, proj.ty);
    if (d <= proj.speed) {
      proj.x = proj.tx;
      proj.y = proj.ty;
      if (proj.kind === 'bomb' || proj.targetId === 0) {
        explode(state, ctx, proj, proj.x, proj.y, events);
        if (proj.splash === 0 && proj.targetId !== 0) {
          // sin splash y sin objetivo: se pierde
        }
      } else {
        const target = state.enemies.find((e) => e.id === proj.targetId);
        if (target && target.hp > 0) {
          const edef = ENEMIES[target.type];
          const dodge = Math.min(0.9, (edef.dodge ?? 0) + target.dodgeBonus);
          if (dodge > 0 && rand(state) < dodge) {
            events.push({ e: 'miss', x: target.x, y: target.y });
          } else if (proj.splash > 0) {
            explode(state, ctx, proj, proj.x, proj.y, events);
          } else {
            events.push({
              e: 'hit',
              x: proj.x,
              y: proj.y,
              r: 0.2,
              kind: proj.poison ? 'poison' : proj.slow ? 'frost' : 'impact',
            });
            applyPayload(state, ctx, proj, target, events);
          }
        }
      }
      continue; // proyectil consumido
    }
    proj.x += ((proj.tx - proj.x) / d) * proj.speed;
    proj.y += ((proj.ty - proj.y) / d) * proj.speed;
    alive.push(proj);
  }
  state.projectiles = alive;
}

// Torre "aturdible" más cercana a un punto, dentro de `maxDist` (celdas), que
// dispare de verdad y no esté ya reclamada por otro zapador este tick. Orden
// estable: recorre `state.towers` en orden y desempata por el primero (determinista).
function nearestSappableTower(
  state: GameState,
  x: number,
  y: number,
  maxDist: number,
  claimed: Set<number>,
): TowerState | null {
  let best: TowerState | null = null;
  let bestD = maxDist;
  for (const t of state.towers) {
    if (claimed.has(t.id)) continue;
    if (!towerFires(t)) continue; // aturdir una mina/aura/trampa no hace nada
    const d = dist(x, y, t.cx + 0.5, t.cy + 0.5);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

function stepEnemies(state: GameState, ctx: SimContext, events: GameEvent[]): void {
  const players = connectedCount(state);
  const speedMult = state.difficulty === 'easy' ? 0.9 : state.difficulty === 'hard' ? 1.08 : 1;
  const stunTicks = 2; // ticks que dura el aturdimiento del Zapador (se renueva cada tick)
  const sapRange = 1.6; // alcance al que un zapador se para junto a una torre
  // Torres ya reclamadas por un zapador ESTE tick: dos zapadores nunca aturden la
  // misma torre (aturdir lo ya aturdido no aporta nada). Determinista: los enemigos
  // se recorren en orden estable y el primero que llega se la queda.
  const sapClaimed = new Set<number>();

  // longitud fija: las crías que nacen al morir un enemigo (veneno) NO deben
  // moverse/curar en su propio tick de nacimiento; se procesan en el siguiente
  const n = state.enemies.length;
  for (let i = 0; i < n; i++) {
    const enemy = state.enemies[i];
    if (enemy.hp <= 0) continue;
    const def = ENEMIES[enemy.type];

    // efectos por tick
    if (enemy.slowUntil <= state.tick) enemy.slowFactor = 1;
    if (enemy.poisonUntil > state.tick && enemy.poisonDps > 0) {
      // el veneno ignora armadura por diseño
      enemy.hp -= enemy.poisonDps / TICK_RATE;
      const tower = state.towers.find((t) => t.id === enemy.poisonSrc);
      if (tower) {
        const tick = enemy.poisonDps / TICK_RATE;
        tower.damage += tick;
        const owner = state.players.find((p) => p.id === tower.owner);
        if (owner) {
          owner.stats.damage += tick;
          creditDamage(enemy, owner.id, tick); // el DoT también da crédito de asistencia a su dueño
        }
      }
      if (enemy.hp <= 0) {
        // baja por DoT: viaPoison=true (la Piedra Filosofal paga botín ×2 por estas)
        killEnemy(state, ctx, enemy, enemy.poisonSrc, events, true);
        continue;
      }
    }
    const regen = (def.regen ?? 0) + enemy.regenBonus;
    if (regen > 0 && enemy.hp < enemy.maxHp) {
      enemy.hp = Math.min(enemy.maxHp, enemy.hp + regen / TICK_RATE);
    }
    // aura de curación: la del tipo (chamán) y la del afijo vampírico
    const auraR = Math.max(def.healAura?.radius ?? 0, enemy.auraRadius);
    const auraHps = Math.max(def.healAura?.hps ?? 0, enemy.auraHps);
    if (auraR > 0 && auraHps > 0) {
      for (const other of state.enemies) {
        if (other === enemy || other.hp <= 0 || other.hp >= other.maxHp) continue;
        if (dist(enemy.x, enemy.y, other.x, other.y) <= auraR) {
          other.hp = Math.min(other.maxHp, other.hp + auraHps / TICK_RATE);
        }
      }
    }

    // Berserker: bajo cierta fracción de vida corre más rápido (determinista, lee hp).
    let rageMult = 1;
    if (def.berserkBelow && enemy.hp < enemy.maxHp * def.berserkBelow) {
      rageMult = def.berserkMult ?? 1;
    }

    // Zapador: si hay una torre LIBRE a su alcance (que dispare y que ningún otro
    // zapador esté aturdiendo), se DETIENE junto a ella y la aturde mientras siga
    // vivo (el aturdimiento se renueva cada tick; al morir el zapador, expira solo
    // en `stunTicks`). Si todas las torres cercanas ya están tomadas, SIGUE
    // CAMINANDO en busca de otra. Prefiere quedarse con su torre actual para no
    // saltar entre torres. Determinista: orden estable + set de reclamadas.
    let sapping = false;
    if (def.sapper) {
      let tower: TowerState | null = null;
      if (enemy.stunTowerId > 0) {
        const cur = state.towers.find((t) => t.id === enemy.stunTowerId);
        if (
          cur &&
          !sapClaimed.has(cur.id) &&
          towerFires(cur) &&
          dist(enemy.x, enemy.y, cur.cx + 0.5, cur.cy + 0.5) <= sapRange
        ) {
          tower = cur;
        }
      }
      if (!tower) tower = nearestSappableTower(state, enemy.x, enemy.y, sapRange, sapClaimed);
      if (tower) {
        sapClaimed.add(tower.id);
        tower.stunnedUntil = state.tick + stunTicks;
        enemy.stunTowerId = tower.id;
        sapping = true;
      } else {
        enemy.stunTowerId = 0;
      }
    }

    // movimiento por waypoints (el zapador que está aturdiendo NO avanza)
    let moveLeft = sapping
      ? 0
      : (def.speed * speedMult * enemy.speedMult * enemy.slowFactor * rageMult) / TICK_RATE;
    const wps = ctx.waypoints[enemy.pathIdx];
    while (moveLeft > 0 && enemy.wpIdx < wps.length) {
      const wp = wps[enemy.wpIdx];
      const d = dist(enemy.x, enemy.y, wp.x, wp.y);
      if (d <= moveLeft) {
        enemy.x = wp.x;
        enemy.y = wp.y;
        enemy.travelled += d;
        moveLeft -= d;
        enemy.wpIdx += 1;
      } else {
        enemy.x += ((wp.x - enemy.x) / d) * moveLeft;
        enemy.y += ((wp.y - enemy.y) / d) * moveLeft;
        enemy.travelled += moveLeft;
        moveLeft = 0;
      }
    }

    // Behemot: al CRUZAR una esquina (avanza el índice de waypoint) aturde todas las
    // torres en radio. Se dispara una vez por esquina (compara con lastWpIdx).
    if (def.stunOnCorner && enemy.wpIdx > enemy.lastWpIdx && enemy.wpIdx < wps.length) {
      const stun = state.tick + Math.round(def.stunOnCorner.seconds * TICK_RATE);
      for (const t of state.towers) {
        if (dist(enemy.x, enemy.y, t.cx + 0.5, t.cy + 0.5) <= def.stunOnCorner.radius) {
          t.stunnedUntil = Math.max(t.stunnedUntil, stun);
        }
      }
    }
    enemy.lastWpIdx = enemy.wpIdx;

    // llegó al final del camino
    if (enemy.wpIdx >= wps.length) {
      if (state.mode === 'horde') {
        // BUCLE: no escapa ni quita vidas — se teletransporta al inicio de su
        // camino conservando su hp actual, pero gana un stack de CANSANCIO.
        const start = ctx.waypoints[enemy.pathIdx][0];
        enemy.x = start.x;
        enemy.y = start.y;
        enemy.wpIdx = 1;
        enemy.travelled = 0;
        // cansancio: −10% del maxHp BASE por vuelta (suelo 10%). Reconstruimos el
        // maxHp base a partir de la retención de la vuelta actual y aplicamos la
        // de la siguiente, clampeando la hp. Determinista (solo aritmética).
        const prevRetention = Math.max(HORDE_LAP_HP_FLOOR, 1 - enemy.laps * HORDE_LAP_HP_LOSS);
        const baseMaxHp = enemy.maxHp / prevRetention;
        enemy.laps += 1;
        const nextRetention = Math.max(HORDE_LAP_HP_FLOOR, 1 - enemy.laps * HORDE_LAP_HP_LOSS);
        enemy.maxHp = Math.max(1, Math.round(baseMaxHp * nextRetention));
        if (enemy.hp > enemy.maxHp) enemy.hp = enemy.maxHp;
      } else if (def.stealGold) {
        // Ladrón: no quita vidas — roba oro repartido entre los jugadores. Reparto
        // determinista (orden estable de players; el resto va al primero).
        enemy.hp = 0;
        const total = def.stealGold;
        const ps = state.players;
        const per = Math.floor(total / ps.length);
        let taken = 0;
        for (let pi = 0; pi < ps.length; pi++) {
          const amount = pi === 0 ? total - per * (ps.length - 1) : per;
          const real = Math.min(ps[pi].gold, amount);
          ps[pi].gold -= real;
          taken += real;
        }
        events.push({ e: 'steal', gold: taken, x: enemy.x, y: enemy.y });
      } else {
        // fuga escalonada: cuesta `livesCost + floor(oleada/10)` (+extra si es élite).
        const cost = def.livesCost + Math.floor(state.wave / LEAK_WAVE_DIV) + (enemy.elite ? ELITE_EXTRA_LIVES : 0);
        state.lives = Math.max(0, state.lives - cost);
        enemy.hp = 0; // sale del juego sin bounty
        events.push({ e: 'leak', lives: state.lives, type: enemy.type });
        if (state.lives <= 0 && !state.over) {
          state.over = { victory: false };
          events.push({ e: 'gameover', victory: false });
        }
      }
    }
  }

  state.enemies = state.enemies.filter((e) => e.hp > 0);

  // DERROTA POR SATURACIÓN (horda): si hay demasiados enemigos vivos a la vez,
  // la fortaleza cae. Se evalúa tras el filtrado; el spawn de esta oleada ya
  // ocurrió en stepWaves (antes de stepEnemies), así que el conteo es fiel.
  if (state.mode === 'horde' && !state.over) {
    const cap = HORDE_CAP[state.difficulty] ?? HORDE_CAP.normal;
    if (state.enemies.length >= cap) {
      state.over = { victory: false };
      events.push({ e: 'gameover', victory: false });
    }
  }
  void players;
}

function stepWaves(state: GameState, ctx: SimContext, events: GameEvent[]): void {
  if (state.over) return;

  if (state.waveState === 'interlude') {
    // generar la próxima oleada una sola vez al entrar al interludio,
    // así la vista previa coincide exactamente con lo que saldrá
    if (state.pendingWave === null) {
      const gen = generateWave(state, state.wave + 1, connectedCount(state), ctx.map.paths.length);
      state.pendingWave = gen.entries;
      state.pendingBoss = gen.hasBoss;
      state.pendingBossType = gen.bossType;
      state.nextWaveComp = gen.comp;
      // etiquetas de telegrafía para la vista previa (leídas por buildSnap)
      state.nextWaveImmune = gen.immune;
      state.nextWaveBlessed = gen.blessed;
      state.nextWaveFlying = gen.flying;
      state.nextWaveInvisible = gen.invisible;
      state.nextWaveBoss = gen.bossType;
    }
    state.interludeLeft -= 1;
    if (state.interludeLeft <= 0) {
      state.wave += 1;
      state.spawnQueue = state.pendingWave;
      state.spawnCooldown = 0;
      state.waveState = 'active';
      // el bono de fin de oleada se multiplica en las oleadas bendecidas
      state.blessedBonusMult = state.nextWaveBlessed ? BLESSED_BONUS_MULT : 1;
      events.push({ e: 'wave_start', wave: state.wave, comp: state.nextWaveComp });
      if (state.pendingBoss && state.pendingBossType) {
        events.push({ e: 'boss', name: ENEMIES[state.pendingBossType].name });
      }
      state.pendingWave = null;
      state.pendingBoss = false;
      state.pendingBossType = null;
      state.nextWaveComp = [];
      state.nextWaveImmune = false;
      state.nextWaveBlessed = false;
      state.nextWaveFlying = false;
      state.nextWaveInvisible = false;
      state.nextWaveBoss = null;
    }
    return;
  }

  // spawning
  if (state.spawnQueue.length > 0) {
    state.spawnCooldown -= 1;
    while (state.spawnCooldown <= 0 && state.spawnQueue.length > 0) {
      const entry = state.spawnQueue.shift()!;
      const enemy = spawnEnemy(state, ctx, entry.type, entry.pathIdx);
      if (entry.elite) makeElite(enemy, entry.affixes ?? []);
      // oleada inmune: todos los enemigos normales (incl. élites) son inmunes a magia.
      // Los JEFES quedan EXENTOS: ya son un muro de por sí; hacerlos también inmunes a
      // hielo/veneno/tesla los volvería casi invencibles (doble castigo).
      if (entry.immune && !ENEMIES[entry.type].boss) enemy.spellImmune = true;
      // oleada bendecida: afijo común ligero (sin ×2.6 hp) — no en jefes
      if (entry.blessed && entry.blessedAffix && !ENEMIES[entry.type].boss) {
        makeBlessed(enemy, entry.blessedAffix);
      }
      // Lote 3 · oleada invisible: los no-jefe nacen invisibles (un Sentry los revela)
      if (entry.invisible && !ENEMIES[entry.type].boss) enemy.invisible = true;
      state.spawnCooldown = state.spawnQueue.length > 0 ? state.spawnQueue[0].delay : 0;
    }
  }

  // fin de oleada: cola de spawn vacía. En classic/endless exigimos además que no
  // queden enemigos vivos; en HORDA no, porque la horda da vueltas indefinidamente
  // y nunca se vaciaría el mapa — la siguiente oleada arranca al vaciarse la cola.
  const waveCleared =
    state.spawnQueue.length === 0 && (state.mode === 'horde' || state.enemies.length === 0);
  if (waveCleared) {
    // el bono se multiplica en las oleadas bendecidas (riesgo/recompensa)
    const bonus = Math.round((WAVE_BONUS_BASE + state.wave * WAVE_BONUS_PER_WAVE) * state.blessedBonusMult);
    state.blessedBonusMult = 1;
    for (const p of state.players) {
      p.gold += bonus;
      p.stats.goldEarned += bonus;
    }
    // ingresos de las minas (la Casa de Moneda reparte a todo el equipo)
    for (const tower of state.towers) {
      const lvl = statsOf(tower);
      if (!lvl.incomePerWave) continue;
      const amount = lvl.incomePerWave;
      const recipients = lvl.incomeToAll ? state.players : state.players.filter((p) => p.id === tower.owner);
      for (const p of recipients) {
        p.gold += amount;
        p.stats.goldEarned += amount;
      }
      events.push({
        e: 'income',
        playerId: tower.owner,
        amount,
        x: tower.cx + 0.5,
        y: tower.cy + 0.5,
      });
    }
    events.push({ e: 'wave_end', wave: state.wave, bonus });

    // el mercado de madera "respira": el precio revierte suave hacia la base
    // al final de cada oleada (aritmética pura, determinista)
    state.woodPrice += (WOOD_PRICE_BASE - state.woodPrice) * WOOD_PRICE_REVERT;

    if (state.totalWaves > 0 && state.wave >= state.totalWaves) {
      state.over = { victory: true };
      events.push({ e: 'gameover', victory: true });
      return;
    }

    state.waveState = 'interlude';
    state.interludeLeft = INTERLUDE_SEC * TICK_RATE;
  }
}

function stepTowers(state: GameState, ctx: SimContext, events: GameEvent[], auras: Map<number, AuraBuff>): void {
  for (const tower of state.towers) {
    // torre ATURDIDA (Zapador / Behemot): no dispara mientras dure el aturdimiento.
    if (tower.stunnedUntil > state.tick) continue;
    // Lote 4 · torre DETENIDA (comando halt): no dispara hasta que la reanuden.
    // Mismo gate que el aturdimiento: tampoco consume cooldown (al reanudar,
    // retoma el enfriamiento donde lo dejó — coherente con stunned).
    if (tower.halted) continue;
    if (tower.cooldownLeft > 0) {
      tower.cooldownLeft -= 1;
      continue;
    }
    fireTower(state, ctx, tower, events, auras);
  }
}

// Torres de camino (F4.2/F4.4): NO disparan; reaccionan a los enemigos que pisan
// su celda. Trampa de púas: cada tick con ≥1 enemigo encima golpea a TODOS los de
// la celda (daño FÍSICO, funciona contra inmunes) y consume 1 carga. Barril
// explosivo (`detonates`): en cuanto la pisan DETONA una única vez — ELIMINA a
// todos los terrestres no-jefe en radio `splash` (los jefes reciben `damage`
// físico) — y desaparece. A 0 cargas se
// auto-eliminan (poof discreto, SIN aviso de chat). Determinista: orden estable de
// torres y enemigos, sin RNG. Se ejecuta tras el movimiento de enemigos.
function stepTraps(state: GameState, ctx: SimContext, events: GameEvent[]): void {
  let removedAny = false;
  for (const trap of state.towers) {
    const def = TOWERS[trap.type];
    if (!def.onPathOnly) continue; // solo las torres de camino
    if (trap.charges <= 0) continue;
    const lvl = statsOf(trap);
    // longitud fija: las crías que nazcan por una muerte no reciben este mismo golpe
    const n = state.enemies.length;

    if (def.detonates) {
      // Barril: ¿algún enemigo terrestre vivo pisa su celda? → detonar.
      let triggered = false;
      for (let i = 0; i < n && !triggered; i++) {
        const e = state.enemies[i];
        if (e.hp <= 0 || ENEMIES[e.type].flying) continue;
        if (Math.floor(e.x) === trap.cx && Math.floor(e.y) === trap.cy) triggered = true;
      }
      if (triggered) {
        const bx = trap.cx + 0.5;
        const by = trap.cy + 0.5;
        const splash = lvl.splash ?? 1.5;
        for (let i = 0; i < n; i++) {
          const e = state.enemies[i];
          if (e.hp <= 0 || ENEMIES[e.type].flying) continue; // explosión a ras de suelo
          if (dist(bx, by, e.x, e.y) <= splash + ENEMIES[e.type].radius * e.radiusMult) {
            if (ENEMIES[e.type].boss) {
              // los JEFES no se eliminan: reciben el daño del barril (físico, con armadura)
              damageEnemy(state, ctx, e, lvl.damage, false, trap.id, events, 0, 0, 0);
            } else {
              // ELIMINACIÓN: cualquier no-jefe dentro del radio muere, da igual su
              // vida, armadura o inmunidad. El daño aplicado = su vida actual (con
              // perforación) para que las estadísticas reflejen la vida retirada.
              damageEnemy(state, ctx, e, Math.max(1, Math.ceil(e.hp)), true, trap.id, events, 0, 0, 0);
            }
          }
        }
        trap.charges = 0;
        removedAny = true;
        events.push({ e: 'hit', x: bx, y: by, r: splash, kind: 'splash' });
        events.push({ e: 'sell', x: bx, y: by, refund: 0 });
      }
      continue;
    }

    // Trampa de púas: golpea a los enemigos cuya celda coincide con la suya.
    let hitAny = false;
    for (let i = 0; i < n; i++) {
      const e = state.enemies[i];
      if (e.hp <= 0) continue;
      if (ENEMIES[e.type].flying) continue; // la trampa está en el suelo
      if (Math.floor(e.x) !== trap.cx || Math.floor(e.y) !== trap.cy) continue;
      hitAny = true;
      // daño físico (pierceArmor irrelevante: es daño directo, funciona vs inmunes)
      damageEnemy(state, ctx, e, lvl.damage, false, trap.id, events, 0, 0, 0);
    }
    if (hitAny) {
      trap.charges -= 1;
      events.push({ e: 'hit', x: trap.cx + 0.5, y: trap.cy + 0.5, r: 0.4, kind: 'impact' });
      if (trap.charges <= 0) {
        removedAny = true;
        // Sin aviso de chat: con varias trampas agotándose a la vez spameaba el chat.
        // El `sell` (refund 0) le basta al cliente para un poof discreto sin texto de oro.
        events.push({ e: 'sell', x: trap.cx + 0.5, y: trap.cy + 0.5, refund: 0 });
      }
    }
  }
  if (removedAny) state.towers = state.towers.filter((t) => !(TOWERS[t.type].onPathOnly && t.charges <= 0));
}

// Auras pasivas (Escarcha Eterna, Corazón de Invierno): ralentizan sin disparar
// a todo lo que rodean. Misma regla que el hielo: mejor factor, no apila; los
// inmunes a magia quedan exentos.
function stepTowerAuras(state: GameState): void {
  for (const tower of state.towers) {
    const lvl = statsOf(tower);
    const aura = lvl.slowAura;
    if (!aura) continue;
    const fusion = fusionOf(tower);
    const canAir = fusion ? fusion.targetsAir : towerTargetsAir(tower.type, tower.spec);
    const tx = tower.cx + 0.5;
    const ty = tower.cy + 0.5;
    for (const e of state.enemies) {
      if (e.hp <= 0) continue;
      if (e.spellImmune) continue; // los inmunes ignoran el aura de Escarcha
      if (ENEMIES[e.type].flying && !canAir) continue;
      if (dist(tx, ty, e.x, e.y) > aura.radius) continue;
      const factor = resolvedSlow(aura.factor, e.slowResist);
      if (factor < e.slowFactor) e.slowFactor = factor;
      // se renueva mientras siga dentro del aura (un par de ticks de margen)
      if (factor < 1) e.slowUntil = Math.max(e.slowUntil, state.tick + 2);
    }
  }
}

// Lote 3 · DETECCIÓN de invisibles (recalculada CADA tick en la sim, determinista):
// un invisible que entra en el radio (= `range`) de algún SENTRY del equipo (torres
// con `detects`) queda `detected` y REVELADO el resto de su recorrido (detección
// PEGAJOSA, estilo Green TD: basta un Sentry en el camino para revelar la oleada;
// caminos largos no exigen cobertura total). Determinista: sin RNG ni reloj, orden
// estable de `state.towers`/`state.enemies`. Se corre tras mover a los enemigos y
// antes de que las torres apunten, para que `pickTarget` lea la detección de este tick.
function recomputeDetection(state: GameState): void {
  for (const t of state.towers) {
    if (!TOWERS[t.type].detects) continue;
    const radius = statsOf(t).range;
    const tx = t.cx + 0.5;
    const ty = t.cy + 0.5;
    for (const e of state.enemies) {
      if (!e.invisible || e.detected) continue; // ya revelado: sigue revelado (pegajoso)
      if (dist(tx, ty, e.x, e.y) <= radius) e.detected = true;
    }
  }
}

// Avanza un tick de la simulación. Muta `state` y devuelve los eventos del tick.
export function stepGame(
  state: GameState,
  ctx: SimContext,
  commands: PlayerCommand[],
): GameEvent[] {
  const events: GameEvent[] = [];
  if (state.over) {
    state.tick += 1;
    return events;
  }
  // aviso de sistema al arrancar la partida (una sola vez, tick 0): telegrafía las
  // reglas duras de Green TD. Solo en classic/endless (la horda no tiene fuga/jefes fijos).
  if (state.tick === 0 && state.mode !== 'horde') {
    events.push({
      e: 'sys',
      msg: '🛡 Las oleadas múltiplos de 5 (desde la 10) son INMUNES a la magia: ten daño físico de reserva. ☠ Los jefes llegan cada 10 (la Quimera voladora en la 15/25/35). 👁 Algunas oleadas son INVISIBLES: compra un Sentry en la 🛒 Tienda para revelarlas.',
    });
  }
  if (state.tick === 0) {
    events.push({
      e: 'sys',
      msg: `🪵 Tu orco leñador tala madera sin parar (+${WOOD_PER_SEC}/s). La necesitas para ★especializar (${WOOD_COST_SPEC}) y el ★★Rango II (${WOOD_COST_RANK2}). Toca el chip 🪵 para COMERCIAR madera y MEJORAR a tu orco.`,
    });
  }
  // F5.2 · madera: el orco leñador de cada jugador tala automáticamente (más
  // rápido a más nivel, F5.5). Aritmética pura por tick (determinista); también
  // para desconectados, como el ingreso de las minas.
  for (const p of state.players) {
    p.wood += ORC_RATES[Math.min(p.orcLevel, ORC_RATES.length) - 1] / TICK_RATE;
  }
  applyCommands(state, ctx.map, ctx.placement, commands, events);
  stepWaves(state, ctx, events);
  stepTowerAuras(state);
  stepEnemies(state, ctx, events);
  // Lote 3 · detección de invisibles por los Sentry: se recalcula tras el movimiento
  // y ANTES de que las torres apunten (stepTowers), para que pickTarget lea `detected`.
  recomputeDetection(state);
  // Trampas de púas: golpean a los enemigos que pisan su celda y consumen carga.
  stepTraps(state, ctx, events);
  // refuerzo de los Estandartes: se calcula una vez por tick (solo lee el estado)
  // y se pasa a las torres para que multipliquen daño/cadencia al disparar.
  const auras = computeAuras(state);
  stepTowers(state, ctx, events, auras);
  stepProjectiles(state, ctx, events);
  state.enemies = state.enemies.filter((e) => e.hp > 0);
  state.tick += 1;
  return events;
}
