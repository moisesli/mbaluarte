// Audio procedural con WebAudio: sin archivos, sonidos sintetizados al vuelo.
//
// F1.3 · Sonido v2 — motor mejorado:
//   - Envelopes ADSR reales (helper `env`) en vez de ramps simples.
//   - Sonidos en CAPAS (grave + click agudo) para dar cuerpo.
//   - Variación aleatoria de pitch por disparo (±5%). OJO: `Math.random` aquí es
//     legítimo — esto es SOLO cliente/audio, NO la simulación (el determinismo
//     solo aplica a packages/shared/src/sim).
//   - Pan estéreo por posición (StereoPannerNode); la x de la celda -> [-1, +1].
//   - Firma sonora distinta por cada torre + sting de élite + percusión de jefe.
//   - Límite de voces simultáneas (~12) con prioridad (jefe > élite > resto).
//   - Limiter/compressor en el master para evitar clipping.
//   - Ganancias separadas SFX / Música (musicGain queda listo para F3.1).
import { store } from './store.js';

let ctx: AudioContext | null = null;
let master: GainNode | null = null; // volumen global (lo mueve el mute)
let limiter: DynamicsCompressorNode | null = null; // evita clipping en oleadas densas
let sfxGain: GainNode | null = null; // volumen de efectos
let musicGain: GainNode | null = null; // volumen de música (preparado para F3.1)
const lastPlayed = new Map<string, number>();

// ---------- límite de voces simultáneas ----------
// Cada sonido programado cuenta como una "voz" hasta que termina. Si se supera
// MAX_VOICES, los de menor prioridad no suenan (evita la cacofonía en oleadas
// densas). Prioridad: jefe (3) > élite (2) > resto (1).
const MAX_VOICES = 12;
interface Voice {
  until: number; // performance.now() en que se libera
  prio: number;
}
let voices: Voice[] = [];

function pruneVoices(now: number): void {
  if (voices.length) voices = voices.filter((v) => v.until > now);
}

// Reserva una voz para un sonido de duración `durMs` y prioridad `prio`.
// Devuelve false si no hay hueco (todo lo activo es de prioridad >= a la nuestra).
function claimVoice(durMs: number, prio: number): boolean {
  const now = performance.now();
  pruneVoices(now);
  if (voices.length < MAX_VOICES) {
    voices.push({ until: now + durMs, prio });
    return true;
  }
  // buscar la voz activa de menor prioridad; si la nuestra es mayor, robarla.
  let worstIdx = -1;
  let worstPrio = Infinity;
  let worstUntil = Infinity;
  for (let i = 0; i < voices.length; i++) {
    const v = voices[i];
    // preferimos robar la de menor prioridad, y a igualdad la más vieja.
    if (v.prio < worstPrio || (v.prio === worstPrio && v.until < worstUntil)) {
      worstPrio = v.prio;
      worstUntil = v.until;
      worstIdx = i;
    }
  }
  if (worstIdx >= 0 && worstPrio < prio) {
    voices[worstIdx] = { until: now + durMs, prio };
    return true;
  }
  return false;
}

function ensureCtx(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext();
      // Cadena: [sfxGain | musicGain] -> master -> limiter -> destino.
      master = ctx.createGain();
      master.gain.value = 1;

      limiter = ctx.createDynamicsCompressor();
      // ajuste de "brickwall" suave: pega fuerte cerca de 0 dB para que nunca
      // clipee aunque suenen muchas voces a la vez.
      limiter.threshold.value = -6;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.12;

      sfxGain = ctx.createGain();
      sfxGain.gain.value = store.sfxVol * BASE_SFX;
      musicGain = ctx.createGain();
      musicGain.gain.value = store.musicVol * BASE_MUSIC;

      sfxGain.connect(master);
      musicGain.connect(master);
      master.connect(limiter);
      limiter.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

// Ganancia base para no saturar el limiter: los volúmenes de usuario (0..1) se
// escalan por estas constantes antes de llegar al bus.
const BASE_SFX = 0.35;
const BASE_MUSIC = 0.5;

// desbloquear el audio con la primera interacción (requisito de los navegadores)
export function unlockAudio(): void {
  ensureCtx();
}

// ---------- volúmenes (persisten en store/localStorage vía main) ----------
export function setSfxVolume(v: number): void {
  store.sfxVol = clamp01(v);
  localStorage.setItem('td_sfx_vol', String(Math.round(store.sfxVol * 100)));
  if (sfxGain && ctx) sfxGain.gain.setTargetAtTime(store.sfxVol * BASE_SFX, ctx.currentTime, 0.01);
}

export function setMusicVolume(v: number): void {
  store.musicVol = clamp01(v);
  localStorage.setItem('td_music_vol', String(Math.round(store.musicVol * 100)));
  if (musicGain && ctx) musicGain.gain.setTargetAtTime(store.musicVol * BASE_MUSIC, ctx.currentTime, 0.01);
}

// El nodo de música lo consumirá F3.1; se expone para no reconstruir el grafo.
export function getMusicBus(): { ctx: AudioContext; bus: GainNode } | null {
  const ac = ensureCtx();
  if (!ac || !musicGain) return null;
  return { ctx: ac, bus: musicGain };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function canPlay(key: string, minGapMs: number): boolean {
  if (store.muted) return false;
  const now = performance.now();
  if ((lastPlayed.get(key) ?? 0) + minGapMs > now) return false;
  lastPlayed.set(key, now);
  return true;
}

// ±5% de variación de pitch para que N disparos idénticos no suenen a metralleta.
function detune(freq: number, cents = 0.05): number {
  return freq * (1 + (Math.random() * 2 - 1) * cents);
}

// ---------- primitivas de síntesis ----------

// Aplica un envelope ADSR real a un GainNode. Devuelve el instante (s) en que el
// sonido ha terminado por completo (para programar el stop y liberar la voz).
function env(
  gain: GainNode,
  t0: number,
  peak: number,
  a: number, // attack (s)
  d: number, // decay (s)
  s: number, // sustain (0..1, fracción del peak)
  r: number, // release (s)
  hold: number, // duración del sustain (s)
): number {
  const g = gain.gain;
  const sustainLevel = Math.max(0.0001, peak * s);
  g.setValueAtTime(0.0001, t0);
  g.exponentialRampToValueAtTime(Math.max(0.0001, peak), t0 + a);
  g.exponentialRampToValueAtTime(sustainLevel, t0 + a + d);
  g.setValueAtTime(sustainLevel, t0 + a + d + hold);
  g.exponentialRampToValueAtTime(0.0001, t0 + a + d + hold + r);
  return a + d + hold + r;
}

interface ToneOpts {
  freq: number;
  type?: OscillatorType;
  volume?: number;
  slideTo?: number; // barrido de frecuencia
  pan?: number; // -1 izq .. +1 der
  // ADSR (en segundos); por defecto un "pluck" corto.
  attack?: number;
  decay?: number;
  sustain?: number;
  release?: number;
  hold?: number;
  delay?: number; // retardo de inicio (s) para apilar capas
}

// Crea el nodo de paneo (o un gain neutro si el navegador no soporta StereoPanner).
function panNode(ac: AudioContext, pan: number): AudioNode {
  if (typeof ac.createStereoPanner === 'function') {
    const p = ac.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    return p;
  }
  return ac.createGain();
}

// Una capa tonal con ADSR. NO reserva voz por sí sola (eso lo hace el `sfx.*`).
function tone(o: ToneOpts): void {
  const ac = ensureCtx();
  if (!ac || !sfxGain) return;
  const t0 = ac.currentTime + (o.delay ?? 0);
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  const pan = panNode(ac, o.pan ?? 0);
  osc.type = o.type ?? 'square';
  osc.frequency.setValueAtTime(o.freq, t0);
  if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(o.slideTo, t0 + (o.hold ?? 0.06) + (o.decay ?? 0.05));
  const total = env(
    gain,
    t0,
    o.volume ?? 0.4,
    o.attack ?? 0.004,
    o.decay ?? 0.05,
    o.sustain ?? 0.0001,
    o.release ?? 0.04,
    o.hold ?? 0,
  );
  osc.connect(gain).connect(pan).connect(sfxGain);
  osc.start(t0);
  osc.stop(t0 + total + 0.02);
}

interface NoiseOpts {
  durationMs: number;
  volume?: number;
  lowpass?: number;
  highpass?: number;
  pan?: number;
  attack?: number;
  release?: number;
  delay?: number;
}

// Ráfaga de ruido filtrado (impactos, explosiones, percusión).
function noise(o: NoiseOpts): void {
  const ac = ensureCtx();
  if (!ac || !sfxGain) return;
  const t0 = ac.currentTime + (o.delay ?? 0);
  const len = Math.max(1, Math.floor((ac.sampleRate * o.durationMs) / 1000));
  const buffer = ac.createBuffer(1, len, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ac.createBufferSource();
  src.buffer = buffer;
  let node: AudioNode = src;
  if (o.highpass) {
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = o.highpass;
    node = node.connect(hp);
  }
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = o.lowpass ?? 1200;
  node = node.connect(lp);
  const gain = ac.createGain();
  const dur = o.durationMs / 1000;
  env(gain, t0, o.volume ?? 0.4, o.attack ?? 0.002, 0.01, 1, o.release ?? dur, dur * 0.4);
  node.connect(gain).connect(panNode(ac, o.pan ?? 0)).connect(sfxGain);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

// ---------- mapa color -> torre ----------
// Los eventos `shot/chain/hit` traen el color de la torre pero no su id. Como
// cada torre tiene un color único, derivamos el tipo del color para darle su
// firma sonora propia.
type TowerSound =
  | 'archer'
  | 'cannon'
  | 'frost'
  | 'poison'
  | 'tesla'
  | 'sniper'
  | 'mortar';
const COLOR_TO_TOWER: Record<string, TowerSound> = {
  '#8bc34a': 'archer',
  '#ff7043': 'cannon',
  '#4fc3f7': 'frost',
  '#9ccc65': 'poison',
  '#ffee58': 'tesla',
  '#b0bec5': 'sniper',
  '#a1887f': 'mortar',
};

// Firma sonora por torre para el impacto de proyectil (`hit` impact / `shot`).
// Cada una combina capas (grave + agudo) con timbre y pitch propios.
function towerShot(kind: TowerSound | undefined, pan: number): void {
  const p = pan;
  switch (kind) {
    case 'frost':
      // cristalino: seno agudo con leve slide + brillo.
      tone({ freq: detune(1100), type: 'sine', volume: 0.16, slideTo: 1500, decay: 0.04, release: 0.09, pan: p });
      tone({ freq: detune(2200), type: 'triangle', volume: 0.06, release: 0.05, pan: p, delay: 0.01 });
      break;
    case 'poison':
      // burbujeo grave y apagado.
      tone({ freq: detune(300), type: 'sine', volume: 0.16, slideTo: 180, decay: 0.06, release: 0.1, pan: p });
      tone({ freq: detune(520), type: 'triangle', volume: 0.07, release: 0.06, pan: p });
      break;
    case 'cannon':
      // "thunk" con cuerpo grave + click de percutor.
      tone({ freq: detune(140), type: 'sine', volume: 0.28, slideTo: 70, decay: 0.05, release: 0.1, pan: p });
      noise({ durationMs: 50, volume: 0.12, lowpass: 2600, highpass: 800, pan: p });
      break;
    case 'archer':
    default:
      // "twang" corto de cuerda: capa grave sine + click agudo.
      tone({ freq: detune(760), type: 'square', volume: 0.11, slideTo: 300, decay: 0.04, release: 0.05, pan: p });
      tone({ freq: detune(240), type: 'sine', volume: 0.08, release: 0.05, pan: p });
      break;
  }
}

// ---------- API pública (mismos nombres; se añaden pan opcionales) ----------

export const sfx = {
  // Impacto de proyectil físico (arquero/cañón/hielo/veneno). `color` -> firma.
  shot(pan = 0, color?: string): void {
    if (!canPlay('shot', 55)) return;
    if (!claimVoice(160, 1)) return;
    towerShot(color ? COLOR_TO_TOWER[color] : undefined, pan);
  },
  // Francotirador / mortero: disparo instantáneo, agudo y con chasquido.
  snipe(pan = 0, color?: string): void {
    if (!canPlay('snipe', 90)) return;
    if (!claimVoice(220, 1)) return;
    if (color === '#a1887f') {
      // mortero: lanzamiento hueco (thump) con silbido.
      tone({ freq: detune(200), type: 'sine', volume: 0.24, slideTo: 90, decay: 0.08, release: 0.14, pan });
      noise({ durationMs: 90, volume: 0.08, lowpass: 1400, highpass: 400, pan });
    } else {
      // francotirador: crack seco y brillante.
      noise({ durationMs: 40, volume: 0.16, lowpass: 6000, highpass: 1800, pan });
      tone({ freq: detune(1600), type: 'sawtooth', volume: 0.18, slideTo: 400, decay: 0.05, release: 0.12, pan });
    }
  },
  // Tesla: zap eléctrico con capa grave + zumbido agudo.
  zap(pan = 0): void {
    if (!canPlay('zap', 70)) return;
    if (!claimVoice(200, 1)) return;
    tone({ freq: detune(160), type: 'sawtooth', volume: 0.2, slideTo: 1500, decay: 0.05, release: 0.1, pan });
    tone({ freq: detune(3200), type: 'square', volume: 0.05, release: 0.06, pan, delay: 0.005 });
    noise({ durationMs: 40, volume: 0.06, lowpass: 5000, highpass: 2000, pan });
  },
  // Explosión (cañón splash, mortero, muerte grande): grave con cuerpo + ruido.
  boom(pan = 0): void {
    if (!canPlay('boom', 70)) return;
    if (!claimVoice(320, 1)) return;
    noise({ durationMs: 300, volume: 0.42, lowpass: 700, release: 0.28, pan });
    tone({ freq: detune(95, 0.03), type: 'sine', volume: 0.38, slideTo: 38, decay: 0.1, release: 0.22, hold: 0.03, pan });
    tone({ freq: detune(180, 0.03), type: 'triangle', volume: 0.14, slideTo: 60, release: 0.12, pan });
  },
  // Muerte normal: pequeño "plop" descendente.
  death(pan = 0): void {
    if (!canPlay('death', 55)) return;
    if (!claimVoice(140, 1)) return;
    tone({ freq: detune(340), type: 'triangle', volume: 0.14, slideTo: 90, decay: 0.06, release: 0.08, pan });
  },
  // Sting de ÉLITE: acorde corto disonante con prioridad media.
  eliteDeath(pan = 0): void {
    if (store.muted) return;
    if (!claimVoice(360, 2)) return;
    tone({ freq: detune(330, 0.02), type: 'sawtooth', volume: 0.2, decay: 0.08, release: 0.22, hold: 0.04, pan });
    tone({ freq: detune(220, 0.02), type: 'triangle', volume: 0.16, slideTo: 110, release: 0.2, hold: 0.03, pan });
    noise({ durationMs: 180, volume: 0.14, lowpass: 900, release: 0.16, pan });
  },
  // Percusión de JEFE al morir: golpe grave contundente, máxima prioridad.
  bossDeath(pan = 0): void {
    if (store.muted) return;
    if (!claimVoice(600, 3)) return;
    noise({ durationMs: 420, volume: 0.5, lowpass: 500, release: 0.4, pan });
    tone({ freq: 70, type: 'sine', volume: 0.5, slideTo: 30, decay: 0.15, release: 0.4, hold: 0.05, pan });
    tone({ freq: 105, type: 'sine', volume: 0.24, slideTo: 45, release: 0.3, pan, delay: 0.04 });
    tone({ freq: 55, type: 'triangle', volume: 0.2, release: 0.35, pan, delay: 0.1 });
  },
  coin(): void {
    if (!canPlay('coin', 60)) return;
    claimVoice(200, 1);
    tone({ freq: 880, type: 'square', volume: 0.12, release: 0.06 });
    tone({ freq: 1320, type: 'square', volume: 0.1, release: 0.08, delay: 0.06 });
  },
  place(pan = 0): void {
    claimVoice(160, 1);
    tone({ freq: 240, type: 'triangle', volume: 0.28, slideTo: 520, decay: 0.06, release: 0.08, pan });
    tone({ freq: 520, type: 'sine', volume: 0.1, release: 0.06, pan, delay: 0.05 });
  },
  upgrade(pan = 0): void {
    claimVoice(320, 1);
    tone({ freq: 440, type: 'square', volume: 0.18, release: 0.07, pan });
    tone({ freq: 660, type: 'square', volume: 0.18, release: 0.07, pan, delay: 0.08 });
    tone({ freq: 880, type: 'square', volume: 0.18, release: 0.1, pan, delay: 0.16 });
  },
  specialize(pan = 0): void {
    if (!claimVoice(900, 2)) return;
    // fanfarria ascendente más épica que la mejora normal
    [523, 659, 784, 1047, 1319].forEach((f, i) =>
      tone({ freq: f, type: 'sawtooth', volume: 0.2, release: 0.14, decay: 0.05, pan, delay: i * 0.09 }),
    );
    tone({ freq: 1047, type: 'triangle', volume: 0.18, release: 0.35, hold: 0.05, pan, delay: 0.48 });
  },
  ping(pan = 0): void {
    if (!canPlay('ping', 120)) return;
    claimVoice(220, 1);
    tone({ freq: 1200, type: 'sine', volume: 0.16, slideTo: 1600, decay: 0.05, release: 0.09, pan });
    tone({ freq: 1600, type: 'sine', volume: 0.12, release: 0.08, pan, delay: 0.09 });
  },
  sell(pan = 0): void {
    claimVoice(200, 1);
    tone({ freq: 500, type: 'triangle', volume: 0.18, slideTo: 220, decay: 0.07, release: 0.1, pan });
  },
  leak(): void {
    if (!canPlay('leak', 250)) return;
    claimVoice(320, 2);
    tone({ freq: 200, type: 'sawtooth', volume: 0.28, slideTo: 80, decay: 0.1, release: 0.2, hold: 0.05 });
  },
  wave(): void {
    // sin posición: pan neutro.
    claimVoice(700, 2);
    tone({ freq: 196, type: 'sawtooth', volume: 0.24, release: 0.15, hold: 0.03 });
    tone({ freq: 262, type: 'sawtooth', volume: 0.24, release: 0.15, hold: 0.03, delay: 0.17 });
    tone({ freq: 330, type: 'sawtooth', volume: 0.26, release: 0.22, hold: 0.05, delay: 0.34 });
  },
  boss(): void {
    // aviso de jefe entrante: percusión grave amenazante.
    claimVoice(1400, 3);
    tone({ freq: 65, type: 'sawtooth', volume: 0.38, slideTo: 52, decay: 0.2, release: 0.4, hold: 0.15 });
    noise({ durationMs: 300, volume: 0.16, lowpass: 400, release: 0.28, delay: 0.05 });
    tone({ freq: 62, type: 'sawtooth', volume: 0.38, slideTo: 44, release: 0.5, hold: 0.2, delay: 0.5 });
  },
  victory(): void {
    claimVoice(1400, 3);
    // fanfarria más rica: acorde ascendente + quinta de remate.
    [523, 659, 784, 1047].forEach((f, i) => {
      tone({ freq: f, type: 'triangle', volume: 0.26, release: 0.22, hold: 0.06, delay: i * 0.16 });
      tone({ freq: f * 1.5, type: 'sine', volume: 0.1, release: 0.2, hold: 0.04, delay: i * 0.16 });
    });
    tone({ freq: 1047, type: 'triangle', volume: 0.28, release: 0.5, hold: 0.1, delay: 0.7 });
    tone({ freq: 1568, type: 'sine', volume: 0.14, release: 0.5, hold: 0.1, delay: 0.7 });
  },
  defeat(): void {
    claimVoice(1600, 3);
    // descenso cromático más sombrío, con capa grave.
    [392, 330, 262, 196].forEach((f, i) => {
      tone({ freq: f, type: 'sawtooth', volume: 0.24, release: 0.28, hold: 0.08, delay: i * 0.22 });
      tone({ freq: f / 2, type: 'triangle', volume: 0.12, release: 0.28, hold: 0.06, delay: i * 0.22 });
    });
  },
  error(): void {
    if (!canPlay('error', 150)) return;
    claimVoice(160, 1);
    tone({ freq: 150, type: 'square', volume: 0.16, slideTo: 110, decay: 0.06, release: 0.08 });
  },
};
