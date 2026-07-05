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
import { getMusicBus, getReverbSend, onAudioUnlock } from './audio.js';

// ---------- teoría musical ----------
// F6 · Rediseño "Celeste" (Lena Raine): la calidez no viene de tríadas planas
// sino de acordes EXTENDIDOS (add9/maj7) con voicings abiertos, un piano-pluck
// soñador, campanitas FM y MUCHA reverberación. Tonalidad: La menor.
// Progresión: Am9 – Fmaj7 – Cadd9 – Gadd9  (i9 – VImaj7 – IIIadd9 – VIIadd9).
const A2 = 45; // MIDI de A2 (nuestra referencia grave)
function midi(n: number): number {
  return 440 * Math.pow(2, (n - 69) / 12);
}

// Acorde = { raíz (bajo), notas del pad (voicing extendido), notas del arp,
// pool de la melodía de campanas (pentatónica del acorde, aguda) }.
interface Chord {
  root: number; // bajo
  pad: number[]; // voicing del pad (octava media, con 7ª/9ª)
  arp: number[]; // notas del arpegio (más agudo)
  lead: number[]; // pool para la campana melódica (más agudo aún)
}
const CHORDS: Chord[] = [
  // Am9: A C E B — la 9ª (B) es el "suspiro" Celeste
  { root: A2, pad: [A2 + 12, A2 + 15, A2 + 19, A2 + 26], arp: [A2 + 24, A2 + 27, A2 + 31, A2 + 26], lead: [A2 + 36, A2 + 38, A2 + 31, A2 + 43] },
  // Fmaj7: F A C E — flotante, sin resolver
  { root: A2 - 4, pad: [A2 + 8, A2 + 12, A2 + 15, A2 + 19], arp: [A2 + 20, A2 + 24, A2 + 27, A2 + 31], lead: [A2 + 32, A2 + 36, A2 + 31, A2 + 39] },
  // Cadd9: C E G D
  { root: A2 + 3, pad: [A2 + 15, A2 + 19, A2 + 22, A2 + 26], arp: [A2 + 27, A2 + 31, A2 + 34, A2 + 26], lead: [A2 + 38, A2 + 39, A2 + 34, A2 + 43] },
  // Gadd9: G B D A
  { root: A2 - 2, pad: [A2 + 10, A2 + 14, A2 + 17, A2 + 21], arp: [A2 + 22, A2 + 26, A2 + 29, A2 + 33], lead: [A2 + 34, A2 + 36, A2 + 33, A2 + 41] },
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
  lead: GainNode; // F6 · campana melódica (la "voz" soñadora)
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
// calm más soñador (76), combate con pulso pero sin apuro (100/114).
const TEMPO: Record<MusicState, number> = { calm: 76, wave: 100, boss: 114 };

const cur: Inputs = { state: 'calm', tension: false, horde: false };

// niveles objetivo de cada capa según el estado (0..1). El crossfade los aplica.
function targetLevels(i: Inputs): Record<keyof Layers, number> {
  const combat = i.state === 'wave' || i.state === 'boss';
  return {
    pad: i.state === 'boss' ? 0.55 : 0.75,
    arp: i.state === 'boss' ? 0.45 : i.state === 'wave' ? 0.6 : 0.7,
    bass: combat ? (i.state === 'boss' ? 0.9 : 0.75) : i.horde ? 0.5 : 0.0,
    perc: i.state === 'boss' ? 1.0 : i.state === 'wave' ? 0.65 : i.horde ? 0.4 : 0.0,
    tens: i.tension ? (i.state === 'boss' ? 0.5 : 0.4) : 0.0,
    // la campana canta en la calma, susurra en combate y calla ante el jefe
    lead: i.state === 'calm' ? 0.65 : i.state === 'wave' ? 0.4 : 0.2,
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

  // F6 · envío generoso a la REVERB GLOBAL: el "aire" Celeste. La percusión y el
  // bajo van casi secos (los manda chorusIn igual, pero la porción es del bus
  // completo y queda equilibrada por el nivel del envío).
  const rev = getReverbSend();
  if (rev) {
    const toRev = ac.createGain();
    toRev.gain.value = 0.34;
    chorusIn.connect(toRev).connect(rev);
  }

  // capas: cada una parte en 0 y se sube por crossfade según el estado.
  const mk = (): GainNode => {
    const g = ac.createGain();
    g.gain.value = 0;
    g.connect(chorusIn!);
    return g;
  };
  layers = { pad: mk(), arp: mk(), bass: mk(), perc: mk(), tens: mk(), lead: mk() };
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
      ['triangle', -4, 0.075],
      ['sine', 5, 0.05],
      ['sine', 1203, 0.016], // brillo: octava arriba, apenas audible (shimmer)
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

// F6 · Piano-pluck soñador: fundamental + armónicos 2/3 débiles con decay largo
// (suena a piano eléctrico de ensueño, no a "beep"). El detune mínimo y la
// velocidad humanizada le quitan lo robótico; la cola larga se funde en la reverb.
function playArp(ac: AudioContext, note: number, t0: number, dur: number, vel: number): void {
  if (!layers) return;
  const f = midi(note);
  const master = ac.createGain();
  const peak = 0.15 * vel * (0.9 + Math.random() * 0.2); // velocidad humana
  master.gain.setValueAtTime(0.0001, t0);
  master.gain.exponentialRampToValueAtTime(peak, t0 + 0.008); // golpe suave
  master.gain.exponentialRampToValueAtTime(peak * 0.35, t0 + dur * 0.5);
  master.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * 1.5); // cola larga
  master.connect(layers.arp);
  const HARMONICS: [number, number, OscillatorType][] = [
    [1, 1.0, 'sine'],
    [2, 0.32, 'sine'],
    [3, 0.1, 'triangle'],
  ];
  for (const [mult, vol, type] of HARMONICS) {
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.value = f * mult;
    osc.detune.value = (Math.random() * 2 - 1) * 4;
    const g = ac.createGain();
    g.gain.value = vol;
    // los armónicos altos mueren antes (como en un piano de verdad)
    if (mult > 1) {
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur * (mult === 2 ? 0.7 : 0.35));
    }
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur * 1.5 + 0.05);
  }
}

// F6 · Campana FM (la "voz" Celeste): portadora sine + modulador a razón 2 con
// índice pequeño que decae — vidrio cálido con cola larguísima hacia la reverb.
function playLead(ac: AudioContext, note: number, t0: number, dur: number): void {
  if (!layers) return;
  const f = midi(note);
  const carrier = ac.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.value = f;
  const mod = ac.createOscillator();
  mod.type = 'sine';
  mod.frequency.value = f * 2;
  const modGain = ac.createGain();
  modGain.gain.setValueAtTime(f * 0.9, t0); // índice FM inicial (brillo del golpe)
  modGain.gain.exponentialRampToValueAtTime(f * 0.05, t0 + dur * 0.6); // se apaga a puro cristal
  mod.connect(modGain).connect(carrier.frequency);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  carrier.connect(g).connect(layers.lead);
  carrier.start(t0);
  mod.start(t0);
  carrier.stop(t0 + dur + 0.05);
  mod.stop(t0 + dur + 0.05);
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
  // más redondo y menos "click": arranque más grave y caída más lenta
  osc.frequency.setValueAtTime(120, t0);
  osc.frequency.exponentialRampToValueAtTime(44, t0 + 0.14);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
  osc.connect(g).connect(layers.perc);
  osc.start(t0);
  osc.stop(t0 + 0.24);
}
function playHat(ac: AudioContext, t0: number, vol: number): void {
  if (!layers) return;
  const len = Math.floor(ac.sampleRate * 0.05);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ac.createBufferSource();
  src.buffer = buf;
  // banda en vez de highpass puro: hat más oscuro y suave (menos "tss" digital)
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 8000;
  bp.Q.value = 0.9;
  const g = ac.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.045);
  src.connect(bp).connect(g).connect(layers.perc);
  src.start(t0);
  src.stop(t0 + 0.06);
}
// F6 · Shaker: ruido en banda media con decay más largo que el hat — el vaivén
// suave que mueve el combate sin ponerse marcial.
function playShaker(ac: AudioContext, t0: number, vol: number): void {
  if (!layers) return;
  const len = Math.floor(ac.sampleRate * 0.09);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 4200;
  bp.Q.value = 1.2;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
  src.connect(bp).connect(g).connect(layers.perc);
  src.start(t0);
  src.stop(t0 + 0.1);
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

  // ARPEGIO: cada corchea, con dinámica (acentos en 0 y 4), timing humanizado
  // (±8 ms) y un VIAJE DE OCTAVA: cada 2 de 4 compases el arpegio sube una
  // octava — la sensación de "ascenso" tan Celeste.
  const lift = barIndex % 4 >= 2 ? 12 : 0;
  const arpNote = chord.arp[ARP_PATTERN[posInBar]] + lift;
  const accent = posInBar === 0 || posInBar === 4 ? 1 : 0.7;
  const tHuman = t0 + (Math.random() - 0.5) * 0.016;
  // en calma suena todo el arpegio; en combate/boss se ralea un poco para dejar
  // espacio a la percusión (más punchy).
  const arpOn = cur.state === 'calm' ? true : posInBar % 2 === 0 || Math.random() > 0.4;
  if (arpOn) playArp(ctx, arpNote, tHuman, eDur * 1.6, accent);

  // CAMPANA melódica (F6): una nota larga del pool del acorde, en las corcheas
  // 2 o 6, no siempre (frases con silencio = respiración). Más presente en calma.
  if ((posInBar === 2 || posInBar === 6) && Math.random() < (cur.state === 'calm' ? 0.55 : 0.3)) {
    const leadNote = chord.lead[Math.floor(Math.random() * chord.lead.length)];
    playLead(ctx, leadNote, t0, eDur * 6);
  }

  // PERCUSIÓN: bombo en 0 y 4; hats en las corcheas impares; shaker en 3 y 7
  // durante el combate. En boss, bombo más denso (también en 2 y 6).
  const kickBeats = cur.state === 'boss' ? [0, 2, 4, 6] : [0, 4];
  if (kickBeats.includes(posInBar)) playKick(ctx, t0, cur.state === 'boss' ? 0.9 : 0.7);
  if (posInBar % 2 === 1) playHat(ctx, t0, cur.state === 'boss' ? 0.055 : 0.04);
  if ((posInBar === 3 || posInBar === 7) && cur.state !== 'calm') playShaker(ctx, t0, 0.05);
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
          lead: round3(layers.lead.gain.value),
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
