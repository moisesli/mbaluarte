import type { Difficulty, GameMode, GameState, PlayerState } from '../types.js';
import {
  CLASSIC_WAVES,
  FIRST_INTERLUDE_SEC,
  START_GOLD,
  START_LIVES,
  TICK_RATE,
} from '../constants.js';

export interface NewPlayerInput {
  id: string;
  name: string;
  color: string;
}

export function makePlayer(input: NewPlayerInput, gold: number): PlayerState {
  return {
    id: input.id,
    name: input.name,
    color: input.color,
    gold,
    connected: true,
    stats: { kills: 0, damage: 0, goldEarned: 0, goldSpent: 0, towersBuilt: 0 },
  };
}

export function createGame(
  mapId: string,
  mode: GameMode,
  difficulty: Difficulty,
  seed: number,
  players: NewPlayerInput[],
): GameState {
  return {
    tick: 0,
    mapId,
    mode,
    difficulty,
    rng: seed | 0,
    lives: START_LIVES,
    maxLives: START_LIVES,
    wave: 0,
    // classic tiene fin por número de oleadas; endless y horde son infinitos (0)
    totalWaves: mode === 'classic' ? CLASSIC_WAVES : 0,
    waveState: 'interlude',
    interludeLeft: FIRST_INTERLUDE_SEC * TICK_RATE,
    nextWaveComp: [],
    nextWaveImmune: false,
    nextWaveBlessed: false,
    nextWaveFlying: false,
    nextWaveBoss: null,
    pendingWave: null,
    pendingBoss: false,
    pendingBossType: null,
    blessedBonusMult: 1,
    spawnQueue: [],
    spawnCooldown: 0,
    enemies: [],
    towers: [],
    projectiles: [],
    players: players.map((p) => makePlayer(p, START_GOLD[difficulty])),
    nextId: 1,
    over: null,
  };
}
