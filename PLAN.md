# 🗺️ Plan de expansión — Fortaleza TD

Roadmap de 7 features en 5 fases. **Ejecutor por defecto: Opus 4.8.**
Las tareas marcadas 🧠 **Fable-5** son las de mayor dificultad arquitectónica o de diseño
y deben ejecutarse con ese modelo.

**Reglas de ejecución para el orquestador (aplican a TODAS las tareas):**

1. Leer este plan y la tarea concreta antes de tocar código. El estado del arte del
   código manda sobre el plan si difieren (el plan se escribió en julio 2026).
2. La simulación (`packages/shared/src/sim`) es **determinista**: nada de `Math.random`,
   `Date.now` ni iterar mutando `state.enemies` (usar longitud fija inicial — ver la
   prueba «los babosines sobreviven a su golpe de nacimiento» en `tools/simtest.ts`).
3. Todo cambio de sim/balance/protocolo debe aplicarse a **ambos backends**
   (`apps/server` Node y `apps/worker` Durable Object) — comparten `@td/shared`, así
   que normalmente solo hay que tocar la sala si cambia la orquestación.
4. Snapshot compacto: los tipos nuevos se **añaden al final** de las tuplas/órdenes
   (`TOWER_ORDER`, `ENEMY_ORDER`, `SnapTower`, `SnapEnemy`) para no romper índices.
5. Puerta de salida de cada tarea: `pnpm check` + `pnpm simtest` (extender con la
   feature) + `pnpm build` + `pnpm wstest` contra Node **y** contra el Worker
   (`pnpm cf:dev` + `PORT=8787 pnpm wstest`) + prueba en navegador + commit.
6. Los nombres de jugador SIEMPRE se escapan antes de `innerHTML` (hubo un XSS).
7. Tocar balance ⇒ bump de `BALANCE_VERSION` en `packages/shared/src/constants.ts`
   (las repeticiones dependen de esto a partir de la Fase 2).

---

## Fase 1 — Victorias rápidas (todas Opus 4.8, ejecutar en este orden)

### F1.1 · Mapas más grandes + minimapa — Opus 4.8 · riesgo bajo-medio

- 2 mapas nuevos en `packages/shared/src/balance/maps.ts`:
  - **El Concilio** 32×20, estilo **Green TD**: 4-6 entradas repartidas por los bordes,
    cada una serpentea por "su territorio" y TODAS convergen en el **castillo central**
    (salida única compartida, como La Encrucijada/Delta pero radial). Cada jugador
    defiende su flanco; las vidas se pierden juntas en el centro. Tema grass.
  - **La Torre** 14×24 (¡vertical!) — pensado para celular en modo retrato.
- **Minimapa** (cliente, `renderer.ts`): esquina superior derecha, visible cuando
  `zoom > 1.15` o el mapa supera ~24 celdas de ancho. Render barato: `drawImage` del
  `mapLayer` ya cacheado a escala mini + puntos de enemigos (rojo/élite morado) +
  puntos de torres + **rectángulo del viewport** estilo WC3. Tap/arrastre en el
  minimapa = recentrar cámara (usar el API `panBy`/zoom existente). Toggleable,
  compacto en móvil (~110 px), oculto en pantallas muy bajas.
- La validación estructural de `simtest` ya cubre mapas nuevos automáticamente.
- Aceptación: simtest valida y los bots juegan en ambos mapas; miniaturas del selector
  bien (las genera `drawMiniMap` solo); en móvil, navegar El Concilio con zoom +
  minimapa es cómodo (tap en el minimapa lleva la cámara ahí).

### F1.2 · Estandarte: auras de fuerza y velocidad, mejorables — Opus 4.8 · riesgo medio

La novena torre (hotkey 9), estilo Green TD: no ataca, buffea torres en radio.

- `balance/towers.ts`: añadir `banner` **al final** de `TOWER_ORDER`. Niveles 1→3:
  +15%/+25%/+35% de daño, radio 2.2/2.6/3.0, costos ~90/140/220. Especializaciones:
  **Estandarte de Guerra** (+60% daño) / **Estandarte de Celeridad** (torres en radio
  disparan +40% más rápido). `TowerLevelDef` gana `auraDamage?: number` y
  `auraHaste?: number` (fracciones, p. ej. 0.25).
- Sim (`sim/step.ts`): antes de `stepTowers`, computar por tick un mapa
  `towerId → {dmgMult, hasteMult}`; **no se apilan**: por cada torre buffeada aplica
  solo el MEJOR aura de cada tipo. `fireTower` multiplica daño y divide cooldown.
  El estandarte mismo no dispara (como la mina).
- Render: mástil con bandera ondeante (reutilizar la bandera del castillo en
  `renderer.ts`), anillo dorado en el suelo (como el aura de Escarcha), brillito en
  las torres buffeadas. Panel (`hud.ts`): "Da +25% de daño a **N** torres".
- simtest: bot construye estandarte junto a torres y el daño total sube vs. sin él;
  assert de no-apilamiento (2 estandartes ≠ 2× buff).

### F1.3 · Sonido v2 (SFX) — Opus 4.8 · riesgo medio

`apps/client/src/audio.ts` es 100% procedural (WebAudio, sin archivos) — mantener eso.

- Envelopes ADSR de verdad, capas (golpe grave + click agudo), variación aleatoria de
  pitch por disparo (±5%) para que 10 arqueros no suenen a metralleta idéntica.
- **Pan estéreo por posición**: `StereoPannerNode` según la x del evento en el mapa
  (los eventos ya traen x,y). Firma sonora distinta por torre (8+), sting de élite,
  percusión de jefe, fanfarrias de victoria/derrota más ricas.
- Límite de voces simultáneas (~12) con prioridad (jefe > élite > resto) y ducking.
- Ajustes: mini-panel ⚙ con sliders separados **SFX** y **Música** (persistidos en
  localStorage; el de música queda listo para F3.2).
- Aceptación: sin errores de consola, sin clipping (limiter en el master), audible la
  diferencia posicional izquierda/derecha en el preview.

### F1.4 · Modo espectador que puede GUIAR — Opus 4.8 · riesgo medio

Hoy, con la partida en curso, un jugador nuevo recibe «La partida ya comenzó». Nuevo
comportamiento: entra como **espectador** — ve todo y puede guiar, pero no juega.

- Protocolo: `room_joined` gana `spectator?: boolean`. En ambos backends
  (`apps/server/src/room.ts` y `apps/worker/src/room-do.ts`): lista
  `spectators: {ws, name, token}[]` separada de `players`; los broadcast
  (`tick/chat/paused/speed/map_ping/game_over`) incluyen espectadores; los comandos de
  juego (`cmd/start/pause/set_speed/set_settings`) los ignoran.
- **Guiar** = chat (prefijo 👁 en el nombre) + `map_ping` + **sugerencia de torre**:
  `map_ping` gana `towerType?: TowerTypeId` — el marcador se dibuja como el fantasma
  de esa torre con el nombre de quien sugiere («👁 Abuelo sugiere: Cañón aquí»).
  Disponible también para jugadores.
- Al terminar la partida, los espectadores pasan automáticamente al lobby como
  jugadores (crear `RoomPlayer` en ese momento; respetar `MAX_PLAYERS`).
- Cliente: banner persistente «👁 Espectador — entras en la próxima partida», ocultar
  barra de torres/oro/botones de acción; para sugerir usa la misma barra de torres en
  "modo sugerencia" (el tap manda la sugerencia en vez de colocar).
- wstest: con partida en curso, un token nuevo entra como espectador, recibe ticks,
  su ping-sugerencia llega a los jugadores, y al `game_over` aparece en `lobby_state`.

**Puerta de fase**: gate completo (regla 5) + commit por tarea + push al final de la fase.

---

## Fase 2 — Motor y modos

### F2.1 · 🧠 Repeticiones — **FABLE-5** · riesgo ALTO (la tarea más difícil del plan)

La sim determinista hace que un replay = `{seed + comandos}` (~2 KB). Nadie más puede
hacerlo tan barato; hay que hacerlo bien.

- **Grabación (ambos backends)**: al drenar `pendingCmds` en `tick()`, anotar
  `[state.tick, playerId, cmd]`. Guardar `{v: BALANCE_VERSION, seed, mapId, mode,
  difficulty, players: [{id,name,color}], cmds}`. OJO: la velocidad x2/x3 mete varios
  `stepGame` por tick de red — los comandos deben grabarse con el **tick de sim** en
  que se aplican (el primero de la ráfaga), no el tick de red.
- Entrega: mensaje `game_over` gana `replay?: ReplayData` (o mensaje aparte si pesa).
  El cliente lo guarda (localStorage, máx. 10) y permite descargar/cargar `.json`.
- **Motor de reproducción en el cliente**: el cliente ya tiene `@td/shared` completo —
  correr `createGame(seed…)` + `stepGame` localmente inyectando los comandos grabados
  en su tick, y alimentar el MISMO pipeline de render (`pushFrame` + `onTick` +
  `processEvents`) a 15 snapshots/s. Sin red. Modo `store.replay` que desactiva
  todo input de juego.
- Controles: ▶/⏸, velocidad x1/x2/x4, barra de progreso con **seek** (re-simular de 0
  al tick destino: 20k ticks tardan <100 ms, medido en simtest ~180k ticks/s).
- Guard de versión: si `v !== BALANCE_VERSION` → «repetición de una versión anterior»
  (se ofrece reproducir igual, sin garantías).
- Verificación CLAVE: reproducir un replay grabado en wstest y comparar el estado
  final (`tick/wave/lives/oro/rng`) con el de la partida original — deben ser
  **idénticos**. Añadir esto como assert nuevo del wstest.

### F2.2 · Modo Horda — Opus 4.8 · riesgo medio

El modo Green TD: los enemigos no escapan, dan vueltas; pierdes por saturación.

- `GameMode` gana `'horde'`. En la sim: la rama de fuga (wpIdx >= final) NO quita
  vidas ni elimina — teletransporta al inicio del camino (`wpIdx=1, travelled=0`,
  misma hp). Derrota cuando `enemies.length >= cap` (cap por dificultad: 45/38/32,
  constantes en `constants.ts`). Sin oleada final: como el infinito, con récords
  propios (highscores ganan campo `mode`).
- HUD: el chip 👾 pasa a ser la vida — `👾 32/38`, amarillo desde 70%, rojo desde 90%
  con pulso. Ocultar ❤.
- UI: tercera opción en los segmentados de modo (home + lobby): «Horda 🌀 (récords)».
- Cuidados de balance: el chamán/regeneradores que dan vueltas curándose pueden
  volverse esponjas eternas — los que completan una vuelta ganan un stack visible
  «Cansancio» (−10% hp máx por vuelta, acumulable) para que la horda vieja muera.
- simtest: escenario horda — bots sobreviven ≥8 oleadas, la partida termina por
  saturación (no cuelga infinito), determinismo se mantiene.

**Puerta de fase**: gate completo; el replay debe poder reproducir una partida de horda.

---

## Fase 3 — Sonido pro

### F3.1 · 🧠 Música procedural adaptativa — **FABLE-5** · riesgo alto (calidad subjetiva)

Que suene BIEN es la parte difícil; por eso va a Fable-5.

- 100% WebAudio, sin archivos: capa ambiental por tema de mapa (drone + pad + arpegio
  pentatónico con progresión lenta), que **reacciona al juego**: interludio = calma,
  oleada = añade percusión y sube tempo, jefe = capa épica (percusión grave + quinta),
  vidas < 5 = tensión (semitono, tremolo). Transiciones con crossfade, nunca cortes.
- Scheduler con look-ahead (patrón estándar de WebAudio: programar 2 compases por
  delante con `setInterval` de 100 ms), master con compressor/limiter compartido con
  los SFX de F1.3, control por el slider «Música».
- Aceptación subjetiva: escucharla 5 minutos sin que canse (loop no evidente),
  y que el cambio interludio→oleada→jefe se perciba claramente.

---

## Fase 4 — Gran contenido

### F4.1 · +5 monstruos y +2 jefes — Opus 4.8 · riesgo medio

Solo enemigos que crean decisiones nuevas (añadir al FINAL de `ENEMY_ORDER`):

- **Zapador 🔨** — se detiene junto a la torre más cercana al camino y la aturde
  (torre no dispara mientras viva; `TowerState` gana `stunnedBy`). Prioridad de fuego.
- **Ladrón 💰** — rápido, no quita vidas: si escapa roba 25 de oro repartido.
- **Berserker 🐗** — bajo 50% de vida corre ×1.8 (leer hp en stepEnemies).
- **Coloso alado 🦅** — volador TANQUE (hueco actual: todo lo volador es frágil).
- **Espectro mayor 👻** — esquiva 50%, inmune a veneno; contrapeso: lento.
- Jefes: **Quimera** (oleada 15 del clásico, VOLADORA — invalida cañón/mortero y
  obliga a doble build) y **Behemot** (oleada 25+ del infinito/horda, aplasta:
  aturde todas las torres en radio 2 al cruzar cada esquina).
- simtest: pool de oleadas los incluye, bots siguen ganando el clásico en normal.

### F4.2 · +2 torres y rango II de especializaciones — Opus 4.8 · riesgo medio

- **Trampa de púas 🪤** — la ÚNICA construible sobre el camino (relajar
  `placementError` por tipo): daña a quien pasa encima, 20 cargas y se vende sola.
  Abre el camino como espacio táctico.
- **Alquimista ⚗️** — aura económica: +30% de bounty por bajas dentro de su radio
  (no se apila; reutiliza la infraestructura de auras del Estandarte).
- **Rango II de especialización** («más niveles»): cada especialización puede
  mejorarse UNA vez más (p. ej. Ballesta Repetidora II: 4 disparos): `TowerSpecDef`
  gana `rank2: {cost, ...overrides}`; `TowerState.spec` sigue igual y `level` pasa a
  4 para representarlo. Visual: segunda corona/gema. Es la forma de subir el techo
  sin reequilibrar los niveles 1-3.

### F4.3 · 🧠 Fusión de torres — **FABLE-5** · riesgo ALTO (diseño + balance)

Element TD style, pero con recetas CURADAS (no combinatoria):

- Regla: dos torres **especializadas**, **adyacentes** (distancia Chebyshev 1), del
  mismo dueño → botón «⚗ Fusionar» en el panel. La fusión consume ambas y crea UNA
  torre fusionada en la celda elegida de las dos (la otra queda libre).
- 6 recetas iniciales (definir en `balance/fusions.ts` con mecánica única cada una):
  Hielo+Veneno = *Plaga Glacial* (nube que ralentiza y envenena en área) ·
  Tesla+Francotirador = *Tormenta de Riel* (rayo perforante que atraviesa en línea) ·
  Cañón+Mortero = *Gran Bertha* (proyectil de mapa completo, cooldown enorme) ·
  Arquero+Estandarte = *Señor de la Guerra* (dispara Y buffea) ·
  Veneno+Alquimista = *Filósofo* (las bajas por veneno pagan doble) ·
  Hielo+Estandarte = *Corazón de Invierno* (aura que ralentiza enemigos Y acelera torres).
- Sim: `TowerState.fusion?: FusionId` con stats propios; los snapshots añaden el
  campo al final de la tupla. Render: arte combinado + partículas dobles.
- Riesgo real: que una receta rompa el juego. OBLIGATORIO: simtest con bots que
  fusionan + pase de balance con 500 partidas simuladas por receta comparando
  win-rate vs. sin fusión (±10% aceptable).

---

## Fase 5 — Cierre (todo 🧠 **FABLE-5**)

### F5.1 · Balance global + revisión adversarial + release

- Simulación masiva: bots en TODOS los mapas × modos × dificultades (matriz completa),
  detectar outliers (mapa imposible, estrategia dominante, economía rota).
- Revisión adversarial multi-agente del código nuevo (como las dos anteriores:
  dimensiones sim/protocolo/render/input/regresiones, verificación con 2 escépticos).
- README + memoria del proyecto actualizados, `BALANCE_VERSION` final, commit,
  `pnpm cf:deploy`, y probar la URL de producción con 2 clientes reales.

---

## Resumen de asignación de modelos

| Tarea | Modelo | Por qué |
|---|---|---|
| F1.1 Mapas · F1.2 Estandarte · F1.3 SFX · F1.4 Espectador | Opus 4.8 | patrón conocido, infraestructura ya existe |
| F2.1 Repeticiones | 🧠 **Fable-5** | arquitectura nueva (sim en cliente, seek, versionado) |
| F2.2 Horda | Opus 4.8 | cambio de sim acotado + balance con bots |
| F3.1 Música procedural | 🧠 **Fable-5** | calidad subjetiva difícil, audio adaptativo |
| F4.1 Monstruos · F4.2 Torres/Rango II | Opus 4.8 | contenido sobre sistemas existentes |
| F4.3 Fusión | 🧠 **Fable-5** | diseño mecánico + riesgo de balance alto |
| F5.1 Balance global + revisión + release | 🧠 **Fable-5** | juicio fino transversal |
