// Motor de reproducción de repeticiones (replays), PURO y determinista.
//
// Un replay = { seed + roster inicial + línea de tiempo de entradas }. Reproducirlo
// es reconstruir la partida con EXCLUSIVAMENTE `createGame` + `stepGame` + las
// entradas grabadas: nada de Math.random / Date. La misma lógica la usan el cliente
// (para renderizar) y las pruebas (para verificar la identidad del estado final).
//
// Determinismo de connectedCount / mid-join: la sim escala la HP de los enemigos y
// el presupuesto de oleada por el número de jugadores CONECTADOS. Por eso el log
// graba, con su tick de sim, tanto los comandos como las entradas a mitad de partida
// (`join`) y los cambios de conexión (`conn`). Al reproducir aplicamos esos eventos
// justo ANTES del stepGame del tick correspondiente, igual que en el servidor las
// mutaciones de `game.players` ocurren entre ticks y ya son visibles en el siguiente.

import type { GameEvent, GameState, ReplayData, PlayerCommand } from '../types.js';
import { createGame, makePlayer } from './state.js';
import { getMap } from '../balance/maps.js';
import { makePlacementContext } from './grid.js';
import { makeSimContext, stepGame, type SimContext } from './step.js';

export interface ReplaySim {
  state: GameState;
  ctx: SimContext;
}

// Estado listo en tick 0: partida con el roster inicial del replay.
export function replayInit(data: ReplayData): ReplaySim {
  const map = getMap(data.mapId);
  const state = createGame(
    data.mapId,
    data.mode,
    data.difficulty,
    data.seed,
    data.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
  );
  const ctx = makeSimContext(map, makePlacementContext(map));
  return { state, ctx };
}

// Aplica los eventos de roster (join/conn) de un tick concreto. Se llama ANTES del
// stepGame de ese tick, para que la mutación de `players` sea visible durante el paso
// (igual que en el servidor). Muta `state`.
function applyRosterAt(state: GameState, data: ReplayData, atTick: number): void {
  for (const e of data.log) {
    if (e.t !== atTick) continue;
    if (e.kind === 'join') {
      // no duplicar si ya existe (por seguridad ante logs raros)
      if (!state.players.some((p) => p.id === e.player.id)) {
        state.players.push(makePlayer(e.player, e.gold, e.wood));
      }
    } else if (e.kind === 'conn') {
      const gp = state.players.find((p) => p.id === e.playerId);
      if (gp) gp.connected = e.connected;
    }
  }
}

// Comandos grabados en un tick concreto, en el orden del log.
function commandsAt(data: ReplayData, atTick: number): PlayerCommand[] {
  const cmds: PlayerCommand[] = [];
  for (const e of data.log) {
    if (e.t === atTick && e.kind === 'cmd') cmds.push({ playerId: e.playerId, cmd: e.cmd });
  }
  return cmds;
}

// Avanza UN tick de la reconstrucción: aplica primero el roster (join/conn) de este
// tick y luego un stepGame con los comandos de este tick. Devuelve los eventos del
// tick para alimentar el render. `atTick` DEBE ser `state.tick` (el tick que se va a
// simular). Muta `state`.
export function replayStep(sim: ReplaySim, data: ReplayData, atTick: number): GameEvent[] {
  applyRosterAt(sim.state, data, atTick);
  return stepGame(sim.state, sim.ctx, commandsAt(data, atTick));
}

// Reconstruye desde 0 hasta `targetTick` (deja el estado con state.tick ===
// targetTick) sin render. Para el SEEK de la barra de progreso. A ~180k ticks/s
// (medido en simtest), 20k ticks tardan <100 ms.
//
// NO se corta al llegar a `over`: `stepGame` avanza el tick sin más cuando la
// partida ya terminó, y el servidor sigue incrementando el tick de sim durante la
// ventana de gracia previa a difundir game_over (con `finalTick` capturado al
// final). Para que la reconstrucción coincida EXACTO con ese `finalTick`, hay que
// avanzar hasta el mismo tick aunque ya esté `over`.
export function replayTo(data: ReplayData, targetTick: number): GameState {
  const sim = replayInit(data);
  const limit = Math.max(0, Math.min(targetTick, data.finalTick));
  while (sim.state.tick < limit) {
    replayStep(sim, data, sim.state.tick);
  }
  return sim.state;
}
