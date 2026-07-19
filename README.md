# 🏰 Fortaleza — Tower Defense Cooperativo

Tower defense multijugador en tiempo real, para jugar con amigos en el navegador o
**dentro de Discord** (Activity). Servidor autoritativo en Cloudflare, render en Canvas
(cero frameworks en el juego), salas con código de 4 letras, chat, reconexión automática,
repeticiones, guardado de partida y tabla de récords global.

**Jugar:** https://fortaleza-td.bezenti.com — o desde Discord: canal de voz → 🚀 actividades → Fortaleza TD
(todo el canal cae automáticamente en la misma sala, con su nombre de Discord).

## Cómo funciona (arquitectura)

- **`packages/shared`** — el corazón: tipos, protocolo, balance (torres/enemigos/oleadas/mapas/calendario)
  y la **simulación completa, determinista** (enteros + RNG con seed; nada de `Math.random`/`Date`).
  TypeScript puro sin I/O: recibe estado + comandos y avanza un tick. El determinismo es lo que hace
  posibles las repeticiones, el guardado (seed + log de comandos) y la validación anti-trampas.
- **`apps/worker`** — **Cloudflare Workers + Durable Objects** (único backend). Cada sala es un
  Durable Object que corre la simulación autoritativa a 15 ticks/s, valida cada comando y ajuste de
  sala **server-side** (nadie hace trampa desde el cliente: ni comandos, ni settings, ni guardados
  adulterados) y difunde snapshots compactos. El Worker sirve además el cliente estático (SPA),
  `/api/*` (récords, salas públicas, Discord OAuth) y enruta cada WebSocket a su sala por código.
- **`apps/client`** — Vite + TypeScript vanilla. El juego se dibuja en `<canvas>` interpolando entre
  snapshots (el HUD es DOM). Partículas, audio y **música procedural adaptativa** por WebAudio,
  soporte táctil completo y modo espectador. El SDK de Discord se carga solo dentro de Discord
  (chunk aparte).

El cliente **nunca** envía estado, solo intenciones (`colocar torre en (x,y)`); el servidor re-valida
todo. Crea sala con `/ws?create=1` (el backend asigna código) y se une con `/ws?code=XXXX`.

## Contenido (balance v19)

- **14 torres** con 3 niveles, **especializaciones excluyentes** al máximo (el Arquero y el Estandarte
  tienen 3 ramas; el resto 2), **Rango ★★** con identidades propias (shred de armadura, ejecución por
  % de vida, crecimiento permanente…) y **Veteranía**: niveles 5→10 para torres en su cúspide, pagando
  oro **y madera** (en Infinito/Horda el tope se abre — el pozo del oro tardío).
- **11 fusiones curadas** estilo Element TD: dos torres especializadas y pegadas se funden en un arma
  única (Gran Bertha, Ojo de Asedio, Tormenta de Riel…).
- **Matriz de combate 4×4**: ataques físico/perforante/asedio/mágico contra armaduras
  ligera/media/blindada/colosal — el mono-build muere; la cartera diversificada gana.
- **26 especies de enemigos** (voladores, evasores, sanadores, spell-immunes, portaestandartes que
  aceleran a los suyos, colosales…), **élites con afijos**, **campeones 👑** (pelotones de mini-jefes)
  y **jefes con afijo con nombre** telegrafiado ("☠ Gólem Adaptativo") — el Adaptativo gana
  resistencia al tipo de daño que más recibe.
- **Clásico = calendario fijo de 36 oleadas** al estilo Green TD: cada oleada es una especie con su
  contrajuego, aéreas/inmunes/campeones en niveles fijos y públicos (pestaña 📅 en la Guía), jefe-muro
  en la 36. **Infinito** y **Horda** (bucle de saturación) con récords; **Turbo ⚡**, 3 dificultades y
  velocidad ×1/×2/×3 del anfitrión. En Infinito/Horda se puede **reparar la fortaleza** (coste
  escalado brutal).
- **11 mapas** en 5 temas — de El Sendero (20×12) a **El Gran Concilio (52×60, 9 puertas)**:
  transcripción fiel del mapa original de Green TD (geometría extraída del `.w3x`). En mapas
  multi-puerta: **reclama tu puerta por color** (tu cámara nace ahí, tu portal gira con tu color),
  el anfitrión puede **cerrar puertas** sin dueño (los monstruos salen solo por las abiertas) y la
  **densidad escala por ruta abierta** con presupuesto neutro (más bichos, misma dificultad).
- **Cámara**: encuadre cover sin bandas muertas, zoom/pan (rueda, pellizco, arrastre, **flechas**),
  minimapa con **radar de fugas** (la puerta que fuga parpadea en rojo) y mapas gigantes con
  `viewCap` — no ves el tablero entero: se juega navegando, como el Green TD original.
- Co-op de hasta 8: vidas compartidas, oro individual con bono por llamar antes, mercado de madera,
  tienda, ping cooperativo, espectadores que sugieren torres, expulsar/vetar, **continuar en otro
  dispositivo**, guardar/cargar partida y **repeticiones** con seek.
- **Rendimiento para máquinas débiles**: sprites de enemigos precacheados por especie (×3.5 medido) y
  **modo ligero autoadaptativo** (baja calidad solo si el frame se sostiene lento; selector en Ajustes).

## Desarrollo

```bash
pnpm install
pnpm dev          # worker con Durable Objects reales en :8787 + Vite en :5173
```

## Pruebas

```bash
pnpm check        # typecheck (shared, client, worker)
pnpm simtest      # partida completa con bots + determinismo + asserts de balance
SIMTEST_SEED=123456846 pnpm simtest   # barrer otras seeds sin tocar código
pnpm cf:dev &     # worker real en :8787…
pnpm wstest       # …test end-to-end: salas, comandos, puertas, guardado, Discord
```

## Deploy (Cloudflare Workers + Durable Objects)

Sin servidor que administrar; corre en el edge. Configuración en
[`apps/worker/wrangler.jsonc`](apps/worker/wrangler.jsonc) (dominio, KV de récords, Durable Objects).

```bash
npx wrangler login   # una vez
pnpm cf:dev          # probar en local (:8787)
pnpm cf:deploy       # compila el cliente y sube el Worker
```

Secretos opcionales (`npx wrangler secret put …` en `apps/worker/`, o el dashboard):
- `DISCORD_CLIENT_SECRET` — habilita la **Discord Activity** (el Client ID público va en `vars`).
- `ADMIN_TOKEN` — habilita `/api/admin/announce` (avisar a los conectados antes de un deploy).

Mientras haya jugadores conectados la sala vive en memoria; si todos se van a la vez, se libera por
inactividad. Las salas y récords sobreviven deploys normales; las partidas en curso se interrumpen
(por eso el aviso previo — o pide a los jugadores guardar).

## Balancear el juego

Todo el balance vive en `packages/shared/src/balance/` (torres, fusiones, enemigos, oleadas, afijos,
**calendar.ts** con el calendario clásico, mapas). Cambiar números ahí no toca lógica. Regla de oro:
si el cambio altera el COMPORTAMIENTO de la sim, sube `BALANCE_VERSION` en `constants.ts` (invalida
replays/guardados viejos a propósito). Después de tocar balance: `pnpm simtest` — el bot debe seguir
ganando la seed de referencia.

## Añadir un mapa

Entrada nueva en `packages/shared/src/balance/maps.ts`: grilla, rutas por waypoints (segmentos
horizontales/verticales; multi-ruta soportado — los tramos compartidos deben ser celda-idénticos),
decoración `blocked`, y opcionalmente `viewCap` (máximo de celdas visibles: el mapa se juega
navegando). Con ≥4 rutas se activan solas las puertas (reclamo por color y cierre del anfitrión).
Aparece automáticamente en los selectores; `pnpm simtest` valida la estructura.
