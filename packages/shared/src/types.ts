export type Difficulty = 'easy' | 'normal' | 'hard';
export type GameMode = 'classic' | 'endless' | 'horde';
export type TargetMode = 'first' | 'last' | 'strong' | 'weak' | 'near';

export type TowerTypeId =
  | 'archer'
  | 'cannon'
  | 'frost'
  | 'poison'
  | 'tesla'
  | 'sniper'
  | 'mortar'
  | 'bank'
  | 'banner'
  // F4.2 — nuevas torres (al FINAL del orden de snapshot)
  | 'trap' // Trampa de púas: se coloca SOBRE el camino; daño físico por cargas
  | 'alchemist' // Alquimista: aura económica (+bounty por bajas en su radio)
  // F4.4 — al FINAL del orden de snapshot
  | 'boom' // Barril explosivo: SOBRE el camino; detona una vez en área y desaparece
  // Lote 3 — al FINAL del orden de snapshot
  | 'sentry'; // Sentry: NO ataca; REVELA a los monstruos invisibles dentro de su radio (item de tienda)

export type EnemyTypeId =
  | 'goblin'
  | 'runner'
  | 'brute'
  | 'bat'
  | 'armored'
  | 'shaman'
  | 'larva'
  | 'troll'
  | 'slime'
  | 'slimelet'
  | 'ghost'
  | 'golem'
  // F4.1 — nuevos monstruos y jefes (al FINAL del orden)
  | 'sapper' // Zapador: aturde la torre más cercana al camino
  | 'thief' // Ladrón: si escapa roba oro (no quita vidas)
  | 'berserker' // Berserker: corre más rápido bajo el 50% de vida
  | 'skywhale' // Coloso alado: volador tanque
  | 'wraith' // Espectro mayor: esquiva 50%, inmune a veneno, lento
  | 'chimera' // jefe volador de media partida
  | 'behemoth'; // jefe terrestre pesado que aturde torres al cruzar esquinas

// F4.3 · Fusión de torres (recetas curadas estilo Element TD). Dos torres
// ESPECIALIZADAS adyacentes del mismo dueño cuyos tipos formen una receta se
// fusionan en UNA torre con mecánica propia (defs en balance/fusions.ts).
export type FusionId =
  | 'glacialplague' // Hielo + Veneno — nube que ralentiza Y envenena en área
  | 'railstorm' // Tesla + Francotirador — rayo perforante en línea recta
  | 'bigbertha' // Cañón + Mortero — obús de mapa completo, cooldown enorme
  | 'warlord' // Arquero + Estandarte — dispara Y buffea como estandarte
  | 'philostone' // Veneno + Alquimista — sus bajas por veneno pagan botín doble
  | 'winterheart' // Hielo + Estandarte — aura doble: ralentiza enemigos y acelera torres
  // issue #7 — nuevas recetas (al FINAL del orden de snapshot)
  | 'toxicstorm' // Tesla + Veneno — cadena eléctrica que ENVENENA a cada enemigo que salta
  | 'shredder' // Arquero + Cañón — autocañón de metralla: ráfaga de obuses ligeros en área
  | 'siegeeye' // Francotirador + Mortero — ojo de asedio: dispara de mapa completo y REMATA
  | 'alchemyvault' // Mina + Alquimista — bóveda: renta por oleada Y aura de botín
  | 'icelance'; // Hielo + Francotirador — lanza gélida de largo alcance que casi congela

// Afijos de enemigos élite. Cada uno modifica el estado del enemigo (ver step.ts).
export type AffixId =
  | 'swift' // veloz
  | 'armored' // coraza
  | 'regen' // regenerador
  | 'vampiric' // vampírico (cura a los cercanos)
  | 'elusive' // escurridizo (esquiva)
  | 'frostward' // gélido (resiste el hielo)
  | 'explosive'; // explosivo (suelta crías al morir)

export interface Vec {
  x: number;
  y: number;
}

// ---------- Definiciones (balance) ----------

export interface TowerLevelDef {
  cost: number; // costo incremental de este nivel
  damage: number;
  range: number; // celdas
  cooldown: number; // segundos
  projectileSpeed?: number; // celdas/s; ausente = disparo instantáneo
  splash?: number; // radio en celdas
  slow?: { factor: number; duration: number }; // factor multiplica velocidad, duración en s
  poison?: { dps: number; duration: number };
  chain?: { targets: number; falloff: number };
  minRange?: number; // celdas (mortero)
  incomePerWave?: number; // oro al final de cada oleada (mina)
  pierceArmor?: boolean;
  // efectos exclusivos de las especializaciones (nivel 4):
  shots?: number; // dispara a varios objetivos a la vez
  execute?: number; // remata enemigos por debajo de esta fracción de vida (0..1)
  incomeToAll?: boolean; // el ingreso va a TODOS los jugadores
  slowAura?: { factor: number; radius: number }; // ralentiza pasivamente a su alrededor (no dispara)
  targetsAirOverride?: boolean; // sobrescribe si la torre alcanza aire
  // F6.2 · multiplicador de daño contra VOLADORES (la Metralla es LA respuesta
  // dura a los tanques aéreos tipo Coloso Alado; 1/ausente = sin bonus)
  airBonus?: number;
  // auras de soporte del Estandarte (no dispara): fracciones, p. ej. 0.25 = +25%.
  // El radio del aura es el propio `range`. Se toma el MEJOR de cada tipo, no se apilan.
  auraDamage?: number; // +daño a las torres cercanas (fracción)
  auraHaste?: number; // +cadencia a las torres cercanas (fracción; divide el cooldown)
  // --- F4.2 ---
  auraBounty?: number; // Alquimista: +bounty (fracción) a bajas dentro del radio (no dispara, no apila)
  charges?: number; // Trampa de púas: golpes disponibles antes de auto-venderse
  // Rango II de especialización (nivel 4): mecánica con rol, robada de los procs de
  // Green TD (ver GREENTD.md §6.2). Se activa mejorando una torre ya especializada.
  multishotRank2?: boolean; // *Ballesta Repetidora II*: 4 disparos (lo lleva `shots`)
  executeCurrent?: number; // *Cañón de Riel II*: remata por debajo de esta fracción de la vida ACTUAL (no inmunes)
  shredChance?: number; // *Obús/Metralla II*: prob. por impacto de reducir a la mitad la armadura en radio 1.5
  growth?: number; // *Arco Largo/Explorador II*: +daño base permanente por disparo
  // --- F4.3 · mecánicas exclusivas de las FUSIONES (balance/fusions.ts) ---
  lineWidth?: number; // *Tormenta de Riel*: rayo PERFORANTE — golpea a todos los enemigos a ≤ esta distancia de la línea de tiro (a inmunes −70%, como el Tesla)
  alsoFires?: boolean; // *Señor de la Guerra*: la torre tiene aura de Estandarte Y ADEMÁS dispara
  poisonBountyMult?: number; // *Piedra Filosofal*: multiplicador de botín de las bajas causadas por SU veneno (DoT)
}

// Especialización: se elige una de dos al llegar al nivel máximo. Es un bloque
// de stats completo con identidad propia (nombre, visual y mecánica). Con `rank2`
// puede mejorarse UNA vez más (nivel 4) pagando `rank2.cost`; los overrides de
// `rank2` reemplazan a los del Rango I al calcular stats con `level === 4`.
export interface TowerSpecDef extends TowerLevelDef {
  key: string; // id estable para el render
  name: string;
  desc: string;
  rank2?: TowerRank2Def; // mejora del Rango II (nivel 4)
}

// Overrides del Rango II: mismos campos que un nivel de torre, más su coste.
export interface TowerRank2Def extends Partial<TowerLevelDef> {
  cost: number;
  desc?: string; // descripción de la mejora (para el panel)
}

export interface TowerDef {
  id: TowerTypeId;
  name: string;
  desc: string;
  color: string;
  hotkey: string;
  targetsAir: boolean;
  targetsGround: boolean;
  projectileKind: 'bullet' | 'shell' | 'bomb' | 'none' | 'beam' | 'snipe';
  levels: [TowerLevelDef, TowerLevelDef, TowerLevelDef];
  specs: [TowerSpecDef, TowerSpecDef]; // ramas A/B al máximo nivel
  // F4.2 · Trampa de púas: única torre construible SOBRE el camino (y solo ahí).
  // El resto de torres siguen sin poder ir sobre el camino.
  onPathOnly?: boolean;
  // F4.4 · Barril explosivo: en cuanto un enemigo terrestre pisa su celda, DETONA
  // y se autodestruye: ELIMINA a los terrestres no-jefe en radio `splash`; a los
  // jefes les hace `damage` físico.
  detonates?: boolean;
  // Lote 3 · Sentry: NO ataca. Cada tick marca como DETECTADOS a los enemigos
  // invisibles dentro de su radio (= su `range`), volviéndolos targeteables y
  // visibles para todo el equipo. No dispara (towerFires lo excluye), no se mejora
  // ni especializa; solo se vende.
  detects?: boolean;
}

export interface EnemyDef {
  id: EnemyTypeId;
  name: string;
  hp: number;
  speed: number; // celdas/s
  bounty: number;
  armor: number; // reducción plana por golpe
  radius: number; // celdas
  livesCost: number;
  flying: boolean;
  color: string;
  regen?: number; // hp/s
  healAura?: { radius: number; hps: number };
  dodge?: number; // 0..1 prob. de esquivar proyectiles
  spawnOnDeath?: { type: EnemyTypeId; count: number };
  boss?: boolean;
  cost: number; // costo de presupuesto para el generador de oleadas
  minWave: number; // oleada mínima en la que puede aparecer
  // --- F4.1 ---
  spellImmune?: boolean; // inmune a slow del hielo, veneno, execute; el Tesla le hace −70%
  stealGold?: number; // Ladrón: oro que roba al equipo si escapa (no quita vidas)
  berserkBelow?: number; // Berserker: fracción de hp (0..1) bajo la cual acelera
  berserkMult?: number; // multiplicador de velocidad al enfurecerse (p. ej. 1.8)
  sapper?: boolean; // Zapador: se detiene junto a la torre más cercana y la aturde
  stunOnCorner?: { radius: number; seconds: number }; // Behemot: aturde torres al cruzar cada esquina
}

export interface MapDef {
  id: string;
  name: string;
  desc: string;
  gridW: number;
  gridH: number;
  // cada camino es una lista de waypoints [col, fila] (esquinas), segmentos alineados a los ejes
  paths: [number, number][][];
  blocked: [number, number][]; // celdas decorativas no construibles
  theme: 'grass' | 'desert' | 'snow' | 'volcano' | 'crystal';
}

// ---------- Estado de partida (runtime, vive en el servidor) ----------

export interface EnemyState {
  id: number;
  type: EnemyTypeId;
  x: number; // celdas (centro)
  y: number;
  hp: number;
  maxHp: number;
  pathIdx: number;
  wpIdx: number; // índice del próximo waypoint
  travelled: number; // distancia recorrida en celdas
  slowFactor: number; // 1 = sin slow
  slowUntil: number; // tick
  poisonDps: number;
  poisonUntil: number; // tick
  poisonSrc: number; // towerId que aplicó el veneno
  bountyMult: number;
  // --- élite y afijos (0/1/vacío en enemigos normales) ---
  elite: boolean;
  affixes: AffixId[];
  speedMult: number; // multiplicador de velocidad (1 = normal)
  armorBonus: number; // armadura extra plana
  regenBonus: number; // regeneración extra (hp/s)
  dodgeBonus: number; // esquiva extra (0..1)
  slowResist: number; // resistencia al hielo (0 = ninguna, 1 = inmune)
  radiusMult: number; // tamaño visual y de hitbox
  auraRadius: number; // aura de curación a aliados (vampírico)
  auraHps: number;
  deathSpawn: number; // crías que suelta al morir (explosivo)
  laps: number; // modo horda: vueltas completadas (cansancio: −10% maxHp base por vuelta)
  // --- F4.1 ---
  spellImmune: boolean; // inmune a magia (slow/veneno/execute; Tesla −70%)
  stunTowerId: number; // Zapador: torre que está aturdiendo (0 = ninguna aún)
  lastWpIdx: number; // Behemot: último waypoint cruzado (para aturdir una vez por esquina)
  // --- F4.2 ---
  armorShredUntil: number; // tick hasta el que su armadura efectiva está a la MITAD (shred del Obús/Metralla II). 0 = sin shred
  // --- Lote 3 · invisibilidad ---
  invisible: boolean; // nace en una oleada INVISIBLE: las torres no pueden apuntarle ni verlo salvo si un Sentry lo detecta
  detected: boolean; // recalculado por tick: true si está dentro del radio de algún Sentry del equipo (targeteable + visible)
  // --- ORO DE ASISTENCIA (co-op) · AL FINAL ---
  // Daño APLICADO acumulado por cada jugador contra este enemigo (playerId → daño; se
  // guarda el DUEÑO de la torre fuente EN EL MOMENTO del golpe, NO el towerId — la torre
  // puede venderse antes de la muerte). Lo alimentan damageEnemy (impactos/splash/línea/
  // trampa/barril) y el tick de veneno (por poisonSrc). Al morir, killEnemy busca aquí al
  // mayor dañador para el oro de asistencia. Determinista: acumulación en orden estable.
  dmgBy: Record<string, number>;
}

export interface TowerState {
  id: number;
  type: TowerTypeId;
  cx: number; // celda (entera)
  cy: number;
  level: number; // 1..3 (4 = Rango II de una especialización)
  spec: number; // -1 sin especializar, 0/1 rama elegida al máximo nivel
  owner: string; // playerId
  cooldownLeft: number; // ticks
  targetMode: TargetMode;
  invested: number; // oro total gastado (para venta)
  kills: number;
  damage: number;
  stunnedUntil: number; // tick hasta el que la torre está aturdida (no dispara). 0 = libre
  // --- F4.2 ---
  charges: number; // Trampa de púas: golpes restantes; a 0 se auto-vende. Otras torres: 0
  growthBonus: number; // *Arco Largo/Explorador II*: +daño base acumulado por disparo (crecimiento permanente)
  // --- F5.3 ---
  // Alquimista: oro EXTRA acumulado que su aura añadió a los botines (la parte
  // del bonus, no el botín entero). Demuestra en el panel si su posición paga.
  goldGen: number;
  // --- F4.3 ---
  // Índice en FUSION_ORDER de la fusión de esta torre; −1 = torre normal. Una torre
  // fusionada conserva su `type` (el de la celda elegida) SOLO para arte/compat: todo
  // su comportamiento sale de la def de la fusión (level=3, spec=−1, sin más mejoras).
  fusion: number;
  // --- Lote 4 · control avanzado ---
  // FOCUS: id del enemigo al que esta torre debe atacar (0 = sin focus, targetMode
  // normal). Si el enfocado muere/escapa, la sim lo limpia y vuelve al targetMode.
  // Si está VIVO pero fuera de rango, la torre dispara normal mientras tanto y
  // CONSERVA el focus para cuando vuelva a entrar en alcance (ver pickTarget).
  focusId: number;
  // STOP: una torre `halted` NO dispara (mismo gate que el aturdimiento). Solo
  // aplica a torres que disparan; las auras/economía no son halteables.
  halted: boolean;
}

export interface ProjectileState {
  id: number;
  kind: 'bullet' | 'shell' | 'bomb';
  x: number;
  y: number;
  targetId: number; // enemigo perseguido (bomb: 0, va a punto fijo)
  tx: number;
  ty: number;
  speed: number; // celdas/tick
  towerId: number;
  owner: string;
  damage: number;
  splash: number;
  slow?: { factor: number; durationTicks: number };
  poison?: { dps: number; durationTicks: number };
  pierceArmor: boolean;
  execute: number; // remata por debajo de esta fracción de vida MÁX (0 = nunca)
  color: string;
  groundOnly: boolean;
  // --- F4.2 ---
  executeCurrent: number; // remata por debajo de esta fracción de la vida ACTUAL (Cañón de Riel II; 0 = nunca)
  shredChance: number; // prob. de shred de armadura AoE por impacto (Obús/Metralla II; 0 = nunca)
  // --- F6.2 ---
  airBonus: number; // multiplicador de daño contra voladores (1 = sin bonus)
}

export interface PlayerStats {
  kills: number;
  damage: number;
  goldEarned: number;
  goldSpent: number;
  towersBuilt: number;
}

export interface PlayerState {
  id: string;
  name: string;
  color: string;
  gold: number;
  // F5.2 · madera: la tala el orco leñador implícito de cada jugador (+WOOD_PER_SEC
  // por segundo, automática); paga especializaciones (★) y Rango II (★★).
  wood: number;
  // F5.5 · nivel del orco leñador (1..ORC_RATES.length): más nivel = más tala/s.
  // Se mejora con oro (comando upgrade_orc, costes en ORC_UPGRADE_COSTS).
  orcLevel: number;
  connected: boolean;
  stats: PlayerStats;
}

export interface SpawnEntry {
  type: EnemyTypeId;
  delay: number; // ticks después del spawn anterior
  pathIdx: number;
  elite?: boolean;
  affixes?: AffixId[];
  // F4.1
  immune?: boolean; // oleada inmune: el enemigo nace spellImmune
  blessed?: boolean; // oleada bendecida: aplica un afijo común sin el ×2.6 de hp
  blessedAffix?: AffixId; // el afijo común de la oleada bendecida
  // Lote 3 · oleada invisible: el enemigo nace `invisible` (no en jefes)
  invisible?: boolean;
}

export interface WaveComp {
  type: EnemyTypeId;
  count: number;
}

export interface GameState {
  tick: number;
  mapId: string;
  mode: GameMode;
  difficulty: Difficulty;
  rng: number; // estado del RNG (mulberry32)
  lives: number;
  maxLives: number;
  wave: number; // oleada actual (0 = aún no empieza la primera)
  totalWaves: number; // 0 = infinito
  waveState: 'interlude' | 'active';
  interludeLeft: number; // ticks
  nextWaveComp: WaveComp[]; // vista previa de la próxima oleada
  // etiquetas de la PRÓXIMA oleada (telegrafía: 🛡 inmune / ⭐ bendecida / 🦅 aérea / ☠ jefe)
  nextWaveImmune: boolean;
  nextWaveBlessed: boolean;
  nextWaveFlying: boolean;
  nextWaveInvisible: boolean; // Lote 3 · la próxima oleada es INVISIBLE (telegrafía 👁)
  nextWaveBoss: EnemyTypeId | null;
  pendingWave: SpawnEntry[] | null; // oleada ya generada, esperando el fin del interludio
  pendingBoss: boolean;
  pendingBossType: EnemyTypeId | null; // jefe de la oleada pendiente (para el anuncio)
  blessedBonusMult: number; // multiplicador del bono de fin de oleada de la oleada ACTIVA (1 normal, 1.5 bendecida)
  spawnQueue: SpawnEntry[];
  spawnCooldown: number; // ticks hasta el próximo spawn
  enemies: EnemyState[];
  towers: TowerState[];
  projectiles: ProjectileState[];
  players: PlayerState[];
  // F5.4 · mercado global de madera: oro que cuesta 1 madera AHORA (compartido
  // por toda la sala; comprar lo sube, vender lo baja, revierte al fin de oleada)
  woodPrice: number;
  nextId: number;
  over: null | { victory: boolean };
}

// ---------- Comandos (cliente -> sim) ----------

export type Command =
  | { kind: 'place'; towerType: TowerTypeId; cx: number; cy: number }
  | { kind: 'upgrade'; towerId: number }
  | { kind: 'specialize'; towerId: number; spec: number }
  | { kind: 'sell'; towerId: number }
  | { kind: 'target'; towerId: number; mode: TargetMode }
  | { kind: 'call_wave' }
  // F5.4 · mercado global de madera: compra/vende WOOD_LOT madera al precio
  // actual de la sala (mueve el precio para todos)
  | { kind: 'buy_wood' }
  | { kind: 'sell_wood' }
  // F5.5 · mejora el orco leñador del jugador (oro → más tala/s, nivel 1..5)
  | { kind: 'upgrade_orc' }
  // F7.1 · TRANSFERENCIA a un aliado (estilo Green TD): envía `gold`/`wood` (enteros
  // ≥0, al menos uno >0) al jugador `to`. La sim valida destinatario, no-a-uno-mismo
  // y fondos; comando NO confiable → toda validación vive en applyCommands.
  | { kind: 'give'; to: string; gold: number; wood: number }
  // F4.3 · fusionar dos torres especializadas adyacentes con receta. `keepId` es la
  // torre cuya CELDA se conserva (debe ser towerId u otherId); la otra queda libre.
  | { kind: 'fuse'; towerId: number; otherId: number; keepId: number }
  // Lote 4 · FOCUS: la torre ataca a ESE enemigo (enemyId 0 = quitar el focus y
  // volver al targetMode automático). Solo torres que DISPARAN, del dueño.
  | { kind: 'focus'; towerId: number; enemyId: number }
  // Lote 4 · STOP/REANUDAR: on=true detiene la torre (no dispara), on=false la
  // reanuda. Solo torres que DISPARAN, del dueño.
  | { kind: 'halt'; towerId: number; on: boolean };

export interface PlayerCommand {
  playerId: string;
  cmd: Command;
}

// ---------- Repeticiones (replays) ----------
//
// Un replay es {semilla + roster inicial + línea de tiempo de entradas}. La sim
// determinista lo reproduce EXACTO. Cada entrada lleva el TICK DE SIM `t` en el
// que ocurre (el `game.tick` ANTES del stepGame que la aplica). Es CRÍTICO grabar
// todo lo que afecte a `connectedCount` (join/conn), porque el escalado de HP y el
// presupuesto de oleada dependen del número de jugadores CONECTADOS.

export interface ReplayPlayer {
  id: string;
  name: string;
  color: string;
}

export type ReplayEntry =
  // un comando aplicado por un jugador en el tick `t`
  | { t: number; kind: 'cmd'; playerId: string; cmd: Command }
  // un jugador entra a mitad de partida en el tick `t` (con su oro exacto de midJoin;
  // `wood` opcional para replays previos a F5.2)
  | { t: number; kind: 'join'; player: ReplayPlayer; gold: number; wood?: number }
  // cambio de conexión de un jugador en el tick `t` (afecta a connectedCount)
  | { t: number; kind: 'conn'; playerId: string; connected: boolean };

export interface ReplayData {
  v: number; // BALANCE_VERSION con el que se grabó (guard de versión al reproducir)
  seed: number; // semilla elegida en startGame
  mapId: string;
  mode: GameMode;
  difficulty: Difficulty;
  players: ReplayPlayer[]; // roster inicial (los que estaban al empezar)
  log: ReplayEntry[]; // línea de tiempo de entradas, ordenada por tick
  finalTick: number; // tick en el que la partida terminó (para el seek y el assert)
  victory: boolean;
  wave: number; // oleada alcanzada
}

// ---------- Eventos (sim -> clientes, efímeros por tick) ----------

export type GameEvent =
  | { e: 'shot'; x: number; y: number; tx: number; ty: number; kind: 'beam' | 'snipe'; color: string }
  | { e: 'chain'; pts: [number, number][]; color: string }
  | { e: 'hit'; x: number; y: number; r: number; kind: 'splash' | 'impact' | 'poison' | 'frost' }
  | { e: 'shred'; x: number; y: number; r: number } // proc de shred de armadura (Obús/Metralla II)
  // `alch`: parte del botín añadida por un aura de Alquimista (ausente/0 = sin
  // bonus). El cliente la usa para destacar el botín aumentado (⚗ en verde).
  | { e: 'death'; x: number; y: number; type: EnemyTypeId; bounty: number; killer: string; elite: boolean; alch?: number }
  | { e: 'miss'; x: number; y: number }
  | { e: 'leak'; lives: number; type: EnemyTypeId }
  | { e: 'steal'; gold: number; x: number; y: number } // el Ladrón escapó y robó oro
  | { e: 'wave_start'; wave: number; comp: WaveComp[] }
  | { e: 'wave_end'; wave: number; bonus: number }
  | { e: 'income'; playerId: string; amount: number; x: number; y: number }
  // F5.4 · operación del mercado de madera: `gold` = oro pagado (compra) o
  // recibido (venta); `price` = precio DESPUÉS de la operación (2 decimales)
  | { e: 'trade'; playerId: string; buy: boolean; wood: number; gold: number; price: number }
  // F5.5 · el orco de un jugador subió de nivel (rate = nueva tala/s)
  | { e: 'orc'; playerId: string; level: number; rate: number }
  // F7.1 · un jugador REGALÓ recursos a otro: el cliente lo convierte en toasts
  // (emisor y receptor) y una línea de killfeed para toda la sala
  | { e: 'give'; from: string; to: string; gold: number; wood: number }
  | { e: 'place'; x: number; y: number; towerType: TowerTypeId }
  | { e: 'upgrade'; x: number; y: number; level: number }
  | { e: 'specialize'; x: number; y: number; towerType: TowerTypeId; spec: number; name: string }
  | { e: 'fuse'; x: number; y: number; fusion: FusionId; name: string } // F4.3: FX + toast de fusión
  | { e: 'sell'; x: number; y: number; refund: number }
  | { e: 'reject'; playerId: string; reason: string }
  | { e: 'boss'; name: string }
  | { e: 'gameover'; victory: boolean }
  | { e: 'sys'; msg: string }
  // ORO DE ASISTENCIA (co-op): el mayor dañador de un enemigo (≥35% de su maxHp) cobra
  // un extra al morir este SI no fue quien dio el golpe final. `player` = playerId del
  // asistente; `gold` = oro cobrado. El cliente pinta "+N 🤝" en su color.
  | { e: 'assist'; x: number; y: number; gold: number; player: string };
