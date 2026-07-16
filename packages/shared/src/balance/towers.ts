import type { TowerDef, TowerLevelDef, TowerSpecDef, TowerTypeId } from '../types.js';

// Orden estable: se usa como índice compacto en los snapshots.
export const TOWER_ORDER: TowerTypeId[] = [
  'archer',
  'cannon',
  'frost',
  'poison',
  'tesla',
  'sniper',
  'mortar',
  'bank',
  'banner',
  // F4.2 — al FINAL para no romper índices de snapshot
  'trap',
  'alchemist',
  // F4.4 — al FINAL para no romper índices de snapshot
  'boom',
  // Lote 3 — al FINAL para no romper índices de snapshot
  'sentry',
  // F5.1 — al FINAL para no romper índices de snapshot
  'flak',
];

export const TOWERS: Record<TowerTypeId, TowerDef> = {
  archer: {
    id: 'archer',
    name: 'Arquero',
    desc: 'Barato y rápido. Dispara a tierra y aire.',
    color: '#8bc34a',
    hotkey: '1',
    targetsAir: true,
    targetsGround: true,
    projectileKind: 'bullet',
    attackType: 'fisico',
    levels: [
      { cost: 50, damage: 8, range: 2.6, cooldown: 0.7, projectileSpeed: 14 },
      { cost: 70, damage: 15, range: 2.9, cooldown: 0.6, projectileSpeed: 15 },
      { cost: 115, damage: 27, range: 3.2, cooldown: 0.5, projectileSpeed: 16 },
    ],
    specs: [
      {
        key: 'repeater',
        name: 'Ballesta Repetidora',
        desc: 'Dispara tres saetas a la vez, casi sin pausa.',
        cost: 240,
        damage: 22,
        range: 3.3,
        cooldown: 0.3,
        projectileSpeed: 18,
        shots: 3,
        rank2: {
          // *Multidisparo II*: 4 disparos + más daño/alcance.
          cost: 360,
          desc: 'Multidisparo II: 4 saetas simultáneas.',
          damage: 40,
          range: 3.6,
          cooldown: 0.28,
          shots: 4,
          multishotRank2: true,
        },
      },
      {
        key: 'longbow',
        name: 'Arco Largo',
        desc: 'Alcance y daño enormes; sus flechas perforan armadura.',
        cost: 240,
        damage: 78,
        range: 5.2,
        cooldown: 0.75,
        projectileSpeed: 20,
        pierceArmor: true,
        rank2: {
          // *Precisión II*: crecimiento permanente — +8 de daño base por disparo.
          cost: 400,
          desc: 'Precisión II: +8 de daño base por cada disparo, para siempre.',
          damage: 140,
          range: 5.8,
          cooldown: 0.7,
          growth: 8,
        },
      },
    ],
  },
  cannon: {
    id: 'cannon',
    name: 'Cañón',
    desc: 'Daño en área. Solo alcanza enemigos terrestres.',
    color: '#ff7043',
    hotkey: '2',
    targetsAir: false,
    targetsGround: true,
    projectileKind: 'shell',
    attackType: 'asedio',
    levels: [
      { cost: 90, damage: 24, range: 2.4, cooldown: 1.6, projectileSpeed: 10, splash: 0.9 },
      { cost: 135, damage: 44, range: 2.6, cooldown: 1.5, projectileSpeed: 10, splash: 1.05 },
      { cost: 215, damage: 78, range: 2.9, cooldown: 1.4, projectileSpeed: 11, splash: 1.2 },
    ],
    specs: [
      {
        key: 'howitzer',
        name: 'Obús',
        desc: 'Un proyectil descomunal con área devastadora.',
        cost: 380,
        damage: 155,
        range: 3.3,
        cooldown: 1.5,
        projectileSpeed: 11,
        splash: 1.9,
        rank2: {
          // *AoE II*: proc de shred de armadura AoE (habilita al resto de torres).
          cost: 420,
          desc: 'AoE II: cada impacto, 3% de reducir a la mitad la armadura en área durante 4 s.',
          damage: 260,
          range: 3.6,
          cooldown: 1.5,
          splash: 2.1,
          shredChance: 0.03,
        },
      },
      {
        key: 'flak',
        name: 'Metralla',
        desc: 'Ráfaga doble antiaérea: a los VOLADORES les hace +50% de daño.',
        cost: 380,
        damage: 52,
        range: 3.0,
        cooldown: 1.1,
        projectileSpeed: 12,
        splash: 1.0,
        shots: 2,
        targetsAirOverride: true,
        // F6.2 · LA respuesta dura a los tanques aéreos (Coloso Alado): la
        // metralla despedaza voladores. Sin esto, un coloso de horda alta
        // (~10k hp) era una esponja eterna para todo el arsenal.
        airBonus: 1.5,
        rank2: {
          // *Antiaéreo II*: ráfaga triple demoledora; aún más letal contra el aire.
          // F5.1 · nerf sutil al mono-build: coste 400→460 (+15%) y daño 90→83 (−8%).
          // El golpe de verdad se lo da la MATRIZ (asedio ×0.65 vs ligera): la
          // Metralla sigue siendo la respuesta de ÁREA al aire pesado, pero deja
          // de borrar sola los enjambres ligeros (eso ahora es de la Balista).
          cost: 460,
          desc: 'Antiaéreo II: ráfaga triple, más daño y área; +60% contra voladores.',
          damage: 83,
          range: 3.3,
          cooldown: 1.0,
          splash: 1.2,
          shots: 3,
          airBonus: 1.6,
        },
      },
    ],
  },
  frost: {
    id: 'frost',
    name: 'Hielo',
    desc: 'Poco daño pero congela: los enemigos van mucho más lento.',
    color: '#4fc3f7',
    hotkey: '3',
    targetsAir: true,
    targetsGround: true,
    projectileKind: 'bullet',
    attackType: 'magico',
    levels: [
      { cost: 70, damage: 4, range: 2.3, cooldown: 0.9, projectileSpeed: 12, slow: { factor: 0.55, duration: 1.6 } },
      { cost: 100, damage: 7, range: 2.5, cooldown: 0.85, projectileSpeed: 13, slow: { factor: 0.45, duration: 2.1 } },
      { cost: 165, damage: 13, range: 2.8, cooldown: 0.8, projectileSpeed: 14, slow: { factor: 0.33, duration: 2.7 } },
    ],
    specs: [
      {
        key: 'glacier',
        name: 'Glaciar',
        desc: 'Casi congela por completo y a todo un grupo a la vez.',
        cost: 320,
        damage: 30,
        range: 3.0,
        cooldown: 0.9,
        projectileSpeed: 14,
        splash: 1.4,
        slow: { factor: 0.15, duration: 3.2 },
        rank2: {
          // *Glaciar II*: casi congela por completo, área enorme y más daño.
          cost: 360,
          desc: 'Glaciar II: congela más y en mayor área.',
          damage: 60,
          range: 3.3,
          cooldown: 0.85,
          splash: 1.7,
          slow: { factor: 0.1, duration: 3.6 },
        },
      },
      {
        key: 'permafrost',
        name: 'Escarcha Eterna',
        desc: 'No dispara: ralentiza sin parar a todo lo que la rodea.',
        cost: 300,
        damage: 0,
        range: 2.8,
        cooldown: 0.8,
        slowAura: { factor: 0.5, radius: 2.7 },
        rank2: {
          // *Escarcha II*: aura más amplia y ralentización más fuerte.
          cost: 340,
          desc: 'Escarcha II: aura más grande y ralentización más brutal.',
          slowAura: { factor: 0.35, radius: 3.3 },
        },
      },
    ],
  },
  poison: {
    id: 'poison',
    name: 'Veneno',
    desc: 'Envenena: daño sostenido que ignora la armadura.',
    color: '#9ccc65',
    hotkey: '4',
    targetsAir: true,
    targetsGround: true,
    projectileKind: 'bullet',
    attackType: 'magico',
    levels: [
      { cost: 80, damage: 6, range: 2.5, cooldown: 1.1, projectileSpeed: 12, poison: { dps: 10, duration: 3 } },
      { cost: 120, damage: 10, range: 2.7, cooldown: 1.05, projectileSpeed: 13, poison: { dps: 19, duration: 3.2 } },
      { cost: 195, damage: 17, range: 2.9, cooldown: 1.0, projectileSpeed: 14, poison: { dps: 34, duration: 3.5 } },
    ],
    specs: [
      {
        key: 'plague',
        name: 'Plaga',
        desc: 'Nube tóxica en área con veneno brutal.',
        cost: 360,
        damage: 20,
        range: 3.0,
        cooldown: 1.0,
        projectileSpeed: 14,
        splash: 1.15,
        poison: { dps: 60, duration: 4 },
        rank2: {
          // *Plaga II*: veneno de área devastador.
          cost: 380,
          desc: 'Plaga II: nube tóxica más grande con veneno demoledor.',
          damage: 34,
          range: 3.3,
          cooldown: 0.95,
          splash: 1.4,
          poison: { dps: 120, duration: 4.5 },
        },
      },
      {
        key: 'corrosion',
        name: 'Corrosión',
        desc: 'Ácido que perfora armadura y derrite hasta a los más gordos.',
        cost: 360,
        damage: 34,
        range: 2.9,
        cooldown: 0.85,
        projectileSpeed: 14,
        poison: { dps: 95, duration: 4 },
        pierceArmor: true,
        rank2: {
          // *Corrosión II*: ácido que derrite tanques enteros. F5.1 · daño
          // PORCENTUAL oficial del lategame: su DoT garantiza al menos el 1.2%
          // de la vida MÁXIMA por segundo (poisonPctMax), con tope de
          // POISON_PCT_CAP_DPS (400 dps) — contra enemigos normales manda el dps
          // plano (no rompe el clásico); contra las esponjas del infinito, el %.
          cost: 400,
          desc: 'Corrosión II: ácido que derrite en proporción al tamaño — al menos el 1,2% de la vida MÁXIMA por segundo (tope 400/s).',
          damage: 60,
          range: 3.2,
          cooldown: 0.8,
          poison: { dps: 190, duration: 4.5 },
          poisonPctMax: 0.012,
        },
      },
    ],
  },
  tesla: {
    id: 'tesla',
    name: 'Tesla',
    desc: 'Rayo instantáneo que salta entre varios enemigos.',
    color: '#ffee58',
    hotkey: '5',
    targetsAir: true,
    targetsGround: true,
    projectileKind: 'beam',
    attackType: 'magico',
    levels: [
      { cost: 120, damage: 18, range: 2.2, cooldown: 1.3, chain: { targets: 3, falloff: 0.7 } },
      { cost: 180, damage: 32, range: 2.4, cooldown: 1.2, chain: { targets: 4, falloff: 0.72 } },
      { cost: 290, damage: 55, range: 2.7, cooldown: 1.1, chain: { targets: 5, falloff: 0.75 } },
    ],
    specs: [
      {
        key: 'storm',
        name: 'Tormenta',
        desc: 'El rayo salta entre casi toda la horda.',
        cost: 420,
        damage: 70,
        range: 3.3,
        cooldown: 1.0,
        chain: { targets: 9, falloff: 0.86 },
        rank2: {
          // *Tormenta II*: el rayo salta entre la horda entera, más fuerte.
          cost: 460,
          desc: 'Tormenta II: el rayo salta más lejos y más veces.',
          damage: 120,
          range: 3.7,
          cooldown: 0.95,
          chain: { targets: 12, falloff: 0.9 },
        },
      },
      {
        key: 'railgun',
        name: 'Riel',
        desc: 'Un único impacto colosal que perfora armadura.',
        cost: 420,
        damage: 240,
        range: 4.2,
        cooldown: 1.6,
        chain: { targets: 1, falloff: 1 },
        pierceArmor: true,
        rank2: {
          // *Riel II*: impacto todavía más colosal y de mayor alcance.
          cost: 480,
          desc: 'Riel II: impacto único aún más demoledor.',
          damage: 460,
          range: 4.8,
          cooldown: 1.55,
        },
      },
    ],
  },
  sniper: {
    id: 'sniper',
    name: 'Francotirador',
    desc: 'Alcance enorme, daño altísimo y perfora armadura. Muy lento.',
    color: '#b0bec5',
    hotkey: '6',
    targetsAir: true,
    targetsGround: true,
    projectileKind: 'snipe',
    attackType: 'perforante',
    levels: [
      { cost: 130, damage: 60, range: 5.5, cooldown: 3.2, pierceArmor: true },
      { cost: 195, damage: 115, range: 6.5, cooldown: 3.0, pierceArmor: true },
      { cost: 310, damage: 210, range: 7.5, cooldown: 2.8, pierceArmor: true },
    ],
    specs: [
      {
        key: 'railcannon',
        name: 'Cañón de Riel',
        desc: 'Daño demoledor; remata a los enemigos malheridos al instante.',
        cost: 520,
        damage: 480,
        range: 8.5,
        cooldown: 3.0,
        pierceArmor: true,
        execute: 0.15,
        rank2: {
          // *Ejecución II*: la ejecución pasa de umbral fijo (15% de la vida MÁX)
          // a rematar por debajo del 75% de la vida ACTUAL (anti-tanque; no inmunes).
          cost: 460,
          desc: 'Ejecución II: remata por debajo del 75% de la vida ACTUAL (no funciona contra inmunes).',
          damage: 620,
          range: 9.0,
          cooldown: 2.9,
          execute: 0,
          executeCurrent: 0.75,
        },
      },
      {
        key: 'ranger',
        name: 'Explorador',
        desc: 'Dispara mucho más rápido sin perder alcance.',
        cost: 480,
        damage: 150,
        range: 7.0,
        cooldown: 1.3,
        pierceArmor: true,
        rank2: {
          // *Explorador II*: cadencia y daño superiores, sin perder alcance.
          cost: 420,
          desc: 'Explorador II: dispara aún más rápido y más fuerte.',
          damage: 260,
          range: 7.5,
          cooldown: 1.1,
        },
      },
    ],
  },
  mortar: {
    id: 'mortar',
    name: 'Mortero',
    desc: 'Artillería de largo alcance con gran área. No dispara de cerca ni al aire.',
    color: '#a1887f',
    hotkey: '7',
    targetsAir: false,
    targetsGround: true,
    projectileKind: 'bomb',
    attackType: 'asedio',
    levels: [
      { cost: 140, damage: 42, range: 6.0, cooldown: 2.9, projectileSpeed: 5.5, splash: 1.3, minRange: 2.0 },
      { cost: 210, damage: 75, range: 6.6, cooldown: 2.8, projectileSpeed: 6, splash: 1.5, minRange: 2.0 },
      { cost: 330, damage: 130, range: 7.2, cooldown: 2.7, projectileSpeed: 6.5, splash: 1.7, minRange: 2.0 },
    ],
    specs: [
      {
        key: 'barrage',
        name: 'Bombardeo',
        desc: 'Lanza tres bombas por andanada. Lluvia de fuego.',
        cost: 520,
        damage: 130,
        range: 7.5,
        cooldown: 3.0,
        projectileSpeed: 6.5,
        splash: 1.7,
        minRange: 2.0,
        shots: 3,
        rank2: {
          // *Bombardeo II*: cuatro bombas por andanada, más daño y área.
          // F5.1 · nerf sutil al mono-build: coste 480→550 (+15%) y daño 230→212
          // (−8%). Conservador a propósito: el mono-mortero muere por la MATRIZ
          // (asedio araña ligera), no por este recorte.
          cost: 550,
          desc: 'Bombardeo II: cuatro bombas por andanada.',
          damage: 212,
          range: 8.0,
          cooldown: 2.9,
          splash: 1.9,
          shots: 4,
        },
      },
      {
        key: 'napalm',
        name: 'Napalm',
        desc: 'Deja el terreno ardiendo: veneno de fuego en toda el área.',
        cost: 500,
        damage: 90,
        range: 7.2,
        cooldown: 2.8,
        projectileSpeed: 6,
        splash: 1.9,
        minRange: 2.0,
        poison: { dps: 55, duration: 4 },
        rank2: {
          // *Napalm II*: incendio de área más letal y duradero.
          cost: 460,
          desc: 'Napalm II: fuego que arde más fuerte en mayor área.',
          damage: 160,
          range: 7.7,
          cooldown: 2.7,
          splash: 2.2,
          poison: { dps: 110, duration: 4.5 },
        },
      },
    ],
  },
  bank: {
    id: 'bank',
    name: 'Mina de oro',
    desc: 'No ataca: genera oro para su dueño al final de cada oleada.',
    color: '#ffd54f',
    hotkey: '8',
    targetsAir: false,
    targetsGround: false,
    projectileKind: 'none',
    attackType: 'fisico', // nominal: no hace daño directo, jamás entra en la matriz
    levels: [
      { cost: 100, damage: 0, range: 0, cooldown: 0, incomePerWave: 14 },
      { cost: 160, damage: 0, range: 0, cooldown: 0, incomePerWave: 26 },
      { cost: 260, damage: 0, range: 0, cooldown: 0, incomePerWave: 48 },
    ],
    specs: [
      {
        key: 'treasury',
        name: 'Tesorería',
        desc: 'Ingreso enorme para su dueño cada oleada.',
        cost: 320,
        damage: 0,
        range: 0,
        cooldown: 0,
        incomePerWave: 110,
        rank2: {
          // *Tesorería II*: ingreso descomunal para su dueño.
          cost: 360,
          desc: 'Tesorería II: ingreso aún mayor cada oleada.',
          incomePerWave: 200,
        },
      },
      {
        key: 'mint',
        name: 'Casa de Moneda',
        desc: 'Reparte oro a TODO el equipo cada oleada.',
        cost: 320,
        damage: 0,
        range: 0,
        cooldown: 0,
        incomePerWave: 55,
        incomeToAll: true,
        rank2: {
          // *Casa de Moneda II*: reparte mucho más oro a todo el equipo.
          cost: 360,
          desc: 'Casa de Moneda II: reparte más oro a todo el equipo.',
          incomePerWave: 100,
        },
      },
    ],
  },
  banner: {
    id: 'banner',
    name: 'Estandarte',
    desc: 'No ataca: refuerza a las torres cercanas de todo el equipo.',
    color: '#ffca28',
    hotkey: '9',
    targetsAir: false,
    targetsGround: false,
    projectileKind: 'none',
    attackType: 'fisico', // nominal: no hace daño directo, jamás entra en la matriz
    levels: [
      { cost: 90, damage: 0, range: 2.2, cooldown: 0, auraDamage: 0.15 },
      { cost: 140, damage: 0, range: 2.6, cooldown: 0, auraDamage: 0.25 },
      { cost: 220, damage: 0, range: 3.0, cooldown: 0, auraDamage: 0.35 },
    ],
    specs: [
      {
        key: 'warbanner',
        name: 'Estandarte de Guerra',
        desc: 'Aura de daño brutal: las torres cercanas pegan mucho más fuerte.',
        cost: 360,
        damage: 0,
        range: 3.0,
        cooldown: 0,
        auraDamage: 0.6,
        rank2: {
          // *Estandarte de Guerra II*: aura de daño aún más brutal y amplia.
          cost: 400,
          desc: 'Guerra II: aura de daño más fuerte y de mayor radio.',
          range: 3.4,
          auraDamage: 0.85,
        },
      },
      {
        key: 'hastebanner',
        name: 'Estandarte de Celeridad',
        desc: 'Aura de cadencia: las torres cercanas disparan mucho más rápido.',
        cost: 360,
        damage: 0,
        range: 3.0,
        cooldown: 0,
        auraHaste: 0.4,
        auraDamage: 0,
        rank2: {
          // *Estandarte de Celeridad II*: aura de cadencia superior y más amplia.
          cost: 400,
          desc: 'Celeridad II: aura de cadencia más fuerte y de mayor radio.',
          range: 3.4,
          auraHaste: 0.6,
        },
      },
    ],
  },

  // ---------- F4.2 · Trampa de púas ----------
  trap: {
    id: 'trap',
    name: 'Trampa de púas',
    desc: 'Se coloca SOBRE el camino. Daño físico por cargas: hiere a quien pasa por encima. Funciona contra inmunes.',
    color: '#c62828',
    hotkey: '0',
    targetsAir: false,
    targetsGround: true,
    projectileKind: 'none',
    attackType: 'asedio',
    onPathOnly: true,
    levels: [
      // No dispara: `charges` marca los golpes disponibles. `damage` es el daño por
      // golpe (físico, ignora inmunidad). No se puede mejorar ni especializar.
      { cost: 60, damage: 55, range: 0, cooldown: 0, charges: 20 },
      { cost: 60, damage: 55, range: 0, cooldown: 0, charges: 20 },
      { cost: 60, damage: 55, range: 0, cooldown: 0, charges: 20 },
    ],
    specs: [
      { key: 'trap', name: 'Trampa de púas', desc: 'No se especializa.', cost: 0, damage: 55, range: 0, cooldown: 0, charges: 20 },
      { key: 'trap', name: 'Trampa de púas', desc: 'No se especializa.', cost: 0, damage: 55, range: 0, cooldown: 0, charges: 20 },
    ],
  },

  // ---------- F4.2 · Alquimista ----------
  alchemist: {
    id: 'alchemist',
    name: 'Alquimista',
    desc: 'No ataca: las bajas de enemigos dentro de su radio dan +30% de oro. No apila.',
    color: '#43a047',
    hotkey: 'q',
    targetsAir: false,
    targetsGround: false,
    projectileKind: 'none',
    attackType: 'fisico', // nominal: no hace daño directo, jamás entra en la matriz
    levels: [
      { cost: 120, damage: 0, range: 2.4, cooldown: 0, auraBounty: 0.3 },
      { cost: 170, damage: 0, range: 2.8, cooldown: 0, auraBounty: 0.3 },
      { cost: 260, damage: 0, range: 3.2, cooldown: 0, auraBounty: 0.3 },
    ],
    specs: [
      {
        key: 'transmuter',
        name: 'Transmutador',
        desc: 'Aura económica enorme: bajas cercanas dan mucho más oro.',
        cost: 340,
        damage: 0,
        range: 3.6,
        cooldown: 0,
        auraBounty: 0.5,
        rank2: {
          // *Transmutador II*: aura económica todavía más generosa y amplia.
          cost: 380,
          desc: 'Transmutador II: bajas cercanas dan aún más oro, en mayor radio.',
          range: 4.0,
          auraBounty: 0.7,
        },
      },
      {
        key: 'philosopher',
        name: 'Filósofo',
        desc: 'Aura económica de gran alcance para cubrir todo un flanco.',
        cost: 340,
        damage: 0,
        range: 4.4,
        cooldown: 0,
        auraBounty: 0.35,
        rank2: {
          // *Filósofo II*: aura de alcance descomunal y más bounty.
          cost: 380,
          desc: 'Filósofo II: cubre un radio enorme con más oro por baja.',
          range: 5.2,
          auraBounty: 0.45,
        },
      },
    ],
  },

  // ---------- F4.4 · Barril explosivo ----------
  boom: {
    id: 'boom',
    name: 'Barril explosivo',
    desc: 'Se coloca SOBRE el camino. Detona UNA vez cuando lo pisan: ELIMINA a los enemigos terrestres del área (los jefes solo reciben daño). Funciona contra inmunes.',
    color: '#ff7043',
    hotkey: 'w',
    targetsAir: false,
    targetsGround: true,
    projectileKind: 'none',
    attackType: 'asedio',
    onPathOnly: true,
    detonates: true,
    levels: [
      // Un solo uso: `charges: 1` (la detonación la consume y el barril desaparece).
      // La detonación ELIMINA a todo no-jefe terrestre en radio `splash`; a los
      // JEFES les hace `damage` físico (con armadura). No se mejora ni se
      // especializa: es un botón de pánico barato.
      { cost: 90, damage: 240, range: 0, cooldown: 0, splash: 1.7, charges: 1 },
      { cost: 90, damage: 240, range: 0, cooldown: 0, splash: 1.7, charges: 1 },
      { cost: 90, damage: 240, range: 0, cooldown: 0, splash: 1.7, charges: 1 },
    ],
    specs: [
      { key: 'boom', name: 'Barril explosivo', desc: 'No se especializa.', cost: 0, damage: 240, range: 0, cooldown: 0, splash: 1.7, charges: 1 },
      { key: 'boom', name: 'Barril explosivo', desc: 'No se especializa.', cost: 0, damage: 240, range: 0, cooldown: 0, splash: 1.7, charges: 1 },
    ],
  },

  // ---------- Lote 3 · Sentry (item de la Tienda) ----------
  sentry: {
    id: 'sentry',
    name: 'Sentry',
    desc: 'No ataca: REVELA a los monstruos invisibles (terrestres y aéreos) dentro de su radio, volviéndolos targeteables para todo el equipo.',
    color: '#29b6f6',
    hotkey: 'e',
    targetsAir: false,
    targetsGround: false,
    projectileKind: 'none',
    attackType: 'fisico', // nominal: no hace daño directo, jamás entra en la matriz
    // `detects`: cada tick marca como detectados a los invisibles dentro de su `range`.
    // No dispara (towerFires lo excluye) y NO se especializa (specs dummy como la
    // Trampa), pero v17 lo hace MEJORABLE: 3 niveles reales que suben el RADIO
    // (=`range`) 3.5 → 4.2 → 5.0. Es un consumible TEMPORAL y RECURRENTE (caduca), así
    // que los costes de mejora son baratos (L1 50 como siempre; L2 40; L3 60). Mejorar
    // además REFRESCA la duración al total del nuevo nivel (ver SENTRY_DURATION_SEC y
    // sim/commands.ts). `range` = radio de detección.
    detects: true,
    levels: [
      { cost: 50, damage: 0, range: 3.5, cooldown: 0 },
      { cost: 40, damage: 0, range: 4.2, cooldown: 0 },
      { cost: 60, damage: 0, range: 5.0, cooldown: 0 },
    ],
    // specs dummy: nunca se usan (specialize rechaza al Sentry). Radio alineado con L3.
    specs: [
      { key: 'sentry', name: 'Sentry', desc: 'No se especializa.', cost: 0, damage: 0, range: 5.0, cooldown: 0 },
      { key: 'sentry', name: 'Sentry', desc: 'No se especializa.', cost: 0, damage: 0, range: 5.0, cooldown: 0 },
    ],
  },

  // ---------- F5.1 · Balista de Cielo (antiaérea PURA) ----------
  flak: {
    id: 'flak',
    name: 'Balista de Cielo',
    desc: 'SOLO dispara al AIRE: dardos perforantes que cazan voladores (los colosales sufren +50% por la matriz). No puede tocar el suelo.',
    color: '#8c9eff',
    hotkey: 'r',
    targetsAir: true,
    // Primera torre del juego que NO pega a tierra: su trade-off de diseño ES ese.
    // A cambio, es claramente LA respuesta aérea (perforante ×1.5 vs colosal, DPS
    // por oro muy por encima del resto contra voladores). pickTarget ya respeta
    // targetsGround=false (mismo gate que targetsAir).
    targetsGround: false,
    projectileKind: 'bullet',
    attackType: 'perforante',
    levels: [
      // costes en línea con el francotirador (130/195/310); daño/cadencia pensados
      // para superar CLARAMENTE en DPS antiaéreo a cualquier generalista de su
      // precio (el banco antiaéreo de balance-probe la pone ~+30% por oro sobre
      // el Tesla y muy por encima del arquero/francotirador contra el aire).
      { cost: 140, damage: 48, range: 4.2, cooldown: 0.9, projectileSpeed: 18 },
      { cost: 205, damage: 90, range: 4.6, cooldown: 0.85, projectileSpeed: 19 },
      { cost: 325, damage: 165, range: 5.0, cooldown: 0.8, projectileSpeed: 20 },
    ],
    specs: [
      {
        // rol A: limpiadora de ENJAMBRES aéreos (bats/quimeras de escolta) — la
        // ráfaga reparte agujas entre varios blancos (shots), sin splash: al no
        // tener área ni tocar tierra, ningún daño puede "colarse" al suelo. Debe
        // GANAR a la Metralla ★★ en daño/oro contra un flujo aéreo (sonda F5.1):
        // es el pago por renunciar del todo al suelo.
        key: 'needlerain',
        name: 'Ráfaga de Agujas',
        desc: 'Aguja tras aguja: ráfaga doble a cadencia máxima contra todo lo que vuele.',
        cost: 500,
        damage: 68,
        range: 5.2,
        cooldown: 0.35,
        projectileSpeed: 22,
        shots: 2,
        rank2: {
          cost: 520,
          desc: 'Agujas II: tres agujas por ráfaga, todavía más rápidas.',
          // F5.1 · revisión adversarial: con 95 esta ráfaga le ganaba al Arpón ★★
          // EN SU PROPIO ROL antitanque (skywhale 12k en 11.3s vs 23.5s). Con 80
          // sigue reinando contra enjambres (~1.200 dps vs colosal) sin invadirlo.
          damage: 80,
          range: 5.6,
          cooldown: 0.3,
          shots: 3,
        },
      },
      {
        // rol B: cazadora de TANQUES aéreos (skywhale/chimera). Su Rango II es la
        // herramienta PORCENTUAL antiaérea del lategame: executeCurrent 0.5 —
        // si el arponazo arranca ≥50% de la vida ACTUAL, derriba. Es "solo aire"
        // por construcción: la torre no puede apuntar ni dañar a nada terrestre.
        // OJO al leer la sonda: el remate NO se contabiliza como daño de torre,
        // así que su cifra de daño SIEMPRE subestima su valor real antijefe.
        key: 'zenith',
        name: 'Arpón del Cénit',
        desc: 'Un arpón colosal de un solo blanco: el terror de los jefes voladores. Perfora armadura.',
        cost: 540,
        damage: 330,
        range: 6.2,
        cooldown: 1.5,
        projectileSpeed: 24,
        pierceArmor: true,
        rank2: {
          cost: 520,
          desc: 'Cénit II: si el arponazo arranca la MITAD de la vida actual del volador, lo derriba al instante (no inmunes).',
          // F5.1 · revisión adversarial: con 460/1.4 quedaba DOMINADO por la
          // Ráfaga de Agujas ★★ en su propio rol. Con 520/1.1 (~709 dps + remate)
          // recupera la corona single-target aérea (TTK 12k ≈ 16s).
          damage: 520,
          range: 6.8,
          cooldown: 1.1,
          executeCurrent: 0.5,
        },
      },
    ],
  },
};

export function towerLevel(type: TowerTypeId, level: number): TowerLevelDef {
  return TOWERS[type].levels[Math.min(level, 3) - 1];
}

// Cache de los bloques de stats del Rango II ya fusionados (spec + overrides).
const rank2Cache = new Map<string, TowerSpecDef>();

// Bloque de stats del Rango II de una spec: la spec base con los `rank2` overrides
// aplicados encima (los campos no presentes en `rank2` se heredan de la spec).
function rank2Stats(type: TowerTypeId, spec: number): TowerSpecDef {
  const key = `${type}:${spec}`;
  const hit = rank2Cache.get(key);
  if (hit) return hit;
  const base = TOWERS[type].specs[spec];
  const { cost: _c, desc: _d, ...over } = base.rank2!;
  const merged: TowerSpecDef = { ...base, ...over };
  rank2Cache.set(key, merged);
  return merged;
}

// Stats activos de una torre: la especialización manda sobre el nivel. El nivel 4
// de una torre especializada con `rank2` usa los stats del Rango II.
export function activeStats(type: TowerTypeId, level: number, spec: number): TowerLevelDef | TowerSpecDef {
  if (spec >= 0) {
    const s = TOWERS[type].specs[spec];
    if (level >= 4 && s.rank2) return rank2Stats(type, spec);
    return s;
  }
  return TOWERS[type].levels[level - 1];
}

// ¿Esta torre especializada puede subir al Rango II (nivel 4)?
export function hasRank2(type: TowerTypeId, spec: number): boolean {
  return spec >= 0 && TOWERS[type].specs[spec]?.rank2 !== undefined;
}

// Coste de subir al Rango II (nivel 4) de una spec, o null si no tiene.
export function rank2Cost(type: TowerTypeId, spec: number): number | null {
  return TOWERS[type].specs[spec]?.rank2?.cost ?? null;
}

// ¿La torre alcanza objetivos aéreos? (algunas especializaciones lo cambian.)
export function towerTargetsAir(type: TowerTypeId, spec: number): boolean {
  const def = TOWERS[type];
  if (spec >= 0 && def.specs[spec].targetsAirOverride !== undefined) {
    return def.specs[spec].targetsAirOverride!;
  }
  return def.targetsAir;
}

export function towerTotalCost(type: TowerTypeId, level: number, spec = -1): number {
  let total = 0;
  const baseLevels = Math.min(level, 3);
  for (let i = 0; i < baseLevels; i++) total += TOWERS[type].levels[i].cost;
  if (spec >= 0) total += TOWERS[type].specs[spec].cost;
  // nivel 4 de una spec = Rango II: suma su coste
  if (level >= 4 && spec >= 0 && TOWERS[type].specs[spec].rank2) {
    total += TOWERS[type].specs[spec].rank2!.cost;
  }
  return total;
}
