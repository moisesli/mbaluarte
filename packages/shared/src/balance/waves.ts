import type { AffixId, Difficulty, EnemyTypeId, GameMode, SpawnEntry, WaveComp } from '../types.js';
import { ENEMIES } from './enemies.js';
import { BOSS_AFFIX_POOL, ELITE_AFFIX_POOL } from './affixes.js';
import { classicWave, type CalendarWave } from './calendar.js';
import {
  BLESSED_FROM,
  BLESSED_ODDS,
  BOSS_AFFIX_FROM_CLASSIC,
  CHAMPION_EVERY,
  CHAMPION_FROM,
  CLASSIC_BOUNTY_COMP,
  CLASSIC_WAVES,
  DIFF_HP_MULT,
  DOOR_DENSITY_UNIT_CAP,
  doorDensityMult,
  ELITE_MIN_WAVE,
  ELITE_TWO_AFFIX_WAVE,
  ENDLESS_BOUNTY_CAP,
  ENDLESS_BOUNTY_FROM,
  ENDLESS_BOUNTY_STEP,
  HP_PER_EXTRA_PLAYER,
  IMMUNE_EVERY,
  IMMUNE_FROM,
  INVISIBLE_EVERY,
  INVISIBLE_FROM,
  TICK_RATE,
} from '../constants.js';
import { rand, pick } from '../rng.js';

// Multiplicador de HP según oleada, dificultad y cantidad de jugadores.
// F5.1 · curva del INFINITO en dos tramos: ×1.13 compuesto hasta la oleada 40 y
// ×1.10 de ahí en adelante. El clásico (36 oleadas) queda EXACTAMENTE igual que
// antes; solo se dobla la rodilla del endless/horda profundos, donde el 1.13
// perpetuo convertía toda oleada >45 en un muro binario imposible de pagar.
export function waveHpMult(wave: number, difficulty: Difficulty, playerCount: number): number {
  const base = 1 + 0.11 * (wave - 1);
  const late =
    wave > 20
      ? Math.pow(1.13, Math.min(wave - 20, 20)) * Math.pow(1.1, Math.max(0, wave - 40))
      : 1;
  const players = 1 + HP_PER_EXTRA_PLAYER * (playerCount - 1);
  return base * late * DIFF_HP_MULT[difficulty] * players;
}

// F5.1 · botín superlineal SOLO en endless: desde la oleada 30 el botín gana un
// término ×1.02 compuesto por oleada (tope ×3 extra) que acompaña la curva
// geométrica de hp — sin él, el endless profundo muere por pobreza, no por reto.
// `mode` es OPCIONAL para no romper la firma pública (sin mode = clásico/horda).
export function waveBountyMult(wave: number, mode?: GameMode): number {
  const base = 1 + 0.03 * (wave - 1);
  const endless =
    mode === 'endless' && wave > ENDLESS_BOUNTY_FROM
      ? Math.min(ENDLESS_BOUNTY_CAP, Math.pow(ENDLESS_BOUNTY_STEP, wave - ENDLESS_BOUNTY_FROM))
      : 1;
  // F9a (v19) · el calendario clásico monoespecie trae menos cuerpos: cada baja
  // paga ×1.3 para que la economía total por oleada quede a la par del generador.
  const classic = mode === 'classic' ? CLASSIC_BOUNTY_COMP : 1;
  return base * endless * classic;
}

// ¿La oleada `wave` es de inmunidad mágica? Múltiplos de 5 desde la 10 (10,15,20,25…)
// PERO se exime la oleada de la Quimera (jefe VOLADOR en 15/25/35): inmune + volador +
// jefe a la vez solo dejaría el arquero/francotirador físicos anti-aire, un triple
// castigo casi imposible. Las oleadas del golem (terrestre) sí son inmunes.
// F5.1 · también se exime la del BEHEMOT (endless: 40/60/80…): la revisión
// adversarial mostró que en la o40 se apilaban TRES castigos a la vez — primer
// Behemot + escolta inmune + último paso ×1.13 de la rodilla de la curva — y 5/6
// muertes no atascadas del endless caían exactamente ahí. Desfasar la inmunidad
// reparte el muro sin ablandar la curva.
export function isImmuneWave(wave: number): boolean {
  if (wave < IMMUNE_FROM || (wave - IMMUNE_FROM) % IMMUNE_EVERY !== 0) return false;
  const isChimeraWave = wave >= 15 && wave % 10 === 5;
  const isBehemothWave = wave >= 30 && wave % 20 === 0;
  return !isChimeraWave && !isBehemothWave;
}

// ¿La oleada `wave` es INVISIBLE? (Lote 3) Cada INVISIBLE_EVERY oleadas desde
// INVISIBLE_FROM (12, 18, 24, 30, 36…), PERO se exime cuando coincide con una
// oleada INMUNE o de JEFE — como la bendecida evita combinarse — para no apilar
// castigos (un invisible + inmune, o invisible + jefe, sería desproporcionado).
// Determinista por número de oleada: NO consume RNG.
// F9a (v19) · con el jefe-muro del clásico en la 36 (waveHasBoss con `mode`), en
// el clásico caen exactamente 3 invisibles: 12, 18 y 24 (la 30 es inmune y la 36
// jefe). Sin `mode` se asume endless (comportamiento previo intacto).
export function isInvisibleWave(wave: number, mode: GameMode = 'endless'): boolean {
  if (wave < INVISIBLE_FROM || (wave - INVISIBLE_FROM) % INVISIBLE_EVERY !== 0) return false;
  return !isImmuneWave(wave) && !waveHasBoss(wave, mode);
}

// F9a (v19) · ¿La oleada trae CAMPEONES 👑? En clásico manda el calendario fijo
// (13/22/31); en infinito/horda entran en rotación cada 10 desde la 13 (13, 23,
// 33…) — cadencia elegida para no chocar jamás con inmunes (múltiplos de 5),
// jefes (10s/15s) ni invisibles (12+6k). Determinista, sin RNG.
export function isChampionWave(wave: number, mode: GameMode = 'endless'): boolean {
  if (mode === 'classic') return classicWave(wave)?.champion === true;
  return wave >= CHAMPION_FROM && (wave - CHAMPION_FROM) % CHAMPION_EVERY === 0;
}

// Presupuesto de la oleada: cuánto "vale" en enemigos.
function waveBudget(wave: number, playerCount: number): number {
  const players = 1 + 0.3 * (playerCount - 1);
  return Math.round((18 + wave * 9 + Math.pow(wave, 1.6)) * players);
}

interface RngState {
  rng: number;
}

// Tipos disponibles según la oleada (sin jefes ni spawns derivados).
function pool(wave: number): EnemyTypeId[] {
  const all: EnemyTypeId[] = [
    'goblin',
    'runner',
    'larva',
    'bat',
    'brute',
    'armored',
    'slime',
    'shaman',
    'ghost',
    'troll',
    // F4.1
    'thief',
    'sapper',
    'berserker',
    'wraith',
    'skywhale',
    // F9a (v19) · los monstruos nuevos entran también al generador del infinito
    'stalker',
    'runebrat',
    'bannerman',
    'harpy',
    'gargoyle',
    'knight',
    'mammoth',
  ];
  return all.filter((t) => ENEMIES[t].minWave <= wave);
}

// F9a (v19) · especies elegibles como CAMPEÓN en infinito/horda: terrestres, sin
// soporte (curar/acelerar ×5 de vida sería un puzle injusto), sin zapadores (un
// campeón-zapador aturdiría una torre media partida) y sin el Mamut (ya es
// semi-campeón de base; ×9 encima lo sacaría del molde "Mega" de ETD2 §4.2).
const CHAMPION_SPECIES: EnemyTypeId[] = ['brute', 'armored', 'troll', 'berserker', 'knight'];

export interface GeneratedWave {
  entries: SpawnEntry[];
  comp: WaveComp[];
  hasBoss: boolean;
  bossType: EnemyTypeId | null; // jefe de la oleada (para el anuncio) o null
  immune: boolean; // toda la oleada es inmune a magia
  blessed: boolean; // oleada bendecida (afijo común + doble botín)
  blessedAffix: AffixId | null; // el afijo común, si es bendecida
  flying: boolean; // la oleada está dominada por lo aéreo / jefe volador (telegrafía 🦅)
  invisible: boolean; // Lote 3 · oleada INVISIBLE: los enemigos no-jefe nacen invisibles (telegrafía 👁)
  // F9a (v19)
  champion: boolean; // oleada de CAMPEONES 👑 (telegrafía)
  bossAffix: AffixId | null; // afijo del jefe ("☠ Gólem Gélido"), si lo trae
}

// Elige el jefe de una oleada con jefe. En el CLÁSICO: golem en múltiplos de 10,
// pero la Quimera (voladora) toma las oleadas 15/25/35 para forzar anti-aire, y
// el JEFE-MURO (Behemot) cierra la 36 (F9a). En endless/horde el Behemot aparece
// en oleadas muy altas (30+) como jefe pesado.
function pickBoss(wave: number, mode: GameMode): EnemyTypeId {
  if (mode === 'classic') {
    const cal = classicWave(wave);
    if (cal?.boss) return cal.boss;
  }
  // Quimera voladora a mitad de partida: 15, 25, 35… (múltiplos de 5 impares en la
  // decena) — obliga a tener anti-aire justo cuando el jugador se acomodó en tierra.
  if (wave >= 15 && wave % 10 === 5) return 'chimera';
  // Behemot terrestre demoledor en oleadas muy altas (endless/horde).
  if (wave >= 30 && wave % 20 === 0) return 'behemoth';
  return 'golem';
}

// ¿La oleada `wave` trae jefe? Golem/Behemot cada 10; Quimera en 15/25/35.
// F9a (v19) · en CLÁSICO, además, la 36 es el JEFE-MURO (Behemot). Sin `mode` se
// asume endless (compatibilidad con los llamadores previos).
export function waveHasBoss(wave: number, mode: GameMode = 'endless'): boolean {
  if (mode === 'classic' && wave === CLASSIC_WAVES) return true;
  return wave > 0 && (wave % 10 === 0 || (wave >= 15 && wave % 10 === 5));
}

// Reparte élites sobre la lista `normal` (índices → afijos). Compartido por el
// generador y el calendario clásico. Determinista: solo rand(state).
// `maxElites` (F9a): el calendario monoespecie CAPA los élites en proporción al
// tamaño de la oleada — en una oleada de 4 tanques, un élite ×2.6 ya es un
// mini-jefe; con la fórmula del generador (pensada para 15-20 unidades baratas)
// salían oleadas-muro. Sin límite = comportamiento del generador de siempre.
// `countMult` (F9d): en oleadas DENSIFICADAS los élites escalan ×densidad — su hp
// va comprimido ×denseTune como el del resto, así count×mult · hp÷mult mantiene
// el presupuesto élite ≈ igual al de la oleada base (neutralidad). Con 1 (todos
// los mapas de 1-3 rutas) la fórmula es EXACTAMENTE la de siempre.
function rollElites(
  state: RngState,
  wave: number,
  normal: EnemyTypeId[],
  maxElites = Infinity,
  countMult = 1,
): Map<number, AffixId[]> {
  const eliteAffixes = new Map<number, AffixId[]>();
  if (wave >= ELITE_MIN_WAVE && normal.length > 0) {
    const count = Math.min(
      normal.length,
      Math.round((1 + Math.floor((wave - ELITE_MIN_WAVE) / 3)) * countMult),
      maxElites,
    );
    const numAffixes = wave >= ELITE_TWO_AFFIX_WAVE ? 2 : 1;
    const chosen = new Set<number>();
    for (let n = 0; n < count; n++) {
      // buscar un índice libre (los enjambres de larvas no valen la pena)
      let idx = -1;
      for (let tries = 0; tries < 8; tries++) {
        const cand = Math.floor(rand(state) * normal.length);
        if (!chosen.has(cand) && normal[cand] !== 'larva') {
          idx = cand;
          break;
        }
      }
      if (idx < 0) break;
      chosen.add(idx);
      const affixes: AffixId[] = [];
      // F9a · los élites tiran de ELITE_AFFIX_POOL (sin los afijos de jefe)
      const affixPool = [...ELITE_AFFIX_POOL];
      for (let a = 0; a < numAffixes && affixPool.length > 0; a++) {
        const pickIdx = Math.floor(rand(state) * affixPool.length);
        affixes.push(affixPool.splice(pickIdx, 1)[0]);
      }
      eliteAffixes.set(idx, affixes);
    }
  }
  return eliteAffixes;
}

// Ensambla las SpawnEntry finales a partir de la lista ordenada + flags de oleada.
// Compartido por el generador y el calendario. Consume RNG solo para el jitter de
// espaciado (determinista). `paths` (F9d): índices de ruta ABIERTOS por los que se
// reparte la oleada en round-robin — con todas abiertas, paths[i % paths.length]
// es EXACTAMENTE el `i % pathCount` de siempre (ni un tick cambia).
function buildEntries(
  state: RngState,
  wave: number,
  ordered: EnemyTypeId[],
  paths: number[],
  opts: {
    eliteAffixes: Map<number, AffixId[]>;
    immune: boolean;
    blessed: boolean;
    blessedAffix: AffixId | null;
    invisible: boolean;
    champion: boolean;
    championHp?: number;
    bossAffix: AffixId | null;
    hpTune?: number;
    gapOverride?: number; // F9a · espaciado fijo del calendario (sanadores/portaestandartes)
    // F9d · oleada densificada: compensación por unidad (hp y botín ÷) y divisor
    // del espaciado (÷mult: la oleada con ×mult unidades dura LO MISMO que la base
    // — sin él, una partida en granconcilio tardaba el triple). Nunca en jefes.
    denseTune?: number;
    gapDiv?: number;
  },
): SpawnEntry[] {
  // Espaciado entre spawns: más denso en oleadas altas. Los campeones marchan
  // espaciados (1.2 s): son pocos y gordos — que se lean uno a uno.
  const baseGap = Math.max(0.28, 0.85 - wave * 0.018);
  const gapDiv = opts.gapDiv ?? 1;
  return ordered.map((type, i) => {
    const isBoss = ENEMIES[type].boss ?? false;
    const gap = isBoss
      ? 1.5
      : opts.champion
        ? 1.2
        : ((opts.gapOverride ?? baseGap) / gapDiv) * (0.75 + rand(state) * 0.5);
    const affixes = opts.eliteAffixes.get(i);
    return {
      type,
      delay: Math.max(2, Math.round(gap * TICK_RATE)),
      pathIdx: paths.length > 1 ? paths[i % paths.length] : (paths[0] ?? 0),
      ...(affixes ? { elite: true, affixes } : {}),
      ...(opts.immune ? { immune: true } : {}),
      ...(opts.blessed && opts.blessedAffix ? { blessed: true, blessedAffix: opts.blessedAffix } : {}),
      // invisible se aplica solo a los no-jefe (spawnEnemy/stepWaves lo respeta)
      ...(opts.invisible && !isBoss ? { invisible: true } : {}),
      // F9a · campeones: toda la oleada (no hay escolta que marcar)
      ...(opts.champion ? { champion: true } : {}),
      ...(opts.champion && opts.championHp !== undefined ? { championHp: opts.championHp } : {}),
      // F9a · el afijo de jefe viaja SOLO en la entrada del jefe
      ...(isBoss && opts.bossAffix ? { bossAffix: opts.bossAffix } : {}),
      // F9a · afinado del calendario clásico (toda la oleada)
      ...(opts.hpTune !== undefined && opts.hpTune !== 1 ? { hpTune: opts.hpTune } : {}),
      // F9d · compensación de densidad: NUNCA en el jefe (exento por diseño)
      ...(opts.denseTune !== undefined && opts.denseTune !== 1 && !isBoss ? { denseTune: opts.denseTune } : {}),
    };
  });
}

// Resumen para la vista previa + etiqueta aérea.
function summarize(ordered: EnemyTypeId[], bossType: EnemyTypeId | null): { comp: WaveComp[]; flying: boolean } {
  const counts = new Map<EnemyTypeId, number>();
  for (const t of ordered) counts.set(t, (counts.get(t) ?? 0) + 1);
  const comp: WaveComp[] = [...counts.entries()].map(([type, count]) => ({ type, count }));
  comp.sort((a, b) => ENEMIES[b.type].cost - ENEMIES[a.type].cost);
  const flyers = ordered.filter((t) => ENEMIES[t].flying).length;
  const flying =
    (bossType !== null && ENEMIES[bossType].flying) || (ordered.length > 0 && flyers >= ordered.length / 2);
  return { comp, flying };
}

// F9a (v19) · afijo del JEFE de la oleada: desde la 20 en clásico, SIEMPRE en
// infinito/horda. Sale del RNG de la sim (determinista, replay-safe).
function rollBossAffix(state: RngState, wave: number, hasBoss: boolean, mode: GameMode): AffixId | null {
  if (!hasBoss) return null;
  if (mode === 'classic' && wave < BOSS_AFFIX_FROM_CLASSIC) return null;
  return pick(state, BOSS_AFFIX_POOL);
}

// F9a (v19) · oleada del CALENDARIO CLÁSICO: una especie temática, cantidad fija
// escalada por jugadores, con jefe/campeones/afinado según la tabla. Los élites y
// la bendición siguen operando encima (son variantes de la MISMA especie, así que
// el tema monoespecie se conserva). `openPaths` (F9d): rutas abiertas — la
// cantidad escala ×doorDensityMult(R) con hp/botín comprimidos (neutro), los
// CAMPEONES y el JEFE quedan exentos.
function generateCalendarWave(
  state: RngState,
  cal: CalendarWave,
  wave: number,
  playerCount: number,
  openPaths: number[],
): GeneratedWave {
  const scale = 1 + 0.3 * (playerCount - 1);
  const immune = isImmuneWave(wave);
  const invisible = isInvisibleWave(wave, 'classic');
  const density = doorDensityMult(openPaths.length, wave);

  if (cal.champion) {
    // CAMPEONES 👑: pelotón sin escolta. La cantidad escala suave con los
    // jugadores (la vida ya escala ×1.4 por jugador extra en waveHpMult).
    // F9d: EXENTOS de la densidad por ruta (ya son pocos a propósito).
    const count = Math.max(3, Math.min(6, Math.round(cal.count * (1 + 0.15 * (playerCount - 1)))));
    const ordered = Array.from({ length: count }, () => cal.type);
    const entries = buildEntries(state, wave, ordered, openPaths, {
      eliteAffixes: new Map(), // los campeones no son élites: son su propio arquetipo
      immune,
      blessed: false,
      blessedAffix: null,
      invisible,
      champion: true,
      championHp: cal.championHp,
      bossAffix: null,
      hpTune: cal.hpTune,
    });
    const { comp, flying } = summarize(ordered, null);
    return {
      entries,
      comp,
      hasBoss: false,
      bossType: null,
      immune,
      blessed: false,
      blessedAffix: null,
      flying,
      invisible,
      champion: true,
      bossAffix: null,
    };
  }

  // F9d · densidad por ruta abierta: cantidad ×density (tope de unidades) y
  // compensación denseTune = baseN/finalN con las cantidades REALES redondeadas
  // (presupuesto y oro totales ≈iguales aunque el redondeo/tope muerda).
  const baseCount = Math.max(1, Math.round(cal.count * scale));
  const count = density > 1 ? Math.min(DOOR_DENSITY_UNIT_CAP, Math.max(1, Math.round(baseCount * density))) : baseCount;
  const denseTune = count !== baseCount ? baseCount / count : 1;
  const normal: EnemyTypeId[] = Array.from({ length: count }, () => cal.type);
  const bosses: EnemyTypeId[] = cal.boss ? [cal.boss] : [];
  const ordered = [...normal, ...bosses];

  // élites capados a ~1 por cada 5 unidades BASE (mínimo 1): ver rollElites. F9d:
  // ambos topes escalan ×densidad (los élites densificados llevan hp comprimido,
  // así count×mult · hp÷mult deja su presupuesto ≈ igual al de la oleada base).
  const eliteAffixes = rollElites(
    state,
    wave,
    normal,
    Math.round(Math.max(1, Math.floor(baseCount / 5)) * (count / baseCount)),
    count / baseCount,
  );
  const bossAffix = rollBossAffix(state, wave, bosses.length > 0, 'classic');

  // Oleada bendecida: mismo dado que el generador (no en inmunes ni jefes).
  let blessed = false;
  let blessedAffix: AffixId | null = null;
  {
    const roll = wave >= BLESSED_FROM ? rand(state) : 1;
    if (roll < 1 / BLESSED_ODDS && !immune && bosses.length === 0) {
      blessed = true;
      blessedAffix = pick(state, ELITE_AFFIX_POOL);
    }
  }

  const entries = buildEntries(state, wave, ordered, openPaths, {
    eliteAffixes,
    immune,
    blessed,
    blessedAffix,
    invisible,
    champion: false,
    bossAffix,
    hpTune: cal.hpTune,
    gapOverride: cal.gap,
    denseTune,
    gapDiv: count / baseCount,
  });
  const { comp, flying } = summarize(ordered, cal.boss ?? null);
  return {
    entries,
    comp,
    hasBoss: bosses.length > 0,
    bossType: cal.boss ?? null,
    immune,
    blessed,
    blessedAffix,
    flying,
    invisible,
    champion: false,
    bossAffix,
  };
}

// F9a (v19) · oleada de CAMPEONES del generador (infinito/horda): especie elegida
// por el RNG entre las elegibles, cantidad 3-6 creciendo con la profundidad.
// F9d: EXENTA de la densidad por ruta (los campeones ya son pocos a propósito);
// solo respeta el reparto por rutas ABIERTAS.
function generateChampionWave(
  state: RngState,
  wave: number,
  playerCount: number,
  openPaths: number[],
): GeneratedWave {
  const candidates = CHAMPION_SPECIES.filter((t) => ENEMIES[t].minWave <= wave);
  const type = candidates.length > 0 ? pick(state, candidates) : 'brute';
  const count = Math.min(
    6,
    3 + Math.floor((wave - CHAMPION_FROM) / 20) + (playerCount > 2 ? 1 : 0),
  );
  const ordered = Array.from({ length: count }, () => type);
  const immune = isImmuneWave(wave); // nunca coincide por cadencia; defensa en profundidad
  const invisible = isInvisibleWave(wave); // ídem
  const entries = buildEntries(state, wave, ordered, openPaths, {
    eliteAffixes: new Map(),
    immune,
    blessed: false,
    blessedAffix: null,
    invisible,
    champion: true,
    bossAffix: null,
  });
  const { comp, flying } = summarize(ordered, null);
  return {
    entries,
    comp,
    hasBoss: false,
    bossType: null,
    immune,
    blessed: false,
    blessedAffix: null,
    flying,
    invisible,
    champion: true,
    bossAffix: null,
  };
}

// F9d · índices de ruta ABIERTOS de un mapa de `pathCount` rutas dadas las
// puertas cerradas (lista canónica de sanitizeClosedDoors). Defensa en
// profundidad: si el resultado quedara vacío, se abren todas (la sim jamás debe
// quedarse sin rutas por las que spawnear).
export function openPathIndices(pathCount: number, closedDoors: number[]): number[] {
  const open: number[] = [];
  for (let i = 0; i < pathCount; i++) if (!closedDoors.includes(i)) open.push(i);
  return open.length > 0 ? open : Array.from({ length: pathCount }, (_, i) => i);
}

// Genera la oleada `wave` para un mapa con `pathCount` caminos.
// F9a (v19) · `mode` decide la fuente: CLÁSICO usa el calendario fijo de 36;
// infinito/horda conservan el generador por presupuesto (+ rotación de campeones).
// El parámetro es opcional (default endless) para no romper herramientas/llamadores.
// F9d · `openPaths`: índices de ruta ABIERTOS (puertas cerrables). Los spawns se
// reparten SOLO entre ellos y la densidad escala con su número (doorDensityMult).
// Ausente = todas abiertas — con R ≤ 3 el resultado es BYTE-IDÉNTICO al previo.
export function generateWave(
  state: RngState,
  wave: number,
  playerCount: number,
  pathCount: number,
  mode: GameMode = 'endless',
  openPaths?: number[],
): GeneratedWave {
  const paths = openPaths && openPaths.length > 0 ? openPaths : Array.from({ length: pathCount }, (_, i) => i);
  if (mode === 'classic') {
    const cal = classicWave(wave);
    if (cal) return generateCalendarWave(state, cal, wave, playerCount, paths);
    // fuera del calendario (no debería ocurrir en clásico de 36): cae al generador
  }
  if (mode !== 'classic' && isChampionWave(wave, mode)) {
    return generateChampionWave(state, wave, playerCount, paths);
  }

  const picks: EnemyTypeId[] = [];
  let budget = waveBudget(wave, playerCount);
  const hasBoss = waveHasBoss(wave, mode);
  let bossType: EnemyTypeId | null = null;

  if (hasBoss) {
    bossType = pickBoss(wave, mode);
    // El jefe consume gran parte del presupuesto; el resto es escolta.
    const bosses = Math.max(1, Math.floor(wave / 30));
    for (let i = 0; i < bosses; i++) picks.push(bossType);
    budget = Math.round(budget * 0.45);
  }

  let candidates = pool(wave);
  let flavor = false; // oleada de sabor (aérea/enjambre): sin sesgo hacia lo caro

  // En una oleada de jefe VOLADOR (Quimera) la escolta NO lleva Colosos Alados:
  // jefe volador + tanques voladores sería un muro de anti-aire desproporcionado.
  // F9a · la Gárgola (voladora blindada) queda fuera por la misma razón.
  if (hasBoss && bossType && ENEMIES[bossType].flying) {
    candidates = candidates.filter((t) => t !== 'skywhale' && t !== 'gargoyle');
  }

  // Oleadas con sabor especial
  if (!hasBoss && wave % 7 === 0 && wave >= 7) {
    // aérea: bats y flyers baratos (el Coloso Alado NO copa estas oleadas — sería un
    // muro de tanques voladores; aparece mezclado en oleadas normales).
    candidates = candidates.filter((t) => (ENEMIES[t].flying && t !== 'skywhale') || t === 'runner');
    if (!candidates.some((t) => ENEMIES[t].flying)) candidates.push('bat');
    flavor = true;
  } else if (!hasBoss && wave % 5 === 0 && wave >= 5 && !isImmuneWave(wave)) {
    // enjambre: muchos y baratos (las oleadas inmunes múltiplos de 5 NO son enjambre)
    candidates = candidates.filter((t) => ENEMIES[t].cost <= 6);
    flavor = true;
  }

  // Sesgo hacia enemigos más caros en oleadas altas (no en las oleadas de sabor)
  while (budget > 0 && picks.length < 220) {
    const affordable = candidates.filter((t) => ENEMIES[t].cost <= budget);
    if (affordable.length === 0) break;
    let choice = pick(state, affordable);
    if (!flavor && rand(state) < Math.min(0.55, wave * 0.03)) {
      // reintento buscando algo más caro
      const expensive = affordable.filter((t) => ENEMIES[t].cost >= 9);
      if (expensive.length > 0) choice = pick(state, expensive);
    }
    picks.push(choice);
    budget -= ENEMIES[choice].cost;
  }

  // Ordenar: mezcla aleatoria pero con el jefe al final
  const normal = picks.filter((t) => !ENEMIES[t].boss);
  const bosses = picks.filter((t) => ENEMIES[t].boss);

  // F9d · densidad por ruta abierta: la escolta/oleada normal se REPLICA hasta
  // ×doorDensityMult(R) (tope de unidades), SIN consumir RNG (copias en
  // round-robin de la lista base — la mezcla de después ya las dispersa), y cada
  // unidad comprime hp/botín ×denseTune = baseN/finalN (presupuesto y oro ≈
  // iguales). Los JEFES quedan exentos (ni cantidad ni vida). Con density = 1
  // (todos los mapas de 1-3 rutas) este bloque no ejecuta NADA: byte-idéntico.
  // HORDA EXENTA (hallazgo adversarial): su derrota es por CONTEO de vivos
  // (HORDE_CAP), no por presupuesto — triplicar unidades (aunque pesen ⅓)
  // triplicaría la presión sobre el aforo y rompería la neutralidad justo en su
  // condición de derrota. La horda multi-puerta conserva el reparto por rutas
  // ABIERTAS (las puertas cerradas funcionan igual), solo que sin densificar.
  const density = mode === 'horde' ? 1 : doorDensityMult(paths.length, wave);
  let denseTune = 1;
  if (density > 1 && normal.length > 0) {
    const baseN = normal.length;
    const target = Math.min(DOOR_DENSITY_UNIT_CAP, Math.round(baseN * density));
    for (let i = baseN; i < target; i++) normal.push(normal[i % baseN]);
    denseTune = baseN / normal.length;
  }

  for (let i = normal.length - 1; i > 0; i--) {
    const j = Math.floor(rand(state) * (i + 1));
    [normal[i], normal[j]] = [normal[j], normal[i]];
  }
  const ordered = [...normal, ...bosses];

  // Élites: unos pocos enemigos normales suben de categoría con 1-2 afijos.
  // Índices dentro de `normal` (los jefes nunca son élite). F9d: su número
  // escala ×densidad real (hp comprimido ⇒ presupuesto élite ≈ igual).
  const eliteAffixes = rollElites(state, wave, normal, Infinity, denseTune > 0 ? 1 / denseTune : 1);

  // Inmunidad mágica: oleadas múltiplos de 5 desde la 10. Todos los enemigos (y
  // élites) de esta oleada son inmunes a magia. Se decide DESPUÉS de las élites
  // (el flag se propaga en spawnEnemy/makeElite leyendo la entrada).
  const immune = isImmuneWave(wave);

  // F9a · afijo del jefe (siempre en endless/horda; clásico desde la 20)
  const bossAffix = rollBossAffix(state, wave, hasBoss, mode);

  // Oleada bendecida: desde la 6, ~1/15 de probabilidad. NO se combina con inmune
  // ni con jefe (para no acumular dificultad). TODA la oleada gana UN afijo común
  // (aplicado como "makeElite ligero": solo el efecto, sin el ×2.6 de hp) y botín
  // ×1.5. Tiramos SIEMPRE el dado en oleadas elegibles para no descuadrar el RNG.
  let blessed = false;
  let blessedAffix: AffixId | null = null;
  {
    const roll = wave >= BLESSED_FROM ? rand(state) : 1;
    if (roll < 1 / BLESSED_ODDS && !immune && !hasBoss) {
      blessed = true;
      blessedAffix = pick(state, ELITE_AFFIX_POOL);
    }
  }

  // Oleada INVISIBLE (Lote 3): determinista por número de oleada (no consume RNG,
  // así no descuadra nada). Marca a TODA la composición no-jefe como invisible:
  // sin un Sentry del equipo, las torres no pueden apuntarla ni verla. Nunca cae
  // en oleadas inmunes ni de jefe (lo garantiza isInvisibleWave).
  const invisible = isInvisibleWave(wave, mode);

  const entries = buildEntries(state, wave, ordered, paths, {
    eliteAffixes,
    immune,
    blessed,
    blessedAffix,
    invisible,
    champion: false,
    bossAffix,
    denseTune,
    gapDiv: denseTune > 0 ? 1 / denseTune : 1,
  });

  const { comp, flying } = summarize(ordered, bossType);

  return {
    entries,
    comp,
    hasBoss,
    bossType,
    immune,
    blessed,
    blessedAffix,
    flying,
    invisible,
    champion: false,
    bossAffix,
  };
}
