// Sistema de partículas. Las posiciones están en unidades de celda;
// el renderer las convierte a píxeles con la transformación de la vista.
import { getPartSprite, getProjSprite } from './sprites.js';

export interface Particle {
  kind: 'dot' | 'ring' | 'text' | 'beam' | 'spark' | 'tex' | 'proj';
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number; // segundos restantes
  maxLife: number;
  color: string;
  size: number; // celdas (dot/spark/tex) o radio final (ring) o px de fuente (text)
  text?: string;
  // beam: línea desde (x,y) hasta (x2,y2); puede tener quiebres
  pts?: [number, number][];
  // tex: textura de partícula (part_<tex>), rotación y giro, blending aditivo
  tex?: string;
  rot?: number;
  spin?: number;
  add?: boolean;
  grow?: number; // el tamaño crece con la vida (humo/anillos)
}

// caché de texturas tintadas (blanco → color) para no recolorear cada frame
const tintCache = new Map<string, HTMLCanvasElement>();
function tinted(img: HTMLImageElement, color: string): HTMLCanvasElement {
  const key = img.src + '|' + color;
  let c = tintCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const cx = c.getContext('2d')!;
  cx.drawImage(img, 0, 0);
  cx.globalCompositeOperation = 'source-in'; // pinta el color respetando el alfa
  cx.fillStyle = color;
  cx.fillRect(0, 0, c.width, c.height);
  tintCache.set(key, c);
  return c;
}

// Partícula con TEXTURA (tintada, normalmente aditiva para dar glow).
export function fx(
  x: number,
  y: number,
  tex: string,
  color: string,
  size: number,
  life: number,
  o: { vx?: number; vy?: number; rot?: number; spin?: number; add?: boolean; grow?: number } = {},
): void {
  addParticle({
    kind: 'tex',
    x,
    y,
    vx: o.vx ?? 0,
    vy: o.vy ?? 0,
    life,
    maxLife: life,
    color,
    size,
    tex,
    rot: o.rot ?? 0,
    spin: o.spin ?? 0,
    add: o.add ?? true,
    grow: o.grow ?? 0,
  });
}

const particles: Particle[] = [];
const MAX_PARTICLES = 600;

export function addParticle(p: Particle): void {
  if (particles.length >= MAX_PARTICLES) particles.shift();
  particles.push(p);
}

export function burst(x: number, y: number, color: string, count = 8, speed = 2.2): void {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.4 + Math.random() * 0.6);
    addParticle({
      kind: 'dot',
      x,
      y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      life: 0.4 + Math.random() * 0.3,
      maxLife: 0.7,
      color,
      size: 0.07 + Math.random() * 0.07,
    });
  }
}

export function ring(x: number, y: number, radius: number, color: string): void {
  addParticle({ kind: 'ring', x, y, vx: 0, vy: 0, life: 0.35, maxLife: 0.35, color, size: radius });
}

export function floatText(x: number, y: number, text: string, color: string, size = 15): void {
  addParticle({
    kind: 'text',
    x,
    y,
    vx: (Math.random() - 0.5) * 0.3,
    vy: -0.9,
    life: 1.0,
    maxLife: 1.0,
    color,
    size,
    text,
  });
}

export function beam(pts: [number, number][], color: string): void {
  addParticle({
    kind: 'beam',
    x: pts[0][0],
    y: pts[0][1],
    vx: 0,
    vy: 0,
    life: 0.14,
    maxLife: 0.14,
    color,
    size: 0,
    pts,
  });
}

export function line(x: number, y: number, x2: number, y2: number, color: string): void {
  beam(
    [
      [x, y],
      [x2, y2],
    ],
    color,
  );
}

// bala puramente visual: recorre origen -> destino en `durationMs` usando un sprite
// de proyectil (atlas proj_<tex>, sin tintar). El daño ya se aplicó al instante en el
// sim (projectileKind: 'snipe'); esto es solo teatro, como el retroceso de las torres.
export function bulletTrail(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  tex: string,
  durationMs = 150,
): void {
  const life = durationMs / 1000;
  addParticle({
    kind: 'proj',
    x: x0,
    y: y0,
    vx: (x1 - x0) / life,
    vy: (y1 - y0) / life,
    life,
    maxLife: life,
    color: '',
    size: 0.7,
    tex,
    rot: Math.atan2(y1 - y0, x1 - x0) + Math.PI / 2,
  });
}

export function updateParticles(dt: number): void {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.kind === 'dot' || p.kind === 'spark' || p.kind === 'tex') {
      p.vx *= 1 - 3 * dt;
      p.vy *= 1 - 3 * dt;
    }
    if (p.kind === 'tex' && p.spin) p.rot = (p.rot ?? 0) + p.spin * dt;
  }
}

export function drawParticles(
  g: CanvasRenderingContext2D,
  toX: (x: number) => number,
  toY: (y: number) => number,
  scale: number,
): void {
  for (const p of particles) {
    const alpha = Math.max(0, p.life / p.maxLife);
    g.globalAlpha = alpha;
    switch (p.kind) {
      case 'tex': {
        const img = p.tex ? getPartSprite(p.tex) : null;
        if (!img) {
          // aún sin cargar: un punto tenue para no quedar en blanco
          g.fillStyle = p.color;
          g.beginPath();
          g.arc(toX(p.x), toY(p.y), p.size * scale * 0.3, 0, Math.PI * 2);
          g.fill();
          break;
        }
        const t = 1 - p.life / p.maxLife;
        const w = p.size * scale * (1 + (p.grow ?? 0) * t);
        const h = w * (img.naturalHeight / img.naturalWidth);
        g.save();
        if (p.add) g.globalCompositeOperation = 'lighter';
        g.globalAlpha = alpha * (p.add ? 0.85 : 1);
        g.translate(toX(p.x), toY(p.y));
        if (p.rot) g.rotate(p.rot);
        g.drawImage(tinted(img, p.color), -w / 2, -h / 2, w, h);
        g.restore();
        break;
      }
      case 'proj': {
        const img = p.tex ? getProjSprite(p.tex) : null;
        if (!img) break;
        // a diferencia de las demás partículas, un proyectil real NO se desvanece
        // en vuelo — opacidad completa siempre, igual que drawProjectiles().
        g.globalAlpha = 1;
        const ph = p.size * scale;
        const pw = (img.naturalWidth / img.naturalHeight) * ph;
        g.save();
        g.translate(toX(p.x), toY(p.y));
        g.rotate(p.rot ?? 0);
        g.drawImage(img, -pw / 2, -ph / 2, pw, ph);
        g.restore();
        break;
      }
      case 'dot':
      case 'spark': {
        g.fillStyle = p.color;
        g.beginPath();
        g.arc(toX(p.x), toY(p.y), p.size * scale, 0, Math.PI * 2);
        g.fill();
        break;
      }
      case 'ring': {
        const progress = 1 - p.life / p.maxLife;
        g.strokeStyle = p.color;
        g.lineWidth = Math.max(1.5, 3 * alpha);
        g.beginPath();
        g.arc(toX(p.x), toY(p.y), p.size * scale * (0.3 + progress * 0.7), 0, Math.PI * 2);
        g.stroke();
        break;
      }
      case 'text': {
        g.fillStyle = p.color;
        g.font = `bold ${p.size}px system-ui, EmojiFix, sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'alphabetic'; // otros dibujantes (barra de jefe) lo cambian
        g.strokeStyle = 'rgba(0,0,0,0.7)';
        g.lineWidth = 3;
        g.strokeText(p.text ?? '', toX(p.x), toY(p.y));
        g.fillText(p.text ?? '', toX(p.x), toY(p.y));
        break;
      }
      case 'beam': {
        if (!p.pts || p.pts.length < 2) break;
        g.strokeStyle = p.color;
        g.lineWidth = Math.max(1.5, 3.5 * alpha);
        g.beginPath();
        g.moveTo(toX(p.pts[0][0]), toY(p.pts[0][1]));
        for (let i = 1; i < p.pts.length; i++) {
          // pequeño zigzag para que el rayo se sienta eléctrico
          const [ax, ay] = p.pts[i - 1];
          const [bx, by] = p.pts[i];
          const mx = (ax + bx) / 2 + (Math.random() - 0.5) * 0.2;
          const my = (ay + by) / 2 + (Math.random() - 0.5) * 0.2;
          g.quadraticCurveTo(toX(mx), toY(my), toX(bx), toY(by));
        }
        g.stroke();
        break;
      }
    }
  }
  g.globalAlpha = 1;
}

export function clearParticles(): void {
  particles.length = 0;
}
