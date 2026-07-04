// Pase de balance F4.3 · Fusión de torres.
//
// Por cada una de las 6 recetas simula N partidas clásicas con bots que RUSHEAN
// esa fusión (plantan el par de ingredientes adyacente, lo especializan con
// prioridad y lo fusionan) y N partidas BASELINE con el MISMO bot y la MISMA
// matriz de semillas pero sin fusionar nunca (se quedan con las dos torres
// especializadas). Compara win-rate y oleada media.
//
// Criterio de aceptación (del plan): una receta es aceptable si su win-rate no
// se aleja del baseline más de ~±10 puntos.
//
// Uso: tsx tools/fusiontest.ts [N] [dificultad] [recetaId]
// (por defecto N=500, normal, todas las recetas)

import {
  createGame,
  findFusion,
  getMap,
  hasRank2,
  makePlacementContext,
  makeSimContext,
  pathCells,
  placementError,
  rank2Cost,
  stepGame,
  towerLevel,
  FUSION_ORDER,
  FUSIONS,
  TICK_RATE,
  TOWERS,
  type Difficulty,
  type FusionDef,
  type GameState,
  type PlayerCommand,
  type TowerTypeId,
} from '@td/shared';

const N = Math.max(1, Number(process.argv[2] ?? 500));
const DIFFICULTY = (['easy', 'normal', 'hard'].includes(process.argv[3] ?? '') ? process.argv[3] : 'normal') as Difficulty;
const MAP_ID = 'sendero';
const MAX_TICKS = TICK_RATE * 60 * 14; // tope duro: si no acaba, cuenta como derrota

// mismas celdas candidatas que usa simtest (construibles y pegadas al camino)
function buildCellCandidates(mapId: string): [number, number][] {
  const map = getMap(mapId);
  const paths = pathCells(map);
  const ctx = makePlacementContext(map);
  const out: [number, number][] = [];
  for (let cy = 0; cy < map.gridH; cy++) {
    for (let cx = 0; cx < map.gridW; cx++) {
      if (placementError(map, ctx, [], cx, cy)) continue;
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

// El MISMO bot de simtest, parametrizado: `recipe` es el par que rushea (se
// planta adyacente con prioridad y se especializa primero); `doFuse` decide si
// además lo fusiona (variante) o se queda con las dos torres (baseline).
function botCommands(
  state: GameState,
  candidates: [number, number][],
  counters: Map<string, number>,
  recipe: FusionDef,
  doFuse: boolean,
): PlayerCommand[] {
  const cmds: PlayerCommand[] = [];
  if (state.waveState !== 'interlude') return cmds;

  const used = new Set(state.towers.map((t) => `${t.cx},${t.cy}`));
  for (const player of state.players) {
    let budget = player.gold;

    // 0) FUSIONAR (solo la variante): par propio especializado adyacente con receta
    const fusedIds = new Set<number>();
    if (doFuse) {
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
    }

    // torres que forman par de receta con una vecina propia (prioridad de progreso)
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

    const mine = state.towers
      .filter((t) => t.owner === player.id && !fusedIds.has(t.id) && t.fusion < 0)
      .map((t) => ({ id: t.id, type: t.type, level: t.level, spec: t.spec }));
    const byPairFirst = <T extends { id: number }>(x: T, y: T) =>
      Number(pairable.has(y.id)) - Number(pairable.has(x.id));

    // RUSH: mientras el jugador no tenga el par de la receta en pie (ni fusionado),
    // plantarlo es la compra PRIORITARIA en cuanto el oro dé para ambos (tras 2
    // torres de contención). La defensa general sigue creciendo con normalidad.
    // El baseline hace exactamente lo mismo; su par simplemente nunca se fusiona.
    const hasFused = state.towers.some((t) => t.owner === player.id && t.fusion >= 0);
    const rushing = !hasFused && pairable.size === 0;
    const [typeA, typeB] = recipe.ingredients;
    const bothCost = TOWERS[typeA].levels[0].cost + TOWERS[typeB].levels[0].cost;

    for (let act = 0; act < 3; act++) {
      // 1) especializar (miembros de par primero)
      const maxed = mine.filter((t) => t.level >= 3 && t.spec < 0).sort(byPairFirst)[0];
      if (maxed) {
        const specIdx = maxed.id % 2;
        const specCost = TOWERS[maxed.type].specs[specIdx].cost;
        if (budget >= specCost) {
          cmds.push({ playerId: player.id, cmd: { kind: 'specialize', towerId: maxed.id, spec: specIdx } });
          maxed.spec = specIdx;
          budget -= specCost;
          continue;
        }
      }

      // 1b) Rango II
      const r2able = mine.find((t) => t.level === 3 && t.spec >= 0 && hasRank2(t.type, t.spec));
      if (r2able) {
        const r2cost = rank2Cost(r2able.type, r2able.spec) ?? Infinity;
        if (budget >= r2cost) {
          cmds.push({ playerId: player.id, cmd: { kind: 'upgrade', towerId: r2able.id } });
          r2able.level = 4;
          budget -= r2cost;
          continue;
        }
      }

      // 1c) RUSH del par: con un núcleo de 4 torres de defensa (si no, los pares
      // de aura/economía mueren antes de despegar), en cuanto el oro dé para
      // AMBOS se plantan juntos en dos celdas adyacentes reservadas de golpe.
      if (rushing && mine.length >= 4 && budget >= bothCost) {
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
          cmds.push({ playerId: player.id, cmd: { kind: 'place', towerType: typeA, cx: ax, cy: ay } });
          cmds.push({ playerId: player.id, cmd: { kind: 'place', towerType: typeB, cx: b[0], cy: b[1] } });
          mine.push({ id: -1 - act, type: typeA, level: 1, spec: -1 });
          mine.push({ id: -100 - act, type: typeB, level: 1, spec: -1 });
          budget -= bothCost;
          placedPair = true;
          break;
        }
        if (placedPair) continue;
      }

      // 2) mejorar la más avanzada (<3), miembros de par primero
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

      // 3) construir
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

      // 4) fallback: mejorar lo que sea
      if (upgradable) {
        const upCost = towerLevel(upgradable.type, upgradable.level + 1).cost;
        if (budget >= upCost) {
          cmds.push({ playerId: player.id, cmd: { kind: 'upgrade', towerId: upgradable.id } });
          upgradable.level += 1;
          budget -= upCost;
          continue;
        }
      }
      break;
    }
  }
  if (state.interludeLeft < TICK_RATE * 8 && state.interludeLeft > TICK_RATE * 2) {
    cmds.push({ playerId: state.players[0].id, cmd: { kind: 'call_wave' } });
  }
  return cmds;
}

interface GameResult {
  win: boolean;
  wave: number;
  lives: number;
  fusions: number;
}

const candidatesCache = buildCellCandidates(MAP_ID);
const mapCache = getMap(MAP_ID);

function runGame(seed: number, recipe: FusionDef, doFuse: boolean): GameResult {
  const simCtx = makeSimContext(mapCache, makePlacementContext(mapCache));
  const state = createGame(MAP_ID, 'classic', DIFFICULTY, seed, [
    { id: 'p1', name: 'Ana', color: '#4fc3f7' },
    { id: 'p2', name: 'Beto', color: '#f06292' },
  ]);
  const counters = new Map<string, number>();
  let fusions = 0;
  let maxWave = 0;
  for (let i = 0; i < MAX_TICKS && !state.over; i++) {
    const events = stepGame(state, simCtx, botCommands(state, candidatesCache, counters, recipe, doFuse));
    for (const ev of events) {
      if (ev.e === 'fuse') fusions++;
      if (ev.e === 'wave_start') maxWave = ev.wave;
    }
  }
  return { win: state.over?.victory === true, wave: maxWave, lives: state.lives, fusions };
}

interface VariantStats {
  winRate: number;
  avgWave: number;
  avgLives: number;
  avgFusions: number;
}

function runVariant(recipe: FusionDef, doFuse: boolean): VariantStats {
  let wins = 0;
  let waves = 0;
  let lives = 0;
  let fusions = 0;
  for (let i = 0; i < N; i++) {
    const seed = 1000 + i * 7919; // misma matriz de semillas para TODAS las variantes
    const r = runGame(seed, recipe, doFuse);
    if (r.win) wins++;
    waves += r.wave;
    lives += r.lives;
    fusions += r.fusions;
  }
  return { winRate: (wins / N) * 100, avgWave: waves / N, avgLives: lives / N, avgFusions: fusions / N };
}

console.log(`Pase de balance F4.3 — ${N} partidas por variante · clásico ${DIFFICULTY} · mapa ${MAP_ID} · 2 bots`);
console.log('receta               | win% fusión | win% base | Δ win | oleada f/b | vidas f/b | fusiones/partida | veredicto');
console.log('---------------------|-------------|-----------|-------|------------|-----------|------------------|----------');

const onlyRecipe = process.argv[4] as (typeof FUSION_ORDER)[number] | undefined;
const t0 = performance.now();
let anyBad = false;
for (const id of onlyRecipe && FUSION_ORDER.includes(onlyRecipe) ? [onlyRecipe] : FUSION_ORDER) {
  const recipe = FUSIONS[id];
  const fused = runVariant(recipe, true);
  const base = runVariant(recipe, false);
  const delta = fused.winRate - base.winRate;
  const ok = Math.abs(delta) <= 10;
  if (!ok) anyBad = true;
  console.log(
    `${recipe.name.padEnd(21)}| ${fused.winRate.toFixed(1).padStart(10)}% | ${base.winRate.toFixed(1).padStart(8)}% | ${(delta >= 0 ? '+' : '') + delta.toFixed(1)} | ${fused.avgWave.toFixed(1)}/${base.avgWave.toFixed(1)} | ${fused.avgLives.toFixed(1)}/${base.avgLives.toFixed(1)} | ${fused.avgFusions.toFixed(2).padStart(16)} | ${ok ? '✅ ok' : '❌ FUERA de ±10'}`,
  );
}
console.log(`\nTiempo total: ${((performance.now() - t0) / 1000).toFixed(0)}s`);
console.log(anyBad ? '💥 Hay recetas fuera del margen ±10: AJUSTAR y re-correr' : '🎉 Todas las recetas dentro de ±10 puntos de win-rate');
process.exitCode = anyBad ? 1 : 0;
