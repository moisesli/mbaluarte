// Prueba de la simulación: dos jugadores bot construyen torres y el juego
// avanza miles de ticks. Verifica oleadas, economía, muertes y determinismo.
import {
  createGame,
  ENEMIES,
  generateWave,
  getMap,
  makePlacementContext,
  makeSimContext,
  pathCells,
  pathLength,
  placementError,
  replayTo,
  stepGame,
  towerLevel,
  BALANCE_VERSION,
  HORDE_CAP,
  MAPS,
  TICK_RATE,
  TOWERS,
  TOWER_ORDER,
  type EnemyState,
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
const MAX_TICKS = TICK_RATE * 60 * 12; // 12 minutos de juego

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

function botCommands(state: GameState, candidates: [number, number][], counters: Map<string, number>): PlayerCommand[] {
  const cmds: PlayerCommand[] = [];
  if (state.waveState !== 'interlude') return cmds;

  // celdas ya ocupadas + las que se reclaman dentro de este mismo tick
  const used = new Set(state.towers.map((t) => `${t.cx},${t.cy}`));
  for (const player of state.players) {
    let budget = player.gold; // oro disponible tras las órdenes de este tick
    // copias locales de las torres del jugador: se mutan para simular el efecto
    // de las órdenes de ESTE tick sin tocar el estado real de la simulación
    const mine = state.towers
      .filter((t) => t.owner === player.id)
      .map((t) => ({ id: t.id, type: t.type, level: t.level, spec: t.spec }));

    // hasta 3 acciones por interludio: prioriza progresar torres hacia la especialización
    for (let act = 0; act < 3; act++) {
      // 1) especializar una torre al máximo aún sin rama (alterna A/B por id)
      const maxed = mine.find((t) => t.level >= 3 && t.spec < 0);
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

      // 2) con una base de torres, subir la más avanzada (<3) hacia el máximo
      const upgradable = mine.filter((t) => t.level < 3).sort((x, y) => y.level - x.level)[0];
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
assert(
  a.state.players.every((p) => p.stats.goldEarned > 100),
  'todos los jugadores ganaron oro',
);
assert(
  a.state.over !== null || a.state.tick === MAX_TICKS,
  `la partida termina o sigue estable (over=${JSON.stringify(a.state.over)})`,
);
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
  };
  st.enemies.push(slime);
  const cannon: TowerState = {
    id: 2000, type: 'cannon', cx: 5, cy: 1, level: 3, spec: -1, owner: 'p1',
    cooldownLeft: 0, targetMode: 'first', invested: 440, kills: 0, damage: 0,
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
    };
    st.enemies.push(enemy);
    const archer: TowerState = {
      id: 2000, type: 'archer', cx: 5, cy: 1, level: 1, spec: -1, owner: 'p1',
      cooldownLeft: 0, targetMode: 'first', invested: 50, kills: 0, damage: 0,
    };
    st.towers.push(archer);
    for (let i = 0; i < banners; i++) {
      st.towers.push({
        id: 3000 + i, type: 'banner', cx: 6 + i, cy: 1, level: 1, spec: -1, owner: 'p1',
        cooldownLeft: 0, targetMode: 'first', invested: 90, kills: 0, damage: 0,
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

console.log('— Determinismo: misma semilla + mismos comandos → mismo estado —');
const b = runScenario();
const hashA = JSON.stringify([a.state.tick, a.state.wave, a.state.lives, a.state.rng, a.state.players.map((p) => p.gold), a.state.nextId]);
const hashB = JSON.stringify([b.state.tick, b.state.wave, b.state.lives, b.state.rng, b.state.players.map((p) => p.gold), b.state.nextId]);
assert(hashA === hashB, 'la simulación es determinista');

console.log(process.exitCode ? '\n💥 Hay fallos' : '\n🎉 Simulación OK');
