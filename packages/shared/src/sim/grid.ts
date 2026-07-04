import type { GameState, MapDef, TowerTypeId, Vec } from '../types.js';
import { TOWERS } from '../balance/towers.js';

// Waypoints de un camino en coordenadas de mundo (centros de celda).
export function pathWaypoints(map: MapDef, pathIdx: number): Vec[] {
  return map.paths[pathIdx].map(([c, r]) => ({ x: c + 0.5, y: r + 0.5 }));
}

export function pathLength(map: MapDef, pathIdx: number): number {
  const wps = pathWaypoints(map, pathIdx);
  let len = 0;
  for (let i = 1; i < wps.length; i++) {
    len += Math.abs(wps[i].x - wps[i - 1].x) + Math.abs(wps[i].y - wps[i - 1].y);
  }
  return len;
}

// Todas las celdas que pisa algún camino (los segmentos son axis-aligned).
export function pathCells(map: MapDef): Set<string> {
  const cells = new Set<string>();
  for (const path of map.paths) {
    for (let i = 1; i < path.length; i++) {
      const [c0, r0] = path[i - 1];
      const [c1, r1] = path[i];
      const dc = Math.sign(c1 - c0);
      const dr = Math.sign(r1 - r0);
      let c = c0;
      let r = r0;
      cells.add(`${c},${r}`);
      while (c !== c1 || r !== r1) {
        c += dc;
        r += dr;
        cells.add(`${c},${r}`);
      }
    }
  }
  return cells;
}

export function blockedCells(map: MapDef): Set<string> {
  return new Set(map.blocked.map(([c, r]) => `${c},${r}`));
}

export interface PlacementContext {
  paths: Set<string>;
  blocked: Set<string>;
}

export function makePlacementContext(map: MapDef): PlacementContext {
  return { paths: pathCells(map), blocked: blockedCells(map) };
}

export type PlacementError = 'fuera' | 'camino' | 'bloqueado' | 'ocupado' | 'fuera_camino' | null;

// `towerType` opcional: relaja la regla del camino por tipo. La Trampa de púas
// (`onPathOnly`) SOLO puede ir SOBRE el camino; el resto de torres, SOLO fuera.
export function placementError(
  map: MapDef,
  ctx: PlacementContext,
  towers: { cx: number; cy: number }[],
  cx: number,
  cy: number,
  towerType?: TowerTypeId,
): PlacementError {
  if (!Number.isInteger(cx) || !Number.isInteger(cy)) return 'fuera';
  if (cx < 0 || cy < 0 || cx >= map.gridW || cy >= map.gridH) return 'fuera';
  const key = `${cx},${cy}`;
  const onPathOnly = towerType ? TOWERS[towerType]?.onPathOnly === true : false;
  const isPath = ctx.paths.has(key);
  if (onPathOnly) {
    // la Trampa DEBE ir sobre el camino; fuera del camino, rechazar
    if (!isPath) return 'fuera_camino';
    // dentro del camino puede haber otra trampa ocupando la celda
    if (towers.some((t) => t.cx === cx && t.cy === cy)) return 'ocupado';
    return null;
  }
  if (isPath) return 'camino';
  if (ctx.blocked.has(key)) return 'bloqueado';
  if (towers.some((t) => t.cx === cx && t.cy === cy)) return 'ocupado';
  return null;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}
