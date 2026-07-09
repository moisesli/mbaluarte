// Sonda de BALANCE (desechable): corre partidas completas con los bots del
// simtest en varias dificultades/semillas y saca métricas para revisar el
// balanceo. No es un test (no falla): imprime datos.
import {
  createGame,
  generateWave,
  getMap,
  hasRank2,
  makePlacementContext,
  makeSimContext,
  pathCells,
  placementError,
  rank2Cost,
  stepGame,
  towerLevel,
  findFusion,
  FUSION_ORDER,
  FUSIONS,
  ORC_RATES,
  ORC_UPGRADE_COSTS,
  TICK_RATE,
  TOWERS,
  WOOD_COST_RANK2,
  WOOD_COST_SPEC,
  type Difficulty,
  type EnemyTypeId,
  type FusionId,
  type GameEvent,
  type GameState,
  type PlayerCommand,
  type SpawnEntry,
  type TowerState,
  type TowerTypeId,
} from '@td/shared';

const MAX_TICKS = TICK_RATE * 60 * 45;

// Torre fusionada armada a mano (misma forma que mkFused del simtest): fusion =
// índice en FUSION_ORDER, level 3, spec −1. `type` = primer ingrediente (arte/compat).
function mkFusedTower(fid: FusionId, cx: number, cy: number, owner = 'p1'): TowerState {
  return {
    id: 90000 + FUSION_ORDER.indexOf(fid), type: FUSIONS[fid].ingredients[0], cx, cy,
    level: 3, spec: -1, fusion: FUSION_ORDER.indexOf(fid), owner,
    cooldownLeft: 0, targetMode: 'first', invested: 400, kills: 0, damage: 0, stunnedUntil: 0,
    charges: 0, growthBonus: 0, goldGen: 0, focusId: 0, halted: false,
  };
}

// Celda construible pegada al camino MÁS cercana a un punto (para plantar la torre
// del banco de pruebas donde de verdad alcanza a los enemigos que pasan).
function nearestBuildCell(mapId: string, x: number, y: number): [number, number] {
  const cands = buildCellCandidates(mapId);
  return cands
    .slice()
    .sort((a, b) => Math.hypot(a[0] + 0.5 - x, a[1] + 0.5 - y) - Math.hypot(b[0] + 0.5 - x, b[1] + 0.5 - y))[0];
}

// Lote 3 · celda libre pegada al camino MÁS cercana al inicio (para el Sentry del bot).
function pickSentryCell(
  candidates: [number, number][],
  used: Set<string>,
  spawn: { x: number; y: number },
): [number, number] | null {
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (const [cx, cy] of candidates) {
    if (used.has(`${cx},${cy}`)) continue;
    const d = Math.hypot(cx + 0.5 - spawn.x, cy + 0.5 - spawn.y);
    if (d < bestD) {
      bestD = d;
      best = [cx, cy];
    }
  }
  return best;
}

function buildCellCandidates(mapId: string): [number, number][] {
  const map = getMap(mapId);
  const paths = pathCells(map);
  const ctx = makePlacementContext(map);
  const out: [number, number][] = [];
  for (let cy = 0; cy < map.gridH; cy++) {
    for (let cx = 0; cx < map.gridW; cx++) {
      if (placementError(map, ctx, [], cx, cy)) continue;
      let nearPath = false;
      for (let dy = -1; dy <= 1 && !nearPath; dy++)
        for (let dx = -1; dx <= 1 && !nearPath; dx++)
          if (paths.has(`${cx + dx},${cy + dy}`)) nearPath = true;
      if (nearPath) out.push([cx, cy]);
    }
  }
  return out;
}

const BUILD_ORDER: TowerTypeId[] = ['archer', 'cannon', 'frost', 'archer', 'tesla', 'banner', 'poison', 'sniper', 'mortar'];

// bot idéntico en espíritu al del simtest (recortado). Ahora coloca un SENTRY antes
// de la oleada 12 (primera invisible), como el bot del simtest: sin él, el bot moría
// SIEMPRE en la 12 y las corridas nunca llegaban al final (sonda inservible).
function botCommands(
  state: GameState,
  candidates: [number, number][],
  counters: Map<string, number>,
  spawn: { x: number; y: number } = { x: 0.5, y: 0.5 },
  useFusion = true,
): PlayerCommand[] {
  const cmds: PlayerCommand[] = [];
  if (state.waveState !== 'interlude') return cmds;
  const used = new Set(state.towers.map((t) => `${t.cx},${t.cy}`));
  let sentryCount = state.towers.filter((t) => t.type === 'sentry').length;
  const sentryTarget = state.wave >= 11 ? 1 : 0;
  for (const player of state.players) {
    let budget = player.gold;
    let woodBudget = player.wood;
    let orcLvl = player.orcLevel;
    // issue #7: como el simtest, el bot solo fusiona su par deliberado (frost+veneno →
    // Plaga Glacial). Fusionar CUALQUIER par adyacente (con 11 recetas) hacía que el
    // bot se auto-mutilara y perdiera; limitarlo restaura su juego sano.
    const fusable = useFusion ? state.towers.filter((t) => t.owner === player.id && t.spec >= 0 && t.fusion < 0) : [];
    outer: for (let i = 0; i < fusable.length; i++) {
      for (let j = i + 1; j < fusable.length; j++) {
        const A = fusable[i]; const B = fusable[j];
        if (Math.max(Math.abs(A.cx - B.cx), Math.abs(A.cy - B.cy)) !== 1) continue;
        if (findFusion(A.type, B.type)?.id !== 'glacialplague') continue;
        cmds.push({ playerId: player.id, cmd: { kind: 'fuse', towerId: A.id, otherId: B.id, keepId: A.id } });
        break outer;
      }
    }
    const mine = state.towers
      .filter((t) => t.owner === player.id && t.fusion < 0 && t.type !== 'sentry')
      .map((t) => ({ id: t.id, type: t.type, level: t.level, spec: t.spec }));
    for (let act = 0; act < 3; act++) {
      const maxed = mine.filter((t) => t.level >= 3 && t.spec < 0)[0];
      if (maxed) {
        const specIdx = maxed.id % 2;
        const specCost = TOWERS[maxed.type].specs[specIdx].cost;
        if (budget >= specCost && woodBudget >= WOOD_COST_SPEC) {
          cmds.push({ playerId: player.id, cmd: { kind: 'specialize', towerId: maxed.id, spec: specIdx } });
          maxed.spec = specIdx; budget -= specCost; woodBudget -= WOOD_COST_SPEC;
          continue;
        }
      }
      const r2able = mine.find((t) => t.level === 3 && t.spec >= 0 && hasRank2(t.type, t.spec));
      if (r2able) {
        const r2cost = rank2Cost(r2able.type, r2able.spec) ?? Infinity;
        if (budget >= r2cost && woodBudget >= WOOD_COST_RANK2) {
          cmds.push({ playerId: player.id, cmd: { kind: 'upgrade', towerId: r2able.id } });
          r2able.level = 4; budget -= r2cost; woodBudget -= WOOD_COST_RANK2;
          continue;
        }
      }
      if (orcLvl < ORC_RATES.length && mine.length >= 6 && woodBudget < WOOD_COST_SPEC && budget >= ORC_UPGRADE_COSTS[orcLvl - 1] + 350) {
        cmds.push({ playerId: player.id, cmd: { kind: 'upgrade_orc' } });
        budget -= ORC_UPGRADE_COSTS[orcLvl - 1];
        orcLvl += 1;
        continue;
      }
      const upgradable = mine.filter((t) => t.level < 3).sort((x, y) => y.level - x.level)[0];
      if (mine.length >= 4 && upgradable) {
        const upCost = towerLevel(upgradable.type, upgradable.level + 1).cost;
        if (budget >= upCost) {
          cmds.push({ playerId: player.id, cmd: { kind: 'upgrade', towerId: upgradable.id } });
          upgradable.level += 1; budget -= upCost;
          continue;
        }
      }
      const n = counters.get(player.id) ?? 0;
      const nextType = BUILD_ORDER[n % BUILD_ORDER.length];
      const cost = TOWERS[nextType].levels[0].cost;
      if (budget >= cost + 20) {
        const cell = candidates.find(([cx, cy]) => !used.has(`${cx},${cy}`));
        if (cell) {
          used.add(`${cell[0]},${cell[1]}`);
          cmds.push({ playerId: player.id, cmd: { kind: 'place', towerType: nextType, cx: cell[0], cy: cell[1] } });
          counters.set(player.id, n + 1);
          mine.push({ id: -1 - act, type: nextType, level: 1, spec: -1 });
          budget -= cost;
          continue;
        }
      }
      break;
    }

    // SENTRY (Lote 3): con oro de sobra y aún sin detector, planta UNO cerca del
    // spawn (detección pegajosa: uno basta para todas las oleadas invisibles).
    const sentryCost = TOWERS.sentry.levels[0].cost;
    if (mine.length >= 4 && sentryCount < sentryTarget && budget >= sentryCost) {
      const cell = pickSentryCell(candidates, used, spawn);
      if (cell) {
        used.add(`${cell[0]},${cell[1]}`);
        cmds.push({ playerId: player.id, cmd: { kind: 'place', towerType: 'sentry', cx: cell[0], cy: cell[1] } });
        sentryCount += 1;
        budget -= sentryCost;
      }
    }
  }
  if (state.interludeLeft < TICK_RATE * 8 && state.interludeLeft > TICK_RATE * 2) {
    cmds.push({ playerId: state.players[0].id, cmd: { kind: 'call_wave' } });
  }
  return cmds;
}

interface RunResult {
  victory: boolean; wave: number; lives: number; minutes: number;
  livesLostByWave: Map<number, number>;
  specs: number; rank2: number; fusions: number; towers: number;
  goldEarned: number; woodSpent: number;
}

function run(mapId: string, diff: Difficulty, seed: number, useFusion = true): RunResult {
  const map = getMap(mapId);
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const state = createGame(mapId, 'classic', diff, seed, [
    { id: 'p1', name: 'Ana', color: '#fff' },
    { id: 'p2', name: 'Beto', color: '#000' },
  ]);
  const candidates = buildCellCandidates(mapId);
  const counters = new Map<string, number>();
  const spawn = simCtx.waypoints[0][0];
  const livesLostByWave = new Map<number, number>();
  let specs = 0, rank2 = 0, fusions = 0, prevLives = state.lives, curWave = 0;
  for (let i = 0; i < MAX_TICKS && !state.over; i++) {
    const events: GameEvent[] = stepGame(state, simCtx, botCommands(state, candidates, counters, spawn, useFusion));
    for (const ev of events) {
      if (ev.e === 'wave_start') { curWave = ev.wave; }
      if (ev.e === 'leak') {
        livesLostByWave.set(curWave, (livesLostByWave.get(curWave) ?? 0) + (prevLives - ev.lives));
        prevLives = ev.lives;
      }
      if (ev.e === 'specialize') specs++;
      if (ev.e === 'fuse') fusions++;
      if (ev.e === 'upgrade' && ev.level === 4) rank2++;
    }
  }
  const seconds = state.tick / TICK_RATE;
  // gasto EXACTO de madera: solo la consumen las specs y el Rango II
  const woodSpent = specs * WOOD_COST_SPEC + rank2 * WOOD_COST_RANK2;
  return {
    victory: state.over?.victory === true,
    wave: state.wave, lives: state.lives, minutes: seconds / 60,
    livesLostByWave, specs, rank2, fusions, towers: state.towers.length,
    goldEarned: state.players.reduce((s, p) => s + p.stats.goldEarned, 0),
    woodSpent,
  };
}

console.log('=== Clásico 36 · 2 bots · «sendero» ===');
for (const diff of ['easy', 'normal', 'hard'] as Difficulty[]) {
  for (const seed of [11, 22, 33]) {
    const r = run('sendero', diff, seed * 1000003);
    const spikes = [...r.livesLostByWave.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([w, l]) => `o${w}:−${l}`).join(' ');
    console.log(
      `${diff.padEnd(6)} seed${seed} → ${r.victory ? 'VICTORIA' : `derrota o${r.wave}`}`.padEnd(38) +
      ` vidas ${String(r.lives).padStart(2)} · ${r.minutes.toFixed(0)}min · torres ${r.towers} · ★${r.specs} ★★${r.rank2} ⚗${r.fusions}` +
      ` · 🪵gastada ${r.woodSpent.toFixed(0)} · picos[${spikes}]`,
    );
  }
}

// ---- issue #7 · winnability del clásico NORMAL en muchas semillas (para elegir
// una semilla robusta para el smoke-test del simtest y confirmar que el juego se
// gana con las 5 recetas nuevas) ----
console.log('\n=== Clásico NORMAL · winnability por semilla (2 bots) ===');
{
  let wins = 0;
  const seeds: number[] = [];
  for (let s = 1; s <= 16; s++) seeds.push(100000007 + s * 7919);
  for (const seed of seeds) {
    const r = run('sendero', 'normal', seed);
    if (r.victory) wins++;
    console.log(
      `seed ${seed} → ${r.victory ? 'VICTORIA' : `derrota/atasco o${r.wave}`}`.padEnd(46) +
        ` vidas ${String(r.lives).padStart(3)} · o${r.wave} · ★${r.specs} ★★${r.rank2} ⚗${r.fusions}`,
    );
  }
  console.log(`→ ${wins}/${seeds.length} semillas GANAN el clásico normal`);
}

// ---- issue #7 · MISMAS semillas CON vs SIN fusiones: las fusiones deben AYUDAR
// (o al menos no romper el juego). El bot fusiona su Plaga Glacial cuando useFusion. ----
console.log('\n=== Clásico NORMAL · CON vs SIN fusiones (mismas semillas) ===');
for (const seed of [100023764, 123456732, 123456741, 123456721]) {
  const withF = run('sendero', 'normal', seed, true);
  const without = run('sendero', 'normal', seed, false);
  console.log(
    `seed ${seed}: CON ${withF.victory ? `VICTORIA(${withF.lives}v,⚗${withF.fusions})` : `o${withF.wave}`}` +
      ` · SIN ${without.victory ? `VICTORIA(${without.lives}v)` : `o${without.wave}`}`,
  );
}

// ---- issue #7 · BANCO DE PRUEBAS de fusiones: cada receta (las 6 viejas + 5
// nuevas) sola frente a un MISMO flujo de enemigos; se mide daño/bajas para
// detectar OUTLIERS (una receta que rompa el juego o que sea inútil). Las de
// APOYO puro (winterheart aura, alchemyvault economía) hacen ~0 daño A PROPÓSITO;
// se miden aparte. ----
function benchFusion(fid: FusionId): { dmg: number; kills: number } {
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 7000, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.wave = 18;
  st.waveState = 'active';
  st.pendingWave = [];
  st.nextId = 30000;
  st.lives = 1e9; // sin game-over: TODAS las recetas ven el flujo COMPLETO (comparable)
  st.maxLives = 1e9;
  const wps = simCtx.waypoints[0];
  const mid = wps[Math.floor(wps.length / 2)];
  const [cx, cy] = nearestBuildCell('sendero', mid.x, mid.y);
  const tower = mkFusedTower(fid, cx, cy);
  st.towers.push(tower);
  // flujo estándar: mezcla tierra/aire/blindado repetida, delays cortos
  const mix: EnemyTypeId[] = ['brute', 'goblin', 'armored', 'bat', 'runner', 'brute'];
  const queue: SpawnEntry[] = [];
  for (let k = 0; k < 40; k++) for (const t of mix) queue.push({ type: t, delay: 6, pathIdx: 0 });
  st.spawnQueue = queue;
  for (let i = 0; i < TICK_RATE * 100; i++) stepGame(st, simCtx, []);
  return { dmg: Math.round(tower.damage), kills: tower.kills };
}

console.log('\n=== Banco de fusiones · daño/bajas contra un MISMO flujo (100 s, wave 18) ===');
{
  const rows = FUSION_ORDER.map((fid) => ({ fid, ...benchFusion(fid) }));
  // ordenar por daño desc (los outliers saltan arriba/abajo)
  rows.sort((a, b) => b.dmg - a.dmg);
  const combat = rows.filter((r) => r.dmg > 0);
  const median = combat.length ? combat[Math.floor(combat.length / 2)].dmg : 0;
  for (const r of rows) {
    const isNew = FUSION_ORDER.indexOf(r.fid) >= 6;
    const rel = median > 0 && r.dmg > 0 ? `${((r.dmg / median) * 100).toFixed(0)}% del mediano` : 'apoyo (0 daño)';
    console.log(
      `${(isNew ? '🆕 ' : '   ') + FUSIONS[r.fid].name}`.padEnd(28) +
        ` daño ${String(r.dmg).padStart(7)} · bajas ${String(r.kills).padStart(3)} · ${rel}`,
    );
  }
  console.log(`(daño mediano de las que disparan: ${median})`);
}

// ---- issue #7 · Bóveda Alquímica: valor ECONÓMICO (su aura de botín). Un mismo
// asesino (railstorm) mata el flujo; con la Bóveda al lado, las bajas cercanas
// pagan +55%. Se compara el oro ganado con y sin la Bóveda. La renta por oleada
// (incomePerWave) es un número fijo, se reporta aparte. ----
function benchVaultGold(withVault: boolean): number {
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 7100, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.wave = 18;
  st.waveState = 'active';
  st.pendingWave = [];
  st.nextId = 31000;
  st.lives = 1e9;
  st.maxLives = 1e9;
  const wps = simCtx.waypoints[0];
  const mid = wps[Math.floor(wps.length / 2)];
  const cands = buildCellCandidates('sendero').slice().sort(
    (a, b) => Math.hypot(a[0] + 0.5 - mid.x, a[1] + 0.5 - mid.y) - Math.hypot(b[0] + 0.5 - mid.x, b[1] + 0.5 - mid.y),
  );
  st.towers.push(mkFusedTower('railstorm', cands[0][0], cands[0][1])); // asesino
  if (withVault) st.towers.push(mkFusedTower('alchemyvault', cands[1][0], cands[1][1]));
  const mix: EnemyTypeId[] = ['brute', 'goblin', 'armored', 'runner'];
  const queue: SpawnEntry[] = [];
  for (let k = 0; k < 40; k++) for (const t of mix) queue.push({ type: t, delay: 8, pathIdx: 0 });
  st.spawnQueue = queue;
  const g0 = st.players[0].gold;
  for (let i = 0; i < TICK_RATE * 100; i++) stepGame(st, simCtx, []);
  return st.players[0].gold - g0;
}

console.log('\n=== Bóveda Alquímica · aura de botín (oro con vs sin) ===');
{
  const withV = benchVaultGold(true);
  const without = benchVaultGold(false);
  const extra = withV - without;
  console.log(
    `oro sin Bóveda ${without} · con Bóveda ${withV} · +${extra} (${without > 0 ? ((extra / without) * 100).toFixed(0) : '∞'}%) por su aura +55%` +
      ` · además renta fija ${FUSIONS.alchemyvault.stats.incomePerWave}/oleada (Mina Tesorería=110, Casa de Moneda=55)`,
  );
}

// ---- ROI del Barril explosivo: ¿se paga solo? ----
console.log('\n=== ROI del Barril (elimina no-jefes, 90 de oro) en oleadas 8/15/25 ===');
for (const wave of [8, 15, 25]) {
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 4242, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.wave = wave; st.waveState = 'active'; st.pendingWave = [];
  // generar una oleada REAL de esa altura y ponerla a andar
  const gen = generateWave({ rng: 777 + wave }, wave, 2, 1);
  st.spawnQueue = gen.entries.filter((e) => !e.elite); // sin élites: caso típico
  st.nextId = 5000;
  st.towers.push({
    id: 9000, type: 'boom', cx: 8, cy: 2, level: 1, spec: -1, owner: 'p1',
    cooldownLeft: 0, targetMode: 'first', invested: 90, kills: 0, damage: 0,
    stunnedUntil: 0, charges: 1, growthBonus: 0, goldGen: 0, fusion: -1, focusId: 0, halted: false,
  });
  let bounty = 0, kills = 0;
  for (let i = 0; i < TICK_RATE * 60 && st.towers.length > 0; i++) {
    for (const ev of stepGame(st, simCtx, [])) {
      if (ev.e === 'death') { bounty += ev.bounty; kills++; }
    }
    if (st.towers.length === 0) break;
  }
  console.log(`oleada ${wave}: el barril mató ${kills} y recuperó 🪙${bounty} de 90 → ROI ${((bounty / 90) * 100).toFixed(0)}%`);
}

// ---- Mercado: ciclo compra→venta y venta→recompra (¿arbitraje?) ----
console.log('\n=== Mercado de madera: ciclos de ida y vuelta (no debe ser rentable) ===');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 999, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  st.enemies.push({
    id: 1, type: 'brute', x: 15.5, y: 2.5, hp: 1e6, maxHp: 1e6, pathIdx: 0, wpIdx: 1, travelled: 0,
    slowFactor: 1, slowUntil: 0, poisonDps: 0, poisonUntil: 0, poisonSrc: 0, bountyMult: 1, elite: false,
    affixes: [], speedMult: 0, armorBonus: 0, regenBonus: 0, dodgeBonus: 0, slowResist: 0, radiusMult: 1,
    auraRadius: 0, auraHps: 0, deathSpawn: 0, laps: 0, spellImmune: false, stunTowerId: 0, lastWpIdx: 1, armorShredUntil: 0,
    dmgBy: {},
  });
  const p = st.players[0];
  p.gold = 10000; p.wood = 100;
  const g0 = p.gold; const w0 = p.wood;
  for (let k = 0; k < 5; k++) {
    stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'buy_wood' } }]);
    stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'sell_wood' } }]);
  }
  console.log(`5 ciclos compra→venta: oro ${g0} → ${p.gold} (Δ ${p.gold - g0}), madera ${w0} → ${p.wood.toFixed(1)} · precio final ${st.woodPrice.toFixed(2)}`);
}
