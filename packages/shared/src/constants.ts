export const TICK_RATE = 15; // ticks por segundo (autoridad del servidor)
export const TICK_MS = 1000 / TICK_RATE;
export const INTERP_DELAY_MS = 120; // el cliente renderiza este delay por detrás para interpolar

export const MAX_PLAYERS = 8;
export const CLASSIC_WAVES = 20;
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

export const BALANCE_VERSION = 4;
export const PROTOCOL_VERSION = 1;
