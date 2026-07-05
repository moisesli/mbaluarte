// Prueba de la simulación: dos jugadores bot construyen torres y el juego
// avanza miles de ticks. Verifica oleadas, economía, muertes y determinismo.
import {
  activeStats,
  computeAuras,
  createGame,
  ENEMIES,
  findFusion,
  generateWave,
  getMap,
  hasRank2,
  makePlacementContext,
  makeSimContext,
  pathCells,
  pathLength,
  placementError,
  rank2Cost,
  replayTo,
  stepGame,
  towerLevel,
  BALANCE_VERSION,
  FUSION_ORDER,
  FUSIONS,
  HORDE_CAP,
  MAPS,
  START_LIVES,
  TICK_RATE,
  TOWERS,
  TOWER_ORDER,
  ORC_RATES,
  ORC_UPGRADE_COSTS,
  START_WOOD,
  WOOD_COST_RANK2,
  WOOD_COST_SPEC,
  WOOD_LOT,
  WOOD_PER_SEC,
  WOOD_SELL_SPREAD,
  type EnemyState,
  type EnemyTypeId,
  type FusionId,
  type GameEvent,
  type GameState,
  type PlayerCommand,
  type ReplayData,
  type ReplayEntry,
  type TowerState,
  type TowerTypeId,
} from '@td/shared';

const MAP_ID = 'sendero';
const SEED = 123456789;
const MAX_TICKS = TICK_RATE * 60 * 40; // 40 minutos de juego (el clásico ahora son 36 oleadas)

// Fábricas para pruebas dirigidas (construir estado a mano sin repetir 25 campos).
function mkEnemy(type: EnemyTypeId, over: Partial<EnemyState> = {}): EnemyState {
  const def = ENEMIES[type];
  return {
    id: 1000, type, x: 5.5, y: 2.5, hp: def.hp, maxHp: def.hp,
    pathIdx: 0, wpIdx: 1, travelled: 0, slowFactor: 1, slowUntil: 0, poisonDps: 0, poisonUntil: 0,
    poisonSrc: 0, bountyMult: 1, elite: false, affixes: [], speedMult: 1, armorBonus: 0, regenBonus: 0,
    dodgeBonus: 0, slowResist: 0, radiusMult: 1, auraRadius: 0, auraHps: 0, deathSpawn: 0, laps: 0,
    spellImmune: def.spellImmune ?? false, stunTowerId: 0, lastWpIdx: 1, armorShredUntil: 0,
    ...over,
  };
}
function mkTower(type: TowerTypeId, over: Partial<TowerState> = {}): TowerState {
  return {
    id: 2000, type, cx: 5, cy: 1, level: 3, spec: -1, owner: 'p1',
    cooldownLeft: 0, targetMode: 'first', invested: 100, kills: 0, damage: 0, stunnedUntil: 0,
    charges: 0, growthBonus: 0, goldGen: 0, fusion: -1,
    ...over,
  };
}
// mkTower con una fusión F4.3 armada directamente (para pruebas dirigidas).
function mkFused(type: TowerTypeId, fusionId: FusionId, over: Partial<TowerState> = {}): TowerState {
  return mkTower(type, { fusion: FUSION_ORDER.indexOf(fusionId), level: 3, spec: -1, ...over });
}

function buildCellCandidates(mapId: string): [number, number][] {
  const map = getMap(mapId);
  const paths = pathCells(map);
  const ctx = makePlacementContext(map);
  const out: [number, number][] = [];
  for (let cy = 0; cy < map.gridH; cy++) {
    for (let cx = 0; cx < map.gridW; cx++) {
      if (placementError(map, ctx, [], cx, cy)) continue;
      // solo celdas pegadas al camino, donde una torre de verdad dispara
      let nearPath = false;
      for (let dy = -1; dy <= 1 && !nearPath; dy++) {
        for (let dx = -1; dx <= 1 && !nearPath; dx++) {
          if (paths.has(`${cx + dx},${cy + dy}`)) nearPath = true;
        }
      }
      if (nearPath) out.push([cx, cy]);
    }
  }
  return out;
}

const BUILD_ORDER: TowerTypeId[] = ['archer', 'cannon', 'frost', 'archer', 'tesla', 'banner', 'poison', 'sniper', 'mortar'];

function botCommands(
  state: GameState,
  candidates: [number, number][],
  counters: Map<string, number>,
): PlayerCommand[] {
  const cmds: PlayerCommand[] = [];
  if (state.waveState !== 'interlude') return cmds;

  // celdas ya ocupadas + las que se reclaman dentro de este mismo tick
  const used = new Set(state.towers.map((t) => `${t.cx},${t.cy}`));
  for (const player of state.players) {
    let budget = player.gold; // oro disponible tras las órdenes de este tick
    let woodBudget = player.wood; // madera disponible (F5.2: specs y Rango II la cuestan)
    let orcLvl = player.orcLevel; // nivel local del orco (para no sobre-pedir mejoras)

    // F4.3 · FUSIONAR (máx. una por tick): dos torres propias ESPECIALIZADAS,
    // adyacentes (Chebyshev 1) y con receta → fuse (se queda en la celda de la 1ª).
    // Las dos torres implicadas se excluyen del resto de órdenes de este tick.
    const fusedIds = new Set<number>();
    const fusable = state.towers.filter((t) => t.owner === player.id && t.spec >= 0 && t.fusion < 0);
    outer: for (let i = 0; i < fusable.length; i++) {
      for (let j = i + 1; j < fusable.length; j++) {
        const A = fusable[i];
        const B = fusable[j];
        if (Math.max(Math.abs(A.cx - B.cx), Math.abs(A.cy - B.cy)) !== 1) continue;
        if (!findFusion(A.type, B.type)) continue;
        cmds.push({ playerId: player.id, cmd: { kind: 'fuse', towerId: A.id, otherId: B.id, keepId: A.id } });
        fusedIds.add(A.id);
        fusedIds.add(B.id);
        break outer;
      }
    }

    // ids de torres que forman PAR de receta con una vecina propia (para priorizar
    // su progreso hacia la especialización y así habilitar la fusión)
    const pairable = new Set<number>();
    {
      const myTowers = state.towers.filter((t) => t.owner === player.id && t.fusion < 0);
      for (let i = 0; i < myTowers.length; i++) {
        for (let j = i + 1; j < myTowers.length; j++) {
          const A = myTowers[i];
          const B = myTowers[j];
          if (Math.max(Math.abs(A.cx - B.cx), Math.abs(A.cy - B.cy)) !== 1) continue;
          if (!findFusion(A.type, B.type)) continue;
          pairable.add(A.id);
          pairable.add(B.id);
        }
      }
    }

    // copias locales de las torres del jugador: se mutan para simular el efecto
    // de las órdenes de ESTE tick sin tocar el estado real de la simulación.
    // Se excluyen las fusionadas este tick y las ya fusionadas (no se mejoran).
    const mine = state.towers
      .filter((t) => t.owner === player.id && !fusedIds.has(t.id) && t.fusion < 0)
      .map((t) => ({ id: t.id, type: t.type, level: t.level, spec: t.spec }));
    // prioridad: primero los miembros de un par de receta, luego el resto
    const byPairFirst = <T extends { id: number }>(x: T, y: T) =>
      Number(pairable.has(y.id)) - Number(pairable.has(x.id));

    // hasta 3 acciones por interludio: prioriza progresar torres hacia la especialización
    for (let act = 0; act < 3; act++) {
      // 1) especializar una torre al máximo aún sin rama (alterna A/B por id);
      // los miembros de par van primero (habilitan la fusión F4.3)
      const maxed = mine.filter((t) => t.level >= 3 && t.spec < 0).sort(byPairFirst)[0];
      if (maxed) {
        const specIdx = maxed.id % 2;
        const specCost = TOWERS[maxed.type].specs[specIdx].cost;
        if (budget >= specCost && woodBudget >= WOOD_COST_SPEC) {
          cmds.push({ playerId: player.id, cmd: { kind: 'specialize', towerId: maxed.id, spec: specIdx } });
          maxed.spec = specIdx;
          budget -= specCost;
          woodBudget -= WOOD_COST_SPEC;
          continue;
        }
      }

      // 1b) Rango II: una torre ya especializada (nivel 3) con rank2 sube al nivel 4.
      const r2able = mine.find((t) => t.level === 3 && t.spec >= 0 && hasRank2(t.type, t.spec));
      if (r2able) {
        const r2cost = rank2Cost(r2able.type, r2able.spec) ?? Infinity;
        if (budget >= r2cost && woodBudget >= WOOD_COST_RANK2) {
          cmds.push({ playerId: player.id, cmd: { kind: 'upgrade', towerId: r2able.id } });
          r2able.level = 4;
          budget -= r2cost;
          woodBudget -= WOOD_COST_RANK2;
          continue;
        }
      }

      // NOTA F5.5: los bots NO mejoran el orco a propósito. La victoria del
      // clásico va justa y cualquier oro desviado de la defensa la vuelca
      // (probado: con mejoras de orco pierden en la 30-36). La mecánica se
      // cubre con su prueba dirigida y en tools/balance-probe.ts, donde el bot
      // SÍ la usa (ahí perder es dato, no fallo).
      void orcLvl;

      // 1c) PROYECTO DE FUSIÓN (F4.3), UNA VEZ por partida y jugador: con una
      // base de ≥6 torres y oro de sobra, planta el par hielo+veneno en dos
      // celdas adyacentes reservadas DE GOLPE (así el otro jugador no roba la
      // vecina entre medias). byPairFirst prioriza especializarlas y el paso 0
      // las fusiona en la Plaga Glacial. Fuera de este proyecto, el bot juega
      // exactamente igual que siempre.
      {
        const hasFused = state.towers.some((t) => t.owner === player.id && t.fusion >= 0);
        const bothCost = TOWERS.frost.levels[0].cost + TOWERS.poison.levels[0].cost;
        if (!hasFused && pairable.size === 0 && mine.length >= 6 && budget >= bothCost + 100) {
          let placedPair = false;
          for (const [ax, ay] of candidates) {
            if (used.has(`${ax},${ay}`)) continue;
            const b = candidates.find(
              ([bx, by]) =>
                !used.has(`${bx},${by}`) && (bx !== ax || by !== ay) && Math.max(Math.abs(bx - ax), Math.abs(by - ay)) === 1,
            );
            if (!b) continue;
            used.add(`${ax},${ay}`);
            used.add(`${b[0]},${b[1]}`);
            cmds.push({ playerId: player.id, cmd: { kind: 'place', towerType: 'frost', cx: ax, cy: ay } });
            cmds.push({ playerId: player.id, cmd: { kind: 'place', towerType: 'poison', cx: b[0], cy: b[1] } });
            mine.push({ id: -1 - act, type: 'frost', level: 1, spec: -1 });
            mine.push({ id: -100 - act, type: 'poison', level: 1, spec: -1 });
            budget -= bothCost;
            placedPair = true;
            break;
          }
          if (placedPair) continue;
        }
      }

      // 2) con una base de torres, subir la más avanzada (<3) hacia el máximo;
      // a igual criterio, primero los miembros de par de receta
      const upgradable = mine
        .filter((t) => t.level < 3)
        .sort((x, y) => byPairFirst(x, y) || y.level - x.level)[0];
      if (mine.length >= 4 && upgradable) {
        const upCost = towerLevel(upgradable.type, upgradable.level + 1).cost;
        if (budget >= upCost) {
          cmds.push({ playerId: player.id, cmd: { kind: 'upgrade', towerId: upgradable.id } });
          upgradable.level += 1;
          budget -= upCost;
          continue;
        }
      }

      // 3) construir una torre nueva
      const n = counters.get(player.id) ?? 0;
      const nextType = BUILD_ORDER[n % BUILD_ORDER.length];
      const cost = TOWERS[nextType].levels[0].cost;
      if (budget >= cost + 20) {
        const cell = candidates.find(([cx, cy]) => !used.has(`${cx},${cy}`));
        if (cell) {
          used.add(`${cell[0]},${cell[1]}`);
          cmds.push({ playerId: player.id, cmd: { kind: 'place', towerType: nextType, cx: cell[0], cy: cell[1] } });
          counters.set(player.id, n + 1);
          mine.push({ id: -1 - act, type: nextType, level: 1, spec: -1 }); // cuenta para la base
          budget -= cost;
          continue;
        }
      }

      // 4) sin nada mejor: mejorar cualquier torre <3 si alcanza
      if (upgradable) {
        const upCost = towerLevel(upgradable.type, upgradable.level + 1).cost;
        if (budget >= upCost) {
          cmds.push({ playerId: player.id, cmd: { kind: 'upgrade', towerId: upgradable.id } });
          upgradable.level += 1;
          budget -= upCost;
          continue;
        }
      }
      break; // no se pudo hacer nada más este tick
    }
  }
  // acelerar: llamar la oleada cuando falten menos de 8 segundos
  if (state.interludeLeft < TICK_RATE * 8 && state.interludeLeft > TICK_RATE * 2) {
    cmds.push({ playerId: state.players[0].id, cmd: { kind: 'call_wave' } });
  }
  return cmds;
}

function runScenario(mapId = MAP_ID, maxTicks = MAX_TICKS): { state: GameState; totalKills: number; totalLeaks: number; maxWave: number; eventCounts: Map<string, number> } {
  const map = getMap(mapId);
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const state = createGame(mapId, 'classic', 'normal', SEED, [
    { id: 'p1', name: 'Ana', color: '#4fc3f7' },
    { id: 'p2', name: 'Beto', color: '#f06292' },
  ]);
  const candidates = buildCellCandidates(mapId);
  const counters = new Map<string, number>();
  const eventCounts = new Map<string, number>();
  let totalKills = 0;
  let totalLeaks = 0;
  let maxWave = 0;

  for (let i = 0; i < maxTicks && !state.over; i++) {
    const events: GameEvent[] = stepGame(state, simCtx, botCommands(state, candidates, counters));
    for (const ev of events) {
      eventCounts.set(ev.e, (eventCounts.get(ev.e) ?? 0) + 1);
      if (ev.e === 'death') totalKills++;
      if (ev.e === 'leak') totalLeaks++;
      if (ev.e === 'wave_start') maxWave = ev.wave;
      if (ev.e === 'reject') throw new Error(`Comando de bot rechazado: ${ev.reason}`);
    }
  }
  return { state, totalKills, totalLeaks, maxWave, eventCounts };
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FALLO: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ ${msg}`);
  }
}

// ---------- validación estructural de todos los mapas ----------

console.log('— Validación de mapas —');
const seenIds = new Set<string>();
for (const map of MAPS) {
  const errors: string[] = [];
  if (seenIds.has(map.id)) errors.push(`id duplicado: ${map.id}`);
  seenIds.add(map.id);
  if (map.paths.length === 0) errors.push('sin caminos');

  for (let p = 0; p < map.paths.length; p++) {
    const path = map.paths[p];
    if (path.length < 2) errors.push(`camino ${p}: menos de 2 waypoints`);
    for (const [c, r] of path) {
      if (c < 0 || r < 0 || c >= map.gridW || r >= map.gridH) {
        errors.push(`camino ${p}: waypoint (${c},${r}) fuera de la grilla ${map.gridW}×${map.gridH}`);
      }
    }
    for (let i = 1; i < path.length; i++) {
      const [c0, r0] = path[i - 1];
      const [c1, r1] = path[i];
      if (c0 === c1 && r0 === r1) errors.push(`camino ${p}: waypoints ${i - 1} y ${i} repetidos`);
      if (c0 !== c1 && r0 !== r1) {
        errors.push(`camino ${p}: segmento ${i - 1}→${i} en diagonal (deben ser horizontales o verticales)`);
      }
    }
    if (pathLength(map, p) < 10) errors.push(`camino ${p}: demasiado corto (${pathLength(map, p)} celdas)`);
  }

  const cells = pathCells(map);
  for (const [c, r] of map.blocked) {
    if (c < 0 || r < 0 || c >= map.gridW || r >= map.gridH) {
      errors.push(`celda bloqueada (${c},${r}) fuera de la grilla`);
    }
    if (cells.has(`${c},${r}`)) errors.push(`celda bloqueada (${c},${r}) pisa el camino`);
  }

  // debe quedar sitio razonable para construir junto al camino
  const buildable = buildCellCandidates(map.id).length;
  if (buildable < 20) errors.push(`solo ${buildable} celdas construibles junto al camino`);

  assert(errors.length === 0, `mapa «${map.name}» (${map.id}) es válido${errors.length ? `: ${errors.join('; ')}` : ''}`);
}

// partida rápida con bots en cada mapa (además de la completa en «sendero»)
for (const map of MAPS) {
  if (map.id === MAP_ID) continue;
  const r = runScenario(map.id, TICK_RATE * 60 * 4);
  assert(
    r.maxWave >= 3 && r.totalKills > 10,
    `los bots juegan en «${map.name}» (oleada ${r.maxWave}, ${r.totalKills} bajas, ${r.state.lives} vidas)`,
  );
}

console.log('— Simulación: partida completa con 2 bots —');
const t0 = performance.now();
const a = runScenario();
const ms = performance.now() - t0;
console.log(
  `   ${a.state.tick} ticks simulados en ${ms.toFixed(0)}ms (${((a.state.tick / ms) * 1000).toFixed(0)} ticks/s) · ` +
    `oleada máx ${a.maxWave} · bajas ${a.totalKills} · fugas ${a.totalLeaks} · vidas ${a.state.lives}`,
);
console.log(`   eventos: ${[...a.eventCounts.entries()].map(([k, v]) => `${k}:${v}`).join(' ')}`);

assert(a.maxWave >= 5, `el juego avanza de oleada (llegó a la ${a.maxWave})`);
assert(a.totalKills > 30, `las torres matan enemigos (${a.totalKills} bajas)`);
assert(a.state.towers.length > 5, `los bots construyeron torres (${a.state.towers.length})`);
assert((a.eventCounts.get('specialize') ?? 0) > 0, `los bots especializan torres (${a.eventCounts.get('specialize') ?? 0})`);
assert(
  a.state.towers.some((t) => t.spec >= 0),
  `hay torres especializadas al final (${a.state.towers.filter((t) => t.spec >= 0).length})`,
);
// F4.2: los bots alcanzan algún RANGO II (torre especializada al nivel 4)
assert(
  a.state.towers.some((t) => t.level >= 4 && t.spec >= 0),
  `los bots alcanzan algún RANGO II (${a.state.towers.filter((t) => t.level >= 4).length} torres en nivel 4)`,
);
// F4.3: los bots FUSIONAN al menos una torre (pares de receta adyacentes) y,
// junto con el assert de victoria de abajo, GANAN el clásico en normal igual.
assert((a.eventCounts.get('fuse') ?? 0) > 0, `los bots FUSIONAN torres (${a.eventCounts.get('fuse') ?? 0} fusiones)`);
assert(
  a.state.players.every((p) => p.stats.goldEarned > 100),
  'todos los jugadores ganaron oro',
);
assert(
  a.state.over !== null || a.state.tick === MAX_TICKS,
  `la partida termina o sigue estable (over=${JSON.stringify(a.state.over)})`,
);
// F4.1: a pesar de las oleadas inmunes/jefes nuevos, los bots (que construyen físico
// de reserva: arquero/cañón/francotirador/mortero) SIGUEN GANANDO el clásico en normal.
assert(
  a.state.over?.victory === true,
  `los bots GANAN el clásico en normal (oleada ${a.maxWave}, ${a.state.lives} vidas, over=${JSON.stringify(a.state.over)})`,
);
// F5.2: el clásico dura 36 oleadas, como Green TD
assert(a.state.totalWaves === 36 && a.maxWave >= 36, `el clásico dura 36 oleadas (jugadas ${a.maxWave}/${a.state.totalWaves})`);
assert((a.eventCounts.get('wave_end') ?? 0) >= 4, 'se completan oleadas');
assert((a.eventCounts.get('hit') ?? 0) > 50, 'hay impactos de proyectiles');
assert((a.eventCounts.get('chain') ?? 0) > 0, 'la torre tesla dispara cadenas');

console.log('— Élites: generación de afijos por oleada —');
{
  const rng = { rng: SEED };
  let eliteEntries = 0;
  let twoAffix = 0;
  const affixSeen = new Set<string>();
  for (let w = 1; w <= 20; w++) {
    const gen = generateWave(rng, w, 2, 1);
    for (const e of gen.entries) {
      if (!e.elite) continue;
      eliteEntries++;
      if (w < 4) throw new Error(`élite en oleada ${w} (antes de la 4)`);
      for (const af of e.affixes ?? []) affixSeen.add(af);
      if ((e.affixes?.length ?? 0) >= 2) twoAffix++;
    }
  }
  assert(eliteEntries > 0, `aparecen élites en las oleadas (${eliteEntries})`);
  assert(affixSeen.size >= 3, `hay variedad de afijos (${affixSeen.size} tipos)`);
  assert(twoAffix > 0, `algún élite lleva 2 afijos en oleadas altas (${twoAffix})`);
}

console.log('— Regresión: las crías de spawnOnDeath sobreviven a un golpe de área —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 999, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 5000;
  st.wave = 1;
  st.waveState = 'active';
  st.spawnQueue = [];
  st.pendingWave = [];

  const slime: EnemyState = {
    id: 1000, type: 'slime', x: 5.5, y: 2.5, hp: ENEMIES.slime.hp, maxHp: ENEMIES.slime.hp,
    pathIdx: 0, wpIdx: 1, travelled: 5, slowFactor: 1, slowUntil: 0, poisonDps: 0, poisonUntil: 0,
    poisonSrc: 0, bountyMult: 1, elite: false, affixes: [], speedMult: 1, armorBonus: 0, regenBonus: 0,
    dodgeBonus: 0, slowResist: 0, radiusMult: 1, auraRadius: 0, auraHps: 0, deathSpawn: 0, laps: 0,
    spellImmune: false, stunTowerId: 0, lastWpIdx: 1, armorShredUntil: 0,
  };
  st.enemies.push(slime);
  const cannon: TowerState = {
    id: 2000, type: 'cannon', cx: 5, cy: 1, level: 3, spec: -1, owner: 'p1',
    cooldownLeft: 0, targetMode: 'first', invested: 440, kills: 0, damage: 0, stunnedUntil: 0,
    charges: 0, growthBonus: 0, goldGen: 0, fusion: -1,
  };
  st.towers.push(cannon);

  let maxSlimelets = 0;
  let slimeDied = false;
  for (let i = 0; i < 40 && st.enemies.length > 0; i++) {
    const events = stepGame(st, simCtx, []);
    for (const ev of events) if (ev.e === 'death' && ev.type === 'slime') slimeDied = true;
    maxSlimelets = Math.max(maxSlimelets, st.enemies.filter((e) => e.type === 'slimelet').length);
  }
  assert(slimeDied, 'el cañón mató al baboso con daño de área');
  assert(maxSlimelets >= 2, `los babosines sobreviven a su golpe de nacimiento (máx vivos: ${maxSlimelets})`);
}

console.log('— Estandarte: refuerza el daño de las torres cercanas (sin apilar) —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));

  // Mide el daño del primer proyectil que dispara un arquero, con `banners`
  // estandartes de nivel 1 colocados adyacentes (todos dentro del radio 2.2).
  function archerShotDamage(banners: number): number {
    const st = createGame('sendero', 'endless', 'normal', 777, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 9000;
    st.wave = 1;
    st.waveState = 'active';
    st.spawnQueue = [];
    st.pendingWave = [];

    // enemigo pegado al arquero y dentro de alcance (wpIdx válido para no fugarse)
    const enemy: EnemyState = {
      id: 1000, type: 'brute', x: 5.5, y: 2.5, hp: 100000, maxHp: 100000,
      pathIdx: 0, wpIdx: 1, travelled: 0, slowFactor: 1, slowUntil: 0, poisonDps: 0, poisonUntil: 0,
      poisonSrc: 0, bountyMult: 1, elite: false, affixes: [], speedMult: 1, armorBonus: 0, regenBonus: 0,
      dodgeBonus: 0, slowResist: 0, radiusMult: 1, auraRadius: 0, auraHps: 0, deathSpawn: 0, laps: 0,
      spellImmune: false, stunTowerId: 0, lastWpIdx: 1, armorShredUntil: 0,
    };
    st.enemies.push(enemy);
    const archer: TowerState = {
      id: 2000, type: 'archer', cx: 5, cy: 1, level: 1, spec: -1, owner: 'p1',
      cooldownLeft: 0, targetMode: 'first', invested: 50, kills: 0, damage: 0, stunnedUntil: 0,
      charges: 0, growthBonus: 0, goldGen: 0, fusion: -1,
    };
    st.towers.push(archer);
    for (let i = 0; i < banners; i++) {
      st.towers.push({
        id: 3000 + i, type: 'banner', cx: 6 + i, cy: 1, level: 1, spec: -1, owner: 'p1',
        cooldownLeft: 0, targetMode: 'first', invested: 90, kills: 0, damage: 0, stunnedUntil: 0,
        charges: 0, growthBonus: 0, goldGen: 0, fusion: -1,
      });
    }
    // un tick: el arquero está listo y dispara; leemos el proyectil emitido
    stepGame(st, simCtx, []);
    const proj = st.projectiles.find((p) => p.towerId === 2000);
    return proj ? proj.damage : 0;
  }

  const base = archerShotDamage(0);
  const withBanner = archerShotDamage(1);
  const withTwo = archerShotDamage(2);
  // base 8, aura +15% → round(8*1.15)=9
  assert(base > 0, `el arquero dispara daño base (${base})`);
  assert(withBanner > base, `el estandarte sube el daño del arquero (${base} → ${withBanner})`);
  assert(withTwo === withBanner, `dos estandartes no apilan: mismo multiplicador que uno (${withBanner} == ${withTwo})`);
}

console.log('— Repetición (replay): reconstruye el estado final EXACTO —');
{
  // Juega una partida con bots GRABANDO el log de comandos igual que el servidor
  // (cada comando con el tick de sim ANTES del stepGame que lo aplica), e inyecta
  // una desconexión + reconexión de Beto a mitad de partida para ejercitar los
  // eventos `conn` (que cambian connectedCount → escalado de HP y presupuesto de
  // oleada). Luego reproduce con el motor puro y compara el estado final: idéntico.
  const mapId = MAP_ID;
  const seed = 424242;
  const map = getMap(mapId);
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const players = [
    { id: 'p1', name: 'Ana', color: '#4fc3f7' },
    { id: 'p2', name: 'Beto', color: '#f06292' },
  ];
  const state = createGame(mapId, 'classic', 'normal', seed, players);
  const candidates = buildCellCandidates(mapId);
  const counters = new Map<string, number>();
  const log: ReplayEntry[] = [];

  // marca de desconexión/reconexión de Beto (elegidas para caer en plena partida)
  const DISCONNECT_TICK = TICK_RATE * 30;
  const RECONNECT_TICK = TICK_RATE * 55;
  let betoConnected = true;

  const maxTicks = TICK_RATE * 60 * 12;
  for (let i = 0; i < maxTicks && !state.over; i++) {
    // cambios de conexión (como markConnected en el servidor): flip + log al tick
    if (betoConnected && state.tick === DISCONNECT_TICK) {
      const gp = state.players.find((p) => p.id === 'p2')!;
      gp.connected = false;
      betoConnected = false;
      log.push({ t: state.tick, kind: 'conn', playerId: 'p2', connected: false });
    } else if (!betoConnected && state.tick === RECONNECT_TICK) {
      const gp = state.players.find((p) => p.id === 'p2')!;
      gp.connected = true;
      betoConnected = true;
      log.push({ t: state.tick, kind: 'conn', playerId: 'p2', connected: true });
    }

    // solo el jugador conectado da órdenes mientras Beto está caído
    const cmds = botCommands(state, candidates, counters).filter(
      (c) => betoConnected || c.playerId !== 'p2',
    );
    const cmdTick = state.tick;
    for (const c of cmds) log.push({ t: cmdTick, kind: 'cmd', playerId: c.playerId, cmd: c.cmd });
    stepGame(state, simCtx, cmds);
  }

  const replay: ReplayData = {
    v: BALANCE_VERSION,
    seed,
    mapId,
    mode: 'classic',
    difficulty: 'normal',
    players,
    log,
    finalTick: state.tick,
    victory: state.over?.victory ?? false,
    wave: state.wave,
  };

  // reconstrucción con el motor puro (createGame + stepGame + entradas grabadas)
  const rebuilt = replayTo(replay, replay.finalTick);

  const realGold = state.players.map((p) => Math.round(p.gold));
  const rebuiltGold = rebuilt.players.map((p) => Math.round(p.gold));

  assert(log.some((e) => e.kind === 'conn' && e.connected === false), 'el log grabó la desconexión de Beto (conn=false)');
  assert(log.some((e) => e.kind === 'conn' && e.connected === true), 'el log grabó la reconexión de Beto (conn=true)');
  assert(rebuilt.tick === state.tick, `tick idéntico (real ${state.tick} == replay ${rebuilt.tick})`);
  assert(rebuilt.wave === state.wave, `oleada idéntica (real ${state.wave} == replay ${rebuilt.wave})`);
  assert(rebuilt.lives === state.lives, `vidas idénticas (real ${state.lives} == replay ${rebuilt.lives})`);
  assert(rebuilt.rng === state.rng, `rng idéntico (real ${state.rng} == replay ${rebuilt.rng})`);
  assert(rebuilt.nextId === state.nextId, `nextId idéntico (real ${state.nextId} == replay ${rebuilt.nextId})`);
  assert(
    JSON.stringify(realGold) === JSON.stringify(rebuiltGold),
    `oro de cada jugador idéntico (real ${JSON.stringify(realGold)} == replay ${JSON.stringify(rebuiltGold)})`,
  );
  assert(
    JSON.stringify(state.over) === JSON.stringify(rebuilt.over),
    `resultado idéntico (over ${JSON.stringify(state.over)})`,
  );

  // el SEEK re-simula de 0 al tick destino y debe coincidir con el paso a paso
  const mid = Math.floor(replay.finalTick / 2);
  const seekState = replayTo(replay, mid);
  const stepState = (() => {
    const s2 = createGame(mapId, 'classic', 'normal', seed, players);
    const ctx2 = makeSimContext(map, makePlacementContext(map));
    while (s2.tick < mid && !s2.over) {
      // aplicar roster + comandos de este tick igual que el motor de replay
      for (const e of log) {
        if (e.t !== s2.tick) continue;
        if (e.kind === 'conn') {
          const gp = s2.players.find((p) => p.id === e.playerId);
          if (gp) gp.connected = e.connected;
        }
      }
      const c = log.filter((e) => e.t === s2.tick && e.kind === 'cmd').map((e) =>
        e.kind === 'cmd' ? { playerId: e.playerId, cmd: e.cmd } : (null as never),
      );
      stepGame(s2, ctx2, c as PlayerCommand[]);
    }
    return s2;
  })();
  assert(
    seekState.tick === stepState.tick && seekState.rng === stepState.rng && seekState.lives === stepState.lives,
    `el seek a tick ${mid} reconstruye el mismo estado (rng ${seekState.rng})`,
  );

  const bytes = JSON.stringify(replay).length;
  console.log(`   replay: ${log.length} entradas, ${bytes} bytes (~${(bytes / 1024).toFixed(1)} KB), ${replay.finalTick} ticks`);
}

console.log('— Modo Horda: bucle, cansancio y derrota por saturación —');

interface HordeResult {
  state: GameState;
  maxAlive: number;
  maxLaps: number;
  loopedAny: boolean; // algún enemigo reinició su recorrido (travelled volvió a 0 con wpIdx=1)
  tiredAny: boolean; // algún enemigo con laps>0 vio su maxHp reducido bajo su base
  maxWave: number;
  ticks: number;
}

// Corre una partida de horda con 2 bots defendiendo. Difícil (cap 32) para que la
// saturación llegue dentro del presupuesto de ticks. Devuelve diagnósticos del
// bucle y el cansancio. Tope de ticks para probar que NO cuelga infinito.
function runHorde(seed: number, difficulty: 'easy' | 'normal' | 'hard', maxTicks: number): HordeResult {
  const map = getMap(MAP_ID);
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const state = createGame(MAP_ID, 'horde', difficulty, seed, [
    { id: 'p1', name: 'Ana', color: '#4fc3f7' },
    { id: 'p2', name: 'Beto', color: '#f06292' },
  ]);
  const candidates = buildCellCandidates(MAP_ID);
  const counters = new Map<string, number>();
  // maxHp base observado la primera vez que vemos a cada enemigo (aún con laps=0)
  const baseMaxHp = new Map<number, number>();
  const prevTravelled = new Map<number, number>();
  let maxAlive = 0;
  let maxLaps = 0;
  let loopedAny = false;
  let tiredAny = false;
  let maxWave = 0;
  let i = 0;
  for (; i < maxTicks && !state.over; i++) {
    stepGame(state, simCtx, botCommands(state, candidates, counters));
    maxWave = Math.max(maxWave, state.wave);
    maxAlive = Math.max(maxAlive, state.enemies.length);
    for (const e of state.enemies) {
      if (!baseMaxHp.has(e.id) && e.laps === 0) baseMaxHp.set(e.id, e.maxHp);
      // BUCLE: el recorrido acumulado (travelled) baja de un tick al siguiente = se
      // teletransportó al inicio (nunca decrece con el movimiento normal)
      const prev = prevTravelled.get(e.id);
      if (prev !== undefined && e.travelled < prev - 1e-6) loopedAny = true;
      prevTravelled.set(e.id, e.travelled);
      if (e.laps > 0) {
        maxLaps = Math.max(maxLaps, e.laps);
        // CANSANCIO: su maxHp actual quedó por debajo del base que tenía sin vueltas
        const base = baseMaxHp.get(e.id);
        if (base !== undefined && e.maxHp < base) tiredAny = true;
      }
    }
  }
  return { state, maxAlive, maxLaps, loopedAny, tiredAny, maxWave, ticks: i };
}

{
  const HORDE_SEED = 20260703;
  const HORDE_MAX_TICKS = TICK_RATE * 60 * 12; // 12 min de tope: si no termina antes, algo cuelga
  const h = runHorde(HORDE_SEED, 'hard', HORDE_MAX_TICKS);
  const cap = HORDE_CAP.hard;
  console.log(
    `   horda(hard): terminó en ${h.ticks} ticks (${(h.ticks / TICK_RATE).toFixed(0)}s) · ` +
      `oleada máx ${h.maxWave} · vivos máx ${h.maxAlive}/${cap} · vueltas máx ${h.maxLaps} · ` +
      `over=${JSON.stringify(h.state.over)}`,
  );

  assert(h.maxWave >= 8, `la horda aguanta varias oleadas antes de saturar (llegó a la ${h.maxWave})`);
  assert(h.loopedAny, 'los enemigos hacen BUCLE (reinician su camino en vez de escapar)');
  assert(h.maxLaps > 0, `hay enemigos que completan vueltas (máx ${h.maxLaps})`);
  assert(h.tiredAny, 'el CANSANCIO reduce el maxHp de los que dan vueltas (anti-esponja)');
  assert(
    h.state.over !== null && h.state.over.victory === false,
    `la partida TERMINA por saturación en derrota (over=${JSON.stringify(h.state.over)})`,
  );
  assert(
    h.state.enemies.length >= cap,
    `la derrota ocurrió al alcanzar el cap de saturación (${h.state.enemies.length} >= ${cap})`,
  );
  assert(h.ticks < HORDE_MAX_TICKS, `NO cuelga infinito: terminó en ${h.ticks} < ${HORDE_MAX_TICKS} ticks`);

  // determinismo: misma semilla → mismo estado final
  const h2 = runHorde(HORDE_SEED, 'hard', HORDE_MAX_TICKS);
  const hashH1 = JSON.stringify([h.state.tick, h.state.wave, h.state.rng, h.state.nextId, h.state.enemies.length, h.state.players.map((p) => p.gold)]);
  const hashH2 = JSON.stringify([h2.state.tick, h2.state.wave, h2.state.rng, h2.state.nextId, h2.state.enemies.length, h2.state.players.map((p) => p.gold)]);
  assert(hashH1 === hashH2, `la horda es determinista (misma semilla → mismo estado final, tick ${h.state.tick})`);
}

console.log('— F4.1 · Sistema de oleadas Green TD: inmunes, bendecidas y jefes —');
{
  // (1) aparecen oleadas inmunes y bendecidas en 20 oleadas
  const rng = { rng: SEED };
  let immuneIn20 = 0;
  let blessedIn20 = 0;
  let immuneTotal = 0;
  let blessedTotal = 0;
  const chimeraWaves: number[] = [];
  let groundBossWave = 0;
  const enemyTypesSeen = new Set<string>();
  for (let w = 1; w <= 40; w++) {
    const gen = generateWave(rng, w, 2, 1);
    if (gen.immune) { immuneTotal++; if (w <= 20) immuneIn20++; }
    if (gen.blessed) { blessedTotal++; if (w <= 20) blessedIn20++; }
    if (gen.bossType === 'chimera') chimeraWaves.push(w);
    if (gen.bossType === 'behemoth') groundBossWave = w;
    for (const e of gen.entries) enemyTypesSeen.add(e.type);
    // consistencia: toda entrada de una oleada inmune lleva immune=true
    if (gen.immune && gen.entries.some((e) => !e.immune)) throw new Error(`oleada inmune ${w} con entradas no-inmunes`);
    // consistencia: las bendecidas llevan afijo común y NO coinciden con inmune/jefe
    if (gen.blessed && (gen.immune || gen.hasBoss)) throw new Error(`oleada bendecida ${w} combinada con inmune/jefe`);
    // consistencia: la oleada de la Quimera (jefe volador) NO es inmune (triple castigo)
    if (gen.bossType === 'chimera' && gen.immune) throw new Error(`la oleada de la Quimera ${w} no debe ser inmune`);
  }
  assert(immuneIn20 >= 2, `aparecen oleadas INMUNES en 20 oleadas (${immuneIn20}: caen en 10 y 20; 15 se exime por ser jefe volador)`);
  assert(immuneTotal >= 4, `hay varias oleadas inmunes en 40 (${immuneTotal}: 10,20,30,40 — las 15/25/35 de la Quimera se eximen)`);
  void blessedIn20;

  // Las oleadas bendecidas son probabilísticas (1/15 desde la 6): en una semilla dada
  // pueden no caer en las primeras 20. Con la semilla 999 SÍ cae (en la 8) — verifica
  // que aparecen y que llevan un afijo común aplicado a TODA la oleada.
  {
    const rng2 = { rng: 999 };
    let firstBlessed = 0;
    let commonAffixOk = false;
    for (let w = 1; w <= 20; w++) {
      const gen = generateWave(rng2, w, 2, 1);
      if (gen.blessed && !firstBlessed) {
        firstBlessed = w;
        // todas las entradas no-jefe llevan el MISMO afijo común
        const nonBoss = gen.entries.filter((e) => e.blessed);
        commonAffixOk = nonBoss.length > 0 && nonBoss.every((e) => e.blessedAffix === gen.blessedAffix);
      }
    }
    assert(firstBlessed > 0 && firstBlessed <= 20, `aparece una oleada BENDECIDA en 20 oleadas (semilla 999, oleada ${firstBlessed})`);
    assert(commonAffixOk, 'la oleada bendecida aplica UN afijo común a toda la oleada');
  }
  assert(blessedTotal >= 1, `hay oleadas bendecidas con la semilla del test (${blessedTotal})`);
  assert(chimeraWaves.includes(15) && chimeraWaves.includes(25), `la Quimera (jefe volador) cae en 15/25/35 del clásico (${chimeraWaves.join(',')})`);
  assert(groundBossWave >= 30, `el Behemot (jefe terrestre) aparece en oleadas altas (oleada ${groundBossWave})`);
  const newMonsters = ['sapper', 'thief', 'berserker', 'skywhale', 'wraith'].filter((t) => enemyTypesSeen.has(t));
  assert(newMonsters.length === 5, `los 5 monstruos nuevos salen por el pool (${newMonsters.join(',')})`);
}

console.log('— F4.1 · Inmunidad mágica: la magia no afecta a un inmune, lo físico sí —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));

  // Construye un enemigo inmune parado en rango y mide el daño de EFECTO (veneno)
  // de una torre de VENENO vs el daño FÍSICO de un arquero.
  function tickDamageOn(immune: boolean, towerType: TowerTypeId): number {
    const st = createGame('sendero', 'endless', 'normal', 555, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const enemy = mkEnemy('brute', { id: 1500, hp: 100000, maxHp: 100000, spellImmune: immune, x: 5.5, y: 2.5 });
    st.enemies.push(enemy);
    const tower = mkTower(towerType, { id: 2500, cx: 5, cy: 1, level: 3, invested: 300 });
    st.towers.push(tower);
    const hp0 = enemy.hp;
    // varios ticks para que el veneno haga su DoT (o el proyectil impacte y envenene)
    for (let i = 0; i < TICK_RATE * 3; i++) stepGame(st, simCtx, []);
    const alive = st.enemies.find((e) => e.id === 1500);
    return alive ? hp0 - alive.hp : hp0;
  }

  const poisonVsImmune = tickDamageOn(true, 'poison');
  const poisonVsNormal = tickDamageOn(false, 'poison');
  const archerVsImmune = tickDamageOn(true, 'archer');
  // el veneno a un inmune SOLO puede hacer el poco daño de impacto físico del dardo,
  // nunca el DoT: mucho menos que a un normal.
  assert(poisonVsImmune < poisonVsNormal * 0.5, `el veneno hace mucho menos daño a un inmune (${poisonVsImmune.toFixed(0)} vs ${poisonVsNormal.toFixed(0)} normal)`);
  assert(archerVsImmune > 0, `el arquero (físico) SÍ le pega al inmune (${archerVsImmune.toFixed(0)})`);

  // Tesla: −70% a inmunes. Un impacto directo.
  function teslaHit(immune: boolean): number {
    const st = createGame('sendero', 'endless', 'normal', 556, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const enemy = mkEnemy('brute', { id: 1600, hp: 100000, maxHp: 100000, spellImmune: immune, x: 5.5, y: 2.5 });
    st.enemies.push(enemy);
    st.towers.push(mkTower('tesla', { id: 2600, cx: 5, cy: 1, level: 3, invested: 500 }));
    const hp0 = enemy.hp;
    stepGame(st, simCtx, []); // un disparo del tesla
    const alive = st.enemies.find((e) => e.id === 1600);
    return alive ? hp0 - alive.hp : hp0;
  }
  const teslaImmune = teslaHit(true);
  const teslaNormal = teslaHit(false);
  assert(teslaImmune > 0 && teslaImmune < teslaNormal, `el Tesla hace daño reducido a los inmunes (${teslaImmune} vs ${teslaNormal} normal, ~−70%)`);

  // Execute (Cañón de Riel, umbral 0.15) NO remata a un inmune; a un normal, sí.
  // maxHp 4000 → umbral 600. El disparo (480) deja al enemigo en ~520 hp: sobrevive
  // al impacto directo pero cae en rango de execute. El normal muere por execute; el
  // inmune queda vivo con ~520 hp (execute es mágico).
  function executeResult(immune: boolean): { killed: boolean; hpLeft: number } {
    const st = createGame('sendero', 'endless', 'normal', 557, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const enemy = mkEnemy('brute', { id: 1700, hp: 1000, maxHp: 4000, spellImmune: immune, x: 5.5, y: 2.5 });
    st.enemies.push(enemy);
    st.towers.push(mkTower('sniper', { id: 2700, spec: 0, cx: 5, cy: 1, level: 3, invested: 800 })); // Cañón de Riel (execute)
    stepGame(st, simCtx, []); // un disparo
    const alive = st.enemies.find((e) => e.id === 1700);
    return { killed: !alive, hpLeft: alive ? alive.hp : 0 };
  }
  const exImmune = executeResult(true);
  const exNormal = executeResult(false);
  assert(!exImmune.killed && exImmune.hpLeft > 0, `el execute (Cañón de Riel) NO remata a un inmune malherido (queda con ${exImmune.hpLeft.toFixed(0)} hp)`);
  assert(exNormal.killed, 'el execute SÍ remata a un enemigo normal malherido');
}

console.log('— F4.1 · Zapador: aturde la torre más cercana (deja de disparar) —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 558, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];

  // arquero en (5,1); un zapador PARADO justo al lado (dentro de 1.6) y un blanco gordo
  const archer = mkTower('archer', { id: 2800, cx: 5, cy: 1, level: 3, invested: 200 });
  st.towers.push(archer);
  const sapper = mkEnemy('sapper', { id: 1800, hp: 100000, maxHp: 100000, x: 5.5, y: 2.5, wpIdx: 1 });
  st.enemies.push(sapper);
  const dummy = mkEnemy('brute', { id: 1801, hp: 100000, maxHp: 100000, x: 5.5, y: 2.7, wpIdx: 1 });
  st.enemies.push(dummy);

  let firedWhileStunned = false;
  let wasStunned = false;
  for (let i = 0; i < TICK_RATE * 2; i++) {
    const dmgBefore = archer.damage;
    stepGame(st, simCtx, []);
    const st2 = st.towers.find((t) => t.id === 2800)!;
    if (st2.stunnedUntil > st.tick - 1) wasStunned = true;
    // mientras el zapador vive y aturde, el arquero no debe hacer daño nuevo
    if (st.enemies.some((e) => e.id === 1800) && archer.damage > dmgBefore) firedWhileStunned = true;
  }
  assert(wasStunned, 'el Zapador aturde a la torre más cercana (stunnedUntil futuro)');
  assert(!firedWhileStunned, 'la torre ATURDIDA no dispara mientras el Zapador vive');

  // al morir el zapador (lo quitamos a mano), el aturdimiento expira y la torre vuelve a disparar
  st.enemies = st.enemies.filter((e) => e.id !== 1800);
  const dmgBefore = st.towers.find((t) => t.id === 2800)!.damage;
  for (let i = 0; i < TICK_RATE; i++) stepGame(st, simCtx, []);
  assert(st.towers.find((t) => t.id === 2800)!.damage > dmgBefore, 'la torre se LIBERA y vuelve a disparar cuando el Zapador muere');
}

console.log('— F4.4 · Zapadores coordinados: nunca aturden dos la misma torre —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 563, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];

  // dos arqueros pegados al camino; dos zapadores llegan a la vez y AMBAS torres
  // están al alcance de AMBOS: deben repartirse (uno cada torre), no apilarse.
  const archerA = mkTower('archer', { id: 3200, cx: 5, cy: 1, level: 3, invested: 200 });
  const archerB = mkTower('archer', { id: 3201, cx: 6, cy: 1, level: 3, invested: 200 });
  st.towers.push(archerA, archerB);
  const sap1 = mkEnemy('sapper', { id: 2300, hp: 100000, maxHp: 100000, x: 5.5, y: 2.5, wpIdx: 1 });
  const sap2 = mkEnemy('sapper', { id: 2301, hp: 100000, maxHp: 100000, x: 6.5, y: 2.5, wpIdx: 1 });
  st.enemies.push(sap1, sap2);

  stepGame(st, simCtx, []);
  assert(
    sap1.stunTowerId > 0 && sap2.stunTowerId > 0 && sap1.stunTowerId !== sap2.stunTowerId,
    `cada zapador aturde una torre DISTINTA (${sap1.stunTowerId} vs ${sap2.stunTowerId})`,
  );
  assert(
    archerA.stunnedUntil > st.tick - 1 && archerB.stunnedUntil > st.tick - 1,
    'con dos zapadores y dos torres, AMBAS torres quedan aturdidas',
  );

  // vendemos la torre del segundo zapador: como la otra ya está tomada por el
  // primero, el segundo debe SEGUIR CAMINANDO (no re-aturdir la misma).
  const takenBy1 = sap1.stunTowerId;
  st.towers = st.towers.filter((t) => t.id !== sap2.stunTowerId);
  const xBefore = sap2.x;
  for (let i = 0; i < TICK_RATE; i++) stepGame(st, simCtx, []);
  assert(sap1.stunTowerId === takenBy1, 'el primer zapador conserva su torre');
  assert(sap2.stunTowerId === 0, 'el segundo zapador NO re-aturde la torre ya tomada');
  assert(sap2.x > xBefore + 0.3, `el segundo zapador sigue caminando en busca de otra torre (x ${xBefore.toFixed(1)} → ${sap2.x.toFixed(1)})`);
}

console.log('— F4.4 · El Zapador ignora torres que no disparan (mina/estandarte) —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 564, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  // solo hay una MINA junto al camino: aturdirla no haría nada, así que el zapador
  // debe pasar de largo sin detenerse.
  const bank = mkTower('bank', { id: 3300, cx: 5, cy: 1, level: 3, invested: 260 });
  st.towers.push(bank);
  const sap = mkEnemy('sapper', { id: 2400, hp: 100000, maxHp: 100000, x: 5.5, y: 2.5, wpIdx: 1 });
  st.enemies.push(sap);
  const xBefore = sap.x;
  for (let i = 0; i < TICK_RATE; i++) stepGame(st, simCtx, []);
  assert(sap.stunTowerId === 0 && bank.stunnedUntil === 0, 'el Zapador NO se detiene a aturdir una mina');
  assert(sap.x > xBefore + 0.5, 'el Zapador sigue su camino si solo hay torres que no disparan');
}

console.log('— F4.1 · Behemot: aturde las torres en radio al cruzar una esquina —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 561, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 25; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  const wps = simCtx.waypoints[0];
  // torre junto al PRIMER waypoint interior; el behemot llega y lo cruza → aturde
  const wp1 = wps[1];
  const tower = mkTower('archer', { id: 2900, cx: Math.round(wp1.x - 0.5), cy: Math.round(wp1.y - 0.5), level: 3, invested: 200 });
  st.towers.push(tower);
  // behemot casi encima del waypoint 1 (a punto de cruzarlo)
  const behemoth = mkEnemy('behemoth', { id: 1850, hp: 500000, maxHp: 500000, x: wp1.x, y: wp1.y - 0.05, wpIdx: 1, lastWpIdx: 1 });
  st.enemies.push(behemoth);
  let stunnedByCorner = false;
  for (let i = 0; i < TICK_RATE * 3; i++) {
    stepGame(st, simCtx, []);
    if (st.towers.find((t) => t.id === 2900)!.stunnedUntil > st.tick) stunnedByCorner = true;
  }
  assert(stunnedByCorner, 'el Behemot aturde las torres en radio al cruzar una esquina');
}

console.log('— F4.1 · Oleada bendecida: afijo común + bono ×1.5 —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 562, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 7; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  st.blessedBonusMult = 1.5; // simula una oleada bendecida activa
  // un enemigo bendecido: aplica un afijo común (swift) sin el ×2.6 de élite
  const gob = mkEnemy('goblin', { id: 1950 });
  const baseHp = gob.hp;
  st.enemies.push(gob);
  // el bono de fin de oleada se multiplica por 1.5
  const goldBefore = st.players[0].gold;
  // vaciar la cola dispara el fin de oleada (spawnQueue vacía + sin enemigos vivos)
  st.enemies = [];
  let bonusSeen = 0;
  for (let i = 0; i < TICK_RATE; i++) {
    const events = stepGame(st, simCtx, []);
    for (const ev of events) if (ev.e === 'wave_end') bonusSeen = ev.bonus;
    if (bonusSeen) break;
  }
  const normalBonus = 20 + 7 * 4; // WAVE_BONUS_BASE + wave*WAVE_BONUS_PER_WAVE
  assert(bonusSeen === Math.round(normalBonus * 1.5), `el bono de una oleada bendecida es ×1.5 (${bonusSeen} == ${Math.round(normalBonus * 1.5)})`);
  assert(st.players[0].gold > goldBefore, 'el bono bendecido se reparte al equipo');
  void baseHp;
}

console.log('— F4.1 · Ladrón: roba oro al escapar (no quita vidas) —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 559, [
    { id: 'p1', name: 'A', color: '#fff' },
    { id: 'p2', name: 'B', color: '#000' },
  ]);
  st.nextId = 8000; st.wave = 3; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  const wps = simCtx.waypoints[0];
  // ladrón en el ÚLTIMO waypoint para que fugue de inmediato
  const thief = mkEnemy('thief', { id: 1900, x: wps[wps.length - 1].x, y: wps[wps.length - 1].y, wpIdx: wps.length - 1, travelled: 999 });
  st.enemies.push(thief);
  const livesBefore = st.lives;
  const goldBefore = st.players.reduce((s, p) => s + p.gold, 0);
  let stole = 0;
  for (let i = 0; i < TICK_RATE && st.enemies.some((e) => e.id === 1900); i++) {
    const events = stepGame(st, simCtx, []);
    for (const ev of events) if (ev.e === 'steal') stole = ev.gold;
  }
  const goldAfter = st.players.reduce((s, p) => s + p.gold, 0);
  assert(st.lives === livesBefore, `el Ladrón NO quita vidas (${livesBefore} → ${st.lives})`);
  assert(stole > 0 && goldAfter < goldBefore, `el Ladrón robó oro al equipo (−${goldBefore - goldAfter}, evento steal ${stole})`);
}

console.log('— F4.1 · Fuga escalonada + START_LIVES 30 —');
{
  assert(START_LIVES === 30, `START_LIVES subió a 30 (${START_LIVES})`);
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  // mismo goblin fugándose en oleada 5 vs oleada 15: la 15 cuesta +1 vida (floor(15/10))
  function leakCost(wave: number): number {
    const st = createGame('sendero', 'endless', 'normal', 560, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = wave; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const wps = simCtx.waypoints[0];
    const g = mkEnemy('goblin', { id: 2100, x: wps[wps.length - 1].x, y: wps[wps.length - 1].y, wpIdx: wps.length - 1, travelled: 999 });
    st.enemies.push(g);
    const before = st.lives;
    for (let i = 0; i < TICK_RATE && st.enemies.some((e) => e.id === 2100); i++) stepGame(st, simCtx, []);
    return before - st.lives;
  }
  const cost5 = leakCost(5);
  const cost15 = leakCost(15);
  assert(cost5 === 1, `una fuga temprana (oleada 5) cuesta 1 vida (${cost5})`);
  assert(cost15 === 2, `una fuga tardía (oleada 15) cuesta 2 vidas — fuga escalonada (${cost15})`);
}

console.log('— F4.1 · Determinismo de las oleadas F4.1 (misma semilla → mismas oleadas) —');
{
  function waveHashes(): string {
    const rng = { rng: 987654321 };
    const out: string[] = [];
    for (let w = 1; w <= 25; w++) {
      const gen = generateWave(rng, w, 3, 2);
      out.push(`${w}:${gen.immune ? 'I' : ''}${gen.blessed ? 'B' : ''}${gen.bossType ?? ''}:${gen.entries.map((e) => e.type).join(',')}`);
    }
    return out.join('|');
  }
  assert(waveHashes() === waveHashes(), 'la generación de oleadas F4.1 es determinista');
}

console.log('— F4.2 · Trampa de púas: daña al pasar y se AUTO-ELIMINA al agotar cargas —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 700, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  // una celda del CAMINO para la trampa (la primera del set de celdas de camino)
  const pathCell = [...pathCells(map)][0].split(',').map(Number) as [number, number];
  const trap = mkTower('trap', { id: 3100, cx: pathCell[0], cy: pathCell[1], level: 1, spec: -1, charges: 20, invested: 60 });
  st.towers.push(trap);
  // enemigo INMUNE parado sobre la celda de la trampa (speedMult 0 = inmóvil, para
  // probar que el daño FÍSICO le entra y que la trampa agota sus cargas sobre él)
  const enemy = mkEnemy('brute', { id: 2200, hp: 100000, maxHp: 100000, spellImmune: true, speedMult: 0, x: pathCell[0] + 0.5, y: pathCell[1] + 0.5, wpIdx: 1 });
  st.enemies.push(enemy);
  const hp0 = enemy.hp;
  // un tick: la trampa golpea y consume una carga
  stepGame(st, simCtx, []);
  const trapAfter1 = st.towers.find((t) => t.id === 3100)!;
  const enemyAfter1 = st.enemies.find((e) => e.id === 2200)!;
  assert(enemyAfter1.hp < hp0, `la Trampa DAÑA a un enemigo que pasa (incluso INMUNE): ${(hp0 - enemyAfter1.hp).toFixed(0)} de daño físico`);
  assert(trapAfter1.charges === 19, `la Trampa consumió 1 carga al golpear (${trapAfter1.charges} restantes)`);

  // dejar correr hasta agotar las 20 cargas: la trampa debe auto-venderse (el enemigo
  // inmóvil la sigue pisando en cada tick).
  let selfRemoved = false;
  for (let i = 0; i < 40 && st.towers.some((t) => t.id === 3100); i++) {
    const events = stepGame(st, simCtx, []);
    for (const ev of events) if (ev.e === 'sell' && Math.round(ev.x - 0.5) === pathCell[0]) selfRemoved = true;
  }
  assert(!st.towers.some((t) => t.id === 3100), 'la Trampa se AUTO-ELIMINA al agotar sus cargas');
  assert(selfRemoved, 'la auto-venta de la Trampa emite un evento de retirada');
}

console.log('— F4.2 · Trampa de púas: SOLO se coloca sobre el camino —');
{
  const map = getMap('sendero');
  const ctx = makePlacementContext(map);
  const pathCell = [...pathCells(map)][0].split(',').map(Number) as [number, number];
  // una celda fuera del camino (construible por una torre normal)
  const off = buildCellCandidates('sendero')[0];
  // la Trampa DENTRO del camino: permitido
  assert(placementError(map, ctx, [], pathCell[0], pathCell[1], 'trap') === null, 'la Trampa SÍ se puede colocar sobre el camino');
  // la Trampa FUERA del camino: rechazada con `fuera_camino`
  assert(placementError(map, ctx, [], off[0], off[1], 'trap') === 'fuera_camino', 'la Trampa NO se puede colocar fuera del camino');
  // una torre normal NO puede ir sobre el camino (regla intacta)
  assert(placementError(map, ctx, [], pathCell[0], pathCell[1], 'archer') === 'camino', 'una torre normal NO puede ir sobre el camino');
  // una torre normal fuera del camino: permitida
  assert(placementError(map, ctx, [], off[0], off[1], 'archer') === null, 'una torre normal SÍ va fuera del camino');
}

console.log('— F4.4 · Barril explosivo: ELIMINA a los no-jefes del área (jefes: solo daño) y desaparece —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 701, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];

  // barril en una celda del camino (fila 2 de «sendero»); alrededor:
  //  - un bruto INMUNE, tanque (100k hp) e inmóvil PISANDO la celda: dispara la
  //    detonación y debe MORIR igualmente (la eliminación ignora vida/armadura/inmunidad)
  //  - un goblin inmóvil DENTRO del radio (1.5 celdas) → eliminado
  //  - un GÓLEM (jefe) DENTRO del radio → NO se elimina: recibe 240−6 de armadura
  //  - un goblin inmóvil FUERA del radio (4 celdas) → intacto
  const barrel = mkTower('boom', { id: 3400, cx: 8, cy: 2, level: 1, spec: -1, charges: 1, invested: 90 });
  st.towers.push(barrel);
  const brute = mkEnemy('brute', { id: 2500, hp: 100000, maxHp: 100000, spellImmune: true, speedMult: 0, x: 8.5, y: 2.5, wpIdx: 1 });
  const near = mkEnemy('goblin', { id: 2501, hp: 32, maxHp: 32, speedMult: 0, x: 10.0, y: 2.5, wpIdx: 1 });
  const boss = mkEnemy('golem', { id: 2503, hp: 100000, maxHp: 100000, speedMult: 0, x: 9.5, y: 2.5, wpIdx: 1 });
  const far = mkEnemy('goblin', { id: 2502, hp: 32, maxHp: 32, speedMult: 0, x: 12.5, y: 2.5, wpIdx: 1 });
  st.enemies.push(brute, near, boss, far);

  let sawSplash = false;
  let sawPoof = false;
  const events = stepGame(st, simCtx, []);
  for (const ev of events) {
    if (ev.e === 'hit' && ev.kind === 'splash' && ev.r >= 1.5) sawSplash = true;
    if (ev.e === 'sell' && ev.refund === 0) sawPoof = true;
  }
  assert(!st.enemies.some((e) => e.id === 2500), 'la detonación ELIMINA a un tanque inmune de 100k hp (no-jefe)');
  assert(!st.enemies.some((e) => e.id === 2501), 'el goblin DENTRO del radio queda eliminado');
  // jefe: NO se elimina — recibe el daño físico del barril (240 − 6 de armadura del Gólem)
  assert(st.enemies.some((e) => e.id === 2503), 'el JEFE dentro del radio SOBREVIVE a la detonación');
  assert(boss.hp === 100000 - 234, `el jefe recibe el daño del barril con armadura (${(100000 - boss.hp).toFixed(0)} == 234)`);
  assert(st.enemies.some((e) => e.id === 2502) && far.hp === 32, 'el goblin FUERA del radio queda intacto');
  assert(!st.towers.some((t) => t.id === 3400), 'el barril se AUTODESTRUYE tras detonar (un solo uso)');
  assert(sawSplash, 'la detonación emite un evento de explosión en área');
  assert(sawPoof, 'la retirada del barril emite el evento de auto-venta (refund 0)');
}

console.log('— F4.4 · Barril explosivo: los voladores NI lo disparan NI lo sufren —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 702, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  const barrel = mkTower('boom', { id: 3500, cx: 8, cy: 2, level: 1, spec: -1, charges: 1, invested: 90 });
  st.towers.push(barrel);
  // un murciélago inmóvil "sobre" la celda del barril: vuela, no lo pisa
  const bat = mkEnemy('bat', { id: 2600, hp: 100000, maxHp: 100000, speedMult: 0, x: 8.5, y: 2.5, wpIdx: 1 });
  st.enemies.push(bat);
  for (let i = 0; i < TICK_RATE; i++) stepGame(st, simCtx, []);
  assert(st.towers.some((t) => t.id === 3500), 'un volador NO dispara la detonación del barril');
  assert(bat.hp === 100000, 'el volador no recibe daño del barril');

  // colocación: mismas reglas que la Trampa (solo SOBRE el camino)
  const ctx = makePlacementContext(map);
  const off = buildCellCandidates('sendero')[0];
  assert(placementError(map, ctx, [], 8, 2, 'boom') === null, 'el Barril SÍ se coloca sobre el camino');
  assert(placementError(map, ctx, [], off[0], off[1], 'boom') === 'fuera_camino', 'el Barril NO se coloca fuera del camino');
}

console.log('— F5.2 · Madera: el orco leñador tala solo; especializar cuesta madera —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 800, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  const p = st.players[0];
  assert(p.wood === START_WOOD, `se empieza con 🪵${START_WOOD} de madera (${p.wood})`);

  // tala pasiva: 5 segundos de sim → +WOOD_PER_SEC*5, sin construir nada
  for (let i = 0; i < TICK_RATE * 5; i++) stepGame(st, simCtx, []);
  const expected = START_WOOD + WOOD_PER_SEC * 5;
  assert(Math.abs(p.wood - expected) < 0.01, `el orco tala solo: ${p.wood.toFixed(2)} ≈ ${expected.toFixed(2)} tras 5 s`);

  // especializar SIN madera suficiente: rechazo claro y la torre queda intacta
  const archer = mkTower('archer', { id: 4000, cx: 5, cy: 1, level: 3, owner: 'p1', invested: 235 });
  st.towers.push(archer);
  p.gold = 10000;
  p.wood = 10;
  let events = stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'specialize', towerId: 4000, spec: 0 } }]);
  const rej = events.find((e) => e.e === 'reject');
  assert(rej !== undefined && rej.e === 'reject' && rej.reason.includes('madera'), `sin madera, especializar se RECHAZA (${rej && rej.e === 'reject' ? rej.reason : 'sin reject'})`);
  assert(archer.spec === -1, 'la torre queda sin especializar tras el rechazo');

  // CON madera: se especializa y descuenta el coste
  p.wood = 50;
  events = stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'specialize', towerId: 4000, spec: 0 } }]);
  assert(archer.spec === 0, 'con madera suficiente, la especialización procede');
  assert(p.wood < 50 - WOOD_COST_SPEC + 1, `descontó 🪵${WOOD_COST_SPEC} de madera (quedan ${p.wood.toFixed(1)})`);
}

console.log('— F6.2 · Metralla antiaérea: ×1.5 a voladores, daño normal a tierra —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  // Mide el primer impacto de una Metralla (cañón spec 1) sobre un objetivo dado.
  function flakHit(type: EnemyTypeId): number {
    const st = createGame('sendero', 'endless', 'normal', 950, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const enemy = mkEnemy(type, { id: 2600, hp: 100000, maxHp: 100000, speedMult: 0, x: 5.5, y: 2.5, wpIdx: 1, dodgeBonus: -1 });
    st.enemies.push(enemy);
    st.towers.push(mkTower('cannon', { id: 3600, cx: 5, cy: 1, level: 3, spec: 1, invested: 820 }));
    for (let i = 0; i < TICK_RATE * 2 && enemy.hp === 100000; i++) stepGame(st, simCtx, []);
    return 100000 - enemy.hp;
  }
  // Metralla: daño 52, splash. Contra el Coloso (volador, armadura 2):
  // round(52×1.5) − 2 = 76. Contra el Bruto (tierra, armadura 2): 52 − 2 = 50.
  const vsAir = flakHit('skywhale');
  const vsGround = flakHit('brute');
  assert(vsAir === 76, `la Metralla hace ×1.5 al Coloso Alado (${vsAir} == 76 por impacto)`);
  assert(vsGround === 50, `contra tierra el daño es el normal (${vsGround} == 50)`);
}

console.log('— F5.5 · Orco mejorable: más tala por nivel, coste en oro, tope —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 901, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  st.enemies.push(mkEnemy('brute', { id: 9200, hp: 100000, maxHp: 100000, speedMult: 0, x: 15.5, y: 2.5, wpIdx: 1 }));
  const p = st.players[0];
  p.gold = 10000;
  assert(p.orcLevel === 1, 'el orco empieza en nivel 1');

  // mejorar: cobra el coste y sube el nivel
  const cost1 = ORC_UPGRADE_COSTS[0];
  let events = stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'upgrade_orc' } }]);
  assert(p.orcLevel === 2 && p.gold === 10000 - cost1, `mejorar el orco cuesta 🪙${cost1} y sube a nv 2`);
  assert(events.some((e) => e.e === 'orc' && e.level === 2), 'la mejora emite su evento (toast del cliente)');

  // la tala nueva es la del nivel 2: medir 5 s exactos DESPUÉS de la mejora
  const w0 = p.wood;
  for (let i = 0; i < TICK_RATE * 5; i++) stepGame(st, simCtx, []);
  const gained = p.wood - w0;
  assert(Math.abs(gained - ORC_RATES[1] * 5) < 0.01, `a nv 2 tala +${ORC_RATES[1]}/s (ganó ${gained.toFixed(2)} en 5 s)`);

  // al máximo: se rechaza con mensaje claro
  p.orcLevel = ORC_RATES.length;
  events = stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'upgrade_orc' } }]);
  const rej = events.find((e) => e.e === 'reject');
  assert(rej !== undefined && rej.e === 'reject' && rej.reason.includes('máximo'), 'mejorar un orco al máximo se RECHAZA');
}

console.log('— F5.4 · Mercado de madera: global, con spread, y el precio se mueve —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 900, [
    { id: 'p1', name: 'Ana', color: '#fff' },
    { id: 'p2', name: 'Beto', color: '#000' },
  ]);
  st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  // un enemigo inmóvil mantiene la oleada VIVA (si no, el fin de oleada reparte
  // su bono en el mismo tick y ensucia la aritmética del oro)
  st.enemies.push(mkEnemy('brute', { id: 9100, hp: 100000, maxHp: 100000, speedMult: 0, x: 15.5, y: 2.5, wpIdx: 1 }));
  const p1 = st.players[0];
  const p2 = st.players[1];
  p1.gold = 1000; p1.wood = 0;
  p2.gold = 1000; p2.wood = 50;

  // COMPRA de p1: paga ceil(precio × lote), recibe el lote y el precio SUBE
  const price0 = st.woodPrice;
  const cost = Math.ceil(price0 * WOOD_LOT);
  let events = stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'buy_wood' } }]);
  assert(p1.gold === 1000 - cost, `la compra cuesta ceil(precio×${WOOD_LOT}) (🪙${cost})`);
  assert(p1.wood >= WOOD_LOT, `la compra entrega ${WOOD_LOT} de madera (${p1.wood.toFixed(1)})`);
  assert(st.woodPrice > price0, `comprar SUBE el precio (${price0} → ${st.woodPrice.toFixed(2)})`);
  assert(events.some((e) => e.e === 'trade' && e.buy && e.playerId === 'p1'), 'la compra emite su evento trade');

  // VENTA de p2 al precio YA SUBIDO por p1: el mercado es GLOBAL
  const priceAfterBuy = st.woodPrice;
  const gain = Math.floor(priceAfterBuy * WOOD_SELL_SPREAD * WOOD_LOT);
  events = stepGame(st, simCtx, [{ playerId: 'p2', cmd: { kind: 'sell_wood' } }]);
  assert(p2.gold === 1000 + gain, `la venta de p2 usa el precio movido por p1 y paga el ${Math.round(WOOD_SELL_SPREAD * 100)}% (+🪙${gain})`);
  assert(st.woodPrice < priceAfterBuy, `vender BAJA el precio (${priceAfterBuy.toFixed(2)} → ${st.woodPrice.toFixed(2)})`);

  // sin madera suficiente: rechazo claro
  p1.wood = 3;
  events = stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'sell_wood' } }]);
  assert(events.some((e) => e.e === 'reject'), 'vender sin madera suficiente se RECHAZA');
}

console.log('— F4.2 · Alquimista: +30% de bounty en su radio, sin apilar —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  // Mide el oro ganado por matar un mismo bruto con `alchemists` alquimistas cubriendo
  // la posición de la muerte (nivel 1 = +30%). Con 2, sigue siendo +30% (no apila).
  function killGold(alchemists: number): number {
    const st = createGame('sendero', 'endless', 'normal', 710, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    // enemigo débil pegado al arquero para que muera de un golpe
    const enemy = mkEnemy('goblin', { id: 2300, hp: 5, maxHp: 32, x: 5.5, y: 2.5, wpIdx: 1 });
    st.enemies.push(enemy);
    const archer = mkTower('archer', { id: 3200, cx: 5, cy: 1, level: 3, invested: 200 });
    st.towers.push(archer);
    for (let i = 0; i < alchemists; i++) {
      // alquimistas junto a la muerte (radio nivel 1 = 2.4; a ≤2.4 de (5.5,2.5))
      st.towers.push(mkTower('alchemist', { id: 3300 + i, cx: 5 + i, cy: 3, level: 1, spec: -1, invested: 120 }));
    }
    const g0 = st.players[0].gold;
    for (let i = 0; i < TICK_RATE * 2 && st.enemies.some((e) => e.id === 2300); i++) stepGame(st, simCtx, []);
    return st.players[0].gold - g0;
  }
  const base = killGold(0);
  const withOne = killGold(1);
  const withTwo = killGold(2);
  assert(base > 0, `matar da bounty base (${base})`);
  assert(withOne === Math.round(base * 1.3), `el Alquimista sube el bounty ×1.3 (${base} → ${withOne})`);
  assert(withTwo === withOne, `dos Alquimistas NO apilan: mismo bounty que uno (${withOne} == ${withTwo})`);
}

console.log('— F5.3 · Alquimista: acumula el oro EXTRA (goldGen) y la baja viene marcada (⚗) —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 711, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  const enemy = mkEnemy('goblin', { id: 2350, hp: 5, maxHp: 32, x: 5.5, y: 2.5, wpIdx: 1 });
  st.enemies.push(enemy);
  st.towers.push(mkTower('archer', { id: 3210, cx: 5, cy: 1, level: 3, invested: 200 }));
  const alch = mkTower('alchemist', { id: 3310, cx: 5, cy: 3, level: 1, spec: -1, invested: 120 });
  st.towers.push(alch);
  let deathAlch = 0;
  for (let i = 0; i < TICK_RATE * 2 && st.enemies.some((e) => e.id === 2350); i++) {
    const events = stepGame(st, simCtx, []);
    for (const ev of events) if (ev.e === 'death' && ev.type === 'goblin') deathAlch = ev.alch ?? 0;
  }
  assert(deathAlch > 0, `la baja dentro del anillo viene marcada con su extra (alch=${deathAlch})`);
  assert(alch.goldGen === deathAlch, `el Alquimista ACUMULA el oro extra en goldGen (${alch.goldGen} == ${deathAlch})`);
}

console.log('— F4.2 · Rango II de ejecución: remata al 75% de la vida ACTUAL, NO a un inmune —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  // Cañón de Riel II (executeCurrent 0.75, daño base 620). Un tanque con 800 hp:
  // el disparo (~620) lo deja bajo el 75% de su vida ACTUAL → rematado. El inmune,
  // con el mismo golpe, SOBREVIVE (executeCurrent es daño de hechizo).
  function railcannon2(immune: boolean): { killed: boolean; hpLeft: number } {
    const st = createGame('sendero', 'endless', 'normal', 720, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const enemy = mkEnemy('brute', { id: 2400, hp: 800, maxHp: 4000, spellImmune: immune, x: 5.5, y: 2.5 });
    st.enemies.push(enemy);
    // sniper spec 0 (Cañón de Riel), nivel 4 = Rango II (executeCurrent)
    st.towers.push(mkTower('sniper', { id: 3400, spec: 0, level: 4, cx: 5, cy: 1, invested: 1200 }));
    stepGame(st, simCtx, []); // un disparo
    const alive = st.enemies.find((e) => e.id === 2400);
    return { killed: !alive, hpLeft: alive ? alive.hp : 0 };
  }
  // verifica que el nivel 4 usa executeCurrent (no execute clásico)
  const r2lvl = activeStats('sniper', 4, 0);
  assert((r2lvl.executeCurrent ?? 0) === 0.75, `el Cañón de Riel II usa executeCurrent 0.75 (${r2lvl.executeCurrent})`);
  const normal = railcannon2(false);
  const immune = railcannon2(true);
  assert(normal.killed, 'el Rango II de ejecución remata a un tanque normal (75% de la vida ACTUAL)');
  assert(!immune.killed && immune.hpLeft > 0, `NO remata a un inmune con el mismo golpe (queda con ${immune.hpLeft.toFixed(0)} hp)`);
}

console.log('— F4.2 · Shred de armadura: reduce a la mitad la armadura efectiva —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  // Un enemigo con armadura 20. Un arquero (daño físico plano) le pega: sin shred,
  // recibe daño - 20; con shred activo, recibe daño - 10 (más daño). Aplicamos el
  // shred a mano (armorShredUntil futuro) y medimos el daño de un golpe idéntico.
  function archerDamage(shred: boolean): number {
    const st = createGame('sendero', 'endless', 'normal', 730, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const enemy = mkEnemy('brute', { id: 2500, hp: 100000, maxHp: 100000, armorBonus: 20, x: 5.5, y: 2.5, wpIdx: 1 });
    if (shred) enemy.armorShredUntil = st.tick + TICK_RATE * 4;
    st.enemies.push(enemy);
    st.towers.push(mkTower('archer', { id: 3500, cx: 5, cy: 1, level: 1, invested: 50 }));
    const hp0 = enemy.hp;
    // deja que el dardo impacte
    for (let i = 0; i < TICK_RATE && st.enemies[0].hp === hp0; i++) stepGame(st, simCtx, []);
    return hp0 - st.enemies[0].hp;
  }
  const noShred = archerDamage(false);
  const withShred = archerDamage(true);
  // armadura base del bruto = 2; +20 bonus = 22. daño arquero nv1 = 8. Sin shred:
  // max(1, 8-22)=1. Con shred: armadura 11 → max(1, 8-11)=1. Ese caso satura al mínimo;
  // usa un enemigo con armadura menor para que el efecto sea medible.
  void noShred; void withShred;

  // versión medible: armadura efectiva 4 vs 2 con un cañón de nivel 3 (daño 78)
  function cannonDamage(shred: boolean): number {
    const st = createGame('sendero', 'endless', 'normal', 731, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const enemy = mkEnemy('goblin', { id: 2510, hp: 100000, maxHp: 100000, armorBonus: 40, x: 5.5, y: 2.5, wpIdx: 1 });
    if (shred) enemy.armorShredUntil = st.tick + TICK_RATE * 4;
    st.enemies.push(enemy);
    st.towers.push(mkTower('sniper', { id: 3510, cx: 5, cy: 1, level: 3, spec: -1, invested: 300 })); // sniper nv3: 210 dmg, NO pierceArmor? sí perfora...
    const hp0 = enemy.hp;
    for (let i = 0; i < TICK_RATE && st.enemies[0].hp === hp0; i++) stepGame(st, simCtx, []);
    return hp0 - st.enemies[0].hp;
  }
  void cannonDamage;

  // El sniper perfora armadura, así que usamos un ARQUERO con daño alto por aura para
  // medir limpio: mejor construir el caso a mano con damageEnemy vía un cañón nv3.
  function measured(shred: boolean): number {
    const st = createGame('sendero', 'endless', 'normal', 732, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const enemy = mkEnemy('goblin', { id: 2520, hp: 100000, maxHp: 100000, armorBonus: 40, x: 5.5, y: 2.5, wpIdx: 1 });
    if (shred) enemy.armorShredUntil = st.tick + TICK_RATE * 4;
    st.enemies.push(enemy);
    st.towers.push(mkTower('cannon', { id: 3520, cx: 5, cy: 1, level: 3, spec: -1, invested: 440 })); // cañón nv3: 78 dmg, no perfora
    const hp0 = enemy.hp;
    for (let i = 0; i < TICK_RATE * 2 && st.enemies[0].hp === hp0; i++) stepGame(st, simCtx, []);
    return hp0 - st.enemies[0].hp;
  }
  const dmgNoShred = measured(false); // armadura efectiva 42 → 78-42 = 36
  const dmgShred = measured(true); // armadura efectiva 21 → 78-21 = 57
  assert(dmgShred > dmgNoShred, `el shred reduce la armadura efectiva a la mitad → más daño (${dmgNoShred} → ${dmgShred})`);
  // el enemigo tiene armadura base 0 (goblin) + 40 bonus = 40; efectiva 20 con shred.
  assert(Math.abs((78 - 20) - dmgShred) <= 1 && Math.abs((78 - 40) - dmgNoShred) <= 1, `armadura efectiva a la mitad con shred (sin ${dmgNoShred}=78-40, con ${dmgShred}=78-20)`);
}

console.log('— F4.2 · Crecimiento permanente: el daño de la torre sube disparo a disparo —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 740, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  // Arco Largo II (archer spec 1, nivel 4 = Rango II con growth +8/disparo)
  const enemy = mkEnemy('brute', { id: 2600, hp: 1e9, maxHp: 1e9, x: 5.5, y: 2.5, wpIdx: 1 });
  st.enemies.push(enemy);
  const bow = mkTower('archer', { id: 3600, spec: 1, level: 4, cx: 5, cy: 1, invested: 900 });
  st.towers.push(bow);
  // captura el daño del primer y de un disparo posterior comparando growthBonus
  const g0 = st.towers.find((t) => t.id === 3600)!.growthBonus;
  // dejar disparar unas cuantas veces
  for (let i = 0; i < TICK_RATE * 6; i++) stepGame(st, simCtx, []);
  const g1 = st.towers.find((t) => t.id === 3600)!.growthBonus;
  assert((activeStats('archer', 4, 1).growth ?? 0) === 8, 'el Arco Largo II tiene growth +8');
  assert(g1 > g0, `el crecimiento permanente sube el bono de daño disparo a disparo (${g0} → ${g1})`);
  assert(g1 % 8 === 0 && g1 >= 8, `el bono crece en pasos de +8 (${g1})`);
}

console.log('— F4.2 · determinismo con torres F4.2 (misma semilla → mismo estado) —');
{
  function f42Hash(): string {
    const map = getMap('sendero');
    const simCtx = makeSimContext(map, makePlacementContext(map));
    const st = createGame('sendero', 'endless', 'normal', 750, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 6; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const pathCell = [...pathCells(map)][0].split(',').map(Number) as [number, number];
    st.towers.push(mkTower('trap', { id: 4000, cx: pathCell[0], cy: pathCell[1], level: 1, spec: -1, charges: 20, invested: 60 }));
    st.towers.push(mkTower('alchemist', { id: 4001, cx: 5, cy: 3, level: 3, spec: 0, invested: 300 }));
    st.towers.push(mkTower('cannon', { id: 4002, spec: 0, level: 4, cx: 6, cy: 1, invested: 800 })); // Obús II (shred)
    for (let k = 0; k < 10; k++) st.enemies.push(mkEnemy('brute', { id: 5000 + k, x: pathCell[0] + 0.5, y: pathCell[1] + 0.5, wpIdx: 1 }));
    for (let i = 0; i < TICK_RATE * 20; i++) stepGame(st, simCtx, []);
    return JSON.stringify([st.tick, st.rng, st.nextId, st.enemies.length, st.towers.map((t) => [t.id, t.charges, t.growthBonus]), st.players[0].gold]);
  }
  assert(f42Hash() === f42Hash(), 'la sim con Trampa/Alquimista/shred es determinista');
}

console.log('— F4.3 · Fusión: consume 2 torres y crea 1 con invested sumado —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 800, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  // dos celdas CONSTRUIBLES adyacentes (Chebyshev 1) para el par hielo+veneno
  const cands = buildCellCandidates('sendero');
  const cellA = cands.find((a) =>
    cands.some((b) => (a[0] !== b[0] || a[1] !== b[1]) && Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) === 1),
  )!;
  const cellB = cands.find(
    (b) => (b[0] !== cellA[0] || b[1] !== cellA[1]) && Math.max(Math.abs(cellA[0] - b[0]), Math.abs(cellA[1] - b[1])) === 1,
  )!;
  // hielo y veneno ESPECIALIZADOS adyacentes → Plaga Glacial
  st.towers.push(mkTower('frost', { id: 4100, cx: cellA[0], cy: cellA[1], spec: 0, invested: 655 }));
  st.towers.push(mkTower('poison', { id: 4101, cx: cellB[0], cy: cellB[1], spec: 1, invested: 755 }));
  const events = stepGame(st, simCtx, [
    { playerId: 'p1', cmd: { kind: 'fuse', towerId: 4100, otherId: 4101, keepId: 4100 } },
  ]);
  const fuseEv = events.find((e) => e.e === 'fuse');
  const fused = st.towers.find((t) => t.id === 4100);
  assert(st.towers.length === 1, `la fusión CONSUME ambas torres y deja UNA (${st.towers.length})`);
  assert(fused !== undefined && fused.fusion === FUSION_ORDER.indexOf('glacialplague'), `la torre resultante lleva la fusión correcta (fusion=${fused?.fusion} = glacialplague)`);
  assert(fused!.invested === 655 + 755, `invested = suma de ambos ingredientes (${fused!.invested} == 1410)`);
  assert(fused!.spec === -1 && fused!.level === 3, `la fusionada queda con level 3 y spec −1 (level=${fused!.level}, spec=${fused!.spec})`);
  assert(fused!.cx === cellA[0] && fused!.cy === cellA[1], `la fusión se queda en la celda de keepId (${fused!.cx},${fused!.cy})`);
  assert(fuseEv !== undefined && fuseEv.e === 'fuse' && fuseEv.name === FUSIONS.glacialplague.name, 'se emite el evento fuse con el nombre de la receta');

  // la celda liberada vuelve a ser construible
  assert(
    placementError(map, makePlacementContext(map), st.towers, cellB[0], cellB[1], 'archer') === null,
    'la celda del ingrediente consumido queda LIBRE',
  );

  // una fusión no se puede mejorar ni especializar ni re-fusionar
  const ev2 = stepGame(st, simCtx, [
    { playerId: 'p1', cmd: { kind: 'upgrade', towerId: 4100 } },
    { playerId: 'p1', cmd: { kind: 'specialize', towerId: 4100, spec: 0 } },
  ]);
  const rejects2 = ev2.filter((e) => e.e === 'reject').map((e) => (e.e === 'reject' ? e.reason : ''));
  assert(rejects2.some((r) => r.includes('no se puede mejorar')), 'una fusión NO se puede mejorar (reject)');
  assert(rejects2.some((r) => r.includes('no se puede especializar')), 'una fusión NO se puede especializar (reject)');
}

console.log('— F4.3 · Fusión: rechazos (adyacencia, spec, receta, dueño, keepId) —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  function tryFuse(
    setup: (st: GameState) => void,
    cmd: { towerId: number; otherId: number; keepId: number },
    by = 'p1',
  ): string[] {
    const st = createGame('sendero', 'endless', 'normal', 801, [
      { id: 'p1', name: 'A', color: '#fff' },
      { id: 'p2', name: 'B', color: '#000' },
    ]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    setup(st);
    const events = stepGame(st, simCtx, [{ playerId: by, cmd: { kind: 'fuse', ...cmd } }]);
    return events.filter((e) => e.e === 'reject').map((e) => (e.e === 'reject' ? e.reason : ''));
  }

  // no adyacentes (distancia 3)
  let r = tryFuse((st) => {
    st.towers.push(mkTower('frost', { id: 4110, cx: 5, cy: 1, spec: 0 }));
    st.towers.push(mkTower('poison', { id: 4111, cx: 8, cy: 1, spec: 0 }));
  }, { towerId: 4110, otherId: 4111, keepId: 4110 });
  assert(r.some((x) => x.includes('adyacentes')), `rechaza torres NO adyacentes (${r[0] ?? 'sin reject'})`);

  // sin especializar
  r = tryFuse((st) => {
    st.towers.push(mkTower('frost', { id: 4112, cx: 5, cy: 1, spec: -1 }));
    st.towers.push(mkTower('poison', { id: 4113, cx: 6, cy: 1, spec: 0 }));
  }, { towerId: 4112, otherId: 4113, keepId: 4112 });
  assert(r.some((x) => x.includes('especializadas')), `rechaza torres SIN especializar (${r[0] ?? 'sin reject'})`);

  // tipos sin receta (arquero + cañón)
  r = tryFuse((st) => {
    st.towers.push(mkTower('archer', { id: 4114, cx: 5, cy: 1, spec: 0 }));
    st.towers.push(mkTower('cannon', { id: 4115, cx: 6, cy: 1, spec: 0 }));
  }, { towerId: 4114, otherId: 4115, keepId: 4114 });
  assert(r.some((x) => x.includes('receta')), `rechaza tipos SIN receta (${r[0] ?? 'sin reject'})`);

  // dueño distinto
  r = tryFuse((st) => {
    st.towers.push(mkTower('frost', { id: 4116, cx: 5, cy: 1, spec: 0, owner: 'p1' }));
    st.towers.push(mkTower('poison', { id: 4117, cx: 6, cy: 1, spec: 0, owner: 'p2' }));
  }, { towerId: 4116, otherId: 4117, keepId: 4116 });
  assert(r.some((x) => x.includes('tuyas')), `rechaza torres de OTRO dueño (${r[0] ?? 'sin reject'})`);

  // keepId que no es ninguna de las dos
  r = tryFuse((st) => {
    st.towers.push(mkTower('frost', { id: 4118, cx: 5, cy: 1, spec: 0 }));
    st.towers.push(mkTower('poison', { id: 4119, cx: 6, cy: 1, spec: 0 }));
  }, { towerId: 4118, otherId: 4119, keepId: 9999 });
  assert(r.some((x) => x.includes('destino')), `rechaza keepId inválido (${r[0] ?? 'sin reject'})`);
}

console.log('— F4.3 · Plaga Glacial: ralentiza+envenena en ÁREA; el inmune queda exento —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 810, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  st.towers.push(mkFused('frost', 'glacialplague', { id: 4200, cx: 5, cy: 1 }));
  // dos normales + un inmune apiñados (dentro del splash 1.5 del primero)
  const e1 = mkEnemy('brute', { id: 4201, hp: 100000, maxHp: 100000, speedMult: 0, x: 5.5, y: 2.5 });
  const e2 = mkEnemy('brute', { id: 4202, hp: 100000, maxHp: 100000, speedMult: 0, x: 6.0, y: 2.8 });
  const im = mkEnemy('brute', { id: 4203, hp: 100000, maxHp: 100000, speedMult: 0, x: 5.2, y: 2.9, spellImmune: true });
  st.enemies.push(e1, e2, im);
  const imHp0 = im.hp;
  for (let i = 0; i < TICK_RATE * 2; i++) stepGame(st, simCtx, []);
  assert(e1.slowFactor < 1 && e1.poisonDps > 0, `la nube RALENTIZA y ENVENENA a la vez (slow ${e1.slowFactor}, dps ${e1.poisonDps})`);
  assert(e2.slowFactor < 1 && e2.poisonDps > 0, `el efecto es de ÁREA: también al segundo enemigo (slow ${e2.slowFactor}, dps ${e2.poisonDps})`);
  assert(im.slowFactor === 1 && im.poisonDps === 0, 'el INMUNE no recibe ni slow ni veneno');
  assert(im.hp < imHp0, `al inmune solo le entra el daño físico de impacto (−${(imHp0 - im.hp).toFixed(0)})`);
}

console.log('— F4.3 · Tormenta de Riel: un disparo golpea a VARIOS alineados (inmunes −70%) —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 811, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  st.towers.push(mkFused('tesla', 'railstorm', { id: 4300, cx: 5, cy: 1 }));
  // tres enemigos alineados en vertical con la torre (x=5.5) + un inmune en la línea
  const a1 = mkEnemy('brute', { id: 4301, hp: 100000, maxHp: 100000, speedMult: 0, x: 5.5, y: 2.5 });
  const a2 = mkEnemy('brute', { id: 4302, hp: 100000, maxHp: 100000, speedMult: 0, x: 5.5, y: 4.0 });
  const a3 = mkEnemy('brute', { id: 4303, hp: 100000, maxHp: 100000, speedMult: 0, x: 5.5, y: 6.0 });
  const im = mkEnemy('brute', { id: 4304, hp: 100000, maxHp: 100000, speedMult: 0, x: 5.5, y: 3.2, spellImmune: true });
  st.enemies.push(a1, a2, a3, im);
  const events = stepGame(st, simCtx, []); // un disparo instantáneo
  const dmg = FUSIONS.railstorm.stats.damage; // 320, perfora armadura
  const lost = (e: EnemyState) => 100000 - e.hp;
  assert(lost(a1) === dmg && lost(a2) === dmg && lost(a3) === dmg, `el rayo PERFORA: los 3 alineados reciben ${dmg} de un solo disparo (${lost(a1)}/${lost(a2)}/${lost(a3)})`);
  assert(lost(im) === Math.round(dmg * 0.3), `el inmune en la línea recibe −70% (${lost(im)} == ${Math.round(dmg * 0.3)})`);
  assert(events.some((e) => e.e === 'shot' && e.kind === 'beam'), 'el disparo emite el evento de rayo lineal');
}

console.log('— F4.3 · Gran Bertha: alcanza un enemigo al OTRO LADO del mapa —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 812, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  st.towers.push(mkFused('cannon', 'bigbertha', { id: 4400, cx: 5, cy: 1 }));
  // el waypoint MÁS LEJANO de la torre (fuera del alcance de cualquier torre normal)
  const wps = simCtx.waypoints[0];
  let farIdx = 1;
  let farDist = 0;
  for (let i = 0; i < wps.length; i++) {
    const d = Math.hypot(wps[i].x - 5.5, wps[i].y - 1.5);
    if (d > farDist) { farDist = d; farIdx = i; }
  }
  const far = mkEnemy('brute', { id: 4401, hp: 100000, maxHp: 100000, speedMult: 0, x: wps[farIdx].x, y: wps[farIdx].y, wpIdx: Math.max(1, farIdx) });
  st.enemies.push(far);
  assert(farDist > 8, `el objetivo está lejísimos (${farDist.toFixed(1)} celdas, más allá de cualquier torre normal)`);
  for (let i = 0; i < TICK_RATE * 5; i++) stepGame(st, simCtx, []);
  assert(far.hp < 100000, `la Gran Bertha lo alcanza igual (−${(100000 - far.hp).toFixed(0)} de daño)`);
}

console.log('— F4.3 · Señor de la Guerra: DISPARA y su aura buffea con regla MAX —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 813, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  const warlord = mkFused('archer', 'warlord', { id: 4500, cx: 5, cy: 1 });
  const archer = mkTower('archer', { id: 4501, cx: 6, cy: 1, level: 1 });
  const banner = mkTower('banner', { id: 4502, cx: 5, cy: 2, level: 1 }); // aura 0.15
  st.towers.push(warlord, archer, banner);
  // enemigo a ~2 celdas: en rango de ambos, y lo bastante lejos para que el
  // proyectil del Señor de la Guerra NO impacte en el mismo tick del disparo
  st.enemies.push(mkEnemy('brute', { id: 4503, hp: 100000, maxHp: 100000, speedMult: 0, x: 5.5, y: 3.5 }));
  // aura: el arquero vecino recibe el MEJOR aura (warlord > estandarte nv1 0.15), sin apilar
  const warAura = FUSIONS.warlord.stats.auraDamage!;
  const auras = computeAuras(st);
  assert(auras.get(4501)?.dmgMult === warAura, `el aura del Señor de la Guerra buffea al vecino con regla MAX: ${warAura}, no ${warAura + 0.15} (${auras.get(4501)?.dmgMult})`);
  // regla de recepción: las torres que DISPARAN reciben auras — el Señor de la
  // Guerra (alsoFires) recibe la del estandarte vecino; un estandarte puro, no.
  assert(auras.get(4500)?.dmgMult === 0.15, `el Señor de la Guerra SÍ recibe auras porque dispara (${auras.get(4500)?.dmgMult} == 0.15 del estandarte nv1)`);
  assert(!auras.has(4502), 'el estandarte puro NO recibe el aura del Señor de la Guerra');
  stepGame(st, simCtx, []);
  const wshot = st.projectiles.find((p) => p.towerId === 4500);
  const ashot = st.projectiles.find((p) => p.towerId === 4501);
  assert(wshot !== undefined && wshot.damage === Math.round(FUSIONS.warlord.stats.damage * 1.15), `el Señor de la Guerra DISPARA, buffeado por el estandarte (proyectil de ${wshot?.damage})`);
  assert(ashot !== undefined && ashot.damage === Math.round(8 * (1 + warAura)), `el arquero vecino dispara buffeado (${ashot?.damage} == ${Math.round(8 * (1 + warAura))})`);
}

console.log('— F4.3 · Piedra Filosofal: las bajas por SU veneno pagan ×2 (y compone con el Alquimista) —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const goblinBounty = ENEMIES.goblin.bounty;
  // Mata un goblin con el DoT de la torre dada y devuelve el oro ganado por la baja.
  function poisonKillGold(towerType: 'philostone' | 'poison', withAlchemist: boolean): number {
    const st = createGame('sendero', 'endless', 'normal', 814, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    if (towerType === 'philostone') {
      st.towers.push(mkFused('poison', 'philostone', { id: 4600, cx: 5, cy: 1 }));
    } else {
      st.towers.push(mkTower('poison', { id: 4600, cx: 5, cy: 1, level: 3, spec: -1 }));
    }
    if (withAlchemist) st.towers.push(mkTower('alchemist', { id: 4601, cx: 5, cy: 3, level: 1, spec: -1 }));
    // hp suficiente para SOBREVIVIR al impacto y morir por el DoT (baja por veneno)
    const gob = mkEnemy('goblin', { id: 4602, hp: 40, maxHp: 60, speedMult: 0, x: 5.5, y: 2.5 });
    st.enemies.push(gob);
    const g0 = st.players[0].gold;
    let died = false;
    for (let i = 0; i < TICK_RATE * 6 && !died; i++) {
      const events = stepGame(st, simCtx, []);
      died = events.some((e) => e.e === 'death');
    }
    return st.players[0].gold - g0;
  }
  const doubled = poisonKillGold('philostone', false);
  const composed = poisonKillGold('philostone', true);
  const normal = poisonKillGold('poison', false);
  assert(normal === Math.round(goblinBounty), `una baja por veneno NORMAL paga el bounty base (${normal} == ${Math.round(goblinBounty)})`);
  assert(doubled === Math.round(goblinBounty * 2), `una baja por veneno de la Piedra Filosofal paga ×2 (${doubled} == ${Math.round(goblinBounty * 2)})`);
  // orden documentado: base × oleada × Alquimista × Piedra, UN redondeo al final
  assert(composed === Math.round(goblinBounty * 1.3 * 2), `compone con el aura del Alquimista: base×1.3×2 (${composed} == ${Math.round(goblinBounty * 1.3 * 2)})`);
}

console.log('— F4.3 · Corazón de Invierno: aura DOBLE (congela enemigos + acelera torres) —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 815, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  const heart = mkFused('frost', 'winterheart', { id: 4700, cx: 5, cy: 1 });
  const archer = mkTower('archer', { id: 4701, cx: 6, cy: 1, level: 1 });
  st.towers.push(heart, archer);
  const enemy = mkEnemy('brute', { id: 4702, hp: 100000, maxHp: 100000, speedMult: 0, x: 5.5, y: 3.0 });
  const im = mkEnemy('brute', { id: 4703, hp: 100000, maxHp: 100000, speedMult: 0, x: 6.0, y: 3.0, spellImmune: true });
  st.enemies.push(enemy, im);
  const heartHaste = FUSIONS.winterheart.stats.auraHaste!;
  const heartSlow = FUSIONS.winterheart.stats.slowAura!.factor;
  const auras = computeAuras(st);
  assert(auras.get(4701)?.hasteMult === heartHaste, `el aura de cadencia llega a la torre vecina (+${heartHaste * 100}%: ${auras.get(4701)?.hasteMult})`);
  stepGame(st, simCtx, []);
  assert(enemy.slowFactor === heartSlow, `el aura de hielo RALENTIZA al enemigo en radio (slowFactor ${enemy.slowFactor})`);
  assert(im.slowFactor === 1, 'el INMUNE queda exento del aura de hielo');
  // el arquero disparó con cadencia acelerada: cooldown < base
  const baseCd = Math.round(0.7 * TICK_RATE);
  const fastCd = Math.round((0.7 * TICK_RATE) / (1 + heartHaste));
  assert(archer.cooldownLeft === fastCd && fastCd < baseCd, `la torre vecina dispara MÁS RÁPIDO (cooldown ${archer.cooldownLeft} == ${fastCd} < ${baseCd})`);
  // el propio Corazón no dispara (es torre de aura)
  assert(st.projectiles.every((p) => p.towerId !== 4700), 'el Corazón de Invierno no dispara');
}

console.log('— Determinismo: misma semilla + mismos comandos → mismo estado —');
const b = runScenario();
const hashA = JSON.stringify([a.state.tick, a.state.wave, a.state.lives, a.state.rng, a.state.players.map((p) => p.gold), a.state.nextId]);
const hashB = JSON.stringify([b.state.tick, b.state.wave, b.state.lives, b.state.rng, b.state.players.map((p) => p.gold), b.state.nextId]);
assert(hashA === hashB, 'la simulación es determinista');

console.log(process.exitCode ? '\n💥 Hay fallos' : '\n🎉 Simulación OK');
