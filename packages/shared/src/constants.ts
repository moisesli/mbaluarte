import type { ArmorTypeId, AttackTypeId } from './types.js';

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

// El SENTRY (👁 de la 🛒 Tienda) es TEMPORAL y MEJORABLE: caduca solas su duración
// (medida en TICKS de sim, determinista) y al mejorarlo gana radio Y se REFRESCA al
// total del nuevo nivel. Duración por nivel (segundos): 5 / 7.5 / 10 min. El índice =
// nivel − 1. Al expirar NO manda chat (spamea): solo el evento `sell` con refund 0
// (poof discreto, como la Trampa al agotar cargas).
export const SENTRY_DURATION_SEC = [300, 450, 600];

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
// F5.1 · TOPE del crecimiento permanente: sin él divergía cuadráticamente
// (+13.000 de daño por flecha en endless o50 → el 52-72% de TODO el daño de una
// partida larga era de esta spec). Con +400 la flecha "termina de crecer" en
// ~2.9× su daño base y queda ~1.6-1.9× del Cañón de Riel ★★ a cualquier
// horizonte: la mejor single-target del juego, no un agujero de balance.
export const GROWTH_CAP = 400;

// ---------- F5.1 · matriz ataque × armadura ----------
// El daño DIRECTO (impacto/splash/cadena/ráfaga/trampa) se multiplica por esta
// matriz ANTES de restar la armadura plana: dmg = max(1, round(daño×mult) − armadura).
// `pierceArmor` ignora la armadura PLANA pero NO la matriz (la matriz es identidad
// de rol, no armadura). El DoT de veneno, las auras y los slows NO pasan por aquí
// (su capa de contrajuego es la inmunidad mágica). Rango de diseño: [0.65, 1.5].
//
//              │ ligera   media   blindada  colosal │ identidad
//  ────────────┼────────────────────────────────────┼─────────────────────────────
//  fisico      │  1.00    1.00     0.90     0.90    │ parejo: nunca brilla, nunca falla
//  perforante  │  0.90    1.05     0.80     1.50    │ caza colosales; la placa lo desvía
//  asedio      │  0.65    0.95     1.50     1.00    │ destroza blindados; araña lo ligero
//  magico      │  1.30    1.20     0.65     0.90    │ funde carne; la placa lo disipa
//
// asedio vs colosal = 1.00 A PROPÓSITO: los jefes/colosos son presa EXCLUSIVA del
// perforante (si el asedio también les pegara de más, cañón+mortero volverían a
// ser la respuesta universal y el rol antijefe del francotirador/Balista se diluye).
export const ATTACK_MATRIX: Record<AttackTypeId, Record<ArmorTypeId, number>> = {
  fisico: { ligera: 1.0, media: 1.0, blindada: 0.9, colosal: 0.9 },
  perforante: { ligera: 0.9, media: 1.05, blindada: 0.8, colosal: 1.5 },
  asedio: { ligera: 0.65, media: 0.95, blindada: 1.5, colosal: 1.0 },
  magico: { ligera: 1.3, media: 1.2, blindada: 0.65, colosal: 0.9 },
};

// multiplicador de la matriz (helper para la sim y la UI)
export function attackMult(attack: AttackTypeId, armor: ArmorTypeId): number {
  return ATTACK_MATRIX[attack][armor];
}

// Nombres e iconos por tipo, para que la fase de UI (guía/bestiario/panel) pinte
// la matriz sin inventarse textos. El icono es emoji (lenguaje del HUD).
export const ATTACK_TYPE_INFO: Record<AttackTypeId, { name: string; icon: string; desc: string }> = {
  fisico: { name: 'Físico', icon: '🗡', desc: 'Daño parejo contra todo; pierde un poco contra placas y jefes.' },
  perforante: { name: 'Perforante', icon: '🏹', desc: 'Atraviesa a los COLOSALES (+50%); la armadura blindada lo desvía.' },
  asedio: { name: 'Asedio', icon: '💣', desc: 'Destroza a los BLINDADOS (+50%) pero apenas araña a los ligeros (−35%).' },
  magico: { name: 'Mágico', icon: '✨', desc: 'Funde a ligeros y medianos; las placas blindadas lo disipan (−35%).' },
};
export const ARMOR_TYPE_INFO: Record<ArmorTypeId, { name: string; icon: string; desc: string }> = {
  ligera: { name: 'Ligera', icon: '🪶', desc: 'Rápidos y frágiles: corredores, murciélagos, alimañas.' },
  media: { name: 'Media', icon: '🛡', desc: 'La infantería común: grunts y monstruos medianos.' },
  blindada: { name: 'Blindada', icon: '🦾', desc: 'Placas pesadas: tanques y acorazados. El asedio las revienta.' },
  colosal: { name: 'Colosal', icon: '🏰', desc: 'Jefes y colosos: solo lo perforante los atraviesa de verdad.' },
};

// F5.1 · TOPE del DoT porcentual (Corrosión ★★): el 1.2%/s de la vida MÁXIMA no
// puede superar estos dps. PORQUÉ: sin tope, el % escala sin límite con el hp de
// los jefes del endless profundo y UNA torre trivializaría cualquier jefe; con
// tope, la Corrosión II crece hasta ~33k de vida máxima (0.012×33k ≈ 400) y de
// ahí en adelante queda plana — relevante en el infinito sin romper el clásico.
export const POISON_PCT_CAP_DPS = 400;

// F5.1 · botín superlineal SOLO en endless: desde la oleada ENDLESS_BOUNTY_FROM el
// botín gana un término ×ENDLESS_BOUNTY_STEP compuesto por oleada por encima de la
// base, con tope ×ENDLESS_BOUNTY_CAP extra. La curva de hp del infinito (waveHpMult)
// crece geométrica; sin este término la economía se queda atrás y toda partida
// endless muere por pobreza en vez de por diseño.
export const ENDLESS_BOUNTY_FROM = 30;
export const ENDLESS_BOUNTY_STEP = 1.02;
export const ENDLESS_BOUNTY_CAP = 3;

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

// ---------- MODO TURBO ⚡ (issue #14, "como en Dota 2") ----------
// Filosofía: el Turbo NO es velocidad de reloj (eso ya lo dan x1/x2/x3). Es LA MISMA
// partida —mismos enemigos, misma vida, mismo reto— con la ECONOMÍA COMPRIMIDA y
// menos tiempos muertos: más botín y madera por baja/oleada, e interludios a la
// mitad. Llegas a los "juguetes" (Rango II, fusiones) hacia la oleada ~12-15 en vez
// de al final. El HP enemigo se queda INTACTO a propósito: comprimimos el ritmo, no
// bajamos la dificultad. Solo aplica a CLÁSICO e INFINITO; la HORDA lo ignora (su
// economía de bucle es otro animal, ver sanitizeSettings). Por defecto OFF, así que
// no cambia ninguna partida existente ni el BALANCE_VERSION (sigue en 18).
// Las partidas turbo NO envían récord (más oro = tabla aparte; v1 = nada).
export const TURBO_BOUNTY_MULT = 1.75; // ×botín por baja (mismo punto que waveBountyMult)
export const TURBO_WAVE_BONUS_MULT = 1.5; // ×bono de fin de oleada
export const TURBO_WOOD_MULT = 1.5; // el orco tala más rápido (donde se aplican ORC_RATES)
export const TURBO_INTERLUDE_MULT = 0.5; // interludios a la mitad (primero y normales)

// ---------- F9a (v19) · nerf del BARRIL EXPLOSIVO ----------
// (a) Coste escalado POR EQUIPO: cada compra encarece el siguiente ×1.3 compuesto.
// El contador vive en GameState (boomsBought) y el server valida el precio real —
// el cliente solo lo muestra (viaja en el snapshot como boomCost).
export const BOOM_COST_TEAM_STEP = 1.3;
// (b) Daño PORCENTUAL con tope en vez de matanza plana: la detonación hace daño
// VERDADERO = min(vida MÁXIMA del enemigo, BOOM_HP_CAP_BASE × waveHpMult actual).
// Traducido: borra a cualquier no-jefe cuya vida BASE ≤ 100 (goblins, corredores,
// murciélagos, blindados, morralla élite pequeña…) pero los élites gordos y los
// tanques (bruto 150, trol 200, caballero 260, campeones) SOBREVIVEN con un
// mordisco. El rol pasa de "borrador universal" a "limpia-morralla de pánico".
export const BOOM_HP_CAP_BASE = 100;

// F9a (v19) · compensación de botín del CALENDARIO clásico: las oleadas
// monoespecie traen MENOS cuerpos (y más gordos) que el generador por presupuesto
// — sumando el botín de las 36, la economía quedaba ~35-40% por debajo de la de
// v18 y toda defensa llegaba pobre a los jefes (medido en simtest). Cada baja del
// clásico paga ×1.3 para que el TOTAL por oleada vuelva a la par. Solo clásico:
// infinito/horda conservan su generador (y su botín) de siempre.
export const CLASSIC_BOUNTY_COMP = 1.35;

// ---------- F9a (v19) · oleadas de CAMPEONES 👑 (ELEMENTTD §9.2) ----------
// Pelotón de 3-6 mini-jefes SIN escolta: ×9 hp, mitad de velocidad, botín ×5 y
// fuga cara. En el clásico van en oleadas fijas del calendario (13/22/31); en
// infinito/horda entran en la rotación cada 10 desde la 13 (13, 23, 33…).
export const CHAMPION_HP_MULT = 8;
export const CHAMPION_SPEED_MULT = 0.5;
export const CHAMPION_BOUNTY_MULT = 5;
// vidas EXTRA por fuga de un campeón (se suma a livesCost y a la fuga escalonada:
// total real 5-8 según especie/oleada — dentro del molde "Mega" de ETD2)
export const CHAMPION_EXTRA_LIVES = 3;
export const CHAMPION_RADIUS_MULT = 1.45;
export const CHAMPION_FROM = 13; // primera oleada de campeones (todas las rotaciones)
export const CHAMPION_EVERY = 10; // infinito/horda: 13, 23, 33…

// ---------- F9a (v19) · AFIJOS DE JEFE (ELEMENTTD §9.1) ----------
// Desde la oleada 20 en clásico (SIEMPRE en infinito/horda), cada jefe llega con
// 1 afijo con nombre, telegrafiado ("☠ Gólem Gélido"). Sale del RNG de generateWave
// (determinista) y reutiliza la tubería de afijos de élite + 2 nuevos AL FINAL.
export const BOSS_AFFIX_FROM_CLASSIC = 20;
export const BOSS_AFFIX_BOUNTY_MULT = 1.3; // un jefe con afijo paga más botín
// Adaptativo: tras ADAPT_HITS impactos del MISMO attackType, ese tipo le pega
// ×(1−ADAPT_RESIST) para siempre — el mono-build se castiga solo; diversificar gana.
export const ADAPT_HITS = 12;
export const ADAPT_RESIST = 0.5;
// Aura Gélida: las torres a ≤ radius celdas del jefe recargan ×slow más lento.
export const CHILL_AURA_RADIUS = 2.6;
export const CHILL_AURA_SLOW = 1.45;

// ---------- F9a (v19) · NIVELES 5→10 post-élite ----------
// Una torre en su CÚSPIDE (Rango II ★★, o fusión) desbloquea niveles de veteranía:
// +8% de daño y +4% de cadencia por nivel (compuestos), pagando ORO + MADERA.
// El paso al nivel 10 cuesta como una fusión (~2 torres especializadas). Tope de
// 6 pasos en clásico (nivel 10); en infinito/horda el tope se ABRE con coste
// ×ELITE_LEVEL_OPEN_STEP compuesto — es el pozo del oro tardío. Las torres SIN
// especializar se quedan en nivel 3: especializar tiene que valer la pena.
export const ELITE_LEVEL_GOLD = [240, 350, 500, 730, 1060, 1540];
export const ELITE_LEVEL_WOOD = [18, 25, 35, 50, 70, 100];
export const ELITE_LEVEL_DMG = 0.08; // +8% daño por nivel (compuesto)
export const ELITE_LEVEL_HASTE = 0.04; // +4% cadencia por nivel (compuesto)
export const ELITE_LEVEL_CAP_CLASSIC = 6; // pasos máx en clásico (= nivel 10)
export const ELITE_LEVEL_OPEN_STEP = 1.5; // endless/horda: coste compuesto tras el paso 6

// ---------- F9a (v19) · REPARAR FORTALEZA (solo infinito/horda) ----------
// Compra de EQUIPO en la 🛒 Tienda: +1 vida (infinito) o +1 de AFORO de saturación
// (horda — su "vida" es el cupo de enemigos vivos, así que reforzar murallas =
// aguantar un enemigo más). Coste inicial 500 escalando ×1.5 compuesto por compra.
// Disponible para todos → los récords siguen justos. En clásico NO existe.
export const REPAIR_COST_BASE = 500;
export const REPAIR_COST_STEP = 1.5;

// ---------- F9a (v19) · specs de identidad ----------
// Poder Vital: +20% de daño mientras el EQUIPO conserve ≥25 vidas (de 30). El
// umbral alto crea el drama de "defended la racha"; reparar (item 7) lo reenciende.
export const VITAL_LIVES_MIN = 25;
// Estandarte del Vencedor: crítico ×1.75. La esperanza (+15% de prob) es ~+11% de
// daño medio — MENOS que el Estandarte de Guerra ★ (+60%): su valor real es la
// CERTEZA (nada esquiva) y el pico de burst que dispara ejecuciones porcentuales.
export const CRIT_MULT = 1.75;

// ---------- F9d · PUERTAS CERRABLES + DENSIDAD POR RUTA ABIERTA ----------
// Nº mínimo de rutas para que un mapa tenga «puertas» (reclamo por color F9b y
// cierre de puertas F9d). ÚNICA fuente de verdad: la comparten sanitizeSettings,
// el RoomDO (claim_door/set_settings) y el lobby del cliente (screens.ts).
export const MULTI_DOOR_MIN = 4;

// Densidad por ruta ABIERTA (F9d, feedback directo: «hay muy pocos monstruos» en
// El Gran Concilio — el calendario reparte el count entre 9 rutas y cada carril
// queda desierto). Con R rutas abiertas la CANTIDAD de una oleada escala
//   ×min(CAP, 1 + STEP·(R − BASE))   (R ≤ BASE ⇒ ×1: los 9 mapas de 1-3 rutas
// quedan EXACTAMENTE como están — verificado tick a tick en simtest), y el HP y
// el botín POR UNIDAD se comprimen ÷(la misma razón) para que el presupuesto y el
// oro TOTALES por oleada queden ≈iguales (dificultad y economía NEUTRAS). La
// elección STEP=0.35/BASE=3 hace mult ≈ R/3: cada carril abierto queda tan
// poblado como el carril de un mapa de 3 rutas (concilio ×1.7, granconcilio ×3).
// Campeones 👑 y JEFES quedan EXENTOS (un jefe es un jefe; los campeones ya son
// pocos a propósito): ni su cantidad ni su vida se tocan. La HORDA también queda
// EXENTA (solo hereda el reparto por rutas abiertas): su derrota es por CONTEO
// de vivos (HORDE_CAP) y densificar el conteo rompería esa neutralidad.
export const DOOR_DENSITY_BASE_ROUTES = 3;
export const DOOR_DENSITY_STEP = 0.35;
export const DOOR_DENSITY_CAP = 3;
// RAMPA por oleada: la densidad plena entra progresivamente (×min(full, 1+0.25·w)
// → full ×3 desde la oleada 8). PORQUÉ: las oleadas 1-9 del clásico son LECCIONES
// calibradas para pocas unidades; triplicar la o1 en un mapa de 9 puertas convertía
// el arranque en una avalancha injugable para equipos chicos (y el smoke de bots
// en granconcilio moría en la o2 en vez de la ~o3 esperada). Con la rampa, el
// early game conserva su curva y la marea crece hasta la densidad plena.
export const DOOR_DENSITY_WAVE_RAMP = 0.25;
// Tope duro de unidades no-jefe por oleada tras densificar (rendimiento: el
// endless profundo con presupuesto alto ×3 llegaría a ~600 spawns por oleada).
// La compensación de HP usa la razón REAL baseN/finalN, así que topar la cantidad
// NO rompe la neutralidad del presupuesto (solo deja de crecer la muchedumbre).
export const DOOR_DENSITY_UNIT_CAP = 260;

// multiplicador de cantidad según rutas abiertas y oleada (helper de sim/pruebas)
export function doorDensityMult(openRoutes: number, wave = 99): number {
  if (openRoutes <= DOOR_DENSITY_BASE_ROUTES) return 1;
  const full = Math.min(DOOR_DENSITY_CAP, 1 + DOOR_DENSITY_STEP * (openRoutes - DOOR_DENSITY_BASE_ROUTES));
  return Math.min(full, 1 + DOOR_DENSITY_WAVE_RAMP * wave);
}

// Normaliza una lista de puertas cerradas para un mapa de `pathCount` rutas.
// Fuente única (la usan sanitizeSettings, createGame y validateSaveData):
//  · solo mapas multi-puerta (≥ MULTI_DOOR_MIN rutas) — el resto queda sin cierres;
//  · índices enteros válidos, únicos y ORDENADOS (forma canónica, determinista);
//  · SIEMPRE al menos 1 ruta abierta: si el cliente pide cerrarlo todo se
//    recortan cierres por el FINAL (queda abierta la puerta de índice más alto).
export function sanitizeClosedDoors(pathCount: number, closed: unknown): number[] {
  if (pathCount < MULTI_DOOR_MIN || !Array.isArray(closed)) return [];
  const seen = new Set<number>();
  for (const d of closed) {
    if (typeof d === 'number' && Number.isInteger(d) && d >= 0 && d < pathCount) seen.add(d);
  }
  const out = [...seen].sort((a, b) => a - b);
  // nunca cerrar TODAS: recortar por el final hasta dejar al menos 1 abierta
  while (out.length >= pathCount) out.pop();
  return out;
}

// orden estable de los tipos de ataque (índice de los contadores del Adaptativo)
export const ATTACK_TYPE_ORDER: AttackTypeId[] = ['fisico', 'perforante', 'asedio', 'magico'];

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
// recetas de fusión nuevas (toxicstorm/shredder/siegeeye/alchemyvault/icelance) ·
// 17: SENTRY rediseñado — MEJORABLE (más radio, 3 niveles) y TEMPORAL (caduca por
// TICKS; duración 5/7.5/10 min por nivel; mejorar refresca el ward) ·
// 18 (F5.1): MATRIZ ataque×armadura (attackType/armorType + ATTACK_MATRIX en el
// daño directo), torre nueva 'flak' (Balista de Cielo, antiaérea pura), DoT
// porcentual de la Corrosión ★★, curva de hp del infinito en dos tramos, botín
// superlineal del endless y retoques de fusiones (Bertha/Fragmentador/Bóveda) —
// invalida guardados y replays de v17 (correcto: la sim ya no reproduce igual) ·
// 19 (F9a): calendario CLÁSICO fijo de 36 oleadas monoespecie (estilo Green TD),
// oleadas de CAMPEONES 👑, 7 monstruos nuevos, afijos de JEFE (Adaptativo/Aura
// Gélida), nerf del Barril (coste de equipo ×1.3 + daño con tope), niveles 5→10
// post-élite, Reparar Fortaleza (infinito/horda), Poder Vital y Estandarte del
// Vencedor (CRÍTICO determinista + Certeza) — invalida guardados/replays de v18
export const BALANCE_VERSION = 19;
export const PROTOCOL_VERSION = 1;
