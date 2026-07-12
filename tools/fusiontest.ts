// Pase de balance F4.3 · Fusión de torres.
//
// Por cada una de las 11 recetas simula N partidas clásicas con bots que RUSHEAN
// esa fusión (plantan el par de ingredientes adyacente, lo especializan con
// prioridad y lo fusionan) y N partidas BASELINE con el MISMO bot y la MISMA
// matriz de semillas pero sin fusionar nunca (se quedan con las dos torres
// especializadas). Compara win-rate y oleada media.
//
// F5.1 · la matriz ataque×armadura ya corre por dentro de la sim (cada fusión
// lleva su `attackType`): este pase sigue siendo RELATIVO (fusión vs baseline con
// el mismo bot), así que absorbe el rebalance sin cambios estructurales.
//
// Criterio de aceptación (del plan): una receta es aceptable si su win-rate no
// se aleja del baseline más de ~±10 puntos.
//
// Uso: tsx tools/fusiontest.ts [N] [dificultad] [recetaId]
// (por defecto N=500, normal, todas las recetas)

import {
  createGame,
  findFusion,
  fusionByIndex,
  getMap,
  hasRank2,
  isInvisibleWave,
  makePlacementContext,
  makeSimContext,
  pathCells,
  placementError,
  rank2Cost,
  stepGame,
  towerLevel,
  towerTargetsAir,
  FUSION_ORDER,
  FUSIONS,
  TICK_RATE,
  TOWERS,
  WOOD_COST_RANK2,
  WOOD_COST_SPEC,
  type Difficulty,
  type FusionDef,
  type GameState,
  type PlayerCommand,
  type TowerTypeId,
} from '@td/shared';

const N = Math.max(1, Number(process.argv[2] ?? 500));
// FUSIONTEST_DEBUG=1: vuelca cada fusión y cada fuga con su oleada (diagnóstico)
const DEBUG = process.env.FUSIONTEST_DEBUG === '1';
const DIFFICULTY = (['easy', 'normal', 'hard'].includes(process.argv[3] ?? '') ? process.argv[3] : 'normal') as Difficulty;
const MAP_ID = 'sendero';
// F5.1 · tope duro: si no acaba, cuenta como derrota. Era 14 min de la época del
// clásico de 20 oleadas: con 36 oleadas (~23 min) NINGUNA partida podía ganar y
// el pase entero era vacuo (0% en todas las filas). 30 min cubre la victoria.
const MAX_TICKS = TICK_RATE * 60 * 30;

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

// v17/F5.1 · celda reservada para el Sentry (como el bot del simtest): sin
// cobertura, las oleadas invisibles (12/18/24/36) se fugaban enteras y ninguna
// variante podía ganar — el pase comparaba derrotas contra derrotas.
function nearestCellToSpawn(
  candidates: [number, number][],
  spawn: { x: number; y: number },
): [number, number] | null {
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (const [cx, cy] of candidates) {
    const d = Math.hypot(cx + 0.5 - spawn.x, cy + 0.5 - spawn.y);
    if (d < bestD) {
      bestD = d;
      best = [cx, cy];
    }
  }
  return best;
}

// El MISMO bot de simtest, parametrizado: `recipe` es el par que rushea (se
// planta adyacente con prioridad y se especializa primero); `doFuse` decide si
// además lo fusiona (variante) o se queda con las dos torres (baseline).
function botCommands(
  state: GameState,
  candidates: [number, number][],
  counters: Map<string, number>,
  recipe: FusionDef,
  doFuse: boolean,
  spawn: { x: number; y: number },
): PlayerCommand[] {
  const cmds: PlayerCommand[] = [];
  if (state.waveState !== 'interlude') return cmds;

  const used = new Set(state.towers.map((t) => `${t.cx},${t.cy}`));
  const sentryCell = nearestCellToSpawn(candidates, spawn);
  if (sentryCell) used.add(`${sentryCell[0]},${sentryCell[1]}`); // reservada para el Sentry
  const wantSentry = isInvisibleWave(state.wave + 1);
  const SENTRY_FRESH = TICK_RATE * 240;
  let sentryDone = false;
  for (const player of state.players) {
    let budget = player.gold;
    // F5.2/F5.1 · presupuesto de MADERA (specs y Rango II la cuestan): sin esto,
    // los specialize se rechazaban en silencio y el bot jugaba sin ninguna
    // especialización — moría en la o10-11 y el pase no medía nada.
    let woodBudget = player.wood;

    // 0) FUSIONAR (solo la variante): par propio especializado adyacente que forme
    // LA RECETA BAJO PRUEBA. F5.1 · OJO: aceptar CUALQUIER receta (como antes)
    // rompía el pase entero — con 11 recetas, las torres tempranas del BUILD_ORDER
    // (arquero+cañón=Fragmentador, hielo+veneno=Plaga…) formaban pares accidentales,
    // `rushing` jamás se activaba y las 11 filas salían IDÉNTICAS (el bot fusionaba
    // pares al azar y se auto-mutilaba, la misma lección del bot del simtest).
    const fusedIds = new Set<number>();
    // F5.1 · fusionar SOLO con base hecha (≥8 torres propias): consumir los dos
    // carries especializados justo en el muro de las oleadas 8-11 era un
    // suicidio del BOT (no de la receta) que castigaba únicamente a los pares
    // que se especializan primero (arquero+cañón). Ningún jugador real fusiona
    // sus dos únicas torres buenas en plena crisis.
    const myCount = state.towers.filter((t) => t.owner === player.id).length;
    // F5.1 · jugador sano #2: NO quedarse ciego al cielo. Si la receta es SOLO
    // tierra y consume torres antiaéreas ESPECIALIZADAS (Fragmentador: el par
    // arquero+cañón son las DOS primeras torres del bot y su Ballesta ★ es su
    // único antiaéreo serio), exige conservar ≥2 torres antiaéreas especializadas
    // tras fusionar — sin esta guarda el bot fusionaba su mejor antiaéreo justo
    // antes de la Quimera (o15/o25) y moría SIEMPRE: el −40 de win-rate era
    // ceguera aérea del bot, no la potencia de la receta (ver banco F5.1).
    const specAirTowers = state.towers.filter((t) => {
      if (t.owner !== player.id) return false;
      const f = fusionByIndex(t.fusion);
      const canAir = f ? f.targetsAir : towerTargetsAir(t.type, t.spec);
      const fires = f ? f.projectileKind !== 'none' : TOWERS[t.type].projectileKind !== 'none';
      return canAir && fires && (f !== null || t.spec >= 0);
    }).length;
    // F5.1 · jugador sano #3: NO comerse los CARRIES. Los dos ingredientes no
    // pueden ser ninguna de las 2 torres más invertidas del jugador (para el
    // Fragmentador, el par orgánico arquero+cañón son sus PRIMERAS torres — con
    // un Arco Largo ★★ en crecimiento, fusionarlo destruye el interés compuesto
    // que carga el lategame del bot). Cuando la base crece y otras torres las
    // superan en inversión, el par temprano deja de ser carry y SÍ se fusiona.
    const topInvested = state.towers
      .filter((t) => t.owner === player.id)
      .sort((x, y) => y.invested - x.invested)
      .slice(0, 2)
      .map((t) => t.id);
    // F5.1 · UNA fusión por jugador y partida: el pase mide "rushear ESA fusión"
    // (singular, como el proyecto del bot del simtest). Sin este gate, el bot
    // convertía EN SERIE cada par orgánico que renacía con el BUILD_ORDER
    // (arquero+cañón se tocan en cada ciclo) y el pase medía "fusiona todo lo
    // fusionable", un plan que ningún jugador ejecuta.
    const alreadyFused = state.towers.some((t) => t.owner === player.id && t.fusion >= 0);
    if (doFuse && !alreadyFused && myCount >= 8) {
      const fusable = state.towers.filter((t) => t.owner === player.id && t.spec >= 0 && t.fusion < 0);
      outer: for (let i = 0; i < fusable.length; i++) {
        for (let j = i + 1; j < fusable.length; j++) {
          const A = fusable[i];
          const B = fusable[j];
          if (Math.max(Math.abs(A.cx - B.cx), Math.abs(A.cy - B.cy)) !== 1) continue;
          if (findFusion(A.type, B.type)?.id !== recipe.id) continue;
          if (topInvested.includes(A.id) || topInvested.includes(B.id)) continue;
          if (!recipe.targetsAir) {
            const consumesSpecAir =
              Number(towerTargetsAir(A.type, A.spec)) + Number(towerTargetsAir(B.type, B.spec));
            if (consumesSpecAir > 0 && specAirTowers - consumesSpecAir < 2) continue;
          }
          cmds.push({ playerId: player.id, cmd: { kind: 'fuse', towerId: A.id, otherId: B.id, keepId: A.id } });
          fusedIds.add(A.id);
          fusedIds.add(B.id);
          break outer;
        }
      }
    }

    // torres que forman el par de LA receta con una vecina propia (prioridad de progreso)
    const pairable = new Set<number>();
    {
      const myTowers = state.towers.filter((t) => t.owner === player.id && t.fusion < 0);
      for (let i = 0; i < myTowers.length; i++) {
        for (let j = i + 1; j < myTowers.length; j++) {
          const A = myTowers[i];
          const B = myTowers[j];
          if (Math.max(Math.abs(A.cx - B.cx), Math.abs(A.cy - B.cy)) !== 1) continue;
          if (findFusion(A.type, B.type)?.id !== recipe.id) continue;
          pairable.add(A.id);
          pairable.add(B.id);
        }
      }
    }

    const mine = state.towers
      .filter((t) => t.owner === player.id && !fusedIds.has(t.id) && t.fusion < 0 && t.type !== 'sentry')
      .map((t) => ({ id: t.id, type: t.type, level: t.level, spec: t.spec }));
    const byPairFirst = <T extends { id: number }>(x: T, y: T) =>
      Number(pairable.has(y.id)) - Number(pairable.has(x.id));

    // SENTRY fresco antes de cada oleada invisible (misma lógica que el simtest)
    if (sentryCell && wantSentry && !sentryDone && mine.length >= 4) {
      const here = state.towers.find((t) => t.type === 'sentry' && t.cx === sentryCell[0] && t.cy === sentryCell[1]);
      const fresh = here !== undefined && here.expiresTick - state.tick > SENTRY_FRESH;
      const sentryCost = TOWERS.sentry.levels[0].cost;
      if (fresh) {
        sentryDone = true;
      } else if (budget >= sentryCost) {
        if (here) cmds.push({ playerId: player.id, cmd: { kind: 'sell', towerId: here.id } });
        cmds.push({ playerId: player.id, cmd: { kind: 'place', towerType: 'sentry', cx: sentryCell[0], cy: sentryCell[1] } });
        sentryDone = true;
        budget -= sentryCost;
      }
    }

    // RUSH: mientras el jugador no tenga el par de la receta en pie (ni fusionado),
    // plantarlo es la compra PRIORITARIA en cuanto el oro dé para ambos (tras 2
    // torres de contención). La defensa general sigue creciendo con normalidad.
    // El baseline hace exactamente lo mismo; su par simplemente nunca se fusiona.
    const hasFused = state.towers.some((t) => t.owner === player.id && t.fusion >= 0);
    const rushing = !hasFused && pairable.size === 0;
    const [typeA, typeB] = recipe.ingredients;
    const bothCost = TOWERS[typeA].levels[0].cost + TOWERS[typeB].levels[0].cost;

    for (let act = 0; act < 3; act++) {
      // 1) especializar (miembros de par primero) — cuesta oro Y madera (F5.2)
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

      // 1b) Rango II — también cuesta madera (F5.2)
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

      // 1c) RUSH del par: con un núcleo de 6 torres de defensa y colchón de oro
      // (alineado con el proyecto de fusión del bot del simtest) — plantar pares
      // débiles (hielo+veneno, hielo+estandarte) a las 4 torres desviaba la
      // defensa justo en el muro de las oleadas 8-11 y hundía TODAS las variantes
      // de esas recetas (baseline incluido): el pase no medía la fusión.
      if (rushing && mine.length >= 6 && budget >= bothCost + 100) {
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
  const spawn = simCtx.waypoints[0][0];
  let fusions = 0;
  let maxWave = 0;
  for (let i = 0; i < MAX_TICKS && !state.over; i++) {
    const events = stepGame(state, simCtx, botCommands(state, candidatesCache, counters, recipe, doFuse, spawn));
    for (const ev of events) {
      if (ev.e === 'fuse') {
        fusions++;
        if (DEBUG) console.log(`   [dbg] fuse «${ev.name}» en o${maxWave} (seed ${seed})`);
      }
      if (ev.e === 'wave_start') maxWave = ev.wave;
      if (DEBUG && ev.e === 'leak') console.log(`   [dbg] fuga en o${maxWave} (vidas ${ev.lives})`);
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
  // F5.1 · margen CONSCIENTE DEL RUIDO: el ±10 duro con N chico dispara falsos
  // positivos (a N=32, el error estándar de la DIFERENCIA de win-rates ronda los
  // ±11 puntos: con 11 recetas, una bandera por puro azar es lo esperable). El
  // margen efectivo es max(10, 1.5·SE): con N grande converge al contrato ±10 de
  // siempre; con N chico solo marca lo que el ruido binomial no puede explicar.
  const pf = fused.winRate / 100;
  const pb = base.winRate / 100;
  const se = Math.sqrt((pf * (1 - pf)) / N + (pb * (1 - pb)) / N) * 100;
  const margin = Math.max(10, 1.5 * se);
  const ok = Math.abs(delta) <= margin;
  if (!ok) anyBad = true;
  console.log(
    `${recipe.name.padEnd(21)}| ${fused.winRate.toFixed(1).padStart(10)}% | ${base.winRate.toFixed(1).padStart(8)}% | ${(delta >= 0 ? '+' : '') + delta.toFixed(1)} | ${fused.avgWave.toFixed(1)}/${base.avgWave.toFixed(1)} | ${fused.avgLives.toFixed(1)}/${base.avgLives.toFixed(1)} | ${fused.avgFusions.toFixed(2).padStart(16)} | ${ok ? '✅ ok' : `❌ FUERA de ±${margin.toFixed(0)}`}`,
  );
}
console.log(`\nTiempo total: ${((performance.now() - t0) / 1000).toFixed(0)}s`);
console.log(anyBad ? '💥 Hay recetas fuera del margen (ruido incluido): AJUSTAR y re-correr' : '🎉 Todas las recetas dentro del margen de win-rate');
process.exitCode = anyBad ? 1 : 0;
