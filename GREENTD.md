
---

## 0. Resumen de constantes globales (verificadas en el JASS)

| Constante | Valor | Fuente |
|---|---|---|
| Vidas iniciales | **50** | `set udg_LIVES=50` (l.836) |
| Oro inicial por jugador | **525** | `SetPlayerStateBJ(...,525)` (l.1192) |
| Bono de oro de ronda inicial | **20**, crece +`4*LVL` por oleada | l.835, l.1753 |
| Oleadas totales | **36** | `CREEPS_WAVE[1..36]`, texto "Wave X of 36" |
| Creeps por oleada por carril | **30** (excepto oleada 31 = 16, oleada 36 = 8) | l.1569-1575 |
| Jugadores | **9** (carriles separados, 1 por color) | `w3i`, spawn points 1-9 |
| Immune cada | **5 niveles** (5,10,15,20,25,30,35) | WTS STRING 370 |
| Niveles aéreos | **7, 17, 23, 27, 35** | WTS STRING 371 |
| Niveles héroe | **28, 29, 30, 32, 33, 34** | array de creeps héroe |

---

## 1. Sistema de daño / armadura (CLAVE)

**Sí, usa íntegramente el sistema WC3 de attack-type vs armor-type.** No es un sistema propio; se apoya en la tabla de multiplicadores nativa de Warcraft III. Esto es lo que hace que "anti-tierra / anti-aire / anti-inmune" funcione sin código.

### Cómo se mapea a los tres ejes del TD

1. **Anti-tierra vs anti-aire** = campo de *targets* del arma (`ua1g`), no el tipo de daño.
   - Torres siege: `targets = enemies,ground` → **solo pueden apuntar a tierra**.
   - Torres air: `targets = air,enemies` → **solo apuntan a aire**.
   - Torres poison/frost/chaos y la súper-torre: `targets = air,enemies,ground` → **apuntan a ambos**.
   - Consecuencia de diseño: en las oleadas aéreas, las siege quedan **inútiles**; obligan a diversificar.

2. **Anti-inmune** = interacción entre *attack-type* de la torre y la *ability de inmunidad* del creep.
   - Los creeps de oleada inmune llevan la ability `Amim` (inmunidad mágica tipo "runed bracers"/spell-immune). Verificado: oleadas 5,10,15,20,25 tienen `Amim` en su lista de abilities.
   - Efecto exacto (WTS STRING 370 y 373, traducido): *"Los creeps inmunes son inmunes a todo daño de hechizo y el tipo de ataque mágico no les funciona. Son inmunes al quemado del Fire Trap, a las Ice Towers y a las Spell Towers."*
   - Es decir: contra inmunes solo sirve **daño físico** (attack-types normal/pierce/siege/hero). Las torres de tipo *magic* y todos los efectos por hechizo/dummy (burn, freeze, chain-lightning, execute) **no aplican**.

3. **Tipos de armadura de los creeps** (extraídos del `w3u`, campo `udty`): varían por oleada — `large` (light), `medium`, `fortified`, `hero`, y `divine` en el jefe final. Esto crea un puzzle de emparejamiento attack-type↔armor sobre el que el jugador debe pensar (p. ej. siege pega fuerte a fortified, mal a hero).

> **Transferible a motor propio sin WC3:** define una matriz `attackType × armorType → multiplicador` (5×6 aprox.), un flag `targetsGround/targetsAir` por torre, y un flag `spellImmune` por creep que anula todo daño marcado como "mágico/efecto". Con esos tres ejes reproduces el 90% de la profundidad táctica.

---

## 2. Familias de torres

Todas las torres son **estructuras** (`hctw`/`hgtw`/`ntt1`/`ndt2`/`hatw` como tipos base) con HP fijado a 9999 al construirse (l.1302; no pueden morir). Números extraídos del `w3u`: `gold` = coste, `atk` = daño base, `cd` = cooldown de ataque (seg), `rng` = alcance.

### 2.1 Siege (anti-tierra, splash) — la columna vertebral
Rol: DPS a tierra con **splash** (`weaponType = msplash`). Cadena de ~15 tiers, coste y daño escalando fuerte.

| Tier | Coste (oro) | Daño base | Cooldown |
|---|---|---|---|
| 1 | 25 | 30 | 1.0 |
| 2 | 40 | 75 | 1.0 |
| 3 | 65 | 140 | 1.0 |
| 4 | 120 | 224 | 1.0 |
| 5 | 140 | 400 | 1.0 |
| 6 | (upgrade) | 650 | 0.7 |
| 7 (BladeMaster) | 180 | 900 | 1.0 |
| 8 | 200 | 1200 | 0.5 |
| 9 | 250 | 1650 | 0.5 |
| 10 | 300 | 2000 | 0.5 |
| 11 | 450 | 2600 | 0.3 |
| alto (n00S) | 600 | 3000 | 0.3 |

Patrón claro: **coste sube ~linealmente, daño sube exponencialmente, cooldown baja** al subir de tier. Solo tierra.

### 2.2 Poison (tierra+aire, DoT + slow)
Rol: single-target con **veneno (DoT) que además ralentiza** ("slow poison", ability `A01I`). Sube por tiers ganando "better damage / better speed". Apuntan a **tierra y aire**.

| Tier ejemplo | Coste | Daño | Cooldown |
|---|---|---|---|
| bajo | 15 | 15 | 0.6 |
| medio | 90 | 110 | 0.4 |
| 210 | 210 | 280 | 0.4 |
| alto | 330 | 800 | 0.1 (rng 1000) |

Descripción canónica (WTS): *"Attacks land and air units. Upgradable, slow poison, single target attack."* — el gancho es el **slow acumulado** que compensa el single-target.

### 2.3 Air (anti-aire puro, splash)
Rol: única familia efectiva en oleadas aéreas. `targets = air,enemies`. Con **splash**. Rango largo (650-750).

| Tier | Coste | Daño | Cooldown | Rango |
|---|---|---|---|---|
| 1 | 30 | 90 | 0.6 | — |
| 2 | 70 | 200 | 0.3 | — |
| 3 | 190 | 300 | — | 650 |
| 4 | 320 | 550 | 0.75 | 650 |
| 5 | 390 | 750 | 0.75 | 700 |
| 6 | 470 | 1000 | 0.5 | 700 |
| 7 | 590 | 1250 | 0.5 | 750 |
| 8 | 700 | 1500 | 0.4 | 750 |

### 2.4 Frost / Ice (slow / control)
Rol: **ralentización de área** (ability `A008`, basada en FrostNova/Slow del WC3). Splash, rango largo (900). Ejemplos: 150 oro / 150 daño / rng 900. Ability de frío = `Aasl` (Slow). **No funciona contra inmunes.**

### 2.5 Fire Trap (trampa de quemado)
Rol: no es torre de ataque, es una **trampa de zona**: *"Burns the units that walk or fly by it"* (quemado por proximidad, DoT). Coste ~250. **No funciona contra inmunes.** Es la única "torre" que pega a aire y tierra por pisar, no por apuntar.

### 2.6 Spell Tower (proc de hechizos aleatorios) — ver §6
Torre que en cada ataque tira 1-100 y dispara un hechizo aleatorio según el tier. No hace daño "normal"; su valor está en los procs.

### 2.7 Chaos Tower (I/II/III)
Tres tiers, solo tierra (*"Attacks land units only"*). Probablemente daño tipo *chaos* (multiplicador uniforme vs toda armadura) — el nombre y que herede de `hctw` lo sugiere, aunque el valor exacto del attack-type no se pudo confirmar en el binario (heredado de la base). **Rol funcional: siege premium que ignora ventajas/desventajas de armadura.**

### 2.8 Súper-torre única (h00C)
Coste **4000**, daño **7435**, rango 800, attack-type **hero**, apunta a tierra+aire. Es la torre "endgame". Tiene además un proc pasivo (ver §6). Es el sumidero de oro de fin de partida.

---

## 3. Mecánica de oleadas

- **36 oleadas**, cada una es **un único tipo de creep** (`CREEPS_WAVE[LVL]`), spawneado **30 veces por carril** (16 en oleada 31, 8 en la 36).
- Spawn **escalonado**: primero 4 carriles, `PolledWait(4s)`, luego el resto con esperas de 2s — reparte la carga y da textura al "río" de creeps.
- **Curva de HP por oleada** (extraída del `w3u`, es una tabla a mano, no una fórmula):

| Oleada | HP | Oleada | HP | Oleada | HP |
|---|---|---|---|---|---|
| 1 | 1.100 | 13 | 41.000 | 25 | 160.000 |
| 2 | 1.600 | 14 | 44.000 | 26 | 250.000 |
| 3 | 2.100 | 15 | 46.000 | 27 | 350.000 |
| 4 | 3.200 | 16 | 50.000 | 28 (héroe) | 340.000 |
| 5 (inmune) | 3.200 | 17 (aéreo) | 42.000 | 29 | 400.000 |
| 6 | 4.400 | 18 | 61.000 | 30 (héroe/inm) | 400.000 |
| 7 (aéreo) | 3.500 | 19 | 85.000 | 31 | 500.000 |
| 8 | 7.500 | 20 (inmune) | 76.000 | 32 | 400.000 |
| 9 | 8.600 | 21 | 130.000 | 33 | 400.000 |
| 10 (inmune) | 16.000 | 22 | 160.000 | 34 | 500.000 |
| 11 | 35.000 | 23 (aéreo) | 150.000 | 35 (aéreo/inm) | 250.000 |
| 12 | 38.000 | 24 | 250.000 | **36 (jefe)** | **300.000** |

  La **armadura** también sube (~10 en oleada 1 → 40-56 en oleadas altas → **hero/150 en jefes** → **divine/600 en el jefe final**). El jefe final combina 300k HP + 600 armadura + attack/armor tipo divino: un muro deliberado.

- **Oleadas AÉREAS (7,17,23,27,35):** solo las torres Air pueden apuntarlas. Castigan al que sobre-invirtió en siege.
- **Oleadas HÉROE (28-34):** creeps con armor-type *hero* (resistente a la mayoría de attack-types), velocidad alta (hasta 522) y HP masivo. El sistema activa un **anti-stuck de héroe** (trigger periódico a 0.13s) al llegar a la 28.
- **Oleadas INMUNE (cada 5):** creeps con ability `Amim` (spell-immune). Ver §1. Anulan Fire Trap, Ice, Spell Towers y torres de tipo mágico. Fuerzan tener **daño físico puro** de reserva.
- **Comandos `-air` / `-hero` / `-immune` / `-boss`:** son **PURO ANUNCIO**. Cada uno solo hace `DisplayTextToForce` recordando en qué niveles ocurren esos tipos (l.3618-3701). **No cambian nada del estado del juego.** Sirven como recordatorio para planificar compras. (Además hay mensajes automáticos temporizados que anuncian lo mismo a los 200s/320s de partida.)

---

## 4. Sistema de vidas / fin de partida — **NO HAY LOOP**

**Hallazgo crítico:** cuando un creep entra en el rect `END` (el Trono):

```
call KillUnit(GetEnteringUnit())      // el creep se ELIMINA, no hace loop
if LIVES > 0:
    if LVL < 10:  LIVES = LIVES - 1
    else:         LIVES = LIVES - ((LVL/10)+1)   // fuga escala con la oleada
```

- **El creep que fuga se MATA y desaparece.** No da la vuelta, no reaparece, no reingresa al carril. Green TD **no** hacía loop de creeps.
- **Vidas = 50** compartidas (hay una unidad "Trono" `nzlc` con 50 HP que refleja las vidas en pantalla).
- **Fuga escalonada:** antes de la oleada 10, cada creep que llega quita **1 vida**. Desde la 10 en adelante quita **`(LVL/10)+1`** vidas (oleada 10-19 = 2, 20-29 = 3, 30-36 = 4). Un leak tardío duele 4x más que uno temprano.
- **Derrota:** un trigger periódico (cada 1s) comprueba `LIVES <= 0` → explota el Trono y ejecuta `CustomDefeat` para toda la fuerza. Derrota **compartida** (co-op real: todos pierden juntos).
- **Victoria:** al limpiar la oleada 36 → `CustomVictory` para todos.

> **Implicación de diseño:** como no hay loop y las vidas son compartidas, un jugador débil arrastra a todo el equipo. El castigo creciente por leak tardío es lo que mantiene la tensión al final.

---

## 5. Economía

Tres fuentes de ingreso, muy transferibles:

1. **Bounty por kill (oro):** cada creep da oro al matarlo (`ubba`/`ubdi`/`ubsi` en el `w3u`; `PLAYER_STATE_GIVES_BOUNTY` activado para el dueño de los creeps). Valores extraídos:
   - Creeps normales: **~29-75 oro** por kill (sube con la oleada: 30 al inicio, 50-75 en oleadas altas).
   - Héroes/jefes: **120-315 oro** (jefe final `nsgh` = **315**).
   - El oro va a **quien da el golpe mortal** (kill-steal real; hay leaderboards de kills por color de jugador). Esto premia el "last hit".

2. **Bono de oleada (a TODO el equipo):** al completar cada oleada, todos reciben `GOLD_ROUND_BONUS` (empieza en 20) y luego se incrementa `+4*LVL` para la siguiente. Además, si quedan estructuras especiales vivas se suma `LVL * nº`. Esto es el **"interés" de facto**: un ingreso pasivo garantizado por sobrevivir la ronda, independiente de los kills.

3. **Madera (lumber) como segunda divisa:** algunos creeps dan **+10 / +15 madera** al morir (`ncp`), y ciertos edificios base dan madera. La madera parece gatear ciertas mejoras (economía dual oro/madera).

- **Refund al vender:** usa el sistema nativo de WC3 (vender estructura devuelve ~75% del coste). No hay refund custom en el JASS → es el estándar de WC3.
- **No hay "interés %" clásico tipo Legion TD.** El equivalente es el bono de ronda escalado (`+4*LVL`), que crece con el tiempo.

---

## 6. Auras y torres de soporte (proc-based) — muy inspirador

Hay **DOS** capas de soporte:

### 6.1 Torres de AURA pasiva (buffean a otras torres)
Familia dedicada `hatw` que **no ataca**, solo emite auras a estructuras aliadas cercanas:
- **Damage Aura** (`AEar`): +daño a los ataques a distancia de torres cercanas. Coste base ~750; tiers 2/3/4 escalan.
- **Speed Aura** (`AOae`): +velocidad de ataque a torres cercanas.
- Un edificio "Aura Tower" genérico (coste 750, luego 1500) **se puede mejorar** en rama Speed **o** Damage. Hay 4 niveles de cada.

> Mecánica transferible: torres de soporte sin ataque que multiplican el DPS de un clúster. Crea decisiones de posicionamiento (agrupar torres para aprovechar el aura vs. cobertura).

### 6.2 Procs on-attack (torres con efecto al pegar)
Sistema en `Unit_passives_attack_trigger` y `Spell_tower_trigger`. En cada ataque se evalúa un proc:

- **Torre con proc de crecimiento (h00C):** 1% por ataque (roll==1) de ganar **+100 de daño base permanente**. Escala sola con el tiempo → recompensa dejarla viva muchas oleadas.
- **Torre reductora de armadura (h01S):** ≤3% por ataque de **reducir a la mitad la armadura** de todos los creeps en radio 300 (AoE armor shred temporal). Habilita al resto de torres.
- **Torres cada-N-ataques (h025/h026):** cada **5º ataque** lanzan forked lightning (rebote). Ritmo garantizado en vez de aleatorio.
- **Spell Tower (tres tiers n00P/n00R/n00S):** en cada ataque tira 1-100 y según el rango y el tier dispara **uno de varios hechizos**:
  - **Chain lightning** (rebota entre creeps).
  - **Inner fire** sobre una torre aliada aleatoria en radio 1000 (buff temporal a otra torre).
  - **Bono de oro**: `LVL*2`, `LVL*3` o `LVL*4` oro instantáneo (según sub-roll) — ¡una torre que **genera economía** al atacar!
  - **Ejecución (tier alto n00S):** proc que hace **75% de la vida ACTUAL del objetivo** como daño divino ("finger of death"). Anti-tanque brutal, pero **no funciona contra inmunes** (es daño por hechizo).

> Estas dos capas juntas (auras de clúster + procs con roles distintos: crecer, shred, ejecutar, generar oro) son lo más rico del diseño para robar.

---

## 7. Ítems y bonos (Random Bonus Wave)

**De dónde salen:** de un sistema de **"oleada bonus aleatoria"** (`Random_bonus_wave`), no de drops normales. Antes de spawnear cada oleada (a partir de la 6), hay ~1/15 de probabilidad de que la oleada sea "bonus": los creeps de esa oleada reciben una habilidad especial y el bono de oro de ronda sube +10.

Los bonos posibles (hashtable `hashCreepsBonus`, `TOTAL_CREEP_BONUS_TYPE=5`) se aplican **a los CREEPS** (los hacen más duros), no al jugador:
- **+8 armadura** (ability A018)
- **+15% evasión** (A019 + A017)
- **+7% regeneración de vida perdida/seg** (A01C + A01A)
- **+20% velocidad de movimiento** (A01B)
- **+20% HP máximo** (`BlzSetUnitMaxHP * 1.2`)

**Recompensa:** completar una oleada bonus da más oro a todo el equipo. Es un mecanismo de **riesgo/recompensa**: oleada más peligrosa a cambio de más economía. (Los +armor/+evasion/etc. son buffs a los enemigos, no ítems para el jugador — el INFORME previo lo interpretó al revés.)

---

## 8. Progresión de base

Cadena **Castle → Fortress → Black Citadel** (`hcas` → `ofrt` → `unp2`). Cada nivel es un **upgrade del edificio central** que **desbloquea acceso a tiers superiores de torres** (gating clásico: no puedes construir siege tier 10 hasta tener la base al nivel adecuado). Los edificios de mejora dan además madera (`ofrt`/`unp2` dan +20 lumber base). La lista de edificios construibles del jugador (del `w3i`) incluye ~10 estructuras. El detalle exacto de qué torre desbloquea cada nivel no está en el JASS (es data del árbol de tecnología `w3t`/requisitos `ureq`), pero el patrón es **base-gating de tiers**.

---

## 9. Estructura del mapa / territorios

- **9 jugadores, 9 carriles SEPARADOS** (uno por color: Red, Blue, Teal, Purple, Yellow, Orange, Green, Pink, Gray). Cada jugador tiene su propio `PLAYER_SPAWN_POINT[1..9]` y su propia zona de construcción.
- **Camino FIJO por waypoints, NO es maze.** Los creeps no buscan ruta ni pueden ser bloqueados por torres. Al entrar en cada rect de waypoint reciben una `IssuePointOrder("move", siguiente_waypoint)`. Cada carril tiene su cadena: `Spawn → Path Xa → Path Xb → ... → topleft/centro`. Ejemplo (carril Pink): `Pink_Spawn → 1a → 1b → topleft`. Otros carriles tienen hasta 5 sub-waypoints (a-e).
- **Convergencia:** todos los carriles confluyen hacia una zona común (`topleft` y sus `topleftgo1..4`) y finalmente al **rect `END` (el Trono)** compartido, donde se pierden vidas.
- Por tanto: **territorios individuales que convergen en un objetivo compartido.** Cada jugador defiende su tramo, pero las vidas y la derrota son **globales/compartidas** → cooperación forzada.
- El `.doo` de unidades preubicadas es pequeño (3.466 bytes): sobre todo marcadores de start-location (`sloc` ×20 = spawns + waypoints) y el Trono (`nzlc` ×2). El terreno/decorado (`war3map.doo`, 27 KB) es cosmético.

---

## 10. Ideas de diseño concretas para robar (TD co-op moderno)

1. **Tres ejes de "tipos" ortogonales (tierra/aire × attack-type/armor-type × spell-immune).** Con una matriz de multiplicadores + flags `targetsAir/Ground` + flag `spellImmune`, obtienes un puzzle de composición de torres muy profundo sin código por-torre. *Por qué funciona:* castiga el mono-build (all-siege muere al aéreo; all-magic muere al inmune) y premia carteras diversificadas. Es la lección #1 de Green TD.

2. **Oleadas "temáticas" telegrafiadas con comandos de recordatorio.** Los `-air/-immune/-hero` no cambian nada mecánico, solo **informan** en qué niveles vienen los tipos duros. *Por qué funciona:* da agencia y planificación (el jugador ahorra oro para la torre correcta) sin sorpresas injustas. Barato de implementar (solo UI), alto impacto en la sensación de dominio.

3. **Torre que GENERA economía al atacar + torre de EJECUCIÓN por % de vida.** La Spell Tower que tira oro (`LVL*2/3/4`) por proc convierte defensa en inversión; el proc de "75% de la vida actual" es un anti-tanque elegante que escala contra jefes pero se anula en inmunes (contrapeso). *Por qué funciona:* añade capas de decisión "¿DPS puro o utilidad?" y da momentos memorables (borrar media barra de un jefe de un golpe).

4. **Sin loop + fuga escalonada por oleada + vidas compartidas.** Los leaks se eliminan (no reciclan), pero cuestan más vidas cuanto más tarde ocurren (`(LVL/10)+1`). *Por qué funciona:* mantiene la tensión creciente hasta el final y hace que la derrota sea un evento de equipo, no individual — ideal para co-op. Mucho más legible que sistemas de loop.

5. **Doble capa de soporte: auras de clúster (posicional) + procs con roles.** Auras de daño/velocidad que recompensan agrupar torres, combinadas con procs especializados (crecer permanentemente, shred de armadura AoE, cada-5-ataques garantizado). *Por qué funciona:* transforma la colocación en decisión estratégica (¿maximizo cobertura o solapo auras?) y da a cada torre de soporte una identidad clara en vez de "torre buff genérica".

**Bonus — Oleada bonus de riesgo/recompensa:** ~1/15 de probabilidad de que una oleada tenga creeps buffeados (+HP/+armor/+evasion/+regen/+ms) a cambio de más oro al limpiarla. Inyecta varianza y decisiones ("¿me arriesgo o construyo defensivo?") sin rediseñar el flujo de oleadas.

---

### Notas de fiabilidad
- HP, armadura, coste, daño, cooldown, rango y bounty: **extraídos directamente del binario `w3u`** (parseado en Python) — alta confianza.
- Roles de familia, immune, aéreo, vidas, economía de ronda, procs: **verificados en JASS/WTS** — alta confianza.
- Attack-types exactos de Chaos Tower y algunos tiers intermedios: **heredados de la unidad base** y no override-ados en el binario → inferidos por nombre/rol, confianza media (lo señalo en §2.7).
- Qué torre desbloquea exactamente cada nivel de base: **no determinable** solo desde el JASS (vive en el árbol de tech `w3t`/`ureq`); descrito a nivel de patrón.
