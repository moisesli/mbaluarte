// F3.1 · Música procedural adaptativa — 100% WebAudio, sin archivos.
//
// Objetivo: que suene INDIE (cálido, algo lo-fi, melódico y con carácter — en la
// línea de Kingdom Rush / Terraria / FTL / Stardew), NO a "beep" plano. Todo se
// sintetiza en vivo y cuelga del bus de música (`getMusicBus()` → `musicGain`),
// que ya respeta el slider «Música» y el mute. NO toca el sfxGain.
//
// Arquitectura:
//   - Un scheduler con LOOK-AHEAD (setInterval ~25 ms que mira ~120 ms adelante y
//     programa cada nota en tiempo absoluto `ctx.currentTime + …`). Así no hay
//     clicks ni deriva aunque el hilo principal se atasque un frame.
//   - CAPAS independientes, cada una con su GainNode colgando de un `chorus`
//     (dos voces con leve detune + delay sutil) que va al bus de música:
//       · pad   — acorde sostenido cálido (triangle/sine, ataque lento).
//       · arp   — arpegio/pluck melódico sobre el acorde.
//       · bass  — bajo simple (raíz del acorde).
//       · perc  — percusión ligera (bombo suave + hat de ruido).
//       · tens  — drone disonante (segunda menor) para la tensión de pocas vidas.
//     Las capas entran/salen con CROSSFADE (~1.5 s) moviendo su gain con
//     `setTargetAtTime`, nunca con cortes.
//   - ADAPTATIVA por estado de juego (lo fija `music.setState`):
//       · calm  → pad + arp, tempo relajado.
//       · wave  → añade bass + perc, sube energía/tempo.
//       · boss  → perc marcada + acorde más tenso, telegrafía la amenaza.
//       · tension (overlay, pocas vidas) → tinte disonante encima de lo que suene.
//
// `Math.random` aquí es legítimo: es SOLO cliente/audio, no la simulación.
import { getMusicBus, onAudioUnlock } from './audio.js';

// ---------- teoría musical ----------
// Tonalidad: La menor natural (aeólico) — cálido y melancólico pero acogedor.
// Progresión de 4 acordes que loopea bien: Am – F – C – G  (i – VI – III – VII).
// Cada acorde: [grados de la escala en semitonos desde A2] para bajo/pad/arp.
const A2 = 45; // MIDI de A2 (nuestra referencia grave)
function midi(n: number): number {
  return 440 * Math.pow(2, (n - 69) / 12);
}

// Acorde = { raíz (nota MIDI del bajo), notas del pad (tríada), notas del arp }.
interface Chord {
  root: number; // bajo
  pad: number[]; // tríada para el pad (octava media)
  arp: number[]; // notas del arpegio (más agudo)
}
// A menor: A B C D E F G. Construimos tríadas diatónicas.
const CHORDS: Chord[] = [
  // Am (i): A C E
  { root: A2, pad: [A2 + 12, A2 + 15, A2 + 19], arp: [A2 + 24, A2 + 27, A2 + 31, A2 + 27] },
  // F (VI): F A C
  { root: A2 - 4, pad: [A2 + 8, A2 + 12, A2 + 15], arp: [A2 + 20, A2 + 24, A2 + 27, A2 + 24] },
  // C (III): C E G
  { root: A2 + 3, pad: [A2 + 15, A2 + 19, A2 + 22], arp: [A2 + 27, A2 + 31, A2 + 34, A2 + 31] },
  // G (VII): G B D
  { root: A2 - 2, pad: [A2 + 10, A2 + 14, A2 + 17], arp: [A2 + 22, A2 + 26, A2 + 29, A2 + 26] },
];

// Patrón de arpegio (índices dentro de chord.arp) por posición dentro del compás
// (8 corcheas). Suave, con saltos melódicos agradables y algún silencio.
const ARP_PATTERN = [0, 2, 1, 3, 2, 0, 1, 3];

// ---------- estado musical ----------
export type MusicState = 'calm' | 'wave' | 'boss';

interface Inputs {
  state: MusicState;
  tension: boolean; // pocas vidas: overlay disonante
  horde: boolean; // modo horda: energía sostenida
}

// ---------- nodos vivos ----------
let bus: GainNode | null = null;
let ctx: AudioContext | null = null;
let started = false;
let running = false;

// gains de capa (para crossfade) — cada uno cuelga del chorus.
interface Layers {
  pad: GainNode;
  arp: GainNode;
  bass: GainNode;
  perc: GainNode;
  tens: GainNode;
}
let layers: Layers | null = null;
let chorusIn: GainNode | null = null; // entrada del chorus; las capas se conectan aquí

// scheduler
let timer: ReturnType<typeof setInterval> | null = null;
let nextNoteTime = 0; // s (reloj del AudioContext) de la próxima corchea
let step = 0; // corchea global (0..∞); compás = 8 corcheas
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12; // s por delante

// tempo por estado (BPM). Se lee la corchea = 60/BPM/2.
const TEMPO: Record<MusicState, number> = { calm: 84, wave: 104, boss: 112 };

const cur: Inputs = { state: 'calm', tension: false, horde: false };

// niveles objetivo de cada capa según el estado (0..1). El crossfade los aplica.
function targetLevels(i: Inputs): Record<keyof Layers, number> {
  const combat = i.state === 'wave' || i.state === 'boss';
  return {
    pad: i.state === 'boss' ? 0.55 : 0.75,
    arp: i.state === 'boss' ? 0.45 : i.state === 'wave' ? 0.6 : 0.7,
    bass: combat ? (i.state === 'boss' ? 0.9 : 0.75) : i.horde ? 0.5 : 0.0,
    perc: i.state === 'boss' ? 1.0 : i.state === 'wave' ? 0.7 : i.horde ? 0.4 : 0.0,
    tens: i.tension ? (i.state === 'boss' ? 0.5 : 0.4) : 0.0,
  };
}

// ---------- construcción del grafo ----------
function buildGraph(ac: AudioContext, out: GainNode): void {
  // Chorus sutil: la señal de las capas va a `chorusIn`; de ahí a un pequeño
  // banco de delays con leve modulación de detune para dar anchura/calidez, más
  // un delay-eco tenue. Todo se mezcla y sale al bus de música.
  chorusIn = ac.createGain();
  chorusIn.gain.value = 1;

  // camino seco
  const dry = ac.createGain();
  dry.gain.value = 0.82;
  chorusIn.connect(dry).connect(out);

  // camino con delay corto modulado (voz de chorus)
  const chDelay = ac.createDelay(0.05);
  chDelay.delayTime.value = 0.018;
  const lfo = ac.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.18; // muy lento
  const lfoGain = ac.createGain();
  lfoGain.gain.value = 0.006;
  lfo.connect(lfoGain).connect(chDelay.delayTime);
  lfo.start();
  const chWet = ac.createGain();
  chWet.gain.value = 0.28;
  chorusIn.connect(chDelay).connect(chWet).connect(out);

  // eco/delay tenue con feedback bajo (sabor lo-fi espacioso)
  const echo = ac.createDelay(0.6);
  echo.delayTime.value = 0.34;
  const echoFb = ac.createGain();
  echoFb.gain.value = 0.22;
  const echoLp = ac.createBiquadFilter();
  echoLp.type = 'lowpass';
  echoLp.frequency.value = 2200;
  const echoWet = ac.createGain();
  echoWet.gain.value = 0.16;
  chorusIn.connect(echo);
  echo.connect(echoLp).connect(echoFb).connect(echo); // feedback
  echoLp.connect(echoWet).connect(out);

  // capas: cada una parte en 0 y se sube por crossfade según el estado.
  const mk = (): GainNode => {
    const g = ac.createGain();
    g.gain.value = 0;
    g.connect(chorusIn!);
    return g;
  };
  layers = { pad: mk(), arp: mk(), bass: mk(), perc: mk(), tens: mk() };
}

// ---------- crossfade de capas ----------
function applyLevels(): void {
  if (!ctx || !layers) return;
  const t = targetLevels(cur);
  const now = ctx.currentTime;
  // constante de tiempo ~0.5 s → ~1.5 s para asentar (crossfade suave, sin cortes).
  const tau = 0.5;
  (Object.keys(t) as (keyof Layers)[]).forEach((k) => {
    layers![k].gain.setTargetAtTime(t[k], now, tau);
  });
}

// ---------- voces (síntesis por nota) ----------
// Pad: dos osciladores (triangle + sine con leve detune) con ataque/relación
// lentos; una nota larga por acorde. Cálido y con cuerpo.
function playPad(ac: AudioContext, notes: number[], t0: number, dur: number): void {
  if (!layers) return;
  for (const n of notes) {
    const f = midi(n);
    for (const [type, det, vol] of [
      ['triangle', -4, 0.09],
      ['sine', 5, 0.06],
    ] as [OscillatorType, number, number][]) {
      const osc = ac.createOscillator();
      osc.type = type;
      osc.frequency.value = f;
      osc.detune.value = det;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.6); // ataque lento
      g.gain.setValueAtTime(vol, t0 + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.4); // cola larga
      osc.connect(g).connect(layers.pad);
      osc.start(t0);
      osc.stop(t0 + dur + 0.5);
    }
  }
}

// Arpegio/pluck: triangle con envolvente corta y brillante; un toque de vibrato
// natural por el detune aleatorio pequeño. Melódico.
function playArp(ac: AudioContext, note: number, t0: number, dur: number, vel: number): void {
  if (!layers) return;
  const osc = ac.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = midi(note);
  osc.detune.value = (Math.random() * 2 - 1) * 6;
  // un poco de brillo con un segundo armónico débil
  const osc2 = ac.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.value = midi(note + 12);
  const g = ac.createGain();
  const peak = 0.16 * vel;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * 0.95);
  const g2 = ac.createGain();
  g2.gain.value = 0.3;
  osc.connect(g).connect(layers.arp);
  osc2.connect(g2).connect(g);
  osc.start(t0);
  osc2.start(t0);
  osc.stop(t0 + dur + 0.05);
  osc2.stop(t0 + dur + 0.05);
}

// Bajo: onda sine/triangle grave y redonda con envolvente media.
function playBass(ac: AudioContext, note: number, t0: number, dur: number): void {
  if (!layers) return;
  const osc = ac.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = midi(note);
  const sub = ac.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = midi(note - 12);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.06, t0 + dur * 0.6);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * 0.98);
  const sg = ac.createGain();
  sg.gain.value = 0.5;
  osc.connect(g).connect(layers.bass);
  sub.connect(sg).connect(g);
  osc.start(t0);
  sub.start(t0);
  osc.stop(t0 + dur + 0.05);
  sub.stop(t0 + dur + 0.05);
}

// Percusión: bombo (sine con pitch-drop) y hat (ruido filtrado corto).
function playKick(ac: AudioContext, t0: number, vol: number): void {
  if (!layers) return;
  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, t0);
  osc.frequency.exponentialRampToValueAtTime(48, t0 + 0.12);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
  osc.connect(g).connect(layers.perc);
  osc.start(t0);
  osc.stop(t0 + 0.2);
}
function playHat(ac: AudioContext, t0: number, vol: number): void {
  if (!layers) return;
  const len = Math.floor(ac.sampleRate * 0.05);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const hp = ac.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 6000;
  const g = ac.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.04);
  src.connect(hp).connect(g).connect(layers.perc);
  src.start(t0);
  src.stop(t0 + 0.06);
}

// Drone de tensión: dos sines con intervalo disonante (segunda menor) y tremolo,
// una octava por encima de la raíz del acorde. Solo audible si `tens` está alto.
function playTension(ac: AudioContext, root: number, t0: number, dur: number): void {
  if (!layers) return;
  for (const semi of [12, 13]) {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = midi(root + semi);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.07, t0 + 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    // tremolo urgente
    const trem = ac.createOscillator();
    trem.type = 'sine';
    trem.frequency.value = 7;
    const tg = ac.createGain();
    tg.gain.value = 0.5;
    trem.connect(tg).connect(g.gain);
    trem.start(t0);
    trem.stop(t0 + dur);
    osc.connect(g).connect(layers.tens);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }
}

// ---------- scheduler ----------
function eighthDur(): number {
  return 60 / TEMPO[cur.state] / 2; // duración de una corchea (s)
}

function scheduleStep(s: number, t0: number): void {
  if (!ctx) return;
  const beatsPerBar = 8; // corcheas
  const posInBar = s % beatsPerBar;
  const barIndex = Math.floor(s / beatsPerBar);
  const chord = CHORDS[barIndex % CHORDS.length];
  const eDur = eighthDur();

  // PAD + tensión + bajo raíz: una vez por compás (en la primera corchea).
  if (posInBar === 0) {
    playPad(ctx, chord.pad, t0, eDur * beatsPerBar);
    if (cur.tension) playTension(ctx, chord.root, t0, eDur * beatsPerBar);
    // bajo: raíz en 1 y en 5 (medio compás) — patrón simple
    playBass(ctx, chord.root, t0, eDur * 3.5);
  }
  if (posInBar === 4) {
    // segundo golpe de bajo (quinta o raíz) para sostener el groove en combate
    playBass(ctx, cur.state === 'boss' ? chord.root + 7 : chord.root, t0, eDur * 3.5);
  }

  // ARPEGIO: cada corchea, con dinámica (acentos en 0 y 4).
  const arpNote = chord.arp[ARP_PATTERN[posInBar]];
  const accent = posInBar === 0 || posInBar === 4 ? 1 : 0.7;
  // en calma suena todo el arpegio; en combate/boss se ralea un poco para dejar
  // espacio a la percusión (más punchy).
  const arpOn = cur.state === 'calm' ? true : posInBar % 2 === 0 || Math.random() > 0.4;
  if (arpOn) playArp(ctx, arpNote, t0, eDur * 1.6, accent);

  // PERCUSIÓN: bombo en 0 y 4; hats en las corcheas impares. En boss, bombo más
  // denso (también en 2 y 6) para telegrafiar la amenaza.
  const kickBeats = cur.state === 'boss' ? [0, 2, 4, 6] : [0, 4];
  if (kickBeats.includes(posInBar)) playKick(ctx, t0, cur.state === 'boss' ? 0.9 : 0.7);
  if (posInBar % 2 === 1) playHat(ctx, t0, cur.state === 'boss' ? 0.06 : 0.045);
}

function schedulerTick(): void {
  if (!ctx || !running) return;
  while (nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
    scheduleStep(step, nextNoteTime);
    nextNoteTime += eighthDur();
    step++;
  }
  updateDebug(); // refresca __musicDebug con las ganancias VIVAS de cada capa
}

// ---------- API pública ----------
// Arranca la música. Se puede llamar antes del desbloqueo de audio: se difiere
// hasta el primer gesto (onAudioUnlock) para respetar la política de autoplay.
export function startMusic(): void {
  if (started) {
    resumeMusic();
    return;
  }
  started = true;
  const begin = (): void => {
    const mb = getMusicBus();
    if (!mb) return;
    ctx = mb.ctx;
    bus = mb.bus;
    buildGraph(ctx, bus);
    running = true;
    nextNoteTime = ctx.currentTime + 0.1;
    step = 0;
    applyLevels();
    if (timer) clearInterval(timer);
    timer = setInterval(schedulerTick, LOOKAHEAD_MS);
    updateDebug();
  };
  // el bus solo existe con el audio desbloqueado; empieza en el mismo gesto.
  onAudioUnlock(begin);
}

// Cambia el estado musical del juego. Idempotente si no cambia nada.
export function setMusicState(state: MusicState, tension: boolean, horde: boolean): void {
  if (cur.state === state && cur.tension === tension && cur.horde === horde) return;
  cur.state = state;
  cur.tension = tension;
  cur.horde = horde;
  applyLevels();
  updateDebug();
}

// Atenúa (pausa suave) sin destruir el grafo: para pausa de partida.
export function pauseMusic(): void {
  if (!running || !ctx || !bus) return;
  running = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  updateDebug();
}

// Reanuda tras una pausa.
export function resumeMusic(): void {
  if (!started || running || !ctx) return;
  running = true;
  nextNoteTime = ctx.currentTime + 0.1;
  if (timer) clearInterval(timer);
  timer = setInterval(schedulerTick, LOOKAHEAD_MS);
  updateDebug();
}

// Detiene y libera todo: volver al menú / fin de partida. Deja el grafo limpio
// para poder re-arrancar en la siguiente partida.
export function stopMusic(): void {
  running = false;
  started = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (ctx && layers) {
    // baja las capas rápido para no dejar cola colgada, luego desconecta.
    const now = ctx.currentTime;
    (Object.keys(layers) as (keyof Layers)[]).forEach((k) =>
      layers![k].gain.setTargetAtTime(0, now, 0.2),
    );
    const toDisconnect = layers;
    const ci = chorusIn;
    setTimeout(() => {
      try {
        (Object.keys(toDisconnect) as (keyof Layers)[]).forEach((k) =>
          toDisconnect[k].disconnect(),
        );
        ci?.disconnect();
      } catch {
        /* nada */
      }
    }, 800);
  }
  layers = null;
  chorusIn = null;
  ctx = null;
  bus = null;
  updateDebug();
}

// ---------- depuración (para verificar por preview_eval) ----------
interface MusicDebug {
  started: boolean;
  running: boolean;
  state: MusicState;
  tension: boolean;
  horde: boolean;
  bpm: number;
  ctxState: string | null;
  step: number;
  levels: Record<string, number> | null;
}
function updateDebug(): void {
  const dbg: MusicDebug = {
    started,
    running,
    state: cur.state,
    tension: cur.tension,
    horde: cur.horde,
    bpm: TEMPO[cur.state],
    ctxState: ctx ? ctx.state : null,
    step,
    levels: layers
      ? {
          pad: round3(layers.pad.gain.value),
          arp: round3(layers.arp.gain.value),
          bass: round3(layers.bass.gain.value),
          perc: round3(layers.perc.gain.value),
          tens: round3(layers.tens.gain.value),
        }
      : null,
  };
  (window as unknown as { __musicDebug?: MusicDebug }).__musicDebug = dbg;
}
// Hook de depuración: fuerza un estado musical desde la consola / preview_eval
// (p. ej. `__musicForce('boss', true, false)`), para verificar los crossfades de
// capa sin tener que provocar un jefe o quedarnos sin vidas en el juego real.
(window as unknown as { __musicForce?: (s: MusicState, t?: boolean, h?: boolean) => void }).__musicForce =
  (s, t = false, h = false) => setMusicState(s, t, h);
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
