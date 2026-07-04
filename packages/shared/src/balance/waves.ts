import type { AffixId, Difficulty, EnemyTypeId, SpawnEntry, WaveComp } from '../types.js';
import { ENEMIES } from './enemies.js';
import { AFFIX_ORDER } from './affixes.js';
import {
  BLESSED_FROM,
  BLESSED_ODDS,
  DIFF_HP_MULT,
  ELITE_MIN_WAVE,
  ELITE_TWO_AFFIX_WAVE,
  HP_PER_EXTRA_PLAYER,
  IMMUNE_EVERY,
  IMMUNE_FROM,
  TICK_RATE,
} from '../constants.js';
import { rand, pick } from '../rng.js';

// Multiplicador de HP según oleada, dificultad y cantidad de jugadores.
export function waveHpMult(wave: number, difficulty: Difficulty, playerCount: number): number {
  const base = 1 + 0.11 * (wave - 1);
  const late = wave > 20 ? Math.pow(1.13, wave - 20) : 1;
  const players = 1 + HP_PER_EXTRA_PLAYER * (playerCount - 1);
  return base * late * DIFF_HP_MULT[difficulty] * players;
}

export function waveBountyMult(wave: number): number {
  return 1 + 0.03 * (wave - 1);
}

// ¿La oleada `wave` es de inmunidad mágica? Múltiplos de 5 desde la 10 (10,15,20,25…)
// PERO se exime la oleada de la Quimera (jefe VOLADOR en 15/25/35): inmune + volador +
// jefe a la vez solo dejaría el arquero/francotirador físicos anti-aire, un triple
// castigo casi imposible. Las oleadas del golem/behemot (terrestres) sí son inmunes.
export function isImmuneWave(wave: number): boolean {
  if (wave < IMMUNE_FROM || (wave - IMMUNE_FROM) % IMMUNE_EVERY !== 0) return false;
  const isChimeraWave = wave >= 15 && wave % 10 === 5;
  return !isChimeraWave;
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
  ];
  return all.filter((t) => ENEMIES[t].minWave <= wave);
}

export interface GeneratedWave {
  entries: SpawnEntry[];
  comp: WaveComp[];
  hasBoss: boolean;
  bossType: EnemyTypeId | null; // jefe de la oleada (para el anuncio) o null
  immune: boolean; // toda la oleada es inmune a magia
  blessed: boolean; // oleada bendecida (afijo común + doble botín)
  blessedAffix: AffixId | null; // el afijo común, si es bendecida
  flying: boolean; // la oleada está dominada por lo aéreo / jefe volador (telegrafía 🦅)
}

// Elige el jefe de una oleada con jefe. En el CLÁSICO: golem en múltiplos de 10,
// pero la Quimera (voladora) toma las oleadas 15/25/35 para forzar anti-aire. En
// endless/horde el Behemot aparece en oleadas muy altas (25+) como jefe pesado.
function pickBoss(wave: number): EnemyTypeId {
  // Quimera voladora a mitad de partida: 15, 25, 35… (múltiplos de 5 impares en la
  // decena) — obliga a tener anti-aire justo cuando el jugador se acomodó en tierra.
  if (wave >= 15 && wave % 10 === 5) return 'chimera';
  // Behemot terrestre demoledor en oleadas muy altas (endless/horde).
  if (wave >= 30 && wave % 20 === 0) return 'behemoth';
  return 'golem';
}

// ¿La oleada `wave` trae jefe? Golem/Behemot cada 10; Quimera en 15/25/35.
function waveHasBoss(wave: number): boolean {
  return wave > 0 && (wave % 10 === 0 || (wave >= 15 && wave % 10 === 5));
}

// Genera la oleada `wave` para un mapa con `pathCount` caminos.
export function generateWave(
  state: RngState,
  wave: number,
  playerCount: number,
  pathCount: number,
): GeneratedWave {
  const picks: EnemyTypeId[] = [];
  let budget = waveBudget(wave, playerCount);
  const hasBoss = waveHasBoss(wave);
  let bossType: EnemyTypeId | null = null;

  if (hasBoss) {
    bossType = pickBoss(wave);
    // El jefe consume gran parte del presupuesto; el resto es escolta.
    const bosses = Math.max(1, Math.floor(wave / 30));
    for (let i = 0; i < bosses; i++) picks.push(bossType);
    budget = Math.round(budget * 0.45);
  }

  let candidates = pool(wave);
  let flavor = false; // oleada de sabor (aérea/enjambre): sin sesgo hacia lo caro

  // En una oleada de jefe VOLADOR (Quimera) la escolta NO lleva Colosos Alados:
  // jefe volador + tanques voladores sería un muro de anti-aire desproporcionado.
  if (hasBoss && bossType && ENEMIES[bossType].flying) {
    candidates = candidates.filter((t) => t !== 'skywhale');
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
  for (let i = normal.length - 1; i > 0; i--) {
    const j = Math.floor(rand(state) * (i + 1));
    [normal[i], normal[j]] = [normal[j], normal[i]];
  }
  const ordered = [...normal, ...bosses];

  // Élites: unos pocos enemigos normales suben de categoría con 1-2 afijos.
  // Índices dentro de `normal` (los jefes nunca son élite).
  const eliteAffixes = new Map<number, AffixId[]>();
  if (wave >= ELITE_MIN_WAVE && normal.length > 0) {
    const count = Math.min(normal.length, 1 + Math.floor((wave - ELITE_MIN_WAVE) / 3));
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
      const affixPool = [...AFFIX_ORDER];
      for (let a = 0; a < numAffixes && affixPool.length > 0; a++) {
        const pickIdx = Math.floor(rand(state) * affixPool.length);
        affixes.push(affixPool.splice(pickIdx, 1)[0]);
      }
      eliteAffixes.set(idx, affixes);
    }
  }

  // Inmunidad mágica: oleadas múltiplos de 5 desde la 10. Todos los enemigos (y
  // élites) de esta oleada son inmunes a magia. Se decide DESPUÉS de las élites
  // (el flag se propaga en spawnEnemy/makeElite leyendo la entrada).
  const immune = isImmuneWave(wave);

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
      blessedAffix = pick(state, AFFIX_ORDER);
    }
  }

  // Espaciado entre spawns: más denso en oleadas altas
  const baseGap = Math.max(0.28, 0.85 - wave * 0.018); // segundos
  const entries: SpawnEntry[] = ordered.map((type, i) => {
    const gap = ENEMIES[type].boss ? 1.5 : baseGap * (0.75 + rand(state) * 0.5);
    const affixes = eliteAffixes.get(i);
    return {
      type,
      delay: Math.max(2, Math.round(gap * TICK_RATE)),
      pathIdx: pathCount > 1 ? (i % pathCount) : 0,
      ...(affixes ? { elite: true, affixes } : {}),
      ...(immune ? { immune: true } : {}),
      ...(blessed && blessedAffix ? { blessed: true, blessedAffix } : {}),
    };
  });

  // Resumen para la vista previa
  const counts = new Map<EnemyTypeId, number>();
  for (const t of ordered) counts.set(t, (counts.get(t) ?? 0) + 1);
  const comp: WaveComp[] = [...counts.entries()].map(([type, count]) => ({ type, count }));
  comp.sort((a, b) => ENEMIES[b.type].cost - ENEMIES[a.type].cost);

  // ¿Domina lo aéreo? (para la etiqueta 🦅): jefe volador, o mayoría de voladores.
  const flyers = ordered.filter((t) => ENEMIES[t].flying).length;
  const flying = (bossType !== null && ENEMIES[bossType].flying) || (ordered.length > 0 && flyers >= ordered.length / 2);

  return { entries, comp, hasBoss, bossType, immune, blessed, blessedAffix, flying };
}
