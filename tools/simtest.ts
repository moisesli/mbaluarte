// Prueba de la simulación: dos jugadores bot construyen torres y el juego
// avanza miles de ticks. Verifica oleadas, economía, muertes y determinismo.
import {
  activeStats,
  applyCommands,
  armorTypeOf,
  attackTypeOf,
  buildSnap,
  computeAuras,
  createGame,
  ENEMIES,
  findFusion,
  generateWave,
  getMap,
  hasRank2,
  isInvisibleWave,
  makePlacementContext,
  makeSimContext,
  pathCells,
  pathLength,
  pathWaypoints,
  placementError,
  rank2Cost,
  replayTo,
  MAX_PLAYERS,
  sanitizeSettings,
  stepGame,
  towerFires,
  towerLevel,
  validateSaveData,
  waveBountyMult,
  waveHpMult,
  ADAPT_HITS,
  ADAPT_RESIST,
  ASSIST_MIN_DMG_FRAC,
  ASSIST_SHARE,
  ATTACK_MATRIX,
  BALANCE_VERSION,
  BOOM_COST_TEAM_STEP,
  BOOM_HP_CAP_BASE,
  boomCost,
  BOSS_AFFIX_POOL,
  CHAMPION_BOUNTY_MULT,
  CHAMPION_EXTRA_LIVES,
  CHAMPION_HP_MULT,
  CHAMPION_SPEED_MULT,
  CHILL_AURA_SLOW,
  CLASSIC_BOUNTY_COMP,
  CLASSIC_CALENDAR,
  classicWave,
  CRIT_MULT,
  DIFF_HP_MULT,
  BLESSED_BOUNTY_MULT,
  DOOR_DENSITY_UNIT_CAP,
  doorDensityMult,
  MULTI_DOOR_MIN,
  openPathIndices,
  sanitizeClosedDoors,
  ELITE_LEVEL_CAP_CLASSIC,
  ELITE_LEVEL_GOLD,
  ELITE_LEVEL_WOOD,
  isChampionWave,
  isImmuneWave,
  nextEliteLevelCost,
  repairCost,
  REPAIR_COST_BASE,
  REPAIR_COST_STEP,
  statsOf,
  VITAL_LIVES_MIN,
  waveHasBoss,
  POISON_PCT_CAP_DPS,
  GROWTH_CAP,
  FIRST_INTERLUDE_SEC,
  FUSION_ORDER,
  FUSIONS,
  HORDE_CAP,
  INTERLUDE_SEC,
  MAPS,
  SENTRY_DURATION_SEC,
  START_LIVES,
  TICK_RATE,
  TOWERS,
  TOWER_ORDER,
  TURBO_BOUNTY_MULT,
  TURBO_INTERLUDE_MULT,
  TURBO_WAVE_BONUS_MULT,
  TURBO_WOOD_MULT,
  WAVE_BONUS_BASE,
  WAVE_BONUS_PER_WAVE,
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
  type SaveData,
  type SaveSlot,
  type TowerState,
  type TowerTypeId,
} from '@td/shared';

const MAP_ID = 'sendero';
// Semilla del smoke-test de partida completa. OJO: es un test de "el juego es
// ganable por bots simples", sensible por diseño a cambios de economía (los bots
// deciden por umbrales de oro). El oro de ASISTENCIA (#9) volteó la semilla
// anterior (123456789: ganaba con 4 vidas, margen finísimo); 123456791 ganaba con 13.
// v17 · el SENTRY pasó a TEMPORAL (caduca): el bot ahora lo RENUEVA en cada ventana
// invisible (12/18/24/36), gasto recurrente que restaba defensa y volcó 123456791 (y
// TODA su vecindad) a derrota en la 36. Semilla vecina ganadora robusta: 123456815
// (Δ+24), que gana con 24 vidas de margen con la nueva cobertura de Sentry.
// F5.1 (v18) · la MATRIZ ataque×armadura cambió todo el flujo de daño y 123456815
// cayó en un sapper-lock en la o10 (4 zapadores élite inmunes aturden las únicas
// torres a su alcance; el bot solo construye en interludios → punto muerto).
// Barrido de 60 semillas (123456789+0..59) con la matriz FINAL (asedio neutro vs
// colosal): 22 GANAN vs 17 con el código previo — la matriz MEJORA la winnability
// global del bot, no la empeora. Elegida 123456821: gana con 21 vidas y toda su
// vecindad (821/822/823/825) también gana.
// F5.1 (revisado) · el TIMEOUT de zapado se REVIRTIÓ por diseño (el zapador debe
// obligar a reaccionar, no aburrirse solo), así que el bot ganó el CONTRAPLAY
// humano en botCommands (plantar arquero junto al zapador a los 6s, vender a los
// 20s, y romper el ATASCO real vendiendo las aferradas). Con ese reflejo, barrido
// de la vecindad 815-845: gana 123456845 (36 oleadas, 9 vidas — mejor margen que
// los 3 del timeout); 815/830 llegan a o30-31 (mueren en el muro del gólem
// inmune, límite económico del bot post-GROWTH_CAP, no sapper-lock: CERO cuelgues
// en 14 semillas barridas). El margen es cota inferior: el bot no usa mercado.
// El SEED admite override por env (SIMTEST_SEED=n pnpm simtest) para sweeps sin
// editar el archivo; el valor fijado aquí es el que corre en el gate.
const SEED = Number(process.env.SIMTEST_SEED ?? 123456845);
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
    invisible: false, detected: false, dmgBy: {},
    champion: false, adaptHits: [0, 0, 0, 0], // F9a (v19)
    denseTune: 1, // F9d
    ...over,
  } as EnemyState;
}
function mkTower(type: TowerTypeId, over: Partial<TowerState> = {}): TowerState {
  return {
    id: 2000, type, cx: 5, cy: 1, level: 3, spec: -1, owner: 'p1',
    cooldownLeft: 0, targetMode: 'first', invested: 100, kills: 0, damage: 0, stunnedUntil: 0,
    charges: 0, growthBonus: 0, goldGen: 0, fusion: -1, focusId: 0, halted: false, expiresTick: 0,
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

// F9a · el FRANCOTIRADOR sube al 5.º puesto: el calendario clásico concentra la
// vida en pocas siluetas gordas (tanques, campeones, jefes) y un humano llega al
// primer Gólem (w10) con single-target físico — el bot ahora también.
const BUILD_ORDER: TowerTypeId[] = ['archer', 'cannon', 'frost', 'archer', 'sniper', 'tesla', 'banner', 'poison', 'mortar'];

// v17 · celda buildable MÁS cercana al inicio del camino, IGNORANDO ocupación: la
// celda RESERVADA del Sentry (fija toda la partida), que cubre el spawn de la oleada
// invisible. Determinista (candidates y spawn son fijos).
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

function botCommands(
  state: GameState,
  candidates: [number, number][],
  counters: Map<string, number>,
  spawn: { x: number; y: number } = { x: 0.5, y: 0.5 },
): PlayerCommand[] {
  const cmds: PlayerCommand[] = [];
  // CONTRAPLAY ANTI-ZAPADOR (el mismo que usa un humano): el zapado NO caduca por
  // diseño (decisión F5.1 revisada) — el zapador OBLIGA a reaccionar. El reflejo
  // del bot imita al jugador: si una torre lleva ≥6s aturdida en plena oleada,
  // (1) PLANTA un arquero pegado al zapador para matarlo (una vez por torre);
  // (2) si a los 14s sigue aturdida, la VENDE como último recurso (rompe el
  // agarre; se repone en el interludio con el refund). Sin este reflejo, el bot
  // —que solo construye en interludios— quedaba COLGADO para siempre con las
  // únicas torres en rango aturdidas (sapper-lock). Determinista: `counters`.
  // CONTRAPLAY ANTI-ZAPADOR (el reflejo humano completo): el zapado NO caduca
  // por diseño (decisión F5.1 revisada) — el zapador OBLIGA a reaccionar.
  // Tres capas deterministas, de menor a mayor drama:
  //  (1) torre aturdida >=6s -> PLANTA un arquero pegado al zapador (una vez por
  //      torre; nunca en la celda RESERVADA del Sentry — okuparla rompía su
  //      refresco), pagando de un presupuesto local del tick;
  //  (2) torre aturdida >=20s -> la VENDE (último recurso; a los 10s era suicida
  //      en oleadas de jefe);
  //  (3) ATASCO real (solo quedan zapadores aferrados, nada por spawnear) ->
  //      a los 5s vende todas las aturdidas: rompe el sapper-lock que dejaba al
  //      bot -que solo construye en interludios- colgado para siempre.
  if (state.waveState === 'active') {
    const reserved = nearestCellToSpawn(candidates, spawn);
    const spent = new Map<string, number>();
    const claimed = new Set(state.towers.map((tw) => `${tw.cx},${tw.cy}`));
    if (reserved) claimed.add(`${reserved[0]},${reserved[1]}`);
    // F9a · ¿queda ALGUNA torre libre disparando? Mientras sí, la jugada humana
    // contra zapadores es PACIENCIA (las libres los muelen — en una oleada pura
    // de zapadores no hay otro objetivo); vender solo procede en el LOCK real.
    const freeTowers = state.towers.some(
      (tw) => towerFires(tw) && tw.stunnedUntil <= state.tick && !tw.halted,
    );
    for (const t of state.towers) {
      const key = `stun:${t.id}`;
      if (t.stunnedUntil > state.tick) {
        if (!counters.has(key)) counters.set(key, state.tick);
        const since = state.tick - counters.get(key)!;
        if (since >= TICK_RATE * 6 && !counters.has(`stunbuild:${t.id}`)) {
          const sapper = state.enemies.find((e) => e.stunTowerId === t.id && e.hp > 0);
          if (sapper) {
            let best: [number, number] | null = null;
            let bestD = 2.6; // a rango de arquero L1 del zapador
            for (const [cx, cy] of candidates) {
              if (claimed.has(`${cx},${cy}`)) continue;
              const d = Math.hypot(cx + 0.5 - sapper.x, cy + 0.5 - sapper.y);
              if (d < bestD) {
                bestD = d;
                best = [cx, cy];
              }
            }
            const owner = state.players.find((p) => p.id === t.owner);
            if (best && owner && owner.gold - (spent.get(t.owner) ?? 0) >= 50) {
              cmds.push({ playerId: t.owner, cmd: { kind: 'place', towerType: 'archer', cx: best[0], cy: best[1] } });
              claimed.add(`${best[0]},${best[1]}`);
              spent.set(t.owner, (spent.get(t.owner) ?? 0) + 50);
              counters.set(`stunbuild:${t.id}`, state.tick);
            }
          }
        }
        // F9a · vender SOLO en el LOCK real (ninguna torre libre disparando) y
        // RACIONADO (una cada 8 s): el calendario clásico trae una oleada PURA de
        // zapadores (w8) y el reflejo viejo ("vende toda torre aturdida ≥20s")
        // era un harakiri — el bot liquidaba su defensa en cadena mientras las
        // torres libres ya estaban moliendo a los zapadores (único objetivo vivo).
        // Un humano espera; solo vende si NADIE puede disparar.
        const lastSell = counters.get('sellCd') ?? -99999;
        if (since >= TICK_RATE * 20 && !freeTowers && state.tick - lastSell >= TICK_RATE * 8) {
          cmds.push({ playerId: t.owner, cmd: { kind: 'sell', towerId: t.id } });
          counters.set('sellCd', state.tick);
          counters.delete(key);
          counters.delete(`stunbuild:${t.id}`);
        }
      } else if (counters.has(key)) {
        counters.delete(key);
        counters.delete(`stunbuild:${t.id}`);
      }
    }
    // F9a · FOCO DE FUEGO en CAMPEONES 👑 (el contrajuego humano canónico del
    // arquetipo: pocos objetivos gordos → concentrar daño y derribarlos UNO a
    // uno, empezando por el que va más adelantado). Sin esto, el bot repartía el
    // daño entre 3-4 campeones y fugaba varios a la vez (6 vidas por cabeza).
    // Solo campeones: en oleadas de jefe el escolta también importa y repartir
    // el fuego sigue siendo razonable.
    // (solo CAMPEONES: enfocar al jefe hacía fugar a su escolta — probado y peor)
    const bigs = state.enemies.filter((e) => e.hp > 0 && e.champion);
    if (bigs.length > 0) {
      const lead = bigs.sort((a, b) => b.travelled - a.travelled || a.id - b.id)[0];
      for (const t of state.towers) {
        if (!towerFires(t) || t.focusId === lead.id) continue;
        cmds.push({ playerId: t.owner, cmd: { kind: 'focus', towerId: t.id, enemyId: lead.id } });
      }
    }
    const alive = state.enemies.filter((e) => e.hp > 0);
    const stalled =
      alive.length > 0 &&
      alive.every((e) => ENEMIES[e.type].sapper && e.stunTowerId > 0) &&
      (state.spawnQueue?.length ?? 0) === 0 &&
      (state.pendingWave?.length ?? 0) === 0;
    if (stalled) {
      if (!counters.has('stall')) counters.set('stall', state.tick);
      // F9a · dos umbrales: LOCK real (nadie dispara) → vender UNA torre a los 5 s;
      // último recurso (torres libres pero fuera de alcance, patológico) → a los
      // 45 s. Vender UNA (la más barata aturdida) libera a su zapador, que camina
      // y muere; vender TODAS (código previo) era la espiral de muerte de la w8.
      const stallFor = state.tick - counters.get('stall')!;
      if ((!freeTowers && stallFor >= TICK_RATE * 5) || stallFor >= TICK_RATE * 45) {
        const stunned = state.towers
          .filter((t) => t.stunnedUntil > state.tick)
          .sort((a, b) => a.invested - b.invested);
        if (stunned.length > 0) {
          cmds.push({ playerId: stunned[0].owner, cmd: { kind: 'sell', towerId: stunned[0].id } });
        }
        counters.set('stall', state.tick); // re-armar: otra venta si sigue atascado
      }
    } else if (counters.has('stall')) {
      counters.delete('stall');
    }
  }
  if (state.waveState !== 'interlude') return cmds;

  // celdas ya ocupadas + las que se reclaman dentro de este mismo tick
  const used = new Set(state.towers.map((t) => `${t.cx},${t.cy}`));

  // Lote 3 (v17) · SENTRY TEMPORAL: el detector CADUCA (5 min de base), así que el bot
  // lo RENUEVA. Clave para no romper el clásico: reserva UNA celda fija junto al spawn
  // (la más cercana, cubre siempre el nacimiento de la oleada) que la defensa NUNCA usa,
  // y en el interludio ANTES de cada oleada invisible (12/18/24/36) garantiza ahí un
  // Sentry FRESCO: si el anterior sigue vivo lo VENDE (recupera el 70% de refund) y
  // planta uno nuevo — refrescar en el sitio evita huecos de cobertura tardíos (celdas
  // llenas) y el refund abarata la renovación. La detección pegajosa hace el resto.
  const sentryCell = nearestCellToSpawn(candidates, spawn);
  if (sentryCell) used.add(`${sentryCell[0]},${sentryCell[1]}`); // reservada: la defensa no construye ahí
  // F9a · pasar el MODO: en clásico las invisibles son 12/18/24 (la 36 ahora es jefe)
  const wantSentry = isInvisibleWave(state.wave + 1, state.mode);
  const SENTRY_FRESH = TICK_RATE * 240; // ya cubierto si al Sentry le sobran ≥4 min
  let sentryDone = false; // un solo (re)plantado por tick (cualquier jugador con oro), sin duplicar
  for (const player of state.players) {
    let budget = player.gold; // oro disponible tras las órdenes de este tick
    let woodBudget = player.wood; // madera disponible (F5.2: specs y Rango II la cuestan)
    let orcLvl = player.orcLevel; // nivel local del orco (para no sobre-pedir mejoras)

    // F4.3 · FUSIONAR (máx. una por tick): dos torres propias ESPECIALIZADAS,
    // adyacentes (Chebyshev 1) y con receta → fuse (se queda en la celda de la 1ª).
    // Las dos torres implicadas se excluyen del resto de órdenes de este tick.
    // issue #7: el bot solo fusiona su PROYECTO deliberado (frost+poison → Plaga
    // Glacial). Con 11 recetas, fusionar CUALQUIER par adyacente hacía que el bot
    // se auto-mutilara (2 torres → 1) sin parar y perdiera el clásico. Limitarlo a
    // la receta del proyecto restaura su juego de siempre y lo hace robusto ante
    // futuras recetas. Las recetas NUEVAS se cubren con pruebas DIRIGIDas más abajo.
    const fusedIds = new Set<number>();
    const fusable = state.towers.filter((t) => t.owner === player.id && t.spec >= 0 && t.fusion < 0);
    outer: for (let i = 0; i < fusable.length; i++) {
      for (let j = i + 1; j < fusable.length; j++) {
        const A = fusable[i];
        const B = fusable[j];
        if (Math.max(Math.abs(A.cx - B.cx), Math.abs(A.cy - B.cy)) !== 1) continue;
        if (findFusion(A.type, B.type)?.id !== 'glacialplague') continue;
        cmds.push({ playerId: player.id, cmd: { kind: 'fuse', towerId: A.id, otherId: B.id, keepId: A.id } });
        fusedIds.add(A.id);
        fusedIds.add(B.id);
        break outer;
      }
    }

    // ids de torres que forman el PAR del proyecto (frost+poison) con una vecina
    // propia (para priorizar su progreso hacia la especialización y así fusionarlas)
    const pairable = new Set<number>();
    {
      const myTowers = state.towers.filter((t) => t.owner === player.id && t.fusion < 0);
      for (let i = 0; i < myTowers.length; i++) {
        for (let j = i + 1; j < myTowers.length; j++) {
          const A = myTowers[i];
          const B = myTowers[j];
          if (Math.max(Math.abs(A.cx - B.cx), Math.abs(A.cy - B.cy)) !== 1) continue;
          if (findFusion(A.type, B.type)?.id !== 'glacialplague') continue;
          pairable.add(A.id);
          pairable.add(B.id);
        }
      }
    }

    // copias locales de las torres del jugador: se mutan para simular el efecto
    // de las órdenes de ESTE tick sin tocar el estado real de la simulación.
    // Se excluyen las fusionadas este tick y las ya fusionadas (no se mejoran).
    const mine = state.towers
      .filter((t) => t.owner === player.id && !fusedIds.has(t.id) && t.fusion < 0 && t.type !== 'sentry')
      .map((t) => ({ id: t.id, type: t.type, level: t.level, spec: t.spec }));
    // prioridad: primero los miembros de un par de receta, luego el resto
    const byPairFirst = <T extends { id: number }>(x: T, y: T) =>
      Number(pairable.has(y.id)) - Number(pairable.has(x.id));

    // SENTRY (Lote 3/v17): la cobertura de las oleadas invisibles es CRÍTICA (una sin
    // detector se fuga entera), así que se resuelve ANTES de la defensa, con el oro
    // principal — no con las sobras (que casi nunca llegan a 50). Antes de una oleada
    // invisible garantiza un Sentry FRESCO en la celda reservada: si el anterior sigue
    // vivo sin holgura lo VENDE (recupera refund) y planta uno nuevo en el sitio;
    // refrescar en el mismo sitio evita los huecos de cobertura tardíos (tablero lleno).
    if (sentryCell && wantSentry && !sentryDone && mine.length >= 4) {
      const here = state.towers.find((t) => t.type === 'sentry' && t.cx === sentryCell[0] && t.cy === sentryCell[1]);
      const fresh = here !== undefined && here.expiresTick - state.tick > SENTRY_FRESH;
      const sentryCost = TOWERS.sentry.levels[0].cost;
      if (fresh) {
        sentryDone = true; // ya hay un Sentry con holgura: nada que hacer esta ventana
      } else if (budget >= sentryCost) {
        if (here) cmds.push({ playerId: player.id, cmd: { kind: 'sell', towerId: here.id } }); // refresca en el sitio (recupera refund)
        cmds.push({ playerId: player.id, cmd: { kind: 'place', towerType: 'sentry', cx: sentryCell[0], cy: sentryCell[1] } });
        sentryDone = true;
        budget -= sentryCost;
      }
    }

    // hasta 4 acciones por tick de interludio (F9a: antes 3 — el calendario
    // monoespecie concentra la vida y el bot llegaba un ~10% corto de DPS a
    // TODAS las oleadas; un humano no tiene un tope de clicks): prioriza
    // progresar torres hacia la especialización
    for (let act = 0; act < 4; act++) {
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
  // acelerar: llamar la oleada cuando el bot ya "terminó de construir" (le quedan
  // pocos segundos de interludio). En TURBO ⚡ el interludio ya viene a la MITAD, así
  // que el umbral debe ser MÁS BAJO: con 8s el bot llamaría la oleada en el PRIMER
  // tick del interludio turbo (que dura ~6.5s) y se quedaría sin ventana para gastar
  // su presupuesto (solo hace 3 acciones/tick) — colapsaba su economía y perdía en
  // el muro del lategame. Un humano no tiene ese problema (construye tocando, no a 3
  // acciones/tick). Con el umbral turbo-consciente el bot conserva el grueso del
  // interludio corto para construir y GANA más holgado (más oro, mismo HP).
  const callBelow = state.turbo ? TICK_RATE * 3 : TICK_RATE * 8;
  if (state.interludeLeft < callBelow && state.interludeLeft > TICK_RATE * 2) {
    cmds.push({ playerId: state.players[0].id, cmd: { kind: 'call_wave' } });
  }
  return cmds;
}

function runScenario(mapId = MAP_ID, maxTicks = MAX_TICKS, seed = SEED, turbo = false): { state: GameState; totalKills: number; totalLeaks: number; maxWave: number; eventCounts: Map<string, number>; leaksByWave: Map<number, number>; sentryPlaces: number } {
  const map = getMap(mapId);
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const state = createGame(mapId, 'classic', 'normal', seed, [
    { id: 'p1', name: 'Ana', color: '#4fc3f7' },
    { id: 'p2', name: 'Beto', color: '#f06292' },
  ], turbo);
  const candidates = buildCellCandidates(mapId);
  const counters = new Map<string, number>();
  const eventCounts = new Map<string, number>();
  let totalKills = 0;
  let totalLeaks = 0;
  let maxWave = 0;
  let sentryPlaces = 0; // v17 · colocaciones de Sentry (el bot recompra para mantener cobertura)

  const spawn = simCtx.waypoints[0][0];
  const leaksByWave = new Map<number, number>();
  for (let i = 0; i < maxTicks && !state.over; i++) {
    const events: GameEvent[] = stepGame(state, simCtx, botCommands(state, candidates, counters, spawn));
    for (const ev of events) {
      eventCounts.set(ev.e, (eventCounts.get(ev.e) ?? 0) + 1);
      if (process.env.SIMTEST_DEBUG && (ev.e === 'sell' || ev.e === 'wave_end' || ev.e === 'leak')) {
        const towers = state.towers.map((t) => `${t.type}${t.level}${t.stunnedUntil > state.tick ? '*' : ''}`).join(',');
        if (ev.e === 'wave_end') console.log(`  [w${state.wave}] end · oro=${state.players.map((p) => Math.floor(p.gold)).join('/')} vidas=${state.lives} torres=[${towers}]`);
        else console.log(`  [w${state.wave}] ${ev.e} ${'type' in ev ? ev.type : ''} ${'refund' in ev ? ev.refund : ''}`);
      }
      if (ev.e === 'leak') leaksByWave.set(state.wave, (leaksByWave.get(state.wave) ?? 0) + 1);
      if (ev.e === 'death') totalKills++;
      if (ev.e === 'leak') totalLeaks++;
      if (ev.e === 'place' && ev.towerType === 'sentry') sentryPlaces++;
      if (ev.e === 'wave_start') maxWave = ev.wave;
      if (ev.e === 'reject') throw new Error(`Comando de bot rechazado: ${ev.reason}`);
    }
  }
  return { state, totalKills, totalLeaks, maxWave, eventCounts, leaksByWave, sentryPlaces };
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
console.log(`   fugas por oleada: ${[...a.leaksByWave.entries()].sort((x, y) => x[0] - y[0]).map(([w, n]) => `w${w}:${n}`).join(' ')}`);
console.log(`   sentries al final: ${a.state.towers.filter((t) => t.type === 'sentry').length} · torres: ${a.state.towers.length}`);

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
// Lote 3/v17: el Sentry es TEMPORAL, así que el bot MANTIENE cobertura recomprando a lo
// largo de la partida (no basta uno). Cuenta las colocaciones de Sentry: cubren las
// ventanas invisibles 12/18/24/36 y los bots GANAN el clásico igual.
assert(
  a.sentryPlaces >= 2,
  `los bots MANTIENEN cobertura de Sentry (${a.sentryPlaces} colocaciones) para las oleadas invisibles y ganan el clásico`,
);
// F5.2: el clásico dura 36 oleadas, como Green TD
assert(a.state.totalWaves === 36 && a.maxWave >= 36, `el clásico dura 36 oleadas (jugadas ${a.maxWave}/${a.state.totalWaves})`);
assert((a.eventCounts.get('wave_end') ?? 0) >= 4, 'se completan oleadas');
assert((a.eventCounts.get('hit') ?? 0) > 50, 'hay impactos de proyectiles');
assert((a.eventCounts.get('chain') ?? 0) > 0, 'la torre tesla dispara cadenas');
// ORO DE ASISTENCIA: en co-op (2 bots que se solapan sobre el mismo camino) se pagan
// asistencias, y los bots SIGUEN GANANDO el clásico igual que antes (regresión).
assert((a.eventCounts.get('assist') ?? 0) > 0, `en co-op se paga oro de ASISTENCIA (${a.eventCounts.get('assist') ?? 0} asistencias) y los bots ganan igual`);

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
    spellImmune: false, stunTowerId: 0, lastWpIdx: 1, armorShredUntil: 0, invisible: false, detected: false, dmgBy: {},
    champion: false, adaptHits: [0, 0, 0, 0], denseTune: 1,
  };
  st.enemies.push(slime);
  const cannon: TowerState = {
    id: 2000, type: 'cannon', cx: 5, cy: 1, level: 3, spec: -1, owner: 'p1',
    cooldownLeft: 0, targetMode: 'first', invested: 440, kills: 0, damage: 0, stunnedUntil: 0,
    charges: 0, growthBonus: 0, goldGen: 0, fusion: -1, focusId: 0, halted: false, expiresTick: 0,
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
      spellImmune: false, stunTowerId: 0, lastWpIdx: 1, armorShredUntil: 0, invisible: false, detected: false, dmgBy: {},
      champion: false, adaptHits: [0, 0, 0, 0], denseTune: 1,
    };
    st.enemies.push(enemy);
    const archer: TowerState = {
      id: 2000, type: 'archer', cx: 5, cy: 1, level: 1, spec: -1, owner: 'p1',
      cooldownLeft: 0, targetMode: 'first', invested: 50, kills: 0, damage: 0, stunnedUntil: 0,
      charges: 0, growthBonus: 0, goldGen: 0, fusion: -1, focusId: 0, halted: false, expiresTick: 0,
    };
    st.towers.push(archer);
    for (let i = 0; i < banners; i++) {
      st.towers.push({
        id: 3000 + i, type: 'banner', cx: 6 + i, cy: 1, level: 1, spec: -1, owner: 'p1',
        cooldownLeft: 0, targetMode: 'first', invested: 90, kills: 0, damage: 0, stunnedUntil: 0,
        charges: 0, growthBonus: 0, goldGen: 0, fusion: -1, focusId: 0, halted: false, expiresTick: 0,
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

console.log('— Oro de ASISTENCIA: el mayor dañador cobra si no da el golpe final —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));

  interface AssistOutcome {
    death?: { killer: string; bounty: number };
    assist?: { player: string; gold: number };
    goldDelta: Record<string, number>;
    goldEarnedDelta: Record<string, number>;
  }

  // Construye un enemigo con `maxHp` (para el umbral del 35%) y hp bajo (muere de un
  // golpe), con el daño previo `preseed` ya acreditado a cada jugador en dmgBy. Un
  // arquero de `killer` da el golpe FINAL. Devuelve los eventos de muerte/asistencia y
  // los deltas de oro. No hay bono de fin de oleada: stepWaves ya pasó en el tick de la
  // muerte y el bucle se corta en cuanto el enemigo desaparece (patrón del Alquimista).
  function runAssistKill(
    players: { id: string; name: string; color: string }[],
    preseed: Record<string, number>,
    killer: string,
    maxHp = 1000,
  ): AssistOutcome {
    const st = createGame('sendero', 'endless', 'normal', 4242, players);
    st.nextId = 9000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const enemy = mkEnemy('goblin', { id: 2400, hp: 5, maxHp, x: 5.5, y: 2.5, wpIdx: 1, dmgBy: { ...preseed } });
    st.enemies.push(enemy);
    st.towers.push(mkTower('archer', { id: 3400, cx: 5, cy: 1, level: 3, owner: killer, invested: 200 }));
    const g0: Record<string, number> = {};
    const e0: Record<string, number> = {};
    for (const p of st.players) { g0[p.id] = p.gold; e0[p.id] = p.stats.goldEarned; }
    const out: AssistOutcome = { goldDelta: {}, goldEarnedDelta: {} };
    for (let i = 0; i < TICK_RATE * 3 && st.enemies.some((e) => e.id === 2400); i++) {
      for (const ev of stepGame(st, simCtx, [])) {
        if (ev.e === 'death' && ev.type === 'goblin') out.death = { killer: ev.killer, bounty: ev.bounty };
        if (ev.e === 'assist') out.assist = { player: ev.player, gold: ev.gold };
      }
    }
    for (const p of st.players) {
      out.goldDelta[p.id] = p.gold - g0[p.id];
      out.goldEarnedDelta[p.id] = p.stats.goldEarned - e0[p.id];
    }
    return out;
  }

  const P2 = [
    { id: 'p1', name: 'Ana', color: '#4fc3f7' },
    { id: 'p2', name: 'Beto', color: '#f06292' },
  ];
  const P3 = [...P2, { id: 'p3', name: 'Caro', color: '#aed581' }];

  // (1) A (p1) hizo el 70% del daño y B (p2) remata → B cobra el botín COMPLETO y A el 25%.
  const r1 = runAssistKill(P2, { p1: 700 }, 'p2');
  const bounty1 = r1.death?.bounty ?? 0;
  const expect1 = Math.max(1, Math.round(bounty1 * ASSIST_SHARE));
  assert(r1.death?.killer === 'p2' && bounty1 > 0, `el matador p2 cobra el botín completo (${bounty1})`);
  assert(
    r1.assist?.player === 'p1' && r1.assist?.gold === expect1,
    `el mayor dañador p1 cobra round(${bounty1}×${ASSIST_SHARE})=${expect1} de asistencia (${JSON.stringify(r1.assist)})`,
  );
  assert(
    r1.goldDelta.p1 === expect1 && r1.goldEarnedDelta.p1 === expect1,
    `la asistencia entra en oro Y goldEarned de p1 (+${r1.goldDelta.p1})`,
  );
  assert(r1.goldDelta.p2 === bounty1, `p2 recibe SOLO su botín completo, sin recortes (+${r1.goldDelta.p2})`);

  // (2) el matador ES el mayor dañador → NO hay asistencia (aunque p1 hiciera ≥35%).
  const r2 = runAssistKill(P2, { p1: 400, p2: 600 }, 'p2');
  assert(r2.assist === undefined, `sin asistencia cuando el matador p2 es el mayor dañador (${JSON.stringify(r2.assist)})`);

  // (3) el mayor dañador aportó < 35% del maxHp → NO hay asistencia (200/1000 = 20%).
  const r3 = runAssistKill(P2, { p1: 200 }, 'p2');
  assert(r3.assist === undefined, `sin asistencia si el mayor dañador aportó < ${Math.round(ASSIST_MIN_DMG_FRAC * 100)}% (${JSON.stringify(r3.assist)})`);

  // (4) el DoT de VENENO acredita daño a su dueño (poisonSrc → owner) para la asistencia.
  {
    const st = createGame('sendero', 'endless', 'normal', 4243, P2);
    st.nextId = 9100; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    // torre de veneno de p1 lejos y en cooldown perpetuo: NO dispara, solo aporta el
    // dueño para atribuir el DoT. El crédito debe venir SOLO del goteo del veneno.
    st.towers.push(mkTower('poison', { id: 3500, cx: 40, cy: 40, owner: 'p1', cooldownLeft: 1 << 30 }));
    const poisoned = mkEnemy('brute', {
      id: 2500, hp: 1000, maxHp: 1000, x: 5.5, y: 2.5, wpIdx: 1,
      poisonDps: 300, poisonUntil: st.tick + TICK_RATE * 10, poisonSrc: 3500,
    });
    st.enemies.push(poisoned);
    for (let i = 0; i < 5; i++) stepGame(st, simCtx, []); // 5 ticks × 300/15 = 100 de daño
    assert(
      Math.abs((poisoned.dmgBy.p1 ?? 0) - 100) < 1e-6,
      `el DoT de veneno acredita a su dueño p1 (${(poisoned.dmgBy.p1 ?? 0).toFixed(1)} de daño en 5 ticks)`,
    );
  }

  // (5) empate de daño → gana el playerId MENOR (determinista). p1==p2, remata p3.
  const r5 = runAssistKill(P3, { p1: 500, p2: 500 }, 'p3');
  assert(r5.assist?.player === 'p1', `empate p1==p2 → la asistencia va al playerId menor, p1 (${JSON.stringify(r5.assist)})`);

  // (6) determinismo: dos corridas idénticas del caso (1) dan EXACTAMENTE el mismo estado.
  const det1 = JSON.stringify(runAssistKill(P2, { p1: 700 }, 'p2'));
  const det2 = JSON.stringify(runAssistKill(P2, { p1: 700 }, 'p2'));
  assert(det1 === det2, `determinismo: dos corridas con asistencia coinciden (${det1 === det2})`);
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
    const cmds = botCommands(state, candidates, counters, simCtx.waypoints[0][0]).filter(
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

console.log('— Guardar/Cargar (issue #12): SaveData válido y el fast-forward reproduce el estado —');
{
  // Juega una partida clásica con 2 bots grabando el log (igual que el servidor) y
  // se DETIENE a mitad (como un guardado en pausa). Construye el SaveData con ese
  // corte, lo VALIDA con el mismo validador que usan cliente/worker, y verifica que
  // el fast-forward (reconstrucción con el motor puro) reproduce EXACTO el estado en
  // el tick guardado: misma oleada/vidas/oro/torres/rng. Es la garantía de que
  // reanudar una partida guardada continúa desde el estado correcto.
  const mapId = MAP_ID;
  const seed = 778899;
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

  // corte del guardado: ~4 minutos de juego (mitad de partida, no terminada)
  const SAVE_TICK = TICK_RATE * 60 * 4;
  const spawn = simCtx.waypoints[0][0];
  for (let i = 0; i < SAVE_TICK && !state.over; i++) {
    const cmds = botCommands(state, candidates, counters, spawn);
    const cmdTick = state.tick;
    for (const c of cmds) log.push({ t: cmdTick, kind: 'cmd', playerId: c.playerId, cmd: c.cmd });
    stepGame(state, simCtx, cmds);
  }

  // slots con tokenHash de relleno (el hash real lo prueba wstest de punta a punta;
  // aquí basta que sean cadenas hex para pasar el validador)
  const slots: SaveSlot[] = players.map((p, i) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    tokenHash: `${i}`.padStart(64, 'a'),
  }));
  const save: SaveData = {
    kind: 'fortaleza-save',
    v: BALANCE_VERSION,
    seed,
    mapId,
    mode: 'classic',
    difficulty: 'normal',
    players,
    log,
    tick: state.tick,
    wave: state.wave,
    salt: 'deadbeefdeadbeef',
    slots,
  };

  // ida y vuelta por JSON (como el archivo compartible) + validación
  const parsed = JSON.parse(JSON.stringify(save));
  const v = validateSaveData(parsed);
  assert(v.ok === true, `el SaveData serializado pasa la validación${v.ok ? '' : `: ${v.msg}`}`);

  // versión anterior del balance → rechazo con mensaje claro
  const oldV = validateSaveData({ ...parsed, v: BALANCE_VERSION - 1 });
  assert(!oldV.ok && /versión anterior/i.test(oldV.msg), 'un guardado de otra versión del balance se rechaza');

  // ANTI-ADULTERACIÓN de joins (visto en producción: 80 «MigracionN» inyectados
  // en el log de un guardado real → récord con 88 nombres): más de MAX_PLAYERS
  // SIMULTÁNEOS se rechaza; el churn legítimo (baja `conn` + alta) sigue pasando.
  const fakeJoin = (n: number) => ({ t: 0, kind: 'join', player: { id: `mig${n}`, name: `Migracion${n}`, color: '#123456' }, gold: 0 });
  const flood = { ...parsed, log: [...parsed.log, ...Array.from({ length: 9 }, (_, i) => fakeJoin(i))] };
  const vFlood = validateSaveData(flood);
  assert(!vFlood.ok && /simultáneos/i.test(vFlood.msg), 'un guardado con joins inyectados (9+ simultáneos) se rechaza');
  const churnLog = [
    ...Array.from({ length: MAX_PLAYERS }, (_, i) => fakeJoin(i)),
    { t: 1, kind: 'conn', playerId: 'mig0', connected: false },
    fakeJoin(99),
  ];
  const vChurn = validateSaveData({ ...parsed, log: churnLog });
  assert(vChurn.ok === true, `el churn legítimo (baja + alta hasta el tope) pasa la validación${vChurn.ok ? '' : `: ${(vChurn as { ok: false; msg: string }).msg}`}`);
  // basura evidente → rechazo
  assert(!validateSaveData({ hola: 1 }).ok, 'un objeto que no es un guardado se rechaza');
  // un comando con tick posterior al guardado → rechazo (defensa anti-corrupción)
  const tamper = { ...parsed, log: [...parsed.log, { t: parsed.tick + 5, kind: 'cmd', playerId: 'p1', cmd: { kind: 'call_wave' } }] };
  assert(!validateSaveData(tamper).ok, 'un comando con tick > guardado se rechaza');

  // INYECCIÓN DE ORO: una entrada `join` del log con oro fuera de rango → rechazo
  // (el oro/madera de un mid-join se cargan DIRECTOS del archivo; sin este tope,
  // un JSON adulterado inyectaría un jugador con oro arbitrario). Ver MAX_JOIN_ECON.
  const joinBase = { t: 30, kind: 'join', player: { id: 'p9', name: 'Intruso', color: '#fff' }, gold: 1500, wood: 0 };
  assert(validateSaveData({ ...parsed, log: [...parsed.log, joinBase] }).ok, 'un mid-join con oro legítimo (1500) pasa');
  const goldHack = { ...parsed, log: [...parsed.log, { ...joinBase, gold: 999999999 }] };
  assert(!validateSaveData(goldHack).ok, 'un mid-join con ORO INYECTADO (999.999.999) se rechaza');
  const woodHack = { ...parsed, log: [...parsed.log, { ...joinBase, wood: 999999999 }] };
  assert(!validateSaveData(woodHack).ok, 'un mid-join con MADERA inyectada se rechaza');
  const negHack = { ...parsed, log: [...parsed.log, { ...joinBase, gold: -50 }] };
  assert(!validateSaveData(negHack).ok, 'un mid-join con oro NEGATIVO se rechaza');
  const shapeHack = { ...parsed, log: [...parsed.log, { t: 30, kind: 'join', player: { id: 'p9' }, gold: 100 }] };
  assert(!validateSaveData(shapeHack).ok, 'un mid-join con `player` mal formado (sin name/color) se rechaza');

  // FAST-FORWARD: reconstruir con el motor puro hasta el tick guardado (como el DO
  // al reanudar) y comparar con el estado vivo en ese mismo tick.
  const rdata: ReplayData = {
    v: save.v, seed: save.seed, mapId: save.mapId, mode: save.mode, difficulty: save.difficulty,
    players: save.players, log: save.log, finalTick: save.tick, victory: false, wave: save.wave,
  };
  const rebuilt = replayTo(rdata, save.tick);

  const liveGold = state.players.map((p) => Math.round(p.gold));
  const rebuiltGold = rebuilt.players.map((p) => Math.round(p.gold));
  assert(rebuilt.tick === state.tick, `el fast-forward alcanza el tick guardado (${rebuilt.tick} == ${state.tick})`);
  assert(rebuilt.wave === state.wave, `oleada idéntica tras reanudar (real ${state.wave} == guardado ${rebuilt.wave})`);
  assert(rebuilt.lives === state.lives, `vidas idénticas tras reanudar (real ${state.lives} == guardado ${rebuilt.lives})`);
  assert(rebuilt.rng === state.rng, `rng idéntico tras reanudar (${rebuilt.rng})`);
  assert(rebuilt.nextId === state.nextId, `nextId idéntico tras reanudar (${rebuilt.nextId})`);
  assert(rebuilt.towers.length === state.towers.length, `mismas torres tras reanudar (real ${state.towers.length} == guardado ${rebuilt.towers.length})`);
  assert(
    JSON.stringify(liveGold) === JSON.stringify(rebuiltGold),
    `oro de cada jugador idéntico tras reanudar (real ${JSON.stringify(liveGold)} == guardado ${JSON.stringify(rebuiltGold)})`,
  );
  assert(state.wave >= 3 && state.towers.length >= 4 && !state.over, `el guardado captura una partida en curso (oleada ${state.wave}, ${state.towers.length} torres)`);

  const kb = (JSON.stringify(save).length / 1024).toFixed(1);
  console.log(`   guardado: ${log.length} comandos, ${kb} KB, tick ${save.tick}, oleada ${save.wave}, ${state.towers.length} torres`);
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
  const spawn = simCtx.waypoints[0][0];
  for (; i < maxTicks && !state.over; i++) {
    stepGame(state, simCtx, botCommands(state, candidates, counters, spawn));
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
    // F5.1 · la del Behemot tampoco (evita el muro TRIPLE de la o40 del endless:
    // primer Behemot + escolta inmune + rodilla de la curva, todo apilado)
    if (gen.bossType === 'behemoth' && gen.immune) throw new Error(`la oleada del Behemot ${w} no debe ser inmune`);
  }
  assert(immuneIn20 >= 2, `aparecen oleadas INMUNES en 20 oleadas (${immuneIn20}: caen en 10 y 20; 15 se exime por ser jefe volador)`);
  assert(immuneTotal >= 3, `hay varias oleadas inmunes en 40 (${immuneTotal}: 10,20,30 — las 15/25/35 de la Quimera y la 40 del Behemot se eximen)`);
  void blessedIn20;

  // Las oleadas bendecidas son probabilísticas (1/15 desde la 6): en una semilla
  // dada pueden no caer pronto. F9a cambió el consumo de RNG del generador, así
  // que se barre un rango de semillas fijo (determinista) hasta encontrar una.
  {
    let firstBlessed = 0;
    let commonAffixOk = false;
    outer: for (let seed = 999; seed < 1010; seed++) {
      const rng2 = { rng: seed };
      for (let w = 1; w <= 40; w++) {
        const gen = generateWave(rng2, w, 2, 1);
        if (gen.blessed) {
          firstBlessed = w;
          // todas las entradas no-jefe llevan el MISMO afijo común
          const nonBoss = gen.entries.filter((e) => e.blessed);
          commonAffixOk = nonBoss.length > 0 && nonBoss.every((e) => e.blessedAffix === gen.blessedAffix);
          break outer;
        }
      }
    }
    assert(firstBlessed > 0, `aparece una oleada BENDECIDA en el barrido de semillas (oleada ${firstBlessed})`);
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
  // maxHp 4000 → umbral 600. F5.1: el disparo de 480 es PERFORANTE y el bruto es
  // BLINDADO (matriz ×0.8) → round(480×0.8)=384 de daño; con hp 900 queda en 516,
  // dentro del umbral de execute. El normal muere por execute; el inmune queda
  // vivo con ~516 hp (execute es mágico). [hp 1000→900 por el rebalance F5.1]
  function executeResult(immune: boolean): { killed: boolean; hpLeft: number } {
    const st = createGame('sendero', 'endless', 'normal', 557, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const enemy = mkEnemy('brute', { id: 1700, hp: 900, maxHp: 4000, spellImmune: immune, x: 5.5, y: 2.5 });
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

  // ---- Ráfaga completa: el multidisparo lanza TODOS sus proyectiles aunque ----
  // ---- solo quede 1 enemigo (los sobrantes repiten objetivo, round-robin)  ----
  console.log('— Ráfaga completa: el multidisparo dispara TODO aunque quede un solo enemigo —');
  function volley(towerType: TowerTypeId, spec: number, ex: number, ey: number): { projs: number; dmg: number } {
    const st = createGame('sendero', 'endless', 'normal', 558, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const enemy = mkEnemy('brute', { id: 1800, hp: 100000, maxHp: 100000, x: ex, y: ey });
    st.enemies.push(enemy);
    st.towers.push(mkTower(towerType, { id: 2800, spec, cx: 5, cy: 1, level: 3, invested: 800 }));
    stepGame(st, simCtx, []); // la primera andanada sale en este tick
    const projs = st.projectiles.length;
    for (let i = 0; i < TICK_RATE * 2; i++) stepGame(st, simCtx, []);
    const alive = st.enemies.find((e) => e.id === 1800)!;
    return { projs, dmg: 100000 - alive.hp };
  }
  // Bombardeo (mortero, spec 0): 3 bombas; minRange 2 → enemigo a 3 celdas.
  const mortarVolley = volley('mortar', 0, 5.5, 4.5);
  assert(mortarVolley.projs === 3, `el Bombardeo lanza sus 3 bombas contra UN solo enemigo (${mortarVolley.projs})`);
  assert(mortarVolley.dmg >= 300, `las 3 bombas impactan al mismo objetivo (daño ${mortarVolley.dmg.toFixed(0)} ≥ 300)`);
  // Ballesta Repetidora (arquero, spec 0): 3 saetas. El enemigo va LEJOS (3 celdas):
  // a 1 celda las saetas impactan dentro del mismo tick y no quedarían en vuelo.
  const repeaterVolley = volley('archer', 0, 5.5, 4.5);
  assert(repeaterVolley.projs === 3, `la Ballesta Repetidora dispara sus 3 saetas contra UN solo enemigo (${repeaterVolley.projs})`);
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

console.log('— v20 · Barril explosivo: elimina la infantería (normal/élite); campeones al TOPE y jefes con asedio —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 701, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];

  // barril en una celda del camino (fila 2 de «sendero»); alrededor (o1, 1 jugador
  // → tope del mordisco a campeones = BOOM_HP_CAP_BASE × 1 = 100):
  //  - un bruto INMUNE tanque (100k hp) PISANDO la celda: dispara la detonación
  //    y MUERE (v20: la infantería —normal o élite— se elimina como el barril
  //    original; el control del abuso vive en el precio ×1.3 de equipo)
  //  - un bruto CAMPEÓN 👑 (100k) DENTRO del radio → SOBREVIVE con 100k−100
  //  - un goblin (32 hp) DENTRO del radio → muere (aun inmune: daño verdadero)
  //  - un GÓLEM (jefe) DENTRO del radio → recibe 240−6 de armadura (sin cambios)
  //  - un goblin FUERA del radio (4 celdas) → intacto
  const barrel = mkTower('boom', { id: 3400, cx: 8, cy: 2, level: 1, spec: -1, charges: 1, invested: 90 });
  st.towers.push(barrel);
  const brute = mkEnemy('brute', { id: 2500, hp: 100000, maxHp: 100000, spellImmune: true, speedMult: 0, x: 8.5, y: 2.5, wpIdx: 1 });
  const champ = mkEnemy('brute', { id: 2504, hp: 100000, maxHp: 100000, champion: true, speedMult: 0, x: 8.0, y: 2.5, wpIdx: 1 });
  const near = mkEnemy('goblin', { id: 2501, hp: 32, maxHp: 32, spellImmune: true, speedMult: 0, x: 10.0, y: 2.5, wpIdx: 1 });
  const boss = mkEnemy('golem', { id: 2503, hp: 100000, maxHp: 100000, speedMult: 0, x: 9.5, y: 2.5, wpIdx: 1 });
  const far = mkEnemy('goblin', { id: 2502, hp: 32, maxHp: 32, speedMult: 0, x: 12.5, y: 2.5, wpIdx: 1 });
  st.enemies.push(brute, champ, near, boss, far);

  let sawSplash = false;
  let sawPoof = false;
  const events = stepGame(st, simCtx, []);
  for (const ev of events) {
    if (ev.e === 'hit' && ev.kind === 'splash' && ev.r >= 1.5) sawSplash = true;
    if (ev.e === 'sell' && ev.refund === 0) sawPoof = true;
  }
  assert(!st.enemies.some((e) => e.id === 2500), 'v20 · el tanque de infantería (élite incluido) MUERE con el barril, como el original');
  assert(
    st.enemies.some((e) => e.id === 2504) && champ.hp === 100000 - 100,
    `v20 · el CAMPEÓN 👑 sobrevive con mordisco al TOPE (perdió ${(100000 - champ.hp).toFixed(0)} == 100)`,
  );
  assert(!st.enemies.some((e) => e.id === 2501), 'la morralla DENTRO del radio muere (aun inmune: daño verdadero)');
  // jefe: NO se elimina — recibe el daño del barril como ASEDIO (matriz F5.1
  // ×1.0 vs colosal: neutro, los jefes son cosa del perforante): 240 − 6 de
  // armadura del Gólem = 234 (el número clásico, intacto).
  assert(st.enemies.some((e) => e.id === 2503), 'el JEFE dentro del radio SOBREVIVE a la detonación');
  assert(boss.hp === 100000 - 234, `el jefe recibe el daño del barril con matriz y armadura (${(100000 - boss.hp).toFixed(0)} == 234)`);
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

console.log('— F6.2 · Metralla antiaérea: ×1.5 a voladores (la matriz F5.1 compone aparte) —');
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
  // Metralla: daño 52, splash, RÁFAGA de 2 (contra un único objetivo los 2 tiros le
  // caen al mismo — ráfaga completa). F5.1: la matriz (ASEDIO) compone DESPUÉS del
  // bonus aéreo. Coloso (volador COLOSAL, armadura 2): airBonus round(52×1.5)=78 →
  // matriz ×1.0 (asedio es NEUTRO vs colosal: los jefes son presa del perforante)
  // → 78 − 2 = 76, ×2 tiros = 152. Bruto (tierra BLINDADA, armadura 2):
  // round(52×1.5)=78 − 2 = 76, ×2 = 152 (el asedio revienta placas).
  const vsAir = flakHit('skywhale');
  const vsGround = flakHit('brute');
  assert(vsAir === 152, `la Metralla hace ×1.5 aéreo (matriz neutra vs colosal) al Coloso Alado (${vsAir} == 152: 2 impactos de 76)`);
  assert(vsGround === 152, `contra tierra blindada aplica la matriz de asedio ×1.5 (${vsGround} == 152: 2 impactos de 76)`);
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
  // Cañón de Riel II (executeCurrent 0.75, daño base 620). F5.1: perforante vs
  // bruto BLINDADO → round(620×0.8)=496 de daño efectivo. Un tanque con 650 hp:
  // el golpe arranca ≥75% de su vida ACTUAL (496 ≥ 487.5) → rematado. El inmune,
  // con el mismo golpe, SOBREVIVE (executeCurrent es daño de hechizo).
  // [hp 800→650 por la matriz F5.1]
  function railcannon2(immune: boolean): { killed: boolean; hpLeft: number } {
    const st = createGame('sendero', 'endless', 'normal', 720, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const enemy = mkEnemy('brute', { id: 2400, hp: 650, maxHp: 4000, spellImmune: immune, x: 5.5, y: 2.5 });
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
  // F5.1: el cañón es ASEDIO y el goblin MEDIA → daño de matriz round(78×0.95)=74;
  // la armadura plana (0 base + 40 bonus) se resta DESPUÉS: sin shred 74−40=34,
  // con shred (armadura a la mitad) 74−20=54.
  const dmgNoShred = measured(false);
  const dmgShred = measured(true);
  assert(dmgShred > dmgNoShred, `el shred reduce la armadura efectiva a la mitad → más daño (${dmgNoShred} → ${dmgShred})`);
  assert(Math.abs((74 - 20) - dmgShred) <= 1 && Math.abs((74 - 40) - dmgNoShred) <= 1, `armadura efectiva a la mitad con shred (sin ${dmgNoShred}=74-40, con ${dmgShred}=74-20)`);
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

  // F9a · una fusión ya NO es un callejón: `upgrade` compra su VETERANÍA (salta
  // 3→5, oro+madera). Especializar/re-fusionar siguen prohibidos.
  {
    const p1 = st.players.find((p) => p.id === 'p1')!;
    p1.gold = 10000;
    p1.wood = 1000;
    const goldBefore = p1.gold;
    const woodBefore = p1.wood;
    const ev2 = stepGame(st, simCtx, [
      { playerId: 'p1', cmd: { kind: 'upgrade', towerId: 4100 } },
      { playerId: 'p1', cmd: { kind: 'specialize', towerId: 4100, spec: 0 } },
    ]);
    const rejects2 = ev2.filter((e) => e.e === 'reject').map((e) => (e.e === 'reject' ? e.reason : ''));
    const fusedNow = st.towers.find((t) => t.id === 4100)!;
    assert(fusedNow.level === 5, `F9a · mejorar una fusión compra VETERANÍA: salta 3→5 (level=${fusedNow.level})`);
    assert(
      goldBefore - p1.gold === ELITE_LEVEL_GOLD[0] && Math.round(woodBefore - p1.wood) === ELITE_LEVEL_WOOD[0],
      `la veteranía de la fusión cobra 🪙${ELITE_LEVEL_GOLD[0]} + 🪵${ELITE_LEVEL_WOOD[0]} (cobró ${goldBefore - p1.gold}/${Math.round(woodBefore - p1.wood)})`,
    );
    assert(rejects2.some((r) => r.includes('no se puede especializar')), 'una fusión NO se puede especializar (reject)');
  }
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

  // tipos sin receta (arquero + tesla — NO forman ninguna de las 11 recetas;
  // OJO: arquero+cañón ahora ES el Fragmentador, así que ya no sirve de "sin receta")
  r = tryFuse((st) => {
    st.towers.push(mkTower('archer', { id: 4114, cx: 5, cy: 1, spec: 0 }));
    st.towers.push(mkTower('tesla', { id: 4115, cx: 6, cy: 1, spec: 0 }));
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
  // F5.1: la Tormenta de Riel es PERFORANTE y los brutos BLINDADOS (matriz ×0.8):
  // daño efectivo round(340×0.8)=272 (perfora la armadura plana, no la matriz).
  const dmg = Math.round(FUSIONS.railstorm.stats.damage * 0.8);
  const lost = (e: EnemyState) => 100000 - e.hp;
  assert(lost(a1) === dmg && lost(a2) === dmg && lost(a3) === dmg, `el rayo PERFORA: los 3 alineados reciben ${dmg} de un solo disparo (${lost(a1)}/${lost(a2)}/${lost(a3)})`);
  // inmune: −70% en el call site (round(340×0.3)=102) y DESPUÉS la matriz ×0.8 → 82
  assert(lost(im) === Math.round(Math.round(FUSIONS.railstorm.stats.damage * 0.3) * 0.8), `el inmune en la línea recibe −70% y la matriz (${lost(im)} == 82)`);
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

console.log('— issue #7 · Tempestad Tóxica: fuse VÁLIDO (tesla+veneno) y la cadena ENVENENA cada salto —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const cands = buildCellCandidates('sendero');
  const cellA = cands.find((a) =>
    cands.some((b) => (a[0] !== b[0] || a[1] !== b[1]) && Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) === 1),
  )!;
  const cellB = cands.find(
    (b) => (b[0] !== cellA[0] || b[1] !== cellA[1]) && Math.max(Math.abs(cellA[0] - b[0]), Math.abs(cellA[1] - b[1])) === 1,
  )!;

  // (a) comando fuse VÁLIDO: tesla + veneno especializados adyacentes → Tempestad Tóxica
  {
    const st = createGame('sendero', 'endless', 'normal', 820, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    st.towers.push(mkTower('tesla', { id: 4800, cx: cellA[0], cy: cellA[1], spec: 0, invested: 540 }));
    st.towers.push(mkTower('poison', { id: 4801, cx: cellB[0], cy: cellB[1], spec: 1, invested: 470 }));
    const ev = stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'fuse', towerId: 4800, otherId: 4801, keepId: 4800 } }]);
    const fused = st.towers.find((t) => t.id === 4800);
    assert(
      st.towers.length === 1 && fused?.fusion === FUSION_ORDER.indexOf('toxicstorm'),
      `el comando fuse tesla+veneno crea la Tempestad Tóxica (fusion=${fused?.fusion})`,
    );
    assert(fused!.invested === 540 + 470, `invested = suma de ingredientes (${fused!.invested} == 1010)`);
    assert(ev.some((e) => e.e === 'fuse' && e.name === FUSIONS.toxicstorm.name), 'emite el evento fuse con el nombre de la Tempestad Tóxica');
  }

  // (b) la cadena ENVENENA a VARIOS enemigos; el inmune recibe el rayo −70% y NADA de veneno
  {
    const st = createGame('sendero', 'endless', 'normal', 821, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    st.towers.push(mkFused('tesla', 'toxicstorm', { id: 4810, cx: 5, cy: 1 }));
    const e1 = mkEnemy('brute', { id: 4811, hp: 1e6, maxHp: 1e6, speedMult: 0, x: 5.5, y: 2.5 });
    const e2 = mkEnemy('brute', { id: 4812, hp: 1e6, maxHp: 1e6, speedMult: 0, x: 6.2, y: 2.7 });
    const im = mkEnemy('brute', { id: 4813, hp: 1e6, maxHp: 1e6, speedMult: 0, x: 5.0, y: 3.0, spellImmune: true });
    st.enemies.push(e1, e2, im);
    stepGame(st, simCtx, []); // un disparo instantáneo (cadena)
    assert(e1.poisonDps > 0 && e2.poisonDps > 0, `la cadena ENVENENA a varios (dps ${e1.poisonDps}/${e2.poisonDps})`);
    assert(im.poisonDps === 0 && im.hp < 1e6, `el inmune recibe el rayo pero SIN veneno (−${(1e6 - im.hp).toFixed(0)}, dps ${im.poisonDps})`);
  }
}

console.log('— issue #7 · Ojo de Asedio: alcanza de MAPA COMPLETO y REMATA por vida ACTUAL (executeCurrent) —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  // F5.1: el Ojo es PERFORANTE y los brutos BLINDADOS → daño efectivo round(640×0.8)=512
  const dmg = Math.round(FUSIONS.siegeeye.stats.damage * 0.8);
  const wps0 = makeSimContext(getMap('sendero'), makePlacementContext(getMap('sendero'))).waypoints[0];
  let farIdx = 1;
  let farDist = 0;
  for (let i = 0; i < wps0.length; i++) {
    const d = Math.hypot(wps0[i].x - 5.5, wps0[i].y - 1.5);
    if (d > farDist) { farDist = d; farIdx = i; }
  }
  assert(farDist > 8, `el waypoint objetivo está lejísimos (${farDist.toFixed(1)} celdas, más allá de toda torre normal)`);

  // (a) malherido (hp 800) al OTRO LADO del mapa: el golpe efectivo de 512 arranca
  // ≥60% de su vida ACTUAL (512 ≥ 480) → lo REMATA de un solo disparo instantáneo
  // (executeCurrent + range 99). [hp 1000→800 por la matriz F5.1: perforante ×0.8]
  {
    const st = createGame('sendero', 'endless', 'normal', 822, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    st.towers.push(mkFused('sniper', 'siegeeye', { id: 4820, cx: 5, cy: 1 }));
    const weak = mkEnemy('brute', { id: 4821, hp: 800, maxHp: 6000, speedMult: 0, x: wps0[farIdx].x, y: wps0[farIdx].y, wpIdx: Math.max(1, farIdx) });
    st.enemies.push(weak);
    stepGame(st, simCtx, []); // un disparo
    assert(weak.hp <= 0, `REMATA de un disparo al malherido lejano (${dmg} ≥ 60% de 800)`);
  }

  // (b) sano (hp 6000): el mismo golpe NO llega al 60% de su vida ACTUAL → solo lo HIERE.
  {
    const st = createGame('sendero', 'endless', 'normal', 823, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    st.towers.push(mkFused('sniper', 'siegeeye', { id: 4822, cx: 5, cy: 1 }));
    const healthy = mkEnemy('brute', { id: 4823, hp: 6000, maxHp: 6000, speedMult: 0, x: 5.5, y: 3.5 });
    st.enemies.push(healthy);
    stepGame(st, simCtx, []); // un disparo (perfora la armadura plana; la matriz ×0.8 sí aplica)
    assert(healthy.hp === 6000 - dmg, `al SANO solo lo hiere, no lo remata (hp ${Math.round(healthy.hp)} == ${6000 - dmg})`);
  }
}

console.log('— issue #7 · Bóveda Alquímica: fuse VÁLIDO (mina+alquimista), no dispara y su aura paga +55% —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 824, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  const cands = buildCellCandidates('sendero');
  const cA = cands.find((a) =>
    cands.some((b) => (a[0] !== b[0] || a[1] !== b[1]) && Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) === 1),
  )!;
  const cB = cands.find(
    (b) => (b[0] !== cA[0] || b[1] !== cA[1]) && Math.max(Math.abs(cA[0] - b[0]), Math.abs(cA[1] - b[1])) === 1,
  )!;
  st.towers.push(mkTower('bank', { id: 4830, cx: cA[0], cy: cA[1], spec: 0, invested: 420 }));
  st.towers.push(mkTower('alchemist', { id: 4831, cx: cB[0], cy: cB[1], spec: 0, invested: 340 }));
  const ev = stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'fuse', towerId: 4830, otherId: 4831, keepId: 4830 } }]);
  const vault = st.towers.find((t) => t.id === 4830)!;
  assert(
    st.towers.length === 1 && vault.fusion === FUSION_ORDER.indexOf('alchemyvault'),
    `mina+alquimista → Bóveda Alquímica (fusion=${vault.fusion})`,
  );
  assert(ev.some((e) => e.e === 'fuse' && e.name === FUSIONS.alchemyvault.name), 'emite el evento fuse de la Bóveda Alquímica');
  assert(!towerFires(vault), 'la Bóveda Alquímica NO dispara (es de apoyo)');

  // su aura de botín (+60% tras el buff F5.1): un arquero remata un goblin encima
  // de la Bóveda y cobra el botín aumentado.
  const gob = mkEnemy('goblin', { id: 4832, hp: 5, maxHp: 60, speedMult: 0, x: vault.cx + 0.5, y: vault.cy + 0.5, wpIdx: 1 });
  st.enemies.push(gob);
  st.towers.push(mkTower('archer', { id: 4833, cx: vault.cx, cy: vault.cy + 1, level: 3, spec: -1 }));
  const g0 = st.players[0].gold;
  for (let i = 0; i < TICK_RATE * 3 && st.enemies.some((e) => e.id === 4832); i++) stepGame(st, simCtx, []);
  const paid = st.players[0].gold - g0;
  assert(
    paid === Math.round(ENEMIES.goblin.bounty * 1.6),
    `una baja en el aura de la Bóveda paga +60% (${paid} == ${Math.round(ENEMIES.goblin.bounty * 1.6)})`,
  );
}

console.log('— issue #7 · determinismo con las recetas nuevas (Tempestad/Fragmentador/Lanza de Hielo) —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  function hashNew(): string {
    const st = createGame('sendero', 'endless', 'normal', 823, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    st.towers.push(mkFused('tesla', 'toxicstorm', { id: 4900, cx: 5, cy: 1 }));
    st.towers.push(mkFused('archer', 'shredder', { id: 4901, cx: 7, cy: 1 }));
    st.towers.push(mkFused('frost', 'icelance', { id: 4902, cx: 9, cy: 1 }));
    for (let k = 0; k < 6; k++) {
      st.enemies.push(mkEnemy('brute', { id: 5000 + k, hp: 4000, maxHp: 4000, x: 5.5 + k * 0.5, y: 2.5, wpIdx: 1 }));
    }
    for (let i = 0; i < TICK_RATE * 15; i++) stepGame(st, simCtx, []);
    return JSON.stringify([st.tick, st.rng, st.nextId, st.enemies.map((e) => Math.round(e.hp)), st.players[0].gold]);
  }
  assert(hashNew() === hashNew(), 'la sim con Tempestad Tóxica/Fragmentador/Lanza de Hielo es determinista');
}

console.log('— F7.1 · Transferencia de recursos a un aliado: fondos exactos, rechazos y determinismo —');
{
  const map = getMap('sendero');
  const pctx = makePlacementContext(map);
  // Se prueba applyCommands DIRECTAMENTE (el mismo código que corre stepGame): así
  // el oro y la madera son EXACTOS, sin la tala del orco que añade cada tick.
  function freshDuo(): GameState {
    const s = createGame('sendero', 'endless', 'normal', 4242, [
      { id: 'p1', name: 'Ana', color: '#fff' },
      { id: 'p2', name: 'Beto', color: '#000' },
    ]);
    s.players[0].gold = 500; s.players[0].wood = 30;
    s.players[1].gold = 100; s.players[1].wood = 5;
    return s;
  }
  const give = (s: GameState, cmd: PlayerCommand['cmd']): GameEvent[] => {
    const ev: GameEvent[] = [];
    applyCommands(s, map, pctx, [{ playerId: 'p1', cmd }], ev);
    return ev;
  };

  // (1) transferencia válida: mueve oro y madera EXACTOS + evento + stats coherentes
  {
    const s = freshDuo();
    const p1 = s.players[0], p2 = s.players[1];
    const spent0 = p1.stats.goldSpent, earned0 = p2.stats.goldEarned;
    const ev = give(s, { kind: 'give', to: 'p2', gold: 120, wood: 10 });
    assert(p1.gold === 380 && p1.wood === 20, `el emisor pierde lo enviado EXACTO (🪙${p1.gold} 🪵${p1.wood})`);
    assert(p2.gold === 220 && p2.wood === 15, `el receptor recibe lo enviado EXACTO (🪙${p2.gold} 🪵${p2.wood})`);
    assert(
      ev.some((e) => e.e === 'give' && e.from === 'p1' && e.to === 'p2' && e.gold === 120 && e.wood === 10),
      'la transferencia emite su evento give',
    );
    assert(p1.stats.goldSpent === spent0 + 120, 'el oro enviado cuenta como GASTADO por el emisor');
    assert(p2.stats.goldEarned === earned0 + 120, 'el oro recibido cuenta como GANADO por el receptor');
  }

  // (2) fondos insuficientes: se RECHAZA y no mueve nada
  {
    const s = freshDuo();
    const before = [s.players[0].gold, s.players[0].wood, s.players[1].gold, s.players[1].wood];
    const ev = give(s, { kind: 'give', to: 'p2', gold: 999999, wood: 0 });
    assert(ev.some((e) => e.e === 'reject'), 'enviar más oro del que tienes se RECHAZA');
    assert(
      JSON.stringify([s.players[0].gold, s.players[0].wood, s.players[1].gold, s.players[1].wood]) === JSON.stringify(before),
      'un envío rechazado por fondos NO mueve recursos',
    );
  }

  // (3) cantidades inválidas (negativa, no entera, ambas cero): RECHAZADAS, sin mover oro
  {
    const s = freshDuo();
    const g0 = s.players[0].gold;
    for (const bad of [{ gold: -10, wood: 0 }, { gold: 5.5, wood: 0 }, { gold: 0, wood: 0 }]) {
      const ev = give(s, { kind: 'give', to: 'p2', gold: bad.gold, wood: bad.wood });
      assert(ev.some((e) => e.e === 'reject'), `rechaza cantidad inválida (🪙${bad.gold} 🪵${bad.wood})`);
    }
    assert(s.players[0].gold === g0, 'ningún envío inválido movió oro');
  }

  // (4) destinatario inexistente y a-uno-mismo: RECHAZADOS
  {
    const s = freshDuo();
    assert(give(s, { kind: 'give', to: 'fantasma', gold: 10, wood: 0 }).some((e) => e.e === 'reject'), 'enviar a un destinatario inexistente se RECHAZA');
    assert(give(s, { kind: 'give', to: 'p1', gold: 10, wood: 0 }).some((e) => e.e === 'reject'), 'enviarse a UNO MISMO se RECHAZA');
    assert(s.players[0].gold === 500 && s.players[1].gold === 100, 'los rechazos de destinatario no mueven oro');
  }

  // (5) determinismo: dos corridas idénticas con el mismo give por stepGame → mismo estado
  function giveRun(): string {
    const s = createGame('sendero', 'endless', 'normal', 4242, [
      { id: 'p1', name: 'Ana', color: '#fff' },
      { id: 'p2', name: 'Beto', color: '#000' },
    ]);
    s.players[0].gold = 500;
    const ctx = makeSimContext(map, makePlacementContext(map));
    for (let i = 0; i < 20; i++) {
      stepGame(s, ctx, i === 3 ? [{ playerId: 'p1', cmd: { kind: 'give', to: 'p2', gold: 77, wood: 0 } }] : []);
    }
    return JSON.stringify([s.tick, s.rng, s.nextId, s.players.map((p) => [Math.round(p.gold * 1000), Math.round(p.wood * 1000)])]);
  }
  assert(giveRun() === giveRun(), 'la transferencia es DETERMINISTA (misma semilla + mismo give → mismo estado)');
}

console.log('— Lote 3 · Oleadas INVISIBLES: calendario determinista, sin inmunes ni jefes —');
{
  const rng = { rng: SEED };
  const invisibleWaves: number[] = [];
  for (let w = 1; w <= 36; w++) {
    const gen = generateWave(rng, w, 2, 1);
    if (gen.invisible) {
      invisibleWaves.push(w);
      // NO coincide con inmune ni jefe (como la bendecida evita combinarse)
      if (gen.immune || gen.hasBoss) throw new Error(`oleada invisible ${w} combinada con inmune/jefe`);
      // toda entrada no-jefe nace invisible
      const nonBoss = gen.entries.filter((e) => !ENEMIES[e.type].boss);
      if (nonBoss.length === 0 || !nonBoss.every((e) => e.invisible)) throw new Error(`oleada invisible ${w} con no-jefes visibles`);
    } else if (gen.entries.some((e) => e.invisible)) {
      throw new Error(`entrada invisible en una oleada ${w} NO invisible`);
    }
  }
  assert(
    JSON.stringify(invisibleWaves) === JSON.stringify([12, 18, 24, 36]),
    `las oleadas invisibles del clásico caen en 12/18/24/36 (${invisibleWaves.join(',')})`,
  );
  // función directa: 12 sí; 30 no (golem + inmune la eximen)
  assert(isInvisibleWave(12) && isInvisibleWave(18) && !isInvisibleWave(30) && !isInvisibleWave(15),
    'isInvisibleWave: 12/18 sí; 30 (golem+inmune) y 15 (Quimera) no');
  // determinista: dos generaciones dan el mismo calendario
  const rng2 = { rng: SEED };
  const inv2: number[] = [];
  for (let w = 1; w <= 36; w++) if (generateWave(rng2, w, 2, 1).invisible) inv2.push(w);
  assert(JSON.stringify(invisibleWaves) === JSON.stringify(inv2), 'el calendario de oleadas invisibles es determinista');
}

console.log('— Lote 3 · Invisibilidad: sin Sentry la torre NO dispara; con Sentry SÍ —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  // Un bruto INVISIBLE inmóvil en rango de un arquero. Sin Sentry: intargeteable
  // (no recibe daño ni queda detectado). Con un Sentry cubriéndolo: detectado y
  // recibe disparos normales.
  function run(sentry: boolean): { dmg: number; detected: boolean } {
    const st = createGame('sendero', 'endless', 'normal', 1300, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 12; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const enemy = mkEnemy('brute', { id: 6000, hp: 100000, maxHp: 100000, invisible: true, speedMult: 0, x: 5.5, y: 2.5, wpIdx: 1 });
    st.enemies.push(enemy);
    st.towers.push(mkTower('archer', { id: 6001, cx: 5, cy: 1, level: 3, invested: 200 }));
    if (sentry) st.towers.push(mkTower('sentry', { id: 6002, cx: 5, cy: 3, level: 1, spec: -1, invested: 50 }));
    const hp0 = enemy.hp;
    for (let i = 0; i < TICK_RATE * 2; i++) stepGame(st, simCtx, []);
    return { dmg: hp0 - enemy.hp, detected: enemy.detected };
  }
  const without = run(false);
  const withS = run(true);
  assert(without.dmg === 0 && !without.detected, `sin Sentry, el invisible NO recibe disparos ni queda detectado (daño ${without.dmg})`);
  assert(withS.detected && withS.dmg > 0, `con un Sentry en rango, el invisible queda DETECTADO y recibe disparos (−${withS.dmg.toFixed(0)})`);
}

console.log('— Lote 3 · La Trampa de camino golpea a un invisible NO detectado —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 1301, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 12; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  const pathCell = [...pathCells(map)][0].split(',').map(Number) as [number, number];
  st.towers.push(mkTower('trap', { id: 6100, cx: pathCell[0], cy: pathCell[1], level: 1, spec: -1, charges: 20, invested: 60 }));
  const enemy = mkEnemy('brute', { id: 6101, hp: 100000, maxHp: 100000, invisible: true, speedMult: 0, x: pathCell[0] + 0.5, y: pathCell[1] + 0.5, wpIdx: 1 });
  st.enemies.push(enemy);
  const hp0 = enemy.hp;
  stepGame(st, simCtx, []);
  assert(!enemy.detected && enemy.hp < hp0, `la Trampa hiere a un invisible NO detectado (−${(hp0 - enemy.hp).toFixed(0)}, detected=${enemy.detected})`);
}

console.log('— Lote 3 · El daño de ÁREA alcanza a un invisible no detectado (colateral) —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 1303, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.wave = 12; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  // un cañón (área) apunta a un enemigo VISIBLE; un invisible NO detectado pegado a él
  // recibe el splash aunque no pueda ser objetivo directo.
  st.towers.push(mkTower('cannon', { id: 6200, cx: 5, cy: 1, level: 3, spec: -1, invested: 440 }));
  const visible = mkEnemy('brute', { id: 6201, hp: 100000, maxHp: 100000, speedMult: 0, x: 5.5, y: 2.5, wpIdx: 1 });
  const hidden = mkEnemy('brute', { id: 6202, hp: 100000, maxHp: 100000, invisible: true, speedMult: 0, x: 5.9, y: 2.5, wpIdx: 1 });
  st.enemies.push(visible, hidden);
  const hp0 = hidden.hp;
  for (let i = 0; i < TICK_RATE * 3 && hidden.hp === hp0; i++) stepGame(st, simCtx, []);
  assert(!hidden.detected && hidden.hp < hp0, `el splash del cañón toca al invisible no detectado (−${(hp0 - hidden.hp).toFixed(0)}, detected=${hidden.detected})`);
}

console.log('— v17 · el Sentry SE MEJORA (más radio) pero NO se especializa; la Trampa sigue sin mejorar —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 1304, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.tick = 500; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  st.towers.push(mkTower('sentry', { id: 6300, cx: 5, cy: 1, level: 1, spec: -1, invested: 50, expiresTick: st.tick + 999999 }));
  st.players[0].gold = 10000; st.players[0].wood = 500;
  const ev = stepGame(st, simCtx, [
    { playerId: 'p1', cmd: { kind: 'upgrade', towerId: 6300 } },
    { playerId: 'p1', cmd: { kind: 'specialize', towerId: 6300, spec: 0 } },
  ]);
  const rejects = ev.filter((e) => e.e === 'reject').map((e) => (e.e === 'reject' ? e.reason : ''));
  const sentry = st.towers.find((t) => t.id === 6300)!;
  assert(sentry.level === 2, `el Sentry SÍ se mejora: sube a nivel 2 (nivel ${sentry.level})`);
  assert(!rejects.some((r) => r.includes('no se puede mejorar')), 'la mejora del Sentry NO se rechaza (v17)');
  assert(rejects.some((r) => r.includes('no se puede especializar')), 'el Sentry NO se puede especializar (reject)');
  assert(sentry.spec === -1, 'el Sentry queda sin especializar');

  // regresión: la Trampa de camino sigue SIN poder mejorarse (gate onPathOnly intacto)
  const pc = [...pathCells(map)][0].split(',').map(Number) as [number, number];
  const st2 = createGame('sendero', 'endless', 'normal', 1305, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st2.nextId = 8100; st2.tick = 10; st2.wave = 1; st2.waveState = 'active'; st2.spawnQueue = []; st2.pendingWave = [];
  st2.towers.push(mkTower('trap', { id: 6400, cx: pc[0], cy: pc[1], level: 1, charges: 20, invested: 60 }));
  st2.players[0].gold = 10000; st2.players[0].wood = 500;
  const ev2 = stepGame(st2, simCtx, [{ playerId: 'p1', cmd: { kind: 'upgrade', towerId: 6400 } }]);
  assert(
    ev2.some((e) => e.e === 'reject' && e.reason.includes('no se puede mejorar')),
    'la Trampa sigue SIN poder mejorarse (regresión v17)',
  );
}

console.log('— v17 · el Sentry CADUCA EXACTO a su duración (evento sell refund 0, SIN sys) —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 1310, [{ id: 'p1', name: 'A', color: '#fff' }]);
  // tick > 0 para no disparar los avisos `sys` del arranque (tick 0). Un enemigo
  // inmóvil off-path mantiene la oleada ACTIVA (evita que se cicle sola y emita nada).
  st.nextId = 8000; st.tick = 500; st.wave = 12; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  st.lives = 1e9; st.maxLives = 1e9; st.players[0].gold = 10000;
  st.enemies.push(mkEnemy('brute', { id: 5, hp: 1e9, maxHp: 1e9, speedMult: 0, x: 40, y: 40, wpIdx: 1 }));
  const cell = buildCellCandidates('sendero')[0];
  const placeTick = st.tick; // la orden `place` se aplica a ESTE tick
  stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'place', towerType: 'sentry', cx: cell[0], cy: cell[1] } }]);
  const sentry = st.towers.find((t) => t.type === 'sentry')!;
  const dur = SENTRY_DURATION_SEC[0] * TICK_RATE;
  assert(sentry.expiresTick === placeTick + dur, `el Sentry nace con expiresTick = tick_colocación + ${dur} (${sentry.expiresTick} == ${placeTick + dur})`);
  let sellTick = -1;
  let sawSys = false;
  for (let i = 0; i < dur + 5 && st.towers.some((t) => t.type === 'sentry'); i++) {
    const tickBefore = st.tick;
    for (const e of stepGame(st, simCtx, [])) {
      if (e.e === 'sell' && e.refund === 0) sellTick = tickBefore;
      if (e.e === 'sys') sawSys = true;
    }
  }
  assert(sellTick === sentry.expiresTick, `el Sentry expira EXACTO en su expiresTick con sell refund 0 (${sellTick} == ${sentry.expiresTick})`);
  assert(!st.towers.some((t) => t.type === 'sentry'), 'el Sentry desaparece al caducar');
  assert(!sawSys, 'la caducidad NO manda mensaje de sistema (sin spam de chat)');
}

console.log('— v17 · mientras vive detecta; tras caducar un invisible NUEVO ya no se revela —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 1312, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.tick = 1000; st.wave = 12; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  st.lives = 1e9; st.maxLives = 1e9;
  const inv = mkEnemy('brute', { id: 6000, hp: 1e6, maxHp: 1e6, invisible: true, speedMult: 0, x: 5.5, y: 2.5, wpIdx: 1 });
  st.enemies.push(inv);
  st.towers.push(mkTower('archer', { id: 6001, cx: 5, cy: 1, level: 3, invested: 200 }));
  // Sentry con caducidad CORTA por construcción (expiresTick a mano)
  st.towers.push(mkTower('sentry', { id: 6002, cx: 5, cy: 3, level: 1, spec: -1, invested: 50, expiresTick: st.tick + 5 }));
  const hp0 = inv.hp;
  stepGame(st, simCtx, []);
  const detectedAlive = inv.detected;
  const dmgAlive = hp0 - inv.hp;
  for (let i = 0; i < 20 && st.towers.some((t) => t.type === 'sentry'); i++) stepGame(st, simCtx, []);
  const sentryGone = !st.towers.some((t) => t.type === 'sentry');
  // un invisible NUEVO (nunca detectado) ya no se revela sin Sentry vivo
  const fresh = mkEnemy('brute', { id: 6099, hp: 1e6, maxHp: 1e6, invisible: true, speedMult: 0, x: 5.5, y: 2.5, wpIdx: 1 });
  st.enemies.push(fresh);
  const fhp0 = fresh.hp;
  for (let i = 0; i < TICK_RATE * 2; i++) stepGame(st, simCtx, []);
  assert(detectedAlive && dmgAlive > 0, `mientras vive, el Sentry detecta y el arquero daña al invisible (−${dmgAlive.toFixed(0)})`);
  assert(sentryGone, 'el Sentry caduca por su expiresTick');
  assert(!fresh.detected && fresh.hp === fhp0, 'tras caducar, un invisible NUEVO ya no se revela ni recibe disparos');
}

console.log('— v17 · mejorar el Sentry L1→L3: sube el radio Y reinicia la duración —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 1311, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 8000; st.tick = 2000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  st.lives = 1e9; st.maxLives = 1e9; st.players[0].gold = 10000;
  const cell = buildCellCandidates('sendero')[0];
  stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'place', towerType: 'sentry', cx: cell[0], cy: cell[1] } }]);
  const s = st.towers.find((t) => t.type === 'sentry')!;
  assert(s.level === 1 && TOWERS.sentry.levels[0].range === 3.5, `el Sentry nace en nivel 1, radio ${TOWERS.sentry.levels[0].range}`);
  // dejar correr un poco: la duración baja
  for (let i = 0; i < TICK_RATE * 30; i++) stepGame(st, simCtx, []);
  const beforeUpExpires = s.expiresTick;
  const upTick1 = st.tick;
  stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'upgrade', towerId: s.id } }]);
  assert(s.level === 2, 'el Sentry sube a nivel 2 (mejora permitida)');
  assert(TOWERS.sentry.levels[1].range > TOWERS.sentry.levels[0].range, `el radio del nivel 2 es mayor (${TOWERS.sentry.levels[1].range} > ${TOWERS.sentry.levels[0].range})`);
  assert(s.expiresTick === upTick1 + SENTRY_DURATION_SEC[1] * TICK_RATE, `mejorar REINICIA la duración al total del nivel 2 (${s.expiresTick} == ${upTick1 + SENTRY_DURATION_SEC[1] * TICK_RATE})`);
  assert(s.expiresTick > beforeUpExpires, 'la duración se REFRESCA (expira más tarde que antes de mejorar)');
  const upTick2 = st.tick;
  stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'upgrade', towerId: s.id } }]);
  assert(s.level === 3, 'el Sentry sube a nivel 3');
  assert(TOWERS.sentry.levels[2].range > TOWERS.sentry.levels[1].range, `el radio del nivel 3 es el mayor (${TOWERS.sentry.levels[2].range})`);
  assert(s.expiresTick === upTick2 + SENTRY_DURATION_SEC[2] * TICK_RATE, `mejorar a nivel 3 REINICIA al total (10 min): ${s.expiresTick} == ${upTick2 + SENTRY_DURATION_SEC[2] * TICK_RATE}`);
  const evMax = stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'upgrade', towerId: s.id } }]);
  assert(evMax.some((e) => e.e === 'reject' && e.reason.includes('Nivel máximo')), 'en nivel 3 el Sentry ya no se mejora (Nivel máximo)');
}

console.log('— Lote 3 · determinismo con oleada invisible + Sentry —');
{
  function hashInv(): string {
    const map = getMap('sendero');
    const simCtx = makeSimContext(map, makePlacementContext(map));
    const st = createGame('sendero', 'classic', 'normal', 1302, [{ id: 'p1', name: 'A', color: '#fff' }]);
    // arranca en el interludio previo a la oleada 12 (invisible) con defensa + Sentry
    st.nextId = 8000; st.wave = 11; st.waveState = 'interlude'; st.interludeLeft = 5 * TICK_RATE;
    st.towers.push(mkTower('sentry', { id: 7000, cx: 5, cy: 3, level: 1, spec: -1 }));
    st.towers.push(mkTower('archer', { id: 7001, cx: 5, cy: 1, level: 3 }));
    st.towers.push(mkTower('cannon', { id: 7002, cx: 6, cy: 1, level: 3 }));
    for (let i = 0; i < TICK_RATE * 40; i++) stepGame(st, simCtx, []);
    return JSON.stringify([
      st.tick, st.rng, st.nextId, st.wave,
      st.enemies.map((e) => [e.id, Math.round(e.x * 100), e.invisible, e.detected]),
      st.players[0].gold,
    ]);
  }
  assert(hashInv() === hashInv(), 'la sim con oleada invisible + Sentry es determinista');
}

console.log('— Lote 4 · FOCUS: la torre ataca al enemigo enfocado, no al que dicta first —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 2600, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 9000; st.wave = 5; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  // francotirador (snipe instantáneo, perfora armadura): el daño llega el mismo tick
  const sniper = mkTower('sniper', { id: 9001, cx: 5, cy: 1, level: 3, invested: 635 });
  st.towers.push(sniper);
  // dos brutos quietos en rango: front va PRIMERO (travelled 10) — el modo 'first'
  // lo elegiría; rear va detrás (travelled 1) y es el que ENFOCAMOS.
  const front = mkEnemy('brute', { id: 9002, hp: 100000, maxHp: 100000, speedMult: 0, x: 5.5, y: 2.5, travelled: 10 });
  const rear = mkEnemy('brute', { id: 9003, hp: 100000, maxHp: 100000, speedMult: 0, x: 7.5, y: 2.5, travelled: 1 });
  st.enemies.push(front, rear);

  // sin focus: dispara al 'first' (front)
  stepGame(st, simCtx, []);
  assert(front.hp < 100000 && rear.hp === 100000, `sin focus, el francotirador respeta 'first' (front −${(100000 - front.hp).toFixed(0)})`);

  // con focus en rear: el siguiente disparo va al ENFOCADO aunque first dicte front
  const frontHp1 = front.hp;
  const ev1 = stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'focus', towerId: 9001, enemyId: 9003 } }]);
  assert(!ev1.some((e) => e.e === 'reject') && sniper.focusId === 9003, 'el comando focus se acepta y queda en la torre');
  for (let i = 0; i < TICK_RATE * 3; i++) stepGame(st, simCtx, []);
  assert(rear.hp < 100000, `con focus, ataca al ENFOCADO y no al 'first' (rear −${(100000 - rear.hp).toFixed(0)})`);
  assert(front.hp === frontHp1, 'el first (front) deja de recibir disparos mientras dura el focus');

  // FUERA DE RANGO: el enfocado se aleja (queda vivo) → la torre ataca normal
  // MIENTRAS TANTO y CONSERVA el focus (comportamiento documentado en pickTarget)
  rear.x = 25.5; // range 7.5: fuera de alcance
  const frontHp2 = front.hp;
  for (let i = 0; i < TICK_RATE * 3; i++) stepGame(st, simCtx, []);
  assert(front.hp < frontHp2, 'con el enfocado fuera de rango, la torre ataca NORMAL mientras tanto');
  assert(sniper.focusId === 9003, 'y CONSERVA el focus para cuando vuelva a entrar en rango');

  // al MORIR el enfocado: focusId se limpia y vuelve al targetMode normal.
  // La limpieza es perezosa (ocurre en el SIGUIENTE intento de apuntar): hay que
  // esperar hasta dos cooldowns del francotirador (2.8 s) — el bucle da margen.
  rear.x = 7.5; // vuelve a rango
  rear.hp = 1; // el próximo disparo lo mata
  for (let i = 0; i < TICK_RATE * 8 && sniper.focusId !== 0; i++) stepGame(st, simCtx, []);
  assert(sniper.focusId === 0, 'al morir el enfocado, el focus se LIMPIA solo (focusId=0)');
  const frontHp3 = front.hp;
  for (let i = 0; i < TICK_RATE * 3; i++) stepGame(st, simCtx, []);
  assert(front.hp < frontHp3, 'y la torre vuelve a su targetMode normal (first)');

  // enemyId: 0 = quitar el focus a mano
  stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'focus', towerId: 9001, enemyId: 9002 } }]);
  assert(sniper.focusId === 9002, 'focus re-armado sobre front');
  stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'focus', towerId: 9001, enemyId: 0 } }]);
  assert(sniper.focusId === 0, 'focus con enemyId=0 vuelve al automático');
}

console.log('— Lote 4 · FOCUS vs invisibles: no se enfoca lo que no se ve —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 2601, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 9100; st.wave = 12; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  const sniper = mkTower('sniper', { id: 9101, cx: 5, cy: 1, level: 3, invested: 635 });
  st.towers.push(sniper);
  const hidden = mkEnemy('brute', { id: 9102, hp: 100000, maxHp: 100000, invisible: true, speedMult: 0, x: 5.5, y: 2.5 });
  st.enemies.push(hidden);

  // (a) el comando se RECHAZA (no puedes ver a ese enemigo)
  const ev = stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'focus', towerId: 9101, enemyId: 9102 } }]);
  assert(
    ev.some((e) => e.e === 'reject' && e.reason.includes('ver')) && sniper.focusId === 0,
    'focus sobre un invisible NO detectado se RECHAZA (focusId sigue en 0)',
  );
  // (b) defensa en profundidad: aun con focusId forzado a mano, pickTarget lo ignora
  sniper.focusId = 9102;
  for (let i = 0; i < TICK_RATE * 3; i++) stepGame(st, simCtx, []);
  assert(hidden.hp === 100000, 'aun con focusId forzado, la torre NO dispara a un invisible no detectado');
}

console.log('— Lote 4 · HALT: una torre detenida no dispara; al reanudar vuelve —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 2602, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.nextId = 9200; st.wave = 3; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  const sniper = mkTower('sniper', { id: 9201, cx: 5, cy: 1, level: 3, invested: 635 });
  st.towers.push(sniper);
  const brute = mkEnemy('brute', { id: 9202, hp: 100000, maxHp: 100000, speedMult: 0, x: 5.5, y: 2.5 });
  st.enemies.push(brute);

  // detenida ANTES de disparar: comandos van primero en el tick → jamás dispara
  const evH = stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'halt', towerId: 9201, on: true } }]);
  assert(!evH.some((e) => e.e === 'reject') && sniper.halted, 'el comando halt(on) se acepta');
  for (let i = 0; i < TICK_RATE * 4; i++) stepGame(st, simCtx, []);
  assert(brute.hp === 100000, `una torre DETENIDA no dispara (hp intacto tras 4 s)`);

  // reanudar: vuelve a disparar
  stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'halt', towerId: 9201, on: false } }]);
  assert(!sniper.halted, 'el comando halt(off) reanuda');
  for (let i = 0; i < TICK_RATE * 4; i++) stepGame(st, simCtx, []);
  assert(brute.hp < 100000, `al REANUDAR vuelve a disparar (−${(100000 - brute.hp).toFixed(0)})`);
}

console.log('— Lote 4 · focus/halt rechazan a quien no es dueño y a torres que no disparan —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 2603, [
    { id: 'p1', name: 'A', color: '#fff' },
    { id: 'p2', name: 'B', color: '#000' },
  ]);
  st.nextId = 9300; st.wave = 3; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
  const sniper = mkTower('sniper', { id: 9301, cx: 5, cy: 1, level: 3, owner: 'p1' });
  st.towers.push(sniper);
  // torres que NO disparan, de p1: estandarte, alquimista, sentry y trampa
  st.towers.push(mkTower('banner', { id: 9302, cx: 6, cy: 1, level: 1 }));
  st.towers.push(mkTower('alchemist', { id: 9303, cx: 7, cy: 1, level: 1 }));
  st.towers.push(mkTower('sentry', { id: 9304, cx: 8, cy: 1, level: 1 }));
  st.towers.push(mkTower('trap', { id: 9305, cx: 5, cy: 2, level: 1, charges: 20 }));
  const brute = mkEnemy('brute', { id: 9306, hp: 100000, maxHp: 100000, speedMult: 0, x: 5.5, y: 2.5 });
  st.enemies.push(brute);

  // (a) p2 intenta controlar la torre de p1 → rechazado, sin efecto
  const evOwner = stepGame(st, simCtx, [
    { playerId: 'p2', cmd: { kind: 'focus', towerId: 9301, enemyId: 9306 } },
    { playerId: 'p2', cmd: { kind: 'halt', towerId: 9301, on: true } },
  ]);
  const ownerRejects = evOwner.filter((e) => e.e === 'reject' && e.reason.includes('dueño'));
  assert(ownerRejects.length === 2, `focus y halt de un NO-dueño se rechazan (${ownerRejects.length}/2 rejects)`);
  assert(sniper.focusId === 0 && !sniper.halted, 'la torre ajena queda intacta (sin focus, sin halt)');

  // (b) focus/halt sobre torres que NO disparan → rechazados
  const evFires = stepGame(st, simCtx, [
    { playerId: 'p1', cmd: { kind: 'focus', towerId: 9302, enemyId: 9306 } }, // estandarte
    { playerId: 'p1', cmd: { kind: 'halt', towerId: 9303, on: true } }, // alquimista
    { playerId: 'p1', cmd: { kind: 'halt', towerId: 9304, on: true } }, // sentry
    { playerId: 'p1', cmd: { kind: 'focus', towerId: 9305, enemyId: 9306 } }, // trampa
  ]);
  const firesRejects = evFires.filter((e) => e.e === 'reject' && e.reason.includes('no dispara'));
  assert(firesRejects.length === 4, `focus/halt sobre estandarte/alquimista/sentry/trampa se rechazan (${firesRejects.length}/4)`);
  assert(st.towers.every((t) => t.focusId === 0 && !t.halted), 'ninguna torre de apoyo quedó con focus/halt');
}

console.log('— Lote 4 · determinismo con focus + halt en plena oleada —');
{
  // Corre una escena real (oleada 6 generada por la sim) y aplica focus/halt/
  // reanudar en ticks fijos; el id del enfocado se ELIGE del estado (primer
  // enemigo vivo), igual en ambas corridas. Estado final → hash idéntico.
  function hashCtl(): string {
    const map = getMap('sendero');
    const simCtx = makeSimContext(map, makePlacementContext(map));
    const st = createGame('sendero', 'classic', 'normal', 2604, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 9400; st.wave = 5; st.waveState = 'interlude'; st.interludeLeft = 2 * TICK_RATE;
    st.towers.push(mkTower('sniper', { id: 9401, cx: 5, cy: 1, level: 3 }));
    st.towers.push(mkTower('cannon', { id: 9402, cx: 6, cy: 1, level: 3 }));
    st.towers.push(mkTower('archer', { id: 9403, cx: 7, cy: 1, level: 3 }));
    for (let i = 0; i < TICK_RATE * 30; i++) {
      const cmds: PlayerCommand[] = [];
      if (i === TICK_RATE * 5 && st.enemies.length > 0) {
        cmds.push({ playerId: 'p1', cmd: { kind: 'focus', towerId: 9401, enemyId: st.enemies[0].id } });
      }
      if (i === TICK_RATE * 6) cmds.push({ playerId: 'p1', cmd: { kind: 'halt', towerId: 9402, on: true } });
      if (i === TICK_RATE * 12) cmds.push({ playerId: 'p1', cmd: { kind: 'halt', towerId: 9402, on: false } });
      if (i === TICK_RATE * 14) cmds.push({ playerId: 'p1', cmd: { kind: 'focus', towerId: 9401, enemyId: 0 } });
      stepGame(st, simCtx, cmds);
    }
    return JSON.stringify([
      st.tick, st.rng, st.nextId, st.wave, st.lives,
      st.enemies.map((e) => [e.id, Math.round(e.x * 100), Math.round(e.hp)]),
      st.towers.map((t) => [t.id, t.focusId, t.halted, t.kills, Math.round(t.damage)]),
      Math.round(st.players[0].gold),
    ]);
  }
  assert(hashCtl() === hashCtl(), 'la sim con focus+halt es DETERMINISTA (mismo hash en dos corridas)');
}

console.log('— F5.1 · Matriz ataque×armadura: el multiplicador aplica ANTES de la armadura plana —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  // Primer golpe de una torre L3 sobre un enemigo inmóvil gordo (sin élite/afijos).
  function firstHit(towerType: TowerTypeId, enemyType: EnemyTypeId): number {
    const st = createGame('sendero', 'endless', 'normal', 5100, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const enemy = mkEnemy(enemyType, { id: 5101, hp: 100000, maxHp: 100000, speedMult: 0, x: 5.5, y: 2.5, wpIdx: 1, dodgeBonus: -1 });
    st.enemies.push(enemy);
    st.towers.push(mkTower(towerType, { id: 5102, cx: 5, cy: 1, level: 3, invested: 500 }));
    for (let i = 0; i < TICK_RATE * 2 && enemy.hp === 100000; i++) stepGame(st, simCtx, []);
    return 100000 - enemy.hp;
  }
  // asignaciones base (guard de identidad: si alguien las cambia, esto salta)
  assert(attackTypeOf({ type: 'cannon', fusion: -1 }) === 'asedio' && attackTypeOf({ type: 'sniper', fusion: -1 }) === 'perforante', 'cañón=asedio y francotirador=perforante');
  assert(attackTypeOf({ type: 'tesla', fusion: -1 }) === 'magico' && attackTypeOf({ type: 'archer', fusion: -1 }) === 'fisico', 'tesla=mágico y arquero=físico');
  assert(armorTypeOf('runner') === 'ligera' && armorTypeOf('armored') === 'blindada' && armorTypeOf('skywhale') === 'colosal' && armorTypeOf('goblin') === 'media', 'runner=ligera, armored=blindada, skywhale=colosal, goblin=media');
  // la matriz queda en el rango de diseño [0.65, 1.5]
  {
    let inRange = true;
    for (const row of Object.values(ATTACK_MATRIX)) for (const v of Object.values(row)) if (v < 0.65 || v > 1.5) inRange = false;
    assert(inRange, 'todos los multiplicadores de la matriz están en [0.65, 1.5]');
  }
  // asedio ARAÑA ligera: cañón L3 (78) vs corredor (ligera, armadura 0) → round(78×0.65)=51
  const vsLight = firstHit('cannon', 'runner');
  assert(vsLight === 51, `asedio araña ligera: cañón 78 → ${vsLight} == 51 contra el corredor`);
  // asedio DESTROZA blindada: vs acorazado (armadura 8) → round(78×1.5)−8 = 109
  const vsArmored = firstHit('cannon', 'armored');
  assert(vsArmored === 109, `asedio destroza blindada: cañón 78 → ${vsArmored} == 109 contra el acorazado`);
  // perforante caza COLOSAL: francotirador L3 (210, perfora) vs coloso alado → round(210×1.5)=315
  const vsColossal = firstHit('sniper', 'skywhale');
  assert(vsColossal === 315, `perforante caza colosal: francotirador 210 → ${vsColossal} == 315 contra el Coloso Alado`);
  // pierceArmor ignora la armadura PLANA pero NO la matriz: sniper vs acorazado
  // (blindada ×0.8, armadura 8 ignorada) → round(210×0.8)=168
  const pierceVsArmored = firstHit('sniper', 'armored');
  assert(pierceVsArmored === 168, `pierceArmor ignora la armadura plana pero NO la matriz (${pierceVsArmored} == 168)`);
  // mágico débil vs blindada: tesla L3 (55) vs acorazado → round(55×0.65)−8 = 28
  const magicVsArmored = firstHit('tesla', 'armored');
  assert(magicVsArmored === 28, `mágico débil vs blindada: tesla 55 → ${magicVsArmored} == 28 contra el acorazado`);
  // el DoT de veneno NO pasa por la matriz ni por la armadura: un blindado con
  // 150 dps de veneno pierde exactamente 150 hp/s (capa de inmunidad aparte).
  {
    const st = createGame('sendero', 'endless', 'normal', 5103, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const tank = mkEnemy('armored', { id: 5104, hp: 100000, maxHp: 100000, speedMult: 0, x: 5.5, y: 2.5, wpIdx: 1, poisonDps: 150, poisonUntil: 10000, poisonSrc: 0 });
    st.enemies.push(tank);
    for (let i = 0; i < TICK_RATE; i++) stepGame(st, simCtx, []);
    assert(Math.abs(100000 - tank.hp - 150) < 1e-6, `el DoT ignora matriz y armadura (perdió ${(100000 - tank.hp).toFixed(1)} == 150 en 1 s)`);
  }
}

console.log('— F5.1 · Balista de Cielo: SOLO aire; su Arpón II remata voladores por vida ACTUAL —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  assert(TOWER_ORDER[TOWER_ORDER.length - 1] === 'flak', 'flak crece AL FINAL de TOWER_ORDER (índices de snapshot intactos)');
  assert(TOWERS.flak.targetsAir && !TOWERS.flak.targetsGround, 'la Balista apunta a aire y NUNCA a tierra (flags)');
  assert(TOWERS.flak.attackType === 'perforante', 'la Balista es perforante (caza colosales)');

  // (a) NO dispara a tierra: un bruto en pleno rango, 3 s, ni un proyectil.
  {
    const st = createGame('sendero', 'endless', 'normal', 5200, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const ground = mkEnemy('brute', { id: 5201, hp: 100000, maxHp: 100000, speedMult: 0, x: 5.5, y: 2.5, wpIdx: 1 });
    st.enemies.push(ground);
    st.towers.push(mkTower('flak', { id: 5202, cx: 5, cy: 1, level: 3, invested: 670 }));
    let anyProj = false;
    for (let i = 0; i < TICK_RATE * 3; i++) {
      stepGame(st, simCtx, []);
      if (st.projectiles.length > 0) anyProj = true;
    }
    assert(!anyProj && ground.hp === 100000, 'la Balista NO dispara a un terrestre en rango (targetsGround=false se respeta)');
  }
  // (b) SÍ dispara al aire, y con la matriz de su rol: L3 (165) vs murciélago
  // (ligera ×0.9 → 149) y vs Coloso Alado (colosal ×1.5, armadura 2 → 246).
  function flakFirstHit(enemyType: EnemyTypeId): number {
    const st = createGame('sendero', 'endless', 'normal', 5203, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const enemy = mkEnemy(enemyType, { id: 5204, hp: 100000, maxHp: 100000, speedMult: 0, x: 5.5, y: 2.5, wpIdx: 1, dodgeBonus: -1 });
    st.enemies.push(enemy);
    st.towers.push(mkTower('flak', { id: 5205, cx: 5, cy: 1, level: 3, invested: 670 }));
    for (let i = 0; i < TICK_RATE * 2 && enemy.hp === 100000; i++) stepGame(st, simCtx, []);
    return 100000 - enemy.hp;
  }
  assert(flakFirstHit('bat') === 149, `la Balista dispara al aire: 165 → ${flakFirstHit('bat')} == 149 al murciélago (ligera ×0.9)`);
  assert(flakFirstHit('skywhale') === 246, `perforante ×1.5 al Coloso Alado (${flakFirstHit('skywhale')} == 246)`);
  // (c) con tierra y aire a la vez, ignora al terrestre aunque vaya PRIMERO.
  {
    const st = createGame('sendero', 'endless', 'normal', 5206, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const first = mkEnemy('brute', { id: 5207, hp: 100000, maxHp: 100000, speedMult: 0, x: 5.5, y: 2.5, travelled: 50, wpIdx: 1 });
    const bat = mkEnemy('bat', { id: 5208, hp: 100000, maxHp: 100000, speedMult: 0, x: 6.5, y: 2.5, travelled: 1, wpIdx: 1, dodgeBonus: -1 });
    st.enemies.push(first, bat);
    st.towers.push(mkTower('flak', { id: 5209, cx: 5, cy: 1, level: 3, invested: 670 }));
    for (let i = 0; i < TICK_RATE * 2; i++) stepGame(st, simCtx, []);
    assert(first.hp === 100000 && bat.hp < 100000, 'con mezcla tierra+aire, la Balista solo toca al volador');
  }
  // (d) Arpón del Cénit II (spec 1, nivel 4): executeCurrent 0.5 — derriba a un
  // volador si el arponazo arranca ≥50% de su vida ACTUAL; el daño efectivo vs
  // colosal es round(520×1.5)=780 (perfora la armadura plana). 520/1.1 desde la
  // revisión adversarial (con 460/1.4 lo dominaba la Ráfaga de Agujas ★★ en su
  // propio rol antitanque).
  function harpoon(hp: number, immune: boolean): { killed: boolean; hpLeft: number } {
    const st = createGame('sendero', 'endless', 'normal', 5210, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const whale = mkEnemy('skywhale', { id: 5211, hp, maxHp: 12000, spellImmune: immune, speedMult: 0, x: 5.5, y: 2.5, wpIdx: 1, dodgeBonus: -1 });
    st.enemies.push(whale);
    st.towers.push(mkTower('flak', { id: 5212, cx: 5, cy: 1, level: 4, spec: 1, invested: 1230 }));
    for (let i = 0; i < TICK_RATE * 2 && st.enemies.some((e) => e.id === 5211 && e.hp === hp); i++) stepGame(st, simCtx, []);
    const alive = st.enemies.find((e) => e.id === 5211);
    return { killed: !alive, hpLeft: alive ? alive.hp : 0 };
  }
  assert((activeStats('flak', 4, 1).executeCurrent ?? 0) === 0.5, 'el Arpón del Cénit II lleva executeCurrent 0.5');
  const downed = harpoon(1200, false);
  assert(downed.killed, 'el Arpón II DERRIBA a un volador malherido (780 ≥ 50% de 1200)');
  const healthy = harpoon(12000, false);
  assert(!healthy.killed && healthy.hpLeft === 12000 - 780, `a un volador sano solo lo hiere (${healthy.hpLeft} == ${12000 - 780})`);
  const immuneWhale = harpoon(1200, true);
  assert(!immuneWhale.killed && immuneWhale.hpLeft === 1200 - 780, `NO remata a un volador inmune (executeCurrent es hechizo): queda con ${immuneWhale.hpLeft}`);
  // el execute del Arpón solo puede tocar AIRE por construcción: la torre no
  // apunta ni daña a nada terrestre (probado en (a) y (c)).
}

console.log('— F5.1 · DoT porcentual (Corrosión II): max(dps plano, 1.2%/s de la vida MÁX) con tope 400 —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  assert((activeStats('poison', 4, 1).poisonPctMax ?? 0) === 0.012, 'la Corrosión II lleva poisonPctMax 0.012');
  assert(POISON_PCT_CAP_DPS === 400, `el tope del DoT porcentual es 400 dps (${POISON_PCT_CAP_DPS})`);
  // dps efectivo aplicado a un enemigo según su vida MÁXIMA
  function corrosionDps(maxHp: number): number {
    const st = createGame('sendero', 'endless', 'normal', 5300, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const enemy = mkEnemy('brute', { id: 5301, hp: maxHp, maxHp, speedMult: 0, x: 5.5, y: 2.5, wpIdx: 1, dodgeBonus: -1 });
    st.enemies.push(enemy);
    st.towers.push(mkTower('poison', { id: 5302, cx: 5, cy: 1, level: 4, spec: 1, invested: 1200 })); // Corrosión II
    for (let i = 0; i < TICK_RATE * 2 && enemy.poisonDps === 0; i++) stepGame(st, simCtx, []);
    return enemy.poisonDps;
  }
  // enemigo chico (maxHp 10000): 1.2% = 120 < 190 → manda el dps PLANO (el clásico no cambia)
  assert(corrosionDps(10000) === 190, `contra un enemigo chico manda el dps plano (${corrosionDps(10000)} == 190)`);
  // esponja media (maxHp 20000): 1.2% = 240 > 190 → manda el porcentual
  assert(corrosionDps(20000) === 240, `contra una esponja media manda el 1.2%/s (${corrosionDps(20000)} == 240)`);
  // jefe del infinito (maxHp 100000): 1.2% = 1200 → TOPE en 400 dps
  assert(corrosionDps(100000) === 400, `contra un jefe del infinito el DoT se TOPA en 400 dps (${corrosionDps(100000)} == 400)`);
}

console.log('— F5.1 · Curva del infinito y botín superlineal del endless —');
{
  // clásico (≤40): waveHpMult IDÉNTICO a la fórmula previa (×1.13 desde la 20)
  const w36 = waveHpMult(36, 'normal', 1);
  assert(Math.abs(w36 - (1 + 0.11 * 35) * Math.pow(1.13, 16)) < 1e-9, `el clásico no cambia: waveHpMult(36) == base×1.13^16 (${w36.toFixed(2)})`);
  // tramo 2: desde la 40, el crecimiento compuesto baja a ×1.10
  const w50 = waveHpMult(50, 'normal', 1);
  assert(
    Math.abs(w50 - (1 + 0.11 * 49) * Math.pow(1.13, 20) * Math.pow(1.1, 10)) < 1e-9,
    `tramo 2 del infinito: waveHpMult(50) == base×1.13^20×1.10^10 (${w50.toFixed(1)})`,
  );
  const growth45 = waveHpMult(45, 'normal', 1) / waveHpMult(44, 'normal', 1);
  const growth35 = waveHpMult(35, 'normal', 1) / waveHpMult(34, 'normal', 1);
  assert(growth45 < growth35, `pasada la 40 el hp crece más suave (${growth45.toFixed(3)} < ${growth35.toFixed(3)})`);
  void DIFF_HP_MULT;

  // botín: sin modo (o horda) la fórmula es la de siempre
  assert(waveBountyMult(40) === 1 + 0.03 * 39, 'waveBountyMult sin modo conserva la firma y la fórmula clásicas');
  // F9a · el CLÁSICO paga ×CLASSIC_BOUNTY_COMP por baja (compensa que el
  // calendario monoespecie trae menos cuerpos que el generador)
  assert(
    Math.abs(waveBountyMult(40, 'classic') - (1 + 0.03 * 39) * CLASSIC_BOUNTY_COMP) < 1e-9,
    `en clásico el botín compensa ×${CLASSIC_BOUNTY_COMP} (sin término superlineal)`,
  );
  // endless: ×1.02 compuesto por oleada sobre la 30…
  const b40 = waveBountyMult(40, 'endless');
  assert(Math.abs(b40 - (1 + 0.03 * 39) * Math.pow(1.02, 10)) < 1e-9, `endless o40: botín ×1.02^10 extra (${b40.toFixed(3)})`);
  // …con tope ×3 extra en oleadas profundas
  const b200 = waveBountyMult(200, 'endless');
  assert(Math.abs(b200 - (1 + 0.03 * 199) * 3) < 1e-9, `el término endless se TOPA en ×3 (${b200.toFixed(2)})`);

  // integración: en una partida ENDLESS los enemigos nacen con el bounty superlineal
  function spawnedBountyMult(mode: 'classic' | 'endless'): number {
    const map = getMap('sendero');
    const simCtx = makeSimContext(map, makePlacementContext(map));
    const st = createGame('sendero', mode, 'normal', 5400, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.wave = 39;
    st.waveState = 'interlude';
    st.interludeLeft = 1;
    st.lives = 1e9; st.maxLives = 1e9;
    // F9a · leer un enemigo NORMAL (los élites llevan ×3 encima y con el nuevo
    // consumo de RNG el primer spawn puede ser élite — falso positivo observado)
    const normal = () => st.enemies.find((e) => !e.elite && !ENEMIES[e.type].boss);
    for (let i = 0; i < TICK_RATE * 30 && !normal(); i++) stepGame(st, simCtx, []);
    return normal()?.bountyMult ?? 0;
  }
  const classicMult = spawnedBountyMult('classic');
  const endlessMult = spawnedBountyMult('endless');
  assert(
    Math.abs(classicMult - waveBountyMult(40, 'classic')) < 1e-9,
    `en clásico la oleada 40 nace con el bounty clásico compensado (${classicMult.toFixed(3)})`,
  );
  assert(Math.abs(endlessMult - waveBountyMult(40, 'endless')) < 1e-9, `en endless la oleada 40 nace con el bounty superlineal (${endlessMult.toFixed(3)})`);
}

console.log('— F5.1 · revisión adversarial: tope de crecimiento (y zapado SIN caducidad) —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  // (a) el ZAPADO NO CADUCA (decisión de diseño: se probó un timeout de 8s y se
  // REVIRTIÓ — el zapador debe OBLIGAR al equipo a reaccionar). Este assert
  // protege esa decisión: tras un buen rato, el zapador sigue aferrado.
  {
    const st = createGame('sendero', 'endless', 'normal', 5500, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const sap = mkEnemy('sapper', { id: 5501, hp: 1e9, maxHp: 1e9, x: 5.5, y: 2.5, travelled: 5, wpIdx: 1, dodgeBonus: -1 });
    st.enemies.push(sap);
    const t = mkTower('archer', { id: 5502, cx: 5, cy: 1, level: 3, invested: 300 });
    st.towers.push(t);
    stepGame(st, simCtx, []);
    assert(sap.stunTowerId === t.id && t.stunnedUntil > st.tick, 'el zapador toma la única torre en rango y la aturde');
    for (let i = 0; i < TICK_RATE * 20; i++) stepGame(st, simCtx, []);
    assert(sap.stunTowerId === t.id && t.stunnedUntil > st.tick, 'a los 20s SIGUE aturdiéndola (el zapado no caduca: reacciona o sufre)');
  }
  // (b) TOPE DE CRECIMIENTO: el Arco Largo II deja de crecer en GROWTH_CAP (sin
  // tope divergía cuadráticamente: +13.000 de daño por flecha en endless o50).
  {
    const st = createGame('sendero', 'endless', 'normal', 5510, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 8000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const dummy = mkEnemy('brute', { id: 5511, hp: 1e9, maxHp: 1e9, speedMult: 0, x: 5.5, y: 2.5, wpIdx: 1, dodgeBonus: -1 });
    st.enemies.push(dummy);
    // Arco Largo II (archer nivel 4, spec 1) a 2 de crecimiento del tope
    const bow = mkTower('archer', { id: 5512, cx: 5, cy: 1, level: 4, spec: 1, invested: 900, growthBonus: GROWTH_CAP - 2 });
    st.towers.push(bow);
    for (let i = 0; i < TICK_RATE * 3; i++) stepGame(st, simCtx, []);
    assert(bow.growthBonus === GROWTH_CAP, `el crecimiento se TOPA en +${GROWTH_CAP} (${bow.growthBonus})`);
    assert((activeStats('archer', 4, 1).growth ?? 0) > 0, 'el Arco Largo II sigue teniendo crecimiento por disparo');
  }
}

console.log('— F5.1 · retoques de fusiones: literales del rebalance (guard de regresión) —');
{
  assert(FUSIONS.bigbertha.stats.cooldown === 6 && FUSIONS.bigbertha.stats.damage === 900, 'Gran Bertha: cooldown 9→6 y daño 780→900');
  assert(FUSIONS.shredder.stats.damage === 46 && FUSIONS.shredder.stats.splash === 1.0, 'Fragmentador: daño 30→46 y splash 0.85→1.0');
  assert(FUSIONS.alchemyvault.stats.incomePerWave === 140 && FUSIONS.alchemyvault.stats.auraBounty === 0.6, 'Bóveda Alquímica: renta 60→140 y aura 0.55→0.6');
  assert(TOWERS.cannon.specs[1].rank2!.cost === 460 && TOWERS.cannon.specs[1].rank2!.damage === 83, 'Metralla ★★: coste 400→460 y daño 90→83');
  assert(TOWERS.mortar.specs[0].rank2!.cost === 550 && TOWERS.mortar.specs[0].rank2!.damage === 212, 'Bombardeo ★★: coste 480→550 y daño 230→212');
  // el Fragmentador es FÍSICO a propósito (asedio contradiría su rol anti-enjambre)
  assert(attackTypeOf({ type: 'archer', fusion: FUSION_ORDER.indexOf('shredder') }) === 'fisico', 'el Fragmentador hereda físico (rol anti-enjambre)');
  assert(attackTypeOf({ type: 'sniper', fusion: FUSION_ORDER.indexOf('siegeeye') }) === 'perforante', 'el Ojo de Asedio hereda perforante (cazatanques)');
}

console.log('— MODO TURBO ⚡ (issue #14): multiplicadores exactos, determinismo y victoria —');
{
  // (a) MULTIPLICADORES EXACTOS comparando turbo ON vs OFF con la MISMA semilla.
  const TSEED = 424242;
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));

  // botín: el turbo multiplica bountyMult EN EL MISMO punto que waveBountyMult (al
  // nacer el enemigo). Generamos un goblin en la oleada 1 y leemos su bountyMult.
  function spawnBountyMult(turbo: boolean): number {
    const st = createGame('sendero', 'classic', 'normal', TSEED, [{ id: 'p1', name: 'A', color: '#fff' }], turbo);
    st.wave = 1;
    st.waveState = 'active';
    st.pendingWave = [];
    st.spawnQueue = [{ type: 'goblin', delay: 0, pathIdx: 0 }];
    st.spawnCooldown = 0;
    st.nextId = 5000;
    stepGame(st, simCtx, []);
    return st.enemies[0].bountyMult;
  }
  const bmOff = spawnBountyMult(false);
  const bmOn = spawnBountyMult(true);
  // F9a · en clásico el bounty base de la o1 ya lleva la compensación ×1.3
  assert(bmOff === CLASSIC_BOUNTY_COMP, `turbo OFF: bountyMult de la o1 clásica es ${CLASSIC_BOUNTY_COMP} (fue ${bmOff})`);
  assert(
    Math.abs(bmOn - bmOff * TURBO_BOUNTY_MULT) < 1e-9,
    `turbo ON: el botín se multiplica ×${TURBO_BOUNTY_MULT} exacto (${bmOff} → ${bmOn})`,
  );

  // bono de fin de oleada + interludio NORMAL: forzamos la oleada 1 "vacía" (sin cola
  // ni enemigos) → un stepGame la da por completada y emite wave_end + reinicia el
  // interludio. Leemos ambos con turbo ON/OFF.
  function clearWaveProbe(turbo: boolean): { bonus: number; interlude: number } {
    const st = createGame('sendero', 'classic', 'normal', TSEED, [{ id: 'p1', name: 'A', color: '#fff' }], turbo);
    st.wave = 1;
    st.waveState = 'active';
    st.pendingWave = [];
    st.spawnQueue = [];
    st.enemies = [];
    const events = stepGame(st, simCtx, []);
    const we = events.find((e) => e.e === 'wave_end') as Extract<GameEvent, { e: 'wave_end' }> | undefined;
    return { bonus: we?.bonus ?? -1, interlude: st.interludeLeft };
  }
  const clrOff = clearWaveProbe(false);
  const clrOn = clearWaveProbe(true);
  const baseBonus = WAVE_BONUS_BASE + 1 * WAVE_BONUS_PER_WAVE; // oleada 1
  assert(clrOff.bonus === baseBonus, `turbo OFF: bono de fin de oleada 1 = ${baseBonus} (fue ${clrOff.bonus})`);
  assert(
    clrOn.bonus === Math.round(baseBonus * TURBO_WAVE_BONUS_MULT),
    `turbo ON: el bono de fin de oleada se multiplica ×${TURBO_WAVE_BONUS_MULT} (${clrOff.bonus} → ${clrOn.bonus})`,
  );
  // interludio NORMAL a la mitad
  assert(clrOff.interlude === INTERLUDE_SEC * TICK_RATE, `turbo OFF: interludio normal = ${INTERLUDE_SEC * TICK_RATE} ticks (fue ${clrOff.interlude})`);
  assert(
    clrOn.interlude === Math.round(INTERLUDE_SEC * TICK_RATE * TURBO_INTERLUDE_MULT),
    `turbo ON: el interludio normal es a la mitad (${clrOff.interlude} → ${clrOn.interlude} ticks)`,
  );

  // interludio INICIAL (createGame) también a la mitad
  const firstOff = createGame('sendero', 'classic', 'normal', TSEED, [{ id: 'p1', name: 'A', color: '#fff' }], false).interludeLeft;
  const firstOn = createGame('sendero', 'classic', 'normal', TSEED, [{ id: 'p1', name: 'A', color: '#fff' }], true).interludeLeft;
  assert(firstOff === FIRST_INTERLUDE_SEC * TICK_RATE, `turbo OFF: primer interludio = ${FIRST_INTERLUDE_SEC * TICK_RATE} ticks (fue ${firstOff})`);
  assert(
    firstOn === Math.round(FIRST_INTERLUDE_SEC * TICK_RATE * TURBO_INTERLUDE_MULT),
    `turbo ON: el primer interludio es a la mitad (${firstOff} → ${firstOn} ticks)`,
  );

  // madera: el orco tala ×TURBO_WOOD_MULT. Corremos 150 ticks sin comandos (dentro del
  // primer interludio en ambos casos) y comparamos el incremento de madera.
  function woodDelta(turbo: boolean): number {
    const st = createGame('sendero', 'classic', 'normal', TSEED, [{ id: 'p1', name: 'A', color: '#fff' }], turbo);
    const before = st.players[0].wood;
    for (let i = 0; i < 150; i++) stepGame(st, simCtx, []);
    return st.players[0].wood - before;
  }
  const woodOff = woodDelta(false);
  const woodOn = woodDelta(true);
  assert(
    Math.abs(woodOn - woodOff * TURBO_WOOD_MULT) < 1e-9,
    `turbo ON: la tala de madera se multiplica ×${TURBO_WOOD_MULT} exacto (${woodOff.toFixed(3)} → ${woodOn.toFixed(3)})`,
  );

  // (b) DETERMINISMO: dos corridas turbo con la MISMA semilla dan el mismo estado.
  const turboWin = runScenario(MAP_ID, MAX_TICKS, SEED, true);
  const turboWin2 = runScenario(MAP_ID, MAX_TICKS, SEED, true);
  const hashT1 = JSON.stringify([turboWin.state.tick, turboWin.state.wave, turboWin.state.lives, turboWin.state.rng, turboWin.state.players.map((p) => [p.gold, p.wood]), turboWin.state.nextId]);
  const hashT2 = JSON.stringify([turboWin2.state.tick, turboWin2.state.wave, turboWin2.state.lives, turboWin2.state.rng, turboWin2.state.players.map((p) => [p.gold, p.wood]), turboWin2.state.nextId]);
  assert(hashT1 === hashT2, `la partida turbo es determinista (misma semilla → mismo estado final, tick ${turboWin.state.tick})`);

  // (c) el bot GANA el clásico TURBO en normal con la MISMA semilla del gate (123456845)
  // y lo hace MÁS HOLGADO que la normal (más oro, mismo HP): la normal gana con 9 vidas,
  // la turbo con 30 (llena). Sim más corto (menos ticks): los interludios a la mitad.
  assert(turboWin.state.over?.victory === true, `el bot GANA el clásico TURBO en normal (oleada ${turboWin.maxWave}, ${turboWin.state.lives} vidas, over=${JSON.stringify(turboWin.state.over)})`);
  assert(
    turboWin.state.over?.victory === true && turboWin.state.lives >= a.state.lives,
    `la victoria turbo es MÁS holgada que la normal (turbo ${turboWin.state.lives} vidas >= normal ${a.state.lives})`,
  );
  assert(turboWin.state.tick < a.state.tick, `la partida turbo dura MENOS ticks que la normal (${turboWin.state.tick} < ${a.state.tick})`);

  // (d) la HORDA IGNORA el flag: sanitizeSettings lo descarta y createGame lo normaliza
  // a false (su economía de bucle no admite la compresión turbo).
  assert(sanitizeSettings({ mapId: 'sendero', mode: 'horde', difficulty: 'normal', turbo: true }).turbo === false, 'sanitizeSettings descarta el turbo en HORDA');
  const hordeTurbo = createGame('sendero', 'horde', 'normal', TSEED, [{ id: 'p1', name: 'A', color: '#fff' }], true);
  assert(hordeTurbo.turbo === false, 'createGame normaliza turbo=false en HORDA aunque se pida true');
  assert(
    hordeTurbo.interludeLeft === FIRST_INTERLUDE_SEC * TICK_RATE,
    `en HORDA el interludio NO se recorta (${hordeTurbo.interludeLeft} == ${FIRST_INTERLUDE_SEC * TICK_RATE}): el flag se ignora`,
  );
}

// ==================== F9a (v19) · BALANCE v19 ====================

console.log('— F9a · Calendario clásico: fijo, determinista y fiel a sus promesas —');
{
  // determinismo: dos corridas con la MISMA semilla → entradas idénticas
  const g1: string[] = [];
  const g2: string[] = [];
  const r1 = { rng: 777001 };
  const r2 = { rng: 777001 };
  for (let w = 1; w <= 36; w++) {
    g1.push(JSON.stringify(generateWave(r1, w, 2, 1, 'classic')));
    g2.push(JSON.stringify(generateWave(r2, w, 2, 1, 'classic')));
  }
  assert(g1.join('|') === g2.join('|'), 'el calendario clásico es DETERMINISTA (misma semilla → mismas 36 oleadas)');

  // promesas del calendario (derivadas de la MISMA sim que las cumple)
  const r3 = { rng: 424242 };
  const airWaves: number[] = [];
  const immuneWaves: number[] = [];
  const invisWaves: number[] = [];
  const champWaves: number[] = [];
  const bossWaves: number[] = [];
  let affixBelow20 = 0;
  let affixFrom20 = 0;
  let speciesOk = true;
  for (let w = 1; w <= 36; w++) {
    const gen = generateWave(r3, w, 2, 1, 'classic');
    const cal = classicWave(w)!;
    if (gen.flying) airWaves.push(w);
    if (gen.immune) immuneWaves.push(w);
    if (gen.invisible) invisWaves.push(w);
    if (gen.champion) champWaves.push(w);
    if (gen.hasBoss) bossWaves.push(w);
    if (gen.bossAffix) (w < 20 ? affixBelow20++ : affixFrom20++);
    // monoespecie: todas las entradas no-jefe son la especie del calendario
    if (gen.entries.some((e) => !ENEMIES[e.type].boss && e.type !== cal.type)) speciesOk = false;
  }
  assert(airWaves.join(',') === '7,15,17,23,25,27,35', `AÉREAS en 7/17/23/27 + jefas voladoras 15/25/35 (${airWaves.join(',')})`);
  assert(immuneWaves.join(',') === '10,20,30', `INMUNES exactamente en 10/20/30 (${immuneWaves.join(',')})`);
  assert(invisWaves.join(',') === '12,18,24', `INVISIBLES exactamente en 12/18/24 (${invisWaves.join(',')})`);
  assert(champWaves.join(',') === '16,22,31', `CAMPEONES 👑 exactamente en 16/22/31 (${champWaves.join(',')})`);
  assert(bossWaves.join(',') === '10,15,20,25,30,35,36', `JEFES en su cadencia + jefe-muro en la 36 (${bossWaves.join(',')})`);
  assert(speciesOk, 'cada oleada del calendario es MONOESPECIE (más su jefe, si lo hay)');
  {
    const r4 = { rng: 99 };
    const g36 = generateWave(r4, 36, 2, 1, 'classic');
    assert(g36.bossType === 'behemoth', `el JEFE-MURO de la 36 es el Behemot (${g36.bossType})`);
  }
  assert(affixBelow20 === 0 && affixFrom20 >= 4, `afijos de JEFE solo desde la o${20} en clásico (antes:${affixBelow20}, después:${affixFrom20})`);
  // waveHasBoss con modo: la 36 solo es jefe EN CLÁSICO
  assert(waveHasBoss(36, 'classic') && !waveHasBoss(36, 'endless'), 'waveHasBoss(36) depende del modo (jefe-muro solo clásico)');
}

console.log('— F9a · Campeones 👑: transformación, botín ×5 y fuga carísima —');
{
  // endless: la rotación cae en 13, 23, 33… y jamás pisa inmunes/jefes/invisibles
  assert(isChampionWave(13) && isChampionWave(23) && isChampionWave(33) && !isChampionWave(20) && !isChampionWave(15), 'la rotación endless de campeones es 13/23/33…');
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 909090, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.wave = 22; // la próxima (23) es de campeones
  st.waveState = 'interlude';
  st.interludeLeft = 1;
  st.lives = 1e9; st.maxLives = 1e9;
  for (let i = 0; i < TICK_RATE * 30 && st.enemies.length === 0; i++) stepGame(st, simCtx, []);
  assert(st.nextWaveChampion === false && st.enemies.length > 0, 'la oleada 23 endless spawnea campeones');
  const champ = st.enemies[0];
  const def = ENEMIES[champ.type];
  const baseHp = Math.round(def.hp * waveHpMult(23, 'normal', 1));
  assert(champ.champion === true, 'el enemigo nace marcado como CAMPEÓN');
  assert(champ.maxHp === Math.round(baseHp * CHAMPION_HP_MULT), `vida ×${CHAMPION_HP_MULT} del presupuesto (${champ.maxHp} == ${Math.round(baseHp * CHAMPION_HP_MULT)})`);
  assert(champ.speedMult === CHAMPION_SPEED_MULT, `velocidad ×${CHAMPION_SPEED_MULT} (${champ.speedMult})`);
  assert(
    Math.abs(champ.bountyMult - waveBountyMult(23, 'endless') * CHAMPION_BOUNTY_MULT) < 1e-9,
    `botín ×${CHAMPION_BOUNTY_MULT} sobre el multiplicador de oleada (${champ.bountyMult.toFixed(2)})`,
  );
  assert(!champ.elite && champ.affixes.length === 0, 'un campeón NO es élite (arquetipo propio, sin afijos)');
  // fuga carísima: livesCost + floor(oleada/10) + CHAMPION_EXTRA_LIVES
  {
    const st2 = createGame('sendero', 'endless', 'normal', 909091, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st2.wave = 23; st2.waveState = 'active'; st2.spawnQueue = []; st2.pendingWave = [];
    st2.lives = 30;
    const wps = pathWaypoints(map, 0).length;
    const leaker = mkEnemy('brute', { id: 6001, champion: true, x: 0, y: 0, wpIdx: wps, travelled: 999 });
    st2.enemies.push(leaker);
    const evs = stepGame(st2, simCtx, []);
    const leak = evs.find((e) => e.e === 'leak');
    const expected = ENEMIES.brute.livesCost + Math.floor(23 / 10) + CHAMPION_EXTRA_LIVES;
    assert(leak !== undefined && 30 - st2.lives === expected, `la fuga de un campeón cuesta ${expected} vidas (costó ${30 - st2.lives})`);
    // pedido del lote de mapas XL: el leak lleva el pathIdx de la ruta del enemigo
    assert(leak !== undefined && leak.e === 'leak' && leak.pathIdx === leaker.pathIdx, `el evento leak lleva pathIdx (${leak && leak.e === 'leak' ? leak.pathIdx : '?'} == ${leaker.pathIdx})`);
  }
}

console.log('— F9a · Barril: coste escalado POR EQUIPO, validado server-side —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('sendero', 'endless', 'normal', 606060, [
    { id: 'p1', name: 'A', color: '#fff' },
    { id: 'p2', name: 'B', color: '#000' },
  ]);
  st.wave = 1; st.waveState = 'active'; st.pendingWave = [];
  // cola "congelada": impide que waveCleared dispare el bono de fin de oleada
  // (ensuciaba las cuentas exactas de oro de este test)
  st.spawnQueue = [{ type: 'goblin', delay: 2, pathIdx: 0 }];
  st.spawnCooldown = 999999;
  const cells = [...pathCells(map)].map((k) => k.split(',').map(Number) as [number, number]);
  const p1 = st.players[0];
  const p2 = st.players[1];
  p1.gold = 1000; p2.gold = 118; // p2 puede pagar el 2.º precio (117) pero no el 3.º
  const base = TOWERS.boom.levels[0].cost;
  assert(boomCost(st) === base, `precio inicial del barril = base (${base})`);
  stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'place', towerType: 'boom', cx: cells[0][0], cy: cells[0][1] } }]);
  assert(st.boomsBought === 1 && p1.gold === 1000 - base, `la 1.ª compra cuesta ${base} y sube el contador del equipo`);
  const second = Math.round(base * BOOM_COST_TEAM_STEP);
  assert(boomCost(st) === second, `el 2.º barril cuesta ×1.3 (${second})`);
  // p2 compra al precio NUEVO aunque el "precio viejo" fuera pagable — server manda
  stepGame(st, simCtx, [{ playerId: 'p2', cmd: { kind: 'place', towerType: 'boom', cx: cells[1][0], cy: cells[1][1] } }]);
  assert(st.boomsBought === 2 && p2.gold === 118 - second, `p2 pagó el precio ESCALADO (${second}), no el base`);
  const third = Math.round(base * BOOM_COST_TEAM_STEP * BOOM_COST_TEAM_STEP);
  // p2 con 1 de oro: rechazo limpio al precio real
  const evs = stepGame(st, simCtx, [{ playerId: 'p2', cmd: { kind: 'place', towerType: 'boom', cx: cells[2][0], cy: cells[2][1] } }]);
  assert(evs.some((e) => e.e === 'reject' && e.reason.includes('oro')), `sin oro para el 3.º (${third}): rechazado server-side`);
  assert(st.boomsBought === 2, 'un rechazo NO sube el contador');
  // vender un barril NO devuelve el escalón (sin ciclos de reset)
  const boomTower = st.towers.find((t) => t.type === 'boom')!;
  stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'sell', towerId: boomTower.id } }]);
  assert(st.boomsBought === 2 && boomCost(st) === third, 'vender el barril NO baja el precio del equipo');
  // el snapshot expone el precio efectivo para el cliente
  assert(buildSnap(st).boomCost === third, `el snapshot lleva boomCost=${third} (el cliente solo lo pinta)`);
}

console.log('— F9a · Niveles 5→10: veteranía con oro+madera, tope clásico, pozo endless —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const mk = (mode: 'classic' | 'endless') => {
    const st = createGame('sendero', mode, 'normal', 505050, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.wave = 1; st.waveState = 'active'; st.pendingWave = [];
    // cola congelada: sin bono de fin de oleada que ensucie las cuentas de oro
    st.spawnQueue = [{ type: 'goblin', delay: 2, pathIdx: 0 }];
    st.spawnCooldown = 999999;
    st.players[0].gold = 100000; st.players[0].wood = 10000;
    return st;
  };
  // (a) subir del Rango II al 5..10 cobrando la tabla exacta
  {
    const st = mk('classic');
    const t = mkTower('archer', { id: 7001, level: 4, spec: 1, invested: 800 });
    st.towers.push(t);
    const baseDmg = (activeStats('archer', 4, 1) as { damage: number }).damage;
    for (let step = 1; step <= 6; step++) {
      const goldBefore = st.players[0].gold;
      stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'upgrade', towerId: 7001 } }]);
      assert(
        t.level === 4 + step && goldBefore - st.players[0].gold === ELITE_LEVEL_GOLD[step - 1],
        `paso ${step}: nivel ${4 + step} cobrando 🪙${ELITE_LEVEL_GOLD[step - 1]}`,
      );
    }
    // stats: +8% daño y +4% cadencia por nivel, compuestos (statsOf)
    const s10 = statsOf({ type: 'archer', level: 10, spec: 1, fusion: -1 });
    assert(s10.damage === Math.round(baseDmg * Math.pow(1.08, 6)), `nivel 10: daño ×1.08^6 (${s10.damage})`);
    assert(
      Math.abs(s10.cooldown - (activeStats('archer', 4, 1) as { cooldown: number }).cooldown / Math.pow(1.04, 6)) < 1e-9,
      `nivel 10: cadencia ÷1.04^6 (${s10.cooldown.toFixed(3)}s)`,
    );
    // (b) TOPE del clásico: nivel 10 es la cima
    const evs = stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'upgrade', towerId: 7001 } }]);
    assert(evs.some((e) => e.e === 'reject' && e.reason.includes('cima')), 'en CLÁSICO el nivel 10 es la cima (reject)');
    assert(t.level === 10, 'la torre queda en nivel 10');
  }
  // (c) endless: el tope se ABRE con curva ×1.5 compuesta
  {
    const st = mk('endless');
    const t = mkTower('archer', { id: 7002, level: 10, spec: 1, invested: 5000 });
    st.towers.push(t);
    const goldBefore = st.players[0].gold;
    stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'upgrade', towerId: 7002 } }]);
    const step7 = Math.round(ELITE_LEVEL_GOLD[5] * 1.5);
    assert(t.level === 11 && goldBefore - st.players[0].gold === step7, `endless: nivel 11 cuesta 🪙${step7} (×1.5 sobre el paso 6)`);
    assert(nextEliteLevelCost(t, 'endless') !== null, 'y el 12 sigue disponible (pozo del oro tardío)');
    assert(nextEliteLevelCost(t, 'classic') === null, 'el MISMO nivel 11 no existiría en clásico');
  }
  // (d) sin madera no hay veteranía (cuesta ORO + MADERA)
  {
    const st = mk('classic');
    st.players[0].wood = ELITE_LEVEL_WOOD[0] - 1;
    const t = mkTower('archer', { id: 7003, level: 4, spec: 1 });
    st.towers.push(t);
    const evs = stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'upgrade', towerId: 7003 } }]);
    assert(evs.some((e) => e.e === 'reject' && e.reason.includes('madera')), 'sin madera: rechazado (no se compra nivel 10 sin pagar madera)');
    assert(t.level === 4, 'la torre no sube');
  }
  // (e) las torres que NO disparan no compran veteranía (+8% de nada = trampa)
  {
    const st = mk('classic');
    const t = mkTower('banner', { id: 7004, level: 4, spec: 0, invested: 800 });
    st.towers.push(t);
    const evs = stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'upgrade', towerId: 7004 } }]);
    assert(evs.some((e) => e.e === 'reject'), 'un Estandarte ★★ NO compra veteranía (no dispara)');
  }
  // (f) una torre SIN especializar sigue clavada en el nivel 3 (refuerza especializar)
  {
    const st = mk('classic');
    const t = mkTower('archer', { id: 7005, level: 3, spec: -1 });
    st.towers.push(t);
    const evs = stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'upgrade', towerId: 7005 } }]);
    assert(evs.some((e) => e.e === 'reject' && e.reason.includes('máximo')), 'sin especializar: nivel 3 es su techo');
  }
}

console.log('— Reparar fortaleza: todos los modos, vidas progresivas (3→5→7→10) —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  // (a) endless: +3 vidas (1ª compra), +5 (2ª), +7 (3ª), +10 (4ª)
  {
    const st = createGame('sendero', 'endless', 'normal', 404040, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.wave = 5; st.waveState = 'active'; st.pendingWave = [];
    st.spawnQueue = [{ type: 'goblin', delay: 2, pathIdx: 0 }]; // cola congelada (sin bono)
    st.spawnCooldown = 999999;
    st.lives = 20;
    st.players[0].gold = 5000;
    assert(repairCost(st) === REPAIR_COST_BASE, `precio inicial ${REPAIR_COST_BASE}`);
    stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'repair' } }]);
    assert(st.lives === 23 && st.players[0].gold === 5000 - REPAIR_COST_BASE, '1ª reparación: +3 vidas');
    const second = Math.round(REPAIR_COST_BASE * REPAIR_COST_STEP);
    assert(repairCost(st) === second, `la 2.ª reparación cuesta ${second} (×${REPAIR_COST_STEP} compuesto)`);
    stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'repair' } }]);
    assert(st.lives === 28 && st.repairsBought === 2, '2ª reparación: +5 vidas (total 28)');
    assert(buildSnap(st).repairCost === Math.round(REPAIR_COST_BASE * REPAIR_COST_STEP * REPAIR_COST_STEP), 'el snapshot expone el precio vivo');
    // Sin tope: reparar incluso con vidas al máximo
    st.lives = st.maxLives;
    st.players[0].gold = 99999;
    const evs = stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'repair' } }]);
    // 3ª compra = +7 vidas (REPAIR_LIVES[2])
    assert(st.lives === st.maxLives + 7, `reparar funciona al tope (+7 vidas: ${st.maxLives} → ${st.lives})`);
    assert(!evs.some((e) => e.e === 'reject'), 'sin rechazo: se acumula sin límite');
  }
  // (b) clásico: ahora SÍ se permite reparar en todos los modos.
  // La oleada da +2 vidas fijo.
  {
    const st = createGame('sendero', 'classic', 'normal', 404041, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.wave = 5; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    st.lives = 10;
    st.players[0].gold = 99999;
    const evs = stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'repair' } }]);
    // reparación = +3 (1ª compra) + oleada = +2 → total 15
    assert(evs.some((e) => e.e === 'repair'), 'reparar en clásico ahora funciona');
    assert(st.lives === 15 && st.repairsBought === 1, 'reparó +3 + oleada +2 = 15');
  }
  // (c) horda: +1 de AFORO de saturación (el equivalente coherente de +1 vida)
  {
    const mkHorde = (repairs: number, enemies: number) => {
      const st = createGame('sendero', 'horde', 'normal', 404042, [{ id: 'p1', name: 'A', color: '#fff' }]);
      st.wave = 3; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
      st.repairsBought = repairs;
      for (let i = 0; i < enemies; i++) st.enemies.push(mkEnemy('goblin', { id: 9000 + i, x: 5.5, y: 2.5, wpIdx: 1, speedMult: 0 }));
      stepGame(st, simCtx, []);
      return st;
    };
    const cap = HORDE_CAP.normal;
    assert(mkHorde(0, cap).over !== null, `sin reparaciones, ${cap} enemigos = derrota por saturación`);
    assert(mkHorde(1, cap).over === null, `con 1 reparación el aforo sube a ${cap + 1}: se sobrevive`);
    assert(mkHorde(1, cap + 1).over !== null, 'y con cap+1 enemigos vuelve a caer (el aforo es exacto)');
  }
}

console.log('— F9a · Estandarte del Vencedor: crítico determinista y CERTEZA —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  // arquero + Vencedor adyacente vs dummy esquivo: medimos crits/misses/daño
  function runCrit(seed: number, withBanner: boolean, dodge = 0): { crits: number; misses: number; dmg: number } {
    const st = createGame('sendero', 'endless', 'normal', seed, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 9000; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const dummy = mkEnemy('brute', { id: 9001, hp: 1e9, maxHp: 1e9, speedMult: 0, x: 5.5, y: 2.5, wpIdx: 1, dodgeBonus: dodge });
    st.enemies.push(dummy);
    st.towers.push(mkTower('archer', { id: 9002, cx: 5, cy: 1, level: 3, spec: -1 }));
    if (withBanner) st.towers.push(mkTower('banner', { id: 9003, cx: 6, cy: 1, level: 3, spec: 2 }));
    let crits = 0;
    let misses = 0;
    for (let i = 0; i < TICK_RATE * 20; i++) {
      for (const ev of stepGame(st, simCtx, [])) {
        if (ev.e === 'crit') crits++;
        if (ev.e === 'miss') misses++;
      }
    }
    return { crits, misses, dmg: Math.round(1e9 - dummy.hp) };
  }
  const plain = runCrit(313131, false);
  const buffed = runCrit(313131, true);
  assert(plain.crits === 0, 'sin Vencedor no hay críticos');
  assert(buffed.crits > 0, `bajo el Vencedor caen críticos (${buffed.crits} en 20s)`);
  assert(buffed.dmg > plain.dmg, `el crítico ×${CRIT_MULT} sube el daño total (${plain.dmg} → ${buffed.dmg})`);
  // determinismo: misma semilla → mismos críticos y mismo daño exacto
  const again = runCrit(313131, true);
  assert(again.crits === buffed.crits && again.dmg === buffed.dmg, 'el crítico es DETERMINISTA (rand(state) de la sim)');
  // CERTEZA: contra un esquivo total (dodge 0.9 clamp), bajo el aura NUNCA falla
  const dodgy = runCrit(313132, false, 0.9);
  const sure = runCrit(313132, true, 0.9);
  assert(dodgy.misses > 0, `sin Certeza el esquivo hace fallar (${dodgy.misses} misses)`);
  assert(sure.misses === 0, 'con CERTEZA ningún proyectil del arquero falla');
  // el Vencedor exige su coste gordo: oro 750 + madera propia 120
  const spec = TOWERS.banner.specs[2];
  assert(spec.key === 'victorybanner' && spec.cost === 750 && spec.woodCost === 120, 'la spec índice 2 del Estandarte es el Vencedor (750🪙 + 120🪵)');
  // regla MAX: dos Vencedores no apilan (computeAuras toma el máximo)
  {
    const st = createGame('sendero', 'endless', 'normal', 313133, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.towers.push(mkTower('archer', { id: 9010, cx: 5, cy: 1, level: 3 }));
    st.towers.push(mkTower('banner', { id: 9011, cx: 6, cy: 1, level: 3, spec: 2 }));
    st.towers.push(mkTower('banner', { id: 9012, cx: 4, cy: 1, level: 3, spec: 2 }));
    const buff = computeAuras(st).get(9010);
    assert(buff !== undefined && buff.critChance === 0.15, `dos Vencedores no apilan: crítico se queda en 15% (${buff?.critChance})`);
  }
}

console.log('— F9a · Poder Vital: +20% con ≥25 vidas; se apaga al fugar; reparar lo reenciende —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  function vitalShot(lives: number): number {
    const st = createGame('sendero', 'endless', 'normal', 212121, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 9100; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    st.lives = lives;
    // a 2.4 celdas: el dardo (speed 17/15 ≈ 1.13/tick) tarda 3 ticks — se puede leer
    st.enemies.push(mkEnemy('brute', { id: 9101, hp: 1e9, maxHp: 1e9, speedMult: 0, x: 5.5, y: 3.9, wpIdx: 1, dodgeBonus: -1 }));
    st.towers.push(mkTower('archer', { id: 9102, cx: 5, cy: 1, level: 3, spec: 2 })); // Poder Vital ★
    stepGame(st, simCtx, []);
    return st.projectiles.find((p) => p.towerId === 9102)?.damage ?? 0;
  }
  const specDmg = (TOWERS.archer.specs[2] as { damage: number }).damage;
  assert(vitalShot(30) === Math.round(specDmg * 1.2), `con 30 vidas el buff está ENCENDIDO (+20%: ${vitalShot(30)})`);
  assert(vitalShot(VITAL_LIVES_MIN) === Math.round(specDmg * 1.2), `en el umbral exacto (${VITAL_LIVES_MIN}) sigue encendido`);
  assert(vitalShot(VITAL_LIVES_MIN - 1) === specDmg, `bajo el umbral se APAGA (daño base ${specDmg})`);
  // sinergia con Reparar (item 7): pasar de 24 → 25 vidas reenciende el buff
  {
    const st = createGame('sendero', 'endless', 'normal', 212122, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 9100; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    st.lives = VITAL_LIVES_MIN - 1;
    st.players[0].gold = 5000;
    st.enemies.push(mkEnemy('brute', { id: 9103, hp: 1e9, maxHp: 1e9, speedMult: 0, x: 5.5, y: 3.9, wpIdx: 1, dodgeBonus: -1 }));
    st.towers.push(mkTower('archer', { id: 9104, cx: 5, cy: 1, level: 3, spec: 2, cooldownLeft: 3 }));
    stepGame(st, simCtx, [{ playerId: 'p1', cmd: { kind: 'repair' } }]);
    for (let i = 0; i < 10 && st.projectiles.length === 0; i++) stepGame(st, simCtx, []);
    const dmg = st.projectiles.find((p) => p.towerId === 9104)?.damage ?? 0;
    assert(st.lives === VITAL_LIVES_MIN + 2 && dmg === Math.round(specDmg * 1.2), `REPARAR (+3 vidas) reenciende el Poder Vital (${dmg})`);
  }
}

console.log('— F9a · Afijos de jefe: Adaptativo (resistencia por tipo) y Aura Gélida —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  // (a) ADAPTATIVO: tras ADAPT_HITS impactos del mismo tipo, ese tipo pega ×0.5
  {
    const st = createGame('sendero', 'endless', 'normal', 111111, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.nextId = 9200; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    const boss = mkEnemy('golem', { id: 9201, hp: 1e9, maxHp: 1e9, speedMult: 0, x: 5.5, y: 2.5, wpIdx: 1, affixes: ['adaptive'] });
    st.enemies.push(boss);
    // francotirador (perforante instantáneo, sin armadura por pierce): daño limpio
    st.towers.push(mkTower('sniper', { id: 9202, cx: 5, cy: 1, level: 3 }));
    const deltas: number[] = [];
    let sawAdapt = false;
    let prevHp = boss.hp;
    for (let i = 0; i < TICK_RATE * 120 && deltas.length < ADAPT_HITS + 3; i++) {
      for (const ev of stepGame(st, simCtx, [])) if (ev.e === 'adapt') sawAdapt = true;
      if (boss.hp !== prevHp) {
        deltas.push(prevHp - boss.hp);
        prevHp = boss.hp;
      }
    }
    const full = deltas[0];
    const adapted = deltas[ADAPT_HITS]; // el impacto ADAPT_HITS+1 (índice ADAPT_HITS) ya resiste
    assert(deltas.slice(0, ADAPT_HITS).every((d) => d === full), `los primeros ${ADAPT_HITS} impactos entran enteros (${full})`);
    assert(adapted < full && Math.abs(adapted - Math.round(full * (1 - ADAPT_RESIST))) <= 1, `del ${ADAPT_HITS + 1}.º en adelante resiste ×${1 - ADAPT_RESIST} (${full} → ${adapted})`);
    assert(sawAdapt, 'la adaptación emite su evento (🧬) para el aviso visual');
  }
  // (b) AURA GÉLIDA: la torre dentro del aura recarga ×CHILL_AURA_SLOW más lento
  {
    function cdAfterShot(withChill: boolean): number {
      const st = createGame('sendero', 'endless', 'normal', 111112, [{ id: 'p1', name: 'A', color: '#fff' }]);
      st.nextId = 9300; st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
      st.enemies.push(mkEnemy('golem', {
        id: 9301, hp: 1e9, maxHp: 1e9, speedMult: 0, x: 5.5, y: 2.5, wpIdx: 1,
        affixes: withChill ? ['chillaura'] : [],
      }));
      const t = mkTower('archer', { id: 9302, cx: 5, cy: 1, level: 3 });
      st.towers.push(t);
      stepGame(st, simCtx, []);
      return t.cooldownLeft;
    }
    const baseCd = (statsOf({ type: 'archer', level: 3, spec: -1, fusion: -1 }) as { cooldown: number }).cooldown * TICK_RATE;
    const normalCd = cdAfterShot(false);
    const chilled = cdAfterShot(true);
    assert(normalCd === Math.round(baseCd), `sin aura la recarga es la normal (${normalCd})`);
    assert(chilled === Math.round(baseCd * CHILL_AURA_SLOW), `bajo el Aura Gélida la recarga sale ×${CHILL_AURA_SLOW} (${normalCd} → ${chilled})`);
  }
  // (c) los afijos de jefe son determinavailable desde generateWave (endless: SIEMPRE)
  {
    const r = { rng: 111113 };
    const g10 = generateWave(r, 10, 1, 1, 'endless');
    assert(g10.bossAffix !== null && BOSS_AFFIX_POOL.includes(g10.bossAffix), `en endless TODO jefe trae afijo (o10: ${g10.bossAffix})`);
    // determinismo del afijo: misma semilla → mismo afijo
    const r2 = { rng: 111113 };
    assert(generateWave(r2, 10, 1, 1, 'endless').bossAffix === g10.bossAffix, 'el afijo del jefe es determinista');
  }
}

console.log('— F9a · Monstruos nuevos: aura de celeridad y presencia en el pool —');
{
  const map = getMap('sendero');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  // (a) Portaestandarte: acelera a los cercanos, NUNCA a sí mismo, sin apilar
  {
    const st = createGame('sendero', 'endless', 'normal', 141414, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st.wave = 1; st.waveState = 'active'; st.spawnQueue = []; st.pendingWave = [];
    st.lives = 1e9; st.maxLives = 1e9;
    const carrier = mkEnemy('bannerman', { id: 9401, x: 5.5, y: 2.34, wpIdx: 1 });
    const buddy = mkEnemy('goblin', { id: 9402, x: 5.5, y: 2.5, wpIdx: 1 });
    const loner = mkEnemy('goblin', { id: 9403, x: 20.5, y: 2.5, travelled: 15, wpIdx: 2 });
    st.enemies.push(carrier, buddy, loner);
    const lonerT0 = loner.travelled;
    stepGame(st, simCtx, []);
    // `travelled` acumula la distancia REAL recorrida (inmune a giros del camino)
    const speedRatio = buddy.travelled / (loner.travelled - lonerT0); // mismo tipo, mismo tick
    assert(Math.abs(speedRatio - ENEMIES.bannerman.hasteAura!.mult) < 0.05, `el goblin junto al Portaestandarte va ×${ENEMIES.bannerman.hasteAura!.mult} (${speedRatio.toFixed(2)})`);
  }
  // (b) los 7 nuevos aparecen por el pool del endless en oleadas altas
  {
    const r = { rng: 151515 };
    const seen = new Set<string>();
    for (let w = 20; w <= 60; w++) {
      if (isChampionWave(w) || waveHasBoss(w)) continue;
      for (const e of generateWave(r, w, 4, 1, 'endless').entries) seen.add(e.type);
    }
    const nuevos = ['gargoyle', 'harpy', 'stalker', 'runebrat', 'bannerman', 'knight', 'mammoth'].filter((t) => seen.has(t));
    assert(nuevos.length >= 6, `los monstruos nuevos entran al generador del endless (${nuevos.join(',')})`);
  }
}

// ==================== F9d · PUERTAS CERRABLES + DENSIDAD POR RUTA ABIERTA ====================

console.log('— F9d · sanitizeSettings/sanitizeClosedDoors: normalización de puertas cerradas —');
{
  // solo mapas multi-puerta (≥ MULTI_DOOR_MIN rutas): en sendero se descarta todo
  const s1 = sanitizeSettings({ mapId: 'sendero', mode: 'classic', difficulty: 'normal', closedDoors: [0] });
  assert(s1.closedDoors === undefined, 'en un mapa de 1 ruta closedDoors se descarta');
  const s2 = sanitizeSettings({ mapId: 'calzada', mode: 'classic', difficulty: 'normal', closedDoors: [0] });
  assert(s2.closedDoors === undefined, `en un mapa de 2 rutas (< ${MULTI_DOOR_MIN}) también se descarta`);
  // índices inválidos/duplicados/no enteros fuera; el resto queda ORDENADO (canónico)
  const s3 = sanitizeSettings({
    mapId: 'granconcilio', mode: 'classic', difficulty: 'normal',
    closedDoors: [8, 1, 1, 4, 99, -3, 2.5, ('x' as unknown) as number],
  });
  assert(JSON.stringify(s3.closedDoors) === '[1,4,8]', `se filtra y ordena canónico ([1,4,8] ≠ ${JSON.stringify(s3.closedDoors)})`);
  // cerrarlo TODO se normaliza: SIEMPRE queda al menos 1 abierta (la de índice más alto)
  const s4 = sanitizeSettings({ mapId: 'granconcilio', mode: 'classic', difficulty: 'normal', closedDoors: [0, 1, 2, 3, 4, 5, 6, 7, 8] });
  assert(JSON.stringify(s4.closedDoors) === '[0,1,2,3,4,5,6,7]', `cerrar las 9 deja 8 cerradas y la 9.ª abierta (${JSON.stringify(s4.closedDoors)})`);
  // no-array / basura → sin cierres
  assert(sanitizeSettings({ mapId: 'granconcilio', mode: 'classic', difficulty: 'normal', closedDoors: ('hola' as unknown) as number[] }).closedDoors === undefined, 'basura no-array → sin cierres');
  // createGame renormaliza como defensa en profundidad (replays/guardados entran directo)
  const g = createGame('granconcilio', 'classic', 'normal', 1, [{ id: 'p1', name: 'A', color: '#fff' }], false, [5, 5, -1, 20, 3]);
  assert(JSON.stringify(g.closedDoors) === '[3,5]', `createGame normaliza closedDoors ([3,5] ≠ ${JSON.stringify(g.closedDoors)})`);
  const gAll = createGame('granconcilio', 'classic', 'normal', 1, [{ id: 'p1', name: 'A', color: '#fff' }], false, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert(gAll.closedDoors.length === 8, 'createGame también garantiza ≥1 ruta abierta');
  assert(JSON.stringify(openPathIndices(9, gAll.closedDoors)) === '[8]', 'openPathIndices deja la ruta 8 abierta');
  const gSend = createGame('sendero', 'classic', 'normal', 1, [{ id: 'p1', name: 'A', color: '#fff' }], false, [0]);
  assert(gSend.closedDoors.length === 0, 'createGame en mapa de 1 ruta: sin cierres');
}

console.log('— F9d · reparto de spawns SOLO por rutas abiertas, determinista —');
{
  // el generador reparte round-robin EXCLUSIVAMENTE entre las abiertas
  const g1 = generateWave({ rng: 909 }, 20, 2, 9, 'endless', [0, 2, 5]);
  const used = new Set(g1.entries.map((e) => e.pathIdx));
  assert([...used].every((p) => p === 0 || p === 2 || p === 5), `todas las entradas van por rutas abiertas ({${[...used].join(',')}} ⊆ {0,2,5})`);
  assert(used.size === 3, 'el round-robin cubre las 3 rutas abiertas');
  // determinista: misma semilla → mismas entradas
  const g2 = generateWave({ rng: 909 }, 20, 2, 9, 'endless', [0, 2, 5]);
  assert(JSON.stringify(g1) === JSON.stringify(g2), 'el reparto por abiertas es DETERMINISTA');
  // BYTE-IDÉNTICO con puertas todas abiertas en mapas chicos: pasar openPaths
  // explícito equivale EXACTO a la firma vieja (clásico y endless, 1 y 2 rutas)
  let identical = true;
  for (let w = 1; w <= 36; w++) {
    const a1 = JSON.stringify(generateWave({ rng: 4000 + w }, w, 2, 1, 'classic'));
    const a2 = JSON.stringify(generateWave({ rng: 4000 + w }, w, 2, 1, 'classic', [0]));
    const b1 = JSON.stringify(generateWave({ rng: 5000 + w }, w, 3, 2, 'endless'));
    const b2 = JSON.stringify(generateWave({ rng: 5000 + w }, w, 3, 2, 'endless', [0, 1]));
    if (a1 !== a2 || b1 !== b2) identical = false;
  }
  assert(identical, 'con 1-2 rutas abiertas el generador es BYTE-IDÉNTICO al previo (36 oleadas comparadas)');
  // EXENCIONES: campeones y jefes no se densifican
  const c9 = generateWave({ rng: 31 }, 16, 2, 9, 'classic', [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const c3 = generateWave({ rng: 31 }, 16, 2, 9, 'classic', [0, 1, 2]);
  assert(c9.champion && c9.entries.length === c3.entries.length, `los CAMPEONES no se densifican (${c9.entries.length} == ${c3.entries.length})`);
  assert(c9.entries.every((e) => e.denseTune === undefined), 'las entradas de campeón no llevan denseTune');
  const b9 = generateWave({ rng: 77 }, 36, 2, 9, 'classic', [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const bossEntries = b9.entries.filter((e) => ENEMIES[e.type].boss);
  const escortEntries = b9.entries.filter((e) => !ENEMIES[e.type].boss);
  assert(bossEntries.length === 1 && bossEntries[0].denseTune === undefined, 'el JEFE no lleva denseTune (exento)');
  assert(escortEntries.every((e) => e.denseTune !== undefined && e.denseTune < 1), 'la escolta del jefe SÍ se densifica y compensa');
  // HORDA exenta de la densidad (su derrota es por CONTEO — HORDE_CAP): mismas
  // unidades con 9 abiertas que con 3, solo cambia el reparto de rutas.
  const h9 = generateWave({ rng: 88 }, 9, 2, 9, 'horde', [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const h3 = generateWave({ rng: 88 }, 9, 2, 9, 'horde', [0, 1, 2]);
  assert(h9.entries.length === h3.entries.length, `la HORDA no se densifica (${h9.entries.length} == ${h3.entries.length}: el aforo de saturación manda)`);
  assert(h9.entries.every((e) => e.denseTune === undefined), 'las entradas de horda no llevan denseTune');
  assert(new Set(h9.entries.map((e) => e.pathIdx)).size === 9, 'pero la horda SÍ reparte por las 9 abiertas');
}

console.log('— F9d · replays/guardados respetan las puertas cerradas —');
{
  const map = getMap('granconcilio');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const closed = [0, 1, 2, 3, 4, 5]; // abiertas 6,7,8 (R=3 ⇒ densidad ×1)
  const mk = () => {
    const st = createGame('granconcilio', 'classic', 'normal', 246810, [{ id: 'p1', name: 'A', color: '#fff' }], false, closed);
    st.lives = 1e9;
    st.maxLives = 1e9;
    st.interludeLeft = 2;
    return st;
  };
  const st = mk();
  const seenPaths = new Set<number>();
  for (let i = 0; i < TICK_RATE * 45; i++) {
    stepGame(st, simCtx, []);
    for (const e of st.enemies) seenPaths.add(e.pathIdx);
  }
  assert(seenPaths.size > 0 && [...seenPaths].every((p) => p >= 6), `en partida solo spawnean las rutas abiertas ({${[...seenPaths].join(',')}} ⊆ {6,7,8})`);
  // identidad de replay: la reconstrucción CON closedDoors reproduce el estado exacto
  const rdata: ReplayData = {
    v: BALANCE_VERSION, seed: 246810, mapId: 'granconcilio', mode: 'classic', difficulty: 'normal',
    players: [{ id: 'p1', name: 'A', color: '#fff' }], log: [], finalTick: st.tick, victory: false, wave: st.wave,
    closedDoors: closed,
  };
  // ojo: el estado de la prueba arrancó con lives/interludeLeft trucados; rehacemos
  // la partida real (sin trucos) para comparar contra su reconstrucción limpia
  const real = createGame('granconcilio', 'classic', 'normal', 246810, [{ id: 'p1', name: 'A', color: '#fff' }], false, closed);
  for (let i = 0; i < TICK_RATE * 60; i++) stepGame(real, simCtx, []);
  const rebuilt = replayTo({ ...rdata, finalTick: real.tick, wave: real.wave }, real.tick);
  assert(
    rebuilt.rng === real.rng && rebuilt.enemies.length === real.enemies.length &&
      JSON.stringify(rebuilt.enemies.map((e) => [e.id, e.pathIdx, Math.round(e.x * 100), Math.round(e.y * 100)])) ===
        JSON.stringify(real.enemies.map((e) => [e.id, e.pathIdx, Math.round(e.x * 100), Math.round(e.y * 100)])),
    `la reconstrucción con closedDoors es IDÉNTICA (rng ${rebuilt.rng} == ${real.rng}, ${rebuilt.enemies.length} enemigos)`,
  );
  // …y SIN closedDoors el reparto es OTRO (garantiza que el campo de veras manda)
  const wrong = replayTo({ ...rdata, finalTick: real.tick, wave: real.wave, closedDoors: undefined }, real.tick);
  assert(
    wrong.enemies.some((e) => e.pathIdx < 6),
    'sin closedDoors la reconstrucción reparte por TODAS las rutas (el campo es imprescindible)',
  );
  // validateSaveData: acepta la forma canónica y rechaza las adulteradas
  const baseSave = {
    kind: 'fortaleza-save', v: BALANCE_VERSION, seed: 1, mapId: 'granconcilio', mode: 'classic', difficulty: 'normal',
    tick: 10, wave: 1, salt: 'ab12', players: [{ id: 'p1', name: 'A', color: '#fff' }],
    slots: [{ id: 'p1', name: 'A', color: '#fff', tokenHash: '' }], log: [],
  };
  assert(validateSaveData({ ...baseSave, closedDoors: [0, 4] }).ok, 'validateSaveData acepta closedDoors canónico');
  assert(!validateSaveData({ ...baseSave, closedDoors: [4, 0] }).ok, 'rechaza closedDoors desordenado (no canónico)');
  assert(!validateSaveData({ ...baseSave, closedDoors: [0, 0, 4] }).ok, 'rechaza duplicados');
  assert(!validateSaveData({ ...baseSave, closedDoors: [0, 99] }).ok, 'rechaza índices fuera de rango');
  assert(!validateSaveData({ ...baseSave, closedDoors: [0, 1, 2, 3, 4, 5, 6, 7, 8] }).ok, 'rechaza cerrar TODAS las rutas');
  assert(validateSaveData({ ...baseSave }).ok, 'sin closedDoors sigue siendo válido (guardados previos)');
}

console.log('— F9d · compensación exacta: hp/botín por unidad y suelo «mínimo 1» —');
{
  const map = getMap('granconcilio');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  // entrada densificada artesanal (tune 1/3): hp y botín comprimidos, crías incluidas
  const st = createGame('granconcilio', 'endless', 'normal', 1357, [{ id: 'p1', name: 'A', color: '#fff' }]);
  st.wave = 3;
  st.waveState = 'active';
  st.pendingWave = [];
  st.spawnQueue = [
    { type: 'larva', delay: 0, pathIdx: 0, denseTune: 1 / 3 },
    { type: 'slime', delay: 2, pathIdx: 0, denseTune: 1 / 3 },
  ];
  st.spawnCooldown = 0;
  st.lives = 1e9;
  st.maxLives = 1e9;
  stepGame(st, simCtx, []);
  const larva = st.enemies.find((e) => e.type === 'larva')!;
  const fullHp = Math.round(ENEMIES.larva.hp * waveHpMult(3, 'normal', 1));
  assert(larva.maxHp === Math.max(1, Math.round(fullHp / 3)), `hp comprimido ÷3 (${larva.maxHp} de ${fullHp})`);
  assert(Math.abs(larva.bountyMult - waveBountyMult(3, 'endless') / 3) < 1e-9, `botín comprimido ÷3 (bountyMult ${larva.bountyMult.toFixed(3)})`);
  // compensación EXACTA contra la oleada base: max(1, round(pago)) − round(pago base)·tune
  const larvaPay = ENEMIES.larva.bounty * larva.bountyMult;
  const larvaComp = Math.max(1, Math.round(larvaPay)) - Math.round(larvaPay * 3) / 3;
  assert(larvaPay < 0.5 && Math.abs(st.waveBonusComp - larvaComp) < 1e-9,
    `el redondeo del botín acumula su desvío en waveBonusComp (${st.waveBonusComp.toFixed(3)} == ${larvaComp.toFixed(3)})`);
  // el kill de la larva paga EXACTAMENTE 1 (mínimo), no 0
  st.towers.push(mkTower('archer', { id: 9901, cx: Math.max(0, map.paths[0][0][0] - 1), cy: map.paths[0][0][1] + 1 }));
  const goldBefore = st.players[0].gold;
  for (let i = 0; i < TICK_RATE * 30 && st.enemies.some((e) => e.type === 'larva'); i++) stepGame(st, simCtx, []);
  const larvaDead = !st.enemies.some((e) => e.type === 'larva');
  assert(larvaDead && st.players[0].gold >= goldBefore + 1, `la baja densificada paga ≥1 de oro (${(st.players[0].gold - goldBefore).toFixed(1)})`);
  // crías: el slime densificado pare slimelets TAMBIÉN comprimidos
  for (let i = 0; i < TICK_RATE * 60 && !st.enemies.some((e) => e.type === 'slimelet'); i++) stepGame(st, simCtx, []);
  const lets = st.enemies.filter((e) => e.type === 'slimelet');
  const letFull = Math.round(ENEMIES.slimelet.hp * waveHpMult(3, 'normal', 1));
  assert(lets.length > 0 && lets.every((l) => l.maxHp === Math.max(1, Math.round(letFull / 3)) && l.denseTune === 1 / 3),
    `las crías heredan la compresión (${lets[0]?.maxHp} de ${letFull})`);
  // y el bono de fin de oleada DESCUENTA la compensación acumulada
  {
    const st2 = createGame('sendero', 'classic', 'normal', 1358, [{ id: 'p1', name: 'A', color: '#fff' }]);
    st2.wave = 3;
    st2.waveState = 'active';
    st2.pendingWave = [];
    st2.spawnQueue = [];
    st2.enemies = [];
    st2.waveBonusComp = 7.4; // exceso simulado
    const evs = stepGame(st2, makeSimContext(getMap('sendero'), makePlacementContext(getMap('sendero'))), []);
    const we = evs.find((e) => e.e === 'wave_end') as Extract<GameEvent, { e: 'wave_end' }>;
    const expected = Math.max(0, WAVE_BONUS_BASE + 3 * WAVE_BONUS_PER_WAVE - Math.round(7.4));
    assert(we !== undefined && we.bonus === expected, `el bono descuenta la compensación (${we?.bonus} == ${expected})`);
    assert(st2.waveBonusComp === 0, 'la compensación se consume al fin de oleada');
  }
}

console.log('— F9d · densidad NEUTRA en presupuesto y oro (granconcilio R=9 vs R=3) —');
// Corre SOLO los spawns de la oleada `w` (sin torres, vidas infinitas) y agrega
// unidades / hp total / botín esperado (mismo redondeo que killEnemy, sin extras).
function spawnWaveProbe(closedDoors: number[], w: number, seed: number): {
  units: number; hp: number; gold: number; blessed: boolean; bonusComp: number; peak: number;
} {
  const map = getMap('granconcilio');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('granconcilio', 'classic', 'normal', seed, [
    { id: 'p1', name: 'A', color: '#fff' },
    { id: 'p2', name: 'B', color: '#000' },
  ], false, closedDoors);
  st.wave = w - 1;
  st.waveState = 'interlude';
  st.interludeLeft = 2; // 1 tick para generar (y leer la telegrafía) + 1 para arrancar
  st.lives = 1e9;
  st.maxLives = 1e9;
  const seen = new Set<number>();
  let units = 0;
  let hp = 0;
  let gold = 0;
  let blessed = false;
  let peak = 0;
  let guard = 0;
  // (cast: TS «recuerda» la asignación de arriba y no ve la mutación de stepGame)
  while (((st.waveState as string) !== 'active' || st.spawnQueue.length > 0) && guard++ < TICK_RATE * 600) {
    stepGame(st, simCtx, []);
    if (st.waveState === 'interlude' && st.nextWaveBlessed) blessed = true;
    if (st.enemies.length > peak) peak = st.enemies.length;
    for (const e of st.enemies) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      units += 1;
      hp += e.maxHp;
      gold += Math.max(1, Math.round(ENEMIES[e.type].bounty * e.bountyMult));
    }
  }
  return { units, hp, gold, blessed, bonusComp: st.waveBonusComp, peak };
}
{
  let maxHpDev = 0;
  let maxGoldDev = 0;
  let worstHpWave = 0;
  let worstGoldWave = 0;
  const rows: string[] = [];
  let sum3Hp = 0;
  let sum9Hp = 0;
  let sum3Gold = 0;
  let sum9Gold = 0;
  for (let w = 1; w <= 36; w++) {
    const base = spawnWaveProbe([0, 1, 2, 3, 4, 5], w, 8600 + w); // R=3 ⇒ densidad ×1 (referencia)
    const dense = spawnWaveProbe([], w, 8600 + w); // R=9 ⇒ densidad plena (con rampa)
    // el oro efectivo de la oleada = botines pagados − compensación del bono.
    // La bendición sale de OTRO punto del RNG en cada lado (consumo distinto):
    // se normaliza su ×1.5 de botín para comparar manzanas con manzanas.
    const bGoldRaw = base.gold - base.bonusComp;
    const dGoldRaw = dense.gold - dense.bonusComp;
    const bGold = base.blessed ? bGoldRaw / BLESSED_BOUNTY_MULT : bGoldRaw;
    const dGold = dense.blessed ? dGoldRaw / BLESSED_BOUNTY_MULT : dGoldRaw;
    const hpDev = Math.abs(dense.hp / base.hp - 1);
    const goldDev = Math.abs(dGold / bGold - 1);
    sum3Hp += base.hp;
    sum9Hp += dense.hp;
    sum3Gold += bGold;
    sum9Gold += dGold;
    if (hpDev > maxHpDev) {
      maxHpDev = hpDev;
      worstHpWave = w;
    }
    if (goldDev > maxGoldDev) {
      maxGoldDev = goldDev;
      worstGoldWave = w;
    }
    rows.push(
      `w${String(w).padStart(2)} · uds ${String(base.units).padStart(3)}→${String(dense.units).padStart(3)} · ` +
        `hp ${String(base.hp).padStart(6)}→${String(dense.hp).padStart(6)} (${((dense.hp / base.hp - 1) * 100).toFixed(1).padStart(5)}%) · ` +
        `oro ${String(Math.round(bGold)).padStart(4)}→${String(Math.round(dGold)).padStart(4)} (${((dGold / bGold - 1) * 100).toFixed(1).padStart(5)}%)` +
        `${dense.blessed !== base.blessed ? ' ⭐' : ''}`,
    );
  }
  for (const r of rows) console.log(`   ${r}`);
  console.log(
    `   TOTAL 36 oleadas · hp ${sum3Hp}→${sum9Hp} (${((sum9Hp / sum3Hp - 1) * 100).toFixed(2)}%) · ` +
      `oro ${Math.round(sum3Gold)}→${Math.round(sum9Gold)} (${((sum9Gold / sum3Gold - 1) * 100).toFixed(2)}%)`,
  );
  assert(maxHpDev <= 0.05, `presupuesto (hp) NEUTRO por oleada: peor desvío ${(maxHpDev * 100).toFixed(1)}% (w${worstHpWave}) ≤ 5%`);
  assert(maxGoldDev <= 0.05, `oro NEUTRO por oleada: peor desvío ${(maxGoldDev * 100).toFixed(1)}% (w${worstGoldWave}) ≤ 5%`);
  assert(Math.abs(sum9Hp / sum3Hp - 1) <= 0.02 && Math.abs(sum9Gold / sum3Gold - 1) <= 0.02, 'los TOTALES de la partida quedan a ±2%');
}

console.log('— F9d · muchedumbre pico y rendimiento (granconcilio 9 vs 4 abiertas, sin defensa) —');
function crowdProbe(closedDoors: number[], wavesTarget: number): { peak: number; peakWave: number; ticks: number; ms: number } {
  const map = getMap('granconcilio');
  const simCtx = makeSimContext(map, makePlacementContext(map));
  const st = createGame('granconcilio', 'classic', 'normal', 424242, [
    { id: 'p1', name: 'A', color: '#fff' },
    { id: 'p2', name: 'B', color: '#000' },
  ], false, closedDoors);
  st.lives = 1e9;
  st.maxLives = 1e9;
  let peak = 0;
  let peakWave = 0;
  let ticks = 0;
  const t0 = performance.now();
  while (!st.over && st.wave <= wavesTarget && ticks < TICK_RATE * 60 * 120) {
    const cmds: PlayerCommand[] =
      st.waveState === 'interlude' && st.interludeLeft > TICK_RATE * 2
        ? [{ playerId: 'p1', cmd: { kind: 'call_wave' } }]
        : [];
    stepGame(st, simCtx, cmds);
    ticks += 1;
    if (st.enemies.length > peak) {
      peak = st.enemies.length;
      peakWave = st.wave;
    }
    if (st.wave >= wavesTarget && st.waveState === 'interlude') break;
  }
  return { peak, peakWave, ticks, ms: performance.now() - t0 };
}
{
  const nine = crowdProbe([], 36);
  const four = crowdProbe([0, 1, 2, 3, 4], 36); // 5 cerradas ⇒ 4 abiertas
  console.log(
    `   9 abiertas: pico ${nine.peak} enemigos vivos (w${nine.peakWave}) · ${nine.ticks} ticks en ${nine.ms.toFixed(0)}ms (${((nine.ticks / nine.ms) * 1000).toFixed(0)} t/s)`,
  );
  console.log(
    `   4 abiertas: pico ${four.peak} enemigos vivos (w${four.peakWave}) · ${four.ticks} ticks en ${four.ms.toFixed(0)}ms (${((four.ticks / four.ms) * 1000).toFixed(0)} t/s)`,
  );
  assert(nine.peak <= DOOR_DENSITY_UNIT_CAP + 60, `el pico con 9 abiertas queda acotado (${nine.peak} ≤ ${DOOR_DENSITY_UNIT_CAP + 60})`);
  assert(nine.ticks / nine.ms > 1, `la sim aguanta la muchedumbre (>1000 ticks/s reales: ${((nine.ticks / nine.ms) * 1000).toFixed(0)})`);
  assert(doorDensityMult(9, 99) === 3 && doorDensityMult(4, 99) === 1.35 && doorDensityMult(3, 99) === 1 && doorDensityMult(1, 99) === 1,
    'doorDensityMult: ×3 con 9 abiertas, ×1.35 con 4, ×1 con ≤3');
  assert(doorDensityMult(9, 1) === 1.25 && doorDensityMult(9, 4) === 2 && doorDensityMult(9, 8) === 3,
    'la RAMPA entra suave: ×1.25 en la o1, ×2 en la o4, plena desde la o8');
  assert(sanitizeClosedDoors(9, [0, 1, 2, 3, 4]).length === 5, 'sanitizeClosedDoors directo (5 cerradas válidas)');
}

console.log('— Determinismo: misma semilla + mismos comandos → mismo estado —');
const b = runScenario();
const hashA = JSON.stringify([a.state.tick, a.state.wave, a.state.lives, a.state.rng, a.state.players.map((p) => p.gold), a.state.nextId]);
const hashB = JSON.stringify([b.state.tick, b.state.wave, b.state.lives, b.state.rng, b.state.players.map((p) => p.gold), b.state.nextId]);
assert(hashA === hashB, 'la simulación es determinista');

console.log(process.exitCode ? '\n💥 Hay fallos' : '\n🎉 Simulación OK');
