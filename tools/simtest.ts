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
  START_LIVES,
  TICK_RATE,
  TOWERS,
  TOWER_ORDER,
  type EnemyState,
  type EnemyTypeId,
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

// Fábricas para pruebas dirigidas (construir estado a mano sin repetir 25 campos).
function mkEnemy(type: EnemyTypeId, over: Partial<EnemyState> = {}): EnemyState {
  const def = ENEMIES[type];
  return {
    id: 1000, type, x: 5.5, y: 2.5, hp: def.hp, maxHp: def.hp,
    pathIdx: 0, wpIdx: 1, travelled: 0, slowFactor: 1, slowUntil: 0, poisonDps: 0, poisonUntil: 0,
    poisonSrc: 0, bountyMult: 1, elite: false, affixes: [], speedMult: 1, armorBonus: 0, regenBonus: 0,
    dodgeBonus: 0, slowResist: 0, radiusMult: 1, auraRadius: 0, auraHps: 0, deathSpawn: 0, laps: 0,
    spellImmune: def.spellImmune ?? false, stunTowerId: 0, lastWpIdx: 1,
    ...over,
  };
}
function mkTower(type: TowerTypeId, over: Partial<TowerState> = {}): TowerState {
  return {
    id: 2000, type, cx: 5, cy: 1, level: 3, spec: -1, owner: 'p1',
    cooldownLeft: 0, targetMode: 'first', invested: 100, kills: 0, damage: 0, stunnedUntil: 0,
    ...over,
  };
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
// F4.1: a pesar de las oleadas inmunes/jefes nuevos, los bots (que construyen físico
// de reserva: arquero/cañón/francotirador/mortero) SIGUEN GANANDO el clásico en normal.
assert(
  a.state.over?.victory === true,
  `los bots GANAN el clásico en normal (oleada ${a.maxWave}, ${a.state.lives} vidas, over=${JSON.stringify(a.state.over)})`,
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
    spellImmune: false, stunTowerId: 0, lastWpIdx: 1,
  };
  st.enemies.push(slime);
  const cannon: TowerState = {
    id: 2000, type: 'cannon', cx: 5, cy: 1, level: 3, spec: -1, owner: 'p1',
    cooldownLeft: 0, targetMode: 'first', invested: 440, kills: 0, damage: 0, stunnedUntil: 0,
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
      spellImmune: false, stunTowerId: 0, lastWpIdx: 1,
    };
    st.enemies.push(enemy);
    const archer: TowerState = {
      id: 2000, type: 'archer', cx: 5, cy: 1, level: 1, spec: -1, owner: 'p1',
      cooldownLeft: 0, targetMode: 'first', invested: 50, kills: 0, damage: 0, stunnedUntil: 0,
    };
    st.towers.push(archer);
    for (let i = 0; i < banners; i++) {
      st.towers.push({
        id: 3000 + i, type: 'banner', cx: 6 + i, cy: 1, level: 1, spec: -1, owner: 'p1',
        cooldownLeft: 0, targetMode: 'first', invested: 90, kills: 0, damage: 0, stunnedUntil: 0,
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

console.log('— Determinismo: misma semilla + mismos comandos → mismo estado —');
const b = runScenario();
const hashA = JSON.stringify([a.state.tick, a.state.wave, a.state.lives, a.state.rng, a.state.players.map((p) => p.gold), a.state.nextId]);
const hashB = JSON.stringify([b.state.tick, b.state.wave, b.state.lives, b.state.rng, b.state.players.map((p) => p.gold), b.state.nextId]);
assert(hashA === hashB, 'la simulación es determinista');

console.log(process.exitCode ? '\n💥 Hay fallos' : '\n🎉 Simulación OK');
