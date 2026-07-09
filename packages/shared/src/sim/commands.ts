import type { GameEvent, GameState, MapDef, PlayerCommand } from '../types.js';
import { TOWERS, towerLevel, hasRank2, rank2Cost } from '../balance/towers.js';
import { FUSION_ORDER, findFusion, towerFires } from '../balance/fusions.js';
import {
  CALL_WAVE_GOLD_PER_SEC,
  ORC_RATES,
  ORC_UPGRADE_COSTS,
  SELL_REFUND,
  TICK_RATE,
  WOOD_COST_RANK2,
  WOOD_COST_SPEC,
  WOOD_LOT,
  WOOD_PRICE_MAX,
  WOOD_PRICE_MIN,
  WOOD_PRICE_STEP,
  WOOD_SELL_SPREAD,
} from '../constants.js';
import { placementError, type PlacementContext } from './grid.js';

function reject(events: GameEvent[], playerId: string, reason: string) {
  events.push({ e: 'reject', playerId, reason });
}

export function applyCommands(
  state: GameState,
  map: MapDef,
  ctx: PlacementContext,
  commands: PlayerCommand[],
  events: GameEvent[],
): void {
  for (const { playerId, cmd } of commands) {
    const player = state.players.find((p) => p.id === playerId);
    if (!player || state.over) continue;

    switch (cmd.kind) {
      case 'place': {
        const def = TOWERS[cmd.towerType];
        if (!def) break;
        const lvl = def.levels[0];
        if (player.gold < lvl.cost) {
          reject(events, playerId, 'No te alcanza el oro');
          break;
        }
        const err = placementError(map, ctx, state.towers, cmd.cx, cmd.cy, cmd.towerType);
        if (err) {
          const msgs: Record<string, string> = {
            fuera: 'Fuera del mapa',
            camino: 'No puedes construir sobre el camino',
            bloqueado: 'Celda bloqueada',
            ocupado: 'Ya hay una torre ahí',
            fuera_camino: 'Esta torre solo va SOBRE el camino',
          };
          reject(events, playerId, msgs[err]);
          break;
        }
        player.gold -= lvl.cost;
        player.stats.goldSpent += lvl.cost;
        player.stats.towersBuilt += 1;
        state.towers.push({
          id: state.nextId++,
          type: cmd.towerType,
          cx: cmd.cx,
          cy: cmd.cy,
          level: 1,
          spec: -1,
          owner: playerId,
          cooldownLeft: 0,
          targetMode: 'first',
          invested: lvl.cost,
          kills: 0,
          damage: 0,
          stunnedUntil: 0,
          charges: lvl.charges ?? 0,
          growthBonus: 0,
          goldGen: 0,
          fusion: -1,
          focusId: 0,
          halted: false,
        });
        events.push({ e: 'place', x: cmd.cx + 0.5, y: cmd.cy + 0.5, towerType: cmd.towerType });
        break;
      }

      case 'upgrade': {
        const tower = state.towers.find((t) => t.id === cmd.towerId);
        if (!tower) break;
        if (tower.owner !== playerId) {
          reject(events, playerId, 'Solo el dueño puede mejorar esta torre');
          break;
        }
        // las torres de camino (Trampa/Barril) y el Sentry no se mejoran
        if (TOWERS[tower.type].onPathOnly || TOWERS[tower.type].detects) {
          reject(events, playerId, 'Esta torre no se puede mejorar');
          break;
        }
        // una torre fusionada no admite más mejoras (F4.3)
        if (tower.fusion >= 0) {
          reject(events, playerId, 'Una fusión no se puede mejorar');
          break;
        }
        // Rango II: una torre ya especializada (nivel 3, spec elegida) con `rank2`
        // puede subir al nivel 4 pagando el coste del Rango II. Reutiliza el comando
        // `upgrade` en vez de inventar protocolo nuevo.
        if (tower.spec >= 0) {
          if (tower.level >= 4) {
            reject(events, playerId, 'Ya está en el Rango II');
            break;
          }
          if (!hasRank2(tower.type, tower.spec)) {
            reject(events, playerId, 'Esta especialización no tiene Rango II');
            break;
          }
          const r2cost = rank2Cost(tower.type, tower.spec)!;
          if (player.gold < r2cost) {
            reject(events, playerId, 'No te alcanza el oro');
            break;
          }
          // F5.2 · el Rango II también cuesta madera (la tala el orco leñador)
          if (player.wood < WOOD_COST_RANK2) {
            reject(events, playerId, `Te falta madera (necesitas 🪵${WOOD_COST_RANK2})`);
            break;
          }
          player.gold -= r2cost;
          player.stats.goldSpent += r2cost;
          player.wood -= WOOD_COST_RANK2;
          tower.level = 4;
          tower.invested += r2cost;
          tower.cooldownLeft = 0;
          events.push({ e: 'upgrade', x: tower.cx + 0.5, y: tower.cy + 0.5, level: tower.level });
          break;
        }
        if (tower.level >= 3) {
          reject(events, playerId, 'Nivel máximo');
          break;
        }
        const cost = towerLevel(tower.type, tower.level + 1).cost;
        if (player.gold < cost) {
          reject(events, playerId, 'No te alcanza el oro');
          break;
        }
        player.gold -= cost;
        player.stats.goldSpent += cost;
        tower.level += 1;
        tower.invested += cost;
        events.push({ e: 'upgrade', x: tower.cx + 0.5, y: tower.cy + 0.5, level: tower.level });
        break;
      }

      case 'specialize': {
        const tower = state.towers.find((t) => t.id === cmd.towerId);
        if (!tower) break;
        if (tower.owner !== playerId) {
          reject(events, playerId, 'Solo el dueño puede especializar esta torre');
          break;
        }
        // una torre fusionada no se especializa (su fusión ES su identidad, F4.3)
        if (tower.fusion >= 0) {
          reject(events, playerId, 'Una fusión no se puede especializar');
          break;
        }
        // el Sentry (y las torres de camino) no se especializan
        if (TOWERS[tower.type].detects || TOWERS[tower.type].onPathOnly) {
          reject(events, playerId, 'Esta torre no se puede especializar');
          break;
        }
        if (tower.level < 3) {
          reject(events, playerId, 'Primero llévala al nivel máximo');
          break;
        }
        if (tower.spec >= 0) {
          reject(events, playerId, 'Ya está especializada');
          break;
        }
        const specs = TOWERS[tower.type].specs;
        if (cmd.spec !== 0 && cmd.spec !== 1) break;
        const spec = specs[cmd.spec];
        if (player.gold < spec.cost) {
          reject(events, playerId, 'No te alcanza el oro');
          break;
        }
        // F5.2 · especializar cuesta madera además de oro (economía Green TD)
        if (player.wood < WOOD_COST_SPEC) {
          reject(events, playerId, `Te falta madera (necesitas 🪵${WOOD_COST_SPEC})`);
          break;
        }
        player.gold -= spec.cost;
        player.stats.goldSpent += spec.cost;
        player.wood -= WOOD_COST_SPEC;
        tower.spec = cmd.spec;
        tower.invested += spec.cost;
        tower.cooldownLeft = 0;
        events.push({
          e: 'specialize',
          x: tower.cx + 0.5,
          y: tower.cy + 0.5,
          towerType: tower.type,
          spec: cmd.spec,
          name: spec.name,
        });
        break;
      }

      case 'sell': {
        const idx = state.towers.findIndex((t) => t.id === cmd.towerId);
        if (idx === -1) break;
        const tower = state.towers[idx];
        if (tower.owner !== playerId) {
          reject(events, playerId, 'Solo el dueño puede vender esta torre');
          break;
        }
        const refund = Math.floor(tower.invested * SELL_REFUND);
        player.gold += refund;
        player.stats.goldEarned += refund;
        state.towers.splice(idx, 1);
        events.push({ e: 'sell', x: tower.cx + 0.5, y: tower.cy + 0.5, refund });
        break;
      }

      case 'target': {
        const tower = state.towers.find((t) => t.id === cmd.towerId);
        if (!tower || tower.owner !== playerId) break;
        tower.targetMode = cmd.mode;
        break;
      }

      // Lote 4 · FOCUS: la torre ataca a ESE enemigo (enemyId 0 = quitar el focus).
      // Validación completa aquí (el comando llega del cliente sin confiar): dueño,
      // torre que DISPARA (estandarte/mina/alquimista/sentry/trampas no apuntan) y
      // enemigo existente Y visible (un invisible no detectado no se puede enfocar:
      // no lo ves — coherente con el hit-test del cliente y con pickTarget).
      case 'focus': {
        const tower = state.towers.find((t) => t.id === cmd.towerId);
        if (!tower) break;
        if (tower.owner !== playerId) {
          reject(events, playerId, 'Solo el dueño puede dar órdenes a esta torre');
          break;
        }
        if (!towerFires(tower)) {
          reject(events, playerId, 'Esta torre no dispara');
          break;
        }
        if (cmd.enemyId === 0) {
          tower.focusId = 0; // volver al targetMode automático
          break;
        }
        const enemy = state.enemies.find((e) => e.id === cmd.enemyId && e.hp > 0);
        if (!enemy) {
          reject(events, playerId, 'Ese enemigo ya no está');
          break;
        }
        if (enemy.invisible && !enemy.detected) {
          reject(events, playerId, 'No puedes ver a ese enemigo');
          break;
        }
        tower.focusId = enemy.id;
        break;
      }

      // Lote 4 · STOP/REANUDAR: on=true la torre deja de disparar; on=false vuelve.
      // Misma validación que focus (solo torres que disparan: las auras/economía
      // no disparan, así que "detenerlas" no significa nada).
      case 'halt': {
        const tower = state.towers.find((t) => t.id === cmd.towerId);
        if (!tower) break;
        if (tower.owner !== playerId) {
          reject(events, playerId, 'Solo el dueño puede dar órdenes a esta torre');
          break;
        }
        if (!towerFires(tower)) {
          reject(events, playerId, 'Esta torre no dispara');
          break;
        }
        tower.halted = cmd.on === true;
        break;
      }

      // F4.3 · Fusión: dos torres ESPECIALIZADAS, ADYACENTES (Chebyshev 1), del
      // MISMO dueño, cuyos tipos formen una receta. Consume ambas y deja UNA torre
      // fusionada en la celda de `keepId` (la otra celda queda libre). Gratis: el
      // coste son las dos torres; `invested` se suma para el refund de venta.
      case 'fuse': {
        const a = state.towers.find((t) => t.id === cmd.towerId);
        const b = state.towers.find((t) => t.id === cmd.otherId);
        if (!a || !b || a.id === b.id) break;
        if (a.owner !== playerId || b.owner !== playerId) {
          reject(events, playerId, 'Solo puedes fusionar torres tuyas');
          break;
        }
        if (a.fusion >= 0 || b.fusion >= 0) {
          reject(events, playerId, 'Esa torre ya es una fusión');
          break;
        }
        if (a.spec < 0 || b.spec < 0) {
          reject(events, playerId, 'Ambas torres deben estar especializadas');
          break;
        }
        if (Math.max(Math.abs(a.cx - b.cx), Math.abs(a.cy - b.cy)) > 1) {
          reject(events, playerId, 'Las torres deben estar adyacentes');
          break;
        }
        const recipe = findFusion(a.type, b.type);
        if (!recipe) {
          reject(events, playerId, 'Esos tipos no forman ninguna receta');
          break;
        }
        const keep = cmd.keepId === a.id ? a : cmd.keepId === b.id ? b : null;
        if (!keep) {
          reject(events, playerId, 'Celda de destino inválida');
          break;
        }
        const other = keep === a ? b : a;
        // la torre conservada SE CONVIERTE en la fusión: level 3 fijo, spec −1,
        // sin más mejoras. El Rango II de los ingredientes se ignora (documentado
        // en fusions.ts); su inversión viaja en `invested`. kills/daño se suman
        // para no perder el historial; el crecimiento (growthBonus) no se hereda.
        keep.fusion = FUSION_ORDER.indexOf(recipe.id);
        keep.level = 3;
        keep.spec = -1;
        keep.invested += other.invested;
        keep.kills += other.kills;
        keep.damage += other.damage;
        keep.goldGen += other.goldGen; // historial económico: también se suma
        keep.cooldownLeft = 0;
        keep.charges = 0;
        keep.growthBonus = 0;
        // Lote 4: la fusión es una torre "nueva" — se limpian focus y stop. Crítico
        // para el Corazón de Invierno (aura pura, no dispara): un `halted` heredado
        // sería imposible de quitar (halt solo acepta torres que disparan).
        keep.focusId = 0;
        keep.halted = false;
        state.towers = state.towers.filter((t) => t.id !== other.id);
        events.push({ e: 'fuse', x: keep.cx + 0.5, y: keep.cy + 0.5, fusion: recipe.id, name: recipe.name });
        break;
      }

      // F5.4 · Mercado GLOBAL de madera: cada operación mueve el precio para toda
      // la sala. Vive en GameState y viaja como cualquier comando → determinista
      // y grabado en los replays sin trabajo extra.
      case 'buy_wood': {
        const cost = Math.ceil(state.woodPrice * WOOD_LOT);
        if (player.gold < cost) {
          reject(events, playerId, 'No te alcanza el oro');
          break;
        }
        player.gold -= cost;
        player.wood += WOOD_LOT;
        state.woodPrice = Math.min(WOOD_PRICE_MAX, state.woodPrice * WOOD_PRICE_STEP);
        events.push({ e: 'trade', playerId, buy: true, wood: WOOD_LOT, gold: cost, price: Math.round(state.woodPrice * 100) / 100 });
        break;
      }

      case 'sell_wood': {
        if (player.wood < WOOD_LOT) {
          reject(events, playerId, `Necesitas 🪵${WOOD_LOT} para vender`);
          break;
        }
        const gain = Math.floor(state.woodPrice * WOOD_SELL_SPREAD * WOOD_LOT);
        player.wood -= WOOD_LOT;
        player.gold += gain;
        state.woodPrice = Math.max(WOOD_PRICE_MIN, state.woodPrice / WOOD_PRICE_STEP);
        events.push({ e: 'trade', playerId, buy: false, wood: WOOD_LOT, gold: gain, price: Math.round(state.woodPrice * 100) / 100 });
        break;
      }

      // F5.5 · mejora del orco leñador: oro → más tala/s, para siempre
      case 'upgrade_orc': {
        if (player.orcLevel >= ORC_RATES.length) {
          reject(events, playerId, 'Tu orco ya está al máximo');
          break;
        }
        const cost = ORC_UPGRADE_COSTS[player.orcLevel - 1];
        if (player.gold < cost) {
          reject(events, playerId, 'No te alcanza el oro');
          break;
        }
        player.gold -= cost;
        player.stats.goldSpent += cost;
        player.orcLevel += 1;
        events.push({ e: 'orc', playerId, level: player.orcLevel, rate: ORC_RATES[player.orcLevel - 1] });
        break;
      }

      // F7.1 · TRANSFERENCIA de recursos a un aliado (estilo Green TD). El comando
      // llega del cliente SIN validar → aquí se comprueba todo: cantidades enteras
      // ≥0 (al menos una >0), destinatario existente y distinto de uno mismo, y
      // fondos suficientes. Mueve oro/madera y ajusta la telemetría con el MISMO
      // criterio que el resto de comandos (oro que sale = goldSpent; oro que entra
      // = goldEarned). Determinista: sin RNG ni reloj.
      case 'give': {
        const { to, gold, wood } = cmd;
        if (
          !Number.isInteger(gold) ||
          !Number.isInteger(wood) ||
          gold < 0 ||
          wood < 0 ||
          (gold === 0 && wood === 0)
        ) {
          reject(events, playerId, 'Cantidad inválida para enviar');
          break;
        }
        if (to === playerId) {
          reject(events, playerId, 'No puedes enviarte recursos a ti mismo');
          break;
        }
        const receiver = state.players.find((p) => p.id === to);
        if (!receiver) {
          reject(events, playerId, 'Ese jugador no está en la partida');
          break;
        }
        if (player.gold < gold || player.wood < wood) {
          reject(events, playerId, 'No te alcanzan los recursos para enviar');
          break;
        }
        player.gold -= gold;
        player.wood -= wood;
        receiver.gold += gold;
        receiver.wood += wood;
        // el oro donado cuenta como gastado por el emisor y ganado por el receptor
        // (la madera no tiene stat propio). Coherente con sell/call_wave/place.
        player.stats.goldSpent += gold;
        receiver.stats.goldEarned += gold;
        events.push({ e: 'give', from: playerId, to, gold, wood });
        break;
      }

      case 'call_wave': {
        if (state.waveState !== 'interlude') break;
        const secsLeft = state.interludeLeft / TICK_RATE;
        if (secsLeft < 1.5) break;
        const bonus = Math.floor(secsLeft * CALL_WAVE_GOLD_PER_SEC);
        for (const p of state.players) {
          p.gold += bonus;
          p.stats.goldEarned += bonus;
        }
        state.interludeLeft = 0;
        events.push({ e: 'sys', msg: `${player.name} llamó la oleada antes (+${bonus} de oro para todos)` });
        break;
      }
    }
  }
}
