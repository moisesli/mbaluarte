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
import { TOWERS, activeStats, towerTargetsAir } from '../balance/towers.js';
import { generateWave, waveBountyMult, waveHpMult } from '../balance/waves.js';
import {
  BLESSED_BOUNTY_MULT,
  BLESSED_BONUS_MULT,
  ELITE_BOUNTY_MULT,
  ELITE_EXTRA_LIVES,
  ELITE_HP_MULT,
  ELITE_RADIUS_MULT,
  HORDE_CAP,
  HORDE_LAP_HP_FLOOR,
  HORDE_LAP_HP_LOSS,
  INTERLUDE_SEC,
  LEAK_WAVE_DIV,
  SPELL_IMMUNE_TESLA_MULT,
  TICK_RATE,
  WAVE_BONUS_BASE,
  WAVE_BONUS_PER_WAVE,
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
  };
  state.enemies.push(enemy);
  return enemy;
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

function killEnemy(
  state: GameState,
  ctx: SimContext,
  enemy: EnemyState,
  killerTowerId: number,
  events: GameEvent[],
): void {
  const def = ENEMIES[enemy.type];
  const bounty = Math.round(def.bounty * enemy.bountyMult);
  const tower = state.towers.find((t) => t.id === killerTowerId);
  let killerName = '';
  if (tower) {
    tower.kills += 1;
    const owner = state.players.find((p) => p.id === tower.owner);
    if (owner) {
      owner.gold += bounty;
      owner.stats.goldEarned += bounty;
      owner.stats.kills += 1;
      killerName = owner.id;
    }
  }
  events.push({ e: 'death', x: enemy.x, y: enemy.y, type: enemy.type, bounty, killer: killerName, elite: enemy.elite });
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

// Aplica daño; devuelve true si el enemigo murió.
// `execute`: si tras el golpe el enemigo queda por debajo de esta fracción de
// vida, se remata al instante (0 = desactivado).
function damageEnemy(
  state: GameState,
  ctx: SimContext,
  enemy: EnemyState,
  amount: number,
  pierceArmor: boolean,
  sourceTowerId: number,
  events: GameEvent[],
  execute = 0,
): boolean {
  if (enemy.hp <= 0) return false;
  const def = ENEMIES[enemy.type];
  const armor = pierceArmor ? 0 : def.armor + enemy.armorBonus;
  const dmg = Math.max(1, amount - armor);
  enemy.hp -= dmg;
  // execute es daño de HECHIZO: no remata a los inmunes a magia.
  if (execute > 0 && !enemy.spellImmune && enemy.hp > 0 && enemy.hp < enemy.maxHp * execute) {
    enemy.hp = 0; // rematado
  }
  const tower = state.towers.find((t) => t.id === sourceTowerId);
  if (tower) {
    tower.damage += dmg;
    const owner = state.players.find((p) => p.id === tower.owner);
    if (owner) owner.stats.damage += dmg;
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
  let best: EnemyState | null = null;
  let bestScore = 0;
  for (const e of state.enemies) {
    if (e.hp <= 0) continue;
    if (exclude && exclude.has(e.id)) continue;
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

// Calcula, por cada torre buffeada, el MEJOR aura de daño y de cadencia de todos
// los Estandartes que la cubren (de CUALQUIER dueño, co-op). No se apila: se toma
// el máximo de cada tipo, no la suma. Solo lee `state`; es determinista (orden
// estable de `state.towers`, sin RNG).
export function computeAuras(state: GameState): Map<number, AuraBuff> {
  const buffs = new Map<number, AuraBuff>();
  for (const banner of state.towers) {
    const blvl = activeStats(banner.type, banner.level, banner.spec);
    if (!isBanner(blvl)) continue;
    const dmg = blvl.auraDamage ?? 0;
    const haste = blvl.auraHaste ?? 0;
    if (dmg <= 0 && haste <= 0) continue;
    const bx = banner.cx + 0.5;
    const by = banner.cy + 0.5;
    for (const target of state.towers) {
      if (target.id === banner.id) continue;
      const tlvl = activeStats(target.type, target.level, target.spec);
      if (isBanner(tlvl)) continue; // un estandarte no buffea a otro estandarte
      if (tlvl.incomePerWave) continue; // ni a la mina
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
  const lvl = activeStats(tower.type, tower.level, tower.spec);
  if (lvl.incomePerWave || lvl.slowAura || isBanner(lvl)) return; // la mina, la permafrost y el estandarte no disparan

  const canAir = towerTargetsAir(tower.type, tower.spec);
  const canGround = towerDef.targetsGround;
  const execute = lvl.execute ?? 0;
  const shots = Math.max(1, lvl.shots ?? 1);

  // refuerzo del/los Estandarte(s) que cubren esta torre (mejor de cada tipo)
  const buff = auras.get(tower.id);
  const dmgMult = buff ? buff.dmgMult : 0;
  const hasteMult = buff ? buff.hasteMult : 0;
  const dmgFor = (base: number) => Math.round(base * (1 + dmgMult));

  const target = pickTarget(state, ctx, tower, lvl, canAir, canGround);
  if (!target) return;

  const tx = tower.cx + 0.5;
  const ty = tower.cy + 0.5;
  tower.cooldownLeft = Math.round((lvl.cooldown * TICK_RATE) / (1 + hasteMult));

  if (towerDef.projectileKind === 'beam') {
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
      // el rayo Tesla es mágico: los inmunes reciben −70% (execute ya se ignora en damageEnemy)
      const linkDmg = current.spellImmune ? Math.max(1, Math.round(dmg * SPELL_IMMUNE_TESLA_MULT)) : dmg;
      damageEnemy(state, ctx, current, linkDmg, lvl.pierceArmor ?? false, tower.id, events, execute);
      dmg = Math.max(1, Math.round(dmg * chain.falloff));
      // buscar el siguiente eslabón cerca del último golpeado
      let next: EnemyState | null = null;
      let nextD = 1.9;
      for (let bi = 0; bi < chainN; bi++) {
        const e = state.enemies[bi];
        if (e.hp <= 0 || hitIds.has(e.id)) continue;
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
    events.push({ e: 'chain', pts, color: towerDef.color });
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
  }

  if (towerDef.projectileKind === 'snipe') {
    // Francotirador: impacto instantáneo, ignora esquiva
    for (const t of targets) {
      events.push({ e: 'shot', x: tx, y: ty, tx: t.x, ty: t.y, kind: 'snipe', color: towerDef.color });
      damageEnemy(state, ctx, t, dmgFor(lvl.damage), lvl.pierceArmor ?? false, tower.id, events, execute);
    }
    return;
  }

  // Proyectil físico (arquero, cañón, hielo, veneno, mortero)
  for (const t of targets) {
    const proj: ProjectileState = {
      id: state.nextId++,
      kind: towerDef.projectileKind === 'bomb' ? 'bomb' : towerDef.projectileKind === 'shell' ? 'shell' : 'bullet',
      x: tx,
      y: ty,
      targetId: towerDef.projectileKind === 'bomb' ? 0 : t.id,
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
      color: towerDef.color,
      groundOnly: !canAir,
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
  damageEnemy(state, ctx, enemy, proj.damage, proj.pierceArmor, proj.towerId, events, proj.execute);
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

// Torre viva más cercana a un punto, dentro de `maxDist` (celdas). Orden estable:
// recorre `state.towers` en orden y desempata por el primero (determinista).
function nearestTower(state: GameState, x: number, y: number, maxDist: number): TowerState | null {
  let best: TowerState | null = null;
  let bestD = maxDist;
  for (const t of state.towers) {
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
        tower.damage += enemy.poisonDps / TICK_RATE;
        const owner = state.players.find((p) => p.id === tower.owner);
        if (owner) owner.stats.damage += enemy.poisonDps / TICK_RATE;
      }
      if (enemy.hp <= 0) {
        killEnemy(state, ctx, enemy, enemy.poisonSrc, events);
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

    // Zapador: si hay una torre viva a su alcance, se DETIENE junto a ella y la
    // aturde mientras siga vivo (el aturdimiento se renueva cada tick; al morir el
    // zapador, expira solo en `stunTicks`). Determinista: torre más cercana estable.
    let sapping = false;
    if (def.sapper) {
      const tower = nearestTower(state, enemy.x, enemy.y, 1.6);
      if (tower) {
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
      const lvl = activeStats(tower.type, tower.level, tower.spec);
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
    if (tower.cooldownLeft > 0) {
      tower.cooldownLeft -= 1;
      continue;
    }
    fireTower(state, ctx, tower, events, auras);
  }
}

// Auras pasivas (Escarcha Eterna): ralentizan sin disparar a todo lo que rodean.
function stepTowerAuras(state: GameState): void {
  for (const tower of state.towers) {
    const lvl = activeStats(tower.type, tower.level, tower.spec);
    const aura = lvl.slowAura;
    if (!aura) continue;
    const canAir = towerTargetsAir(tower.type, tower.spec);
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
      msg: '🛡 Las oleadas múltiplos de 5 (desde la 10) son INMUNES a la magia: ten daño físico de reserva. ☠ Los jefes llegan cada 10 (la Quimera voladora en la 15/25/35).',
    });
  }
  applyCommands(state, ctx.map, ctx.placement, commands, events);
  stepWaves(state, ctx, events);
  stepTowerAuras(state);
  stepEnemies(state, ctx, events);
  // refuerzo de los Estandartes: se calcula una vez por tick (solo lee el estado)
  // y se pasa a las torres para que multipliquen daño/cadencia al disparar.
  const auras = computeAuras(state);
  stepTowers(state, ctx, events, auras);
  stepProjectiles(state, ctx, events);
  state.enemies = state.enemies.filter((e) => e.hp > 0);
  state.tick += 1;
  return events;
}
