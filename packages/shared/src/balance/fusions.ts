import type { FusionId, TowerLevelDef, TowerSpecDef, TowerTypeId } from '../types.js';
import { activeStats } from './towers.js';

// ---------- F4.3 · Fusión de torres — 6 recetas curadas estilo Element TD ----------
//
// Regla: dos torres ESPECIALIZADAS (spec >= 0; nivel 3 o 4), ADYACENTES (distancia
// Chebyshev 1), del MISMO dueño, cuyos tipos formen una receta. La fusión CONSUME
// ambas y crea UNA torre fusionada en la celda elegida (`keepId`); la otra queda
// libre. No cuesta oro extra: el "coste" son las dos torres consumidas.
//
// Decisiones documentadas:
// - La fusionada queda con level=3, spec=−1 y `fusion` = índice en FUSION_ORDER.
//   No admite más mejoras/especializaciones (solo venta). Su `type` es el de la
//   torre conservada, SOLO para arte/compat: TODO el comportamiento sale de aquí.
// - `invested` = suma de ambos ingredientes (el refund de venta no pierde nada
//   más que el 30% normal).
// - El Rango II (nivel 4) de los ingredientes se IGNORA mecánicamente (la fusión
//   tiene stats fijos), pero su coste sí viaja en `invested`, así que se recupera
//   al vender como cualquier otra inversión.
// - `growthBonus` (crecimiento del Arco Largo II) NO se hereda: la fusión es una
//   torre nueva.

// Orden estable: índice compacto en los snapshots (SnapTower[13]; −1 = sin fusión).
// Solo CRECE por el final.
export const FUSION_ORDER: FusionId[] = [
  'glacialplague',
  'railstorm',
  'bigbertha',
  'warlord',
  'philostone',
  'winterheart',
];

export interface FusionDef {
  id: FusionId;
  name: string;
  desc: string;
  icon: string; // emoji para HUD/toasts
  color: string;
  ingredients: [TowerTypeId, TowerTypeId]; // par SIN orden
  projectileKind: 'bullet' | 'shell' | 'bomb' | 'none' | 'beam' | 'snipe';
  targetsAir: boolean;
  targetsGround: boolean;
  stats: TowerLevelDef; // stats completos de la torre fusionada (cost = 0: no se compra)
}

export const FUSIONS: Record<FusionId, FusionDef> = {
  // 1 · Hielo + Veneno — nube que RALENTIZA y ENVENENA a la vez a todos los
  // enemigos del área. Los inmunes a magia no reciben ni slow ni DoT (solo el
  // pequeño daño físico de impacto) — lo resuelve applyPayload como siempre.
  glacialplague: {
    id: 'glacialplague',
    name: 'Plaga Glacial',
    desc: 'Nube gélida y tóxica: ralentiza Y envenena a todos los enemigos del área.',
    icon: '🧪❄',
    color: '#4dd0b1',
    ingredients: ['frost', 'poison'],
    projectileKind: 'shell',
    targetsAir: true,
    targetsGround: true,
    stats: {
      cost: 0,
      damage: 40,
      range: 3.2,
      cooldown: 1.0,
      projectileSpeed: 13,
      splash: 1.6,
      slow: { factor: 0.3, duration: 2.5 },
      poison: { dps: 110, duration: 4 },
    },
  },

  // 2 · Tesla + Francotirador — rayo PERFORANTE en línea recta: elige objetivo,
  // traza la línea y daña a TODOS los enemigos cercanos a ella. El rayo es mágico:
  // a los inmunes les entra −70%, como el Tesla (coherencia F4.1).
  railstorm: {
    id: 'railstorm',
    name: 'Tormenta de Riel',
    desc: 'Rayo perforante: atraviesa y daña a TODOS los enemigos alineados con el disparo.',
    icon: '⚡🎯',
    color: '#ffe082',
    ingredients: ['tesla', 'sniper'],
    projectileKind: 'beam',
    targetsAir: true,
    targetsGround: true,
    stats: {
      cost: 0,
      damage: 340,
      range: 7.0,
      cooldown: 2.4,
      pierceArmor: true,
      lineWidth: 0.7,
    },
  },

  // 3 · Cañón + Mortero — alcance de TODO el mapa, obús devastador de gran radio,
  // cooldown ENORME. Daño físico: pega normal a los inmunes. Solo tierra.
  bigbertha: {
    id: 'bigbertha',
    name: 'Gran Bertha',
    desc: 'Obús devastador con alcance de TODO el mapa y área enorme. Recarga lentísima.',
    icon: '💣🧨',
    color: '#ff8a65',
    ingredients: ['cannon', 'mortar'],
    projectileKind: 'bomb',
    targetsAir: false,
    targetsGround: true,
    stats: {
      cost: 0,
      damage: 780,
      range: 99, // todo el mapa
      cooldown: 9,
      projectileSpeed: 8,
      splash: 2.6,
      minRange: 2.0,
    },
  },

  // 4 · Arquero + Estandarte — DISPARA y a la vez BUFFEA como estandarte. Su aura
  // entra en computeAuras con la regla MAX/no-apilar; el radio del aura es su
  // `range` (el mismo del disparo). Como SÍ dispara (`alsoFires`), también RECIBE
  // auras de otros Estandartes (regla MAX; un estandarte puro sigue sin recibir).
  warlord: {
    id: 'warlord',
    name: 'Señor de la Guerra',
    desc: 'Dispara Y refuerza a la vez: aura de daño de Estandarte mientras combate.',
    icon: '🏹🚩',
    color: '#ffb74d',
    ingredients: ['archer', 'banner'],
    projectileKind: 'bullet',
    targetsAir: true,
    targetsGround: true,
    stats: {
      cost: 0,
      damage: 82,
      range: 3.4,
      cooldown: 0.4,
      projectileSpeed: 16,
      pierceArmor: true,
      auraDamage: 0.45,
      alsoFires: true,
    },
  },

  // 5 · Veneno + Alquimista — las bajas causadas por SU veneno (DoT) pagan botín
  // DOBLE. Orden de multiplicadores del botín (un solo redondeo al final):
  //   base × mult de oleada/élite/bendición × aura de Alquimista × Piedra Filosofal.
  // (F4.2 ya usa "Filósofo" para una spec del Alquimista; por eso esta es la Piedra.)
  philostone: {
    id: 'philostone',
    name: 'Piedra Filosofal',
    desc: 'Transmutación letal: las bajas causadas por SU veneno pagan botín DOBLE.',
    icon: '☠⚗',
    color: '#ffd54f',
    ingredients: ['poison', 'alchemist'],
    projectileKind: 'bullet',
    targetsAir: true,
    targetsGround: true,
    stats: {
      cost: 0,
      damage: 28,
      range: 3.6,
      cooldown: 1.0,
      projectileSpeed: 14,
      poison: { dps: 90, duration: 4 },
      poisonBountyMult: 2,
    },
  },

  // 6 · Hielo + Estandarte — aura DOBLE: ralentiza a los enemigos en radio (misma
  // regla que la Escarcha: se toma el MEJOR factor, no se apila; inmunes exentos)
  // Y acelera la cadencia de las torres aliadas (auraHaste, regla MAX). No dispara.
  winterheart: {
    id: 'winterheart',
    name: 'Corazón de Invierno',
    desc: 'Aura doble: congela a los enemigos cercanos Y acelera a las torres aliadas.',
    icon: '❄🚩',
    color: '#81d4fa',
    ingredients: ['frost', 'banner'],
    projectileKind: 'none',
    targetsAir: true,
    targetsGround: true,
    stats: {
      cost: 0,
      damage: 0,
      range: 3.6, // radio del aura de cadencia
      cooldown: 0,
      slowAura: { factor: 0.35, radius: 3.6 },
      auraHaste: 0.6,
    },
  },
};

// ¿Estos dos tipos forman una receta? (par sin orden)
export function findFusion(a: TowerTypeId, b: TowerTypeId): FusionDef | null {
  for (const id of FUSION_ORDER) {
    const def = FUSIONS[id];
    const [x, y] = def.ingredients;
    if ((x === a && y === b) || (x === b && y === a)) return def;
  }
  return null;
}

// Def de fusión por índice de snapshot (−1 o fuera de rango = null).
export function fusionByIndex(idx: number): FusionDef | null {
  if (idx < 0 || idx >= FUSION_ORDER.length) return null;
  return FUSIONS[FUSION_ORDER[idx]];
}

// Def de fusión de una torre del estado de sim (null si no está fusionada).
export function fusionOf(t: { fusion: number }): FusionDef | null {
  return fusionByIndex(t.fusion);
}

// Stats activos de una torre TENIENDO EN CUENTA la fusión: si está fusionada,
// mandan los stats de la fusión; si no, los de activeStats (nivel/spec/Rango II).
// Es el reemplazo fusion-aware de activeStats para todo lo que lea TowerState.
export function statsOf(t: {
  type: TowerTypeId;
  level: number;
  spec: number;
  fusion: number;
}): TowerLevelDef | TowerSpecDef {
  const f = fusionByIndex(t.fusion);
  return f ? f.stats : activeStats(t.type, t.level, t.spec);
}
