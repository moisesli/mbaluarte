export const TICK_RATE = 15; // ticks por segundo (autoridad del servidor)
export const TICK_MS = 1000 / TICK_RATE;
export const INTERP_DELAY_MS = 120; // el cliente renderiza este delay por detrás para interpolar

export const MAX_PLAYERS = 8;
export const CLASSIC_WAVES = 36; // como en Green TD (antes 20)
// Velocidades de simulación que puede elegir el anfitrión (steps por tick de red).
export const GAME_SPEEDS = [1, 2, 3] as const;

export const START_LIVES = 30;

// ---------- modo horda ----------
// Los enemigos no se escapan: dan vueltas en bucle. Se pierde por SATURACIÓN
// (demasiados vivos a la vez). Cap de enemigos vivos por dificultad; al alcanzarlo
// la partida termina en derrota.
export const HORDE_CAP: Record<string, number> = { easy: 45, normal: 38, hard: 32 };
// Cansancio (anti-esponja): cada vuelta completada baja el maxHp efectivo del
// enemigo un −10% de su maxHp BASE (el que tenía al nacer, antes de dar vueltas),
// acumulable, con un suelo del 10% para que nunca llegue a 0 de golpe.
export const HORDE_LAP_HP_LOSS = 0.1;
export const HORDE_LAP_HP_FLOOR = 0.1;
export const SELL_REFUND = 0.7;
export const CALL_WAVE_GOLD_PER_SEC = 2; // oro por segundo restante al llamar la oleada antes
export const FIRST_INTERLUDE_SEC = 25;
export const INTERLUDE_SEC = 13;

export const WAVE_BONUS_BASE = 20;
export const WAVE_BONUS_PER_WAVE = 4;

// ---------- élites ----------
export const ELITE_MIN_WAVE = 4; // antes de esta oleada no hay élites
export const ELITE_TWO_AFFIX_WAVE = 10; // desde aquí, los élites llevan 2 afijos
export const ELITE_HP_MULT = 2.6;
export const ELITE_BOUNTY_MULT = 3;
export const ELITE_RADIUS_MULT = 1.3;
export const ELITE_EXTRA_LIVES = 1; // vidas extra que cuesta si se escapa

// ---------- F4.1 · sistema de oleadas Green TD ----------
// Inmunidad mágica: cada N oleadas desde IMMUNE_FROM (10,15,20…) la oleada sale
// inmune (todos sus enemigos y élites `spellImmune`). Fuerza tener daño físico.
export const IMMUNE_FROM = 10;
export const IMMUNE_EVERY = 5;
// El Tesla (rayo mágico) hace este multiplicador de daño a los inmunes.
export const SPELL_IMMUNE_TESLA_MULT = 0.3; // −70%
// Fuga escalonada: coste extra de vidas = floor(oleada / LEAK_WAVE_DIV).
export const LEAK_WAVE_DIV = 10;
// Oleada bendecida (bonus riesgo/recompensa): desde BLESSED_FROM, con probabilidad
// 1/BLESSED_ODDS (RNG determinista), toda la oleada gana un afijo común (sin el ×2.6
// de hp de élite) + botín ×BLESSED_BOUNTY_MULT + bono de fin de oleada ×BLESSED_BONUS_MULT.
export const BLESSED_FROM = 6;
export const BLESSED_ODDS = 15;
export const BLESSED_BOUNTY_MULT = 1.5;
export const BLESSED_BONUS_MULT = 1.5;

// ---------- Lote 3 · oleadas INVISIBLES (estilo Green TD) ----------
// Cada INVISIBLE_EVERY oleadas desde INVISIBLE_FROM la oleada sale INVISIBLE: las
// torres NO pueden apuntar a un enemigo invisible NO DETECTADO (ni verlo). Un
// SENTRY del equipo (torre-item de la 🛒 Tienda) lo REVELA dentro de su radio.
// Es DETERMINISTA por número de oleada (no consume RNG). Se exime cuando la oleada
// coincide con INMUNE o con JEFE (mira isInvisibleWave en balance/waves.ts): así en
// el clásico de 36 caen ~4 oleadas invisibles (12, 18, 24, 36) sin apilar castigos.
export const INVISIBLE_FROM = 12;
export const INVISIBLE_EVERY = 6;

// ---------- F4.2 · torres nuevas + Rango II ----------
// Trampa de púas: cargas iniciales (cada golpe consume 1; a 0 se auto-vende).
export const TRAP_CHARGES = 20;
// Alquimista: multiplicador de bounty para las bajas dentro de su radio (no apila).
export const ALCHEMIST_BOUNTY_MULT = 1.3; // +30%
// Rango II · Obús/Metralla II: shred de armadura AoE.
export const SHRED_CHANCE = 0.03; // 3% por impacto
export const SHRED_RADIUS = 1.5; // celdas alrededor del enemigo golpeado
export const SHRED_DURATION = 4; // segundos que dura el shred (armadura a la mitad)
// Rango II · Arco Largo/Explorador II: crecimiento permanente por disparo.
export const GROWTH_PER_SHOT = 8; // +8 de daño base por cada disparo, para siempre

// ---------- F5.2 · madera (economía secundaria estilo Green TD) ----------
// Cada jugador tiene un orco leñador implícito que tala madera AUTOMÁTICAMENTE,
// sin construir nada (como el peón de Green TD). El oro compra torres; la madera
// compra PODER: las ★especializaciones y el ★★Rango II cuestan madera además de
// oro. (Un edificio que acelere la tala puede venir en una iteración futura.)
export const WOOD_PER_SEC = 0.4; // tala BASE del orco nivel 1 (= ORC_RATES[0])
export const START_WOOD = 30; // madera inicial
export const WOOD_COST_SPEC = 45; // coste en madera de una especialización (★)
export const WOOD_COST_RANK2 = 60; // coste en madera del Rango II (★★)
// F5.5 · el ORCO se MEJORA con oro (nivel 1..5): tala por segundo según nivel y
// coste de subir AL SIGUIENTE nivel (índice = nivel actual − 1). Es el motor de
// madera a largo plazo; el mercado es la conversión instantánea.
export const ORC_RATES = [0.4, 0.6, 0.8, 1.0, 1.25]; // 🪵/s por nivel de orco
export const ORC_UPGRADE_COSTS = [140, 260, 420, 620]; // 🪙 para pasar a nv 2..5

// ---------- F5.4 · mercado global de madera ----------
// Un único mercado POR SALA (el precio vive en GameState → determinista, viaja
// en snapshots y replays). Comprar SUBE el precio y vender lo BAJA — para todos
// los jugadores. La venta paga con descuento (spread) para que el ping-pong no
// sea gratis, y el precio revierte suave hacia la base al final de cada oleada.
export const WOOD_LOT = 10; // madera por operación
export const WOOD_PRICE_BASE = 2; // oro por madera (precio inicial)
export const WOOD_PRICE_MIN = 0.5;
export const WOOD_PRICE_MAX = 8;
export const WOOD_PRICE_STEP = 1.08; // cada compra ×1.08; cada venta ÷1.08
export const WOOD_SELL_SPREAD = 0.85; // la venta paga el 85% del precio
export const WOOD_PRICE_REVERT = 0.05; // reversión hacia la base al fin de oleada

// ---------- ORO DE ASISTENCIA (co-op) ----------
// El matador se lleva su botín COMPLETO como siempre. ADEMÁS, si el MAYOR dañador de
// un enemigo NO es quien dio el golpe final y le hizo suficiente daño, cobra un EXTRA
// de "asistencia": recompensa al que hizo el trabajo sin llevarse la baja (issue #9).
// - ASSIST_SHARE: fracción del botín FINAL que cobra el asistente (round, mín. 1). No
//   sale del bolsillo del matador (es oro nuevo, como el botín).
// - ASSIST_MIN_DMG_FRAC: umbral mínimo de daño acumulado (sobre el maxHp del enemigo)
//   para que un dañador cuente como asistente — evita pagar por un roce. En solitario
//   nunca dispara: el matador es siempre su propio mayor dañador.
export const ASSIST_SHARE = 0.25;
export const ASSIST_MIN_DMG_FRAC = 0.35;

// oro de entrada para quien se une con la partida ya empezada
export const midJoinGold = (wave: number) => 180 + wave * 22;

export const START_GOLD: Record<string, number> = {
  easy: 300,
  normal: 220,
  hard: 180,
};

export const DIFF_HP_MULT: Record<string, number> = {
  easy: 0.8,
  normal: 1.0,
  hard: 1.3,
};

export const DIFF_SPEED_MULT: Record<string, number> = {
  easy: 0.9,
  normal: 1.0,
  hard: 1.08,
};

// escalado de HP por jugador extra (co-op)
export const HP_PER_EXTRA_PLAYER = 0.4;

export const PLAYER_COLORS = [
  '#4fc3f7', // celeste
  '#f06292', // rosa
  '#aed581', // verde
  '#ffb74d', // naranja
  '#ba68c8', // morado
  '#fff176', // amarillo
  '#4db6ac', // teal
  '#e57373', // rojo
];

// 14: ráfaga completa del multidisparo · 15: oro de ASISTENCIA (el mayor dañador
// con ≥35% del maxHp cobra un extra si no dio el golpe final) · 16 (issue #7): 5
// recetas de fusión nuevas (toxicstorm/shredder/siegeeye/alchemyvault/icelance)
export const BALANCE_VERSION = 16;
export const PROTOCOL_VERSION = 1;
