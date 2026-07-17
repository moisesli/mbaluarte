// dialog.ts — modales propios en DOM, reemplazo de confirm()/alert()/prompt() nativos.
//
// POR QUÉ: el juego corre embebido como Discord Activity (iframe sandboxeado) y ahí
// los diálogos nativos del navegador están BLOQUEADOS: confirm() devuelve false en
// silencio, alert() no muestra nada, prompt() devuelve null. Resultado real en
// producción: «Abandonar partida» parecía no hacer nada, y el anfitrión no podía
// banear ni ceder la sala desde Discord. Este módulo los sustituye por un overlay
// propio (misma estética que el resto del juego: .overlay/.overlay-card/.panel).
//
// API: ask() confirma (Cancelar/OK), tell() informa (un botón), showLink() reemplaza
// el prompt() de "copiar enlace" con un <input readonly> + botón de copiar.

type CloseFn = (confirmed: boolean) => void;

// El overlay se crea UNA vez, perezosamente (nunca se toca index.html), y se
// reutiliza en todas las llamadas siguientes.
let overlay: HTMLDivElement | null = null;
let msgEl: HTMLParagraphElement;
let linkRow: HTMLDivElement;
let linkInput: HTMLInputElement;
let copyBtn: HTMLButtonElement;
let cancelBtn: HTMLButtonElement;
let okBtn: HTMLButtonElement;

// el modal actualmente abierto (si lo hay): guarda cómo resolver su promesa, para
// poder cancelarlo si llega OTRO modal antes de que el usuario responda.
let active: { close: CloseFn } | null = null;

function build(): void {
  if (overlay) return;

  overlay = document.createElement('div');
  overlay.className = 'overlay dialog-overlay';
  overlay.hidden = true;

  const card = document.createElement('div');
  card.className = 'overlay-card panel dialog-card';
  overlay.appendChild(card);

  msgEl = document.createElement('p');
  msgEl.className = 'dialog-msg';
  card.appendChild(msgEl);

  // fila del enlace (solo la usa showLink): input de solo lectura + copiar
  linkRow = document.createElement('div');
  linkRow.className = 'dialog-linkrow';
  linkInput = document.createElement('input');
  linkInput.type = 'text';
  linkInput.readOnly = true;
  linkInput.className = 'dialog-link-input';
  copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn ghost small';
  copyBtn.textContent = '📋 Copiar';
  linkRow.append(linkInput, copyBtn);
  linkRow.hidden = true;
  card.appendChild(linkRow);

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn ghost';
  cancelBtn.textContent = 'Cancelar';
  okBtn = document.createElement('button');
  okBtn.type = 'button';
  actions.append(cancelBtn, okBtn);
  card.appendChild(actions);

  // clic en el fondo oscuro (no en la tarjeta) cancela — mismo patrón que el bestiario.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeActive(false);
  });
  cancelBtn.addEventListener('click', () => closeActive(false));
  okBtn.addEventListener('click', () => closeActive(true));
  copyBtn.addEventListener('click', () => void doCopy());

  // FASE DE CAPTURA + stopPropagation en TODA tecla mientras el modal esté abierto.
  // Por qué no basta con lo que ya hacen input.ts/main.ts: sus listeners de atajos
  // viven en `window` (burbuja) y se auto-desactivan solo si document.activeElement
  // es un <input>/<textarea> — pero el foco durante un modal normalmente está en un
  // <button> (Aceptar/Cancelar), que ese filtro NO reconoce. Sin esto, Enter para
  // confirmar el modal TAMBIÉN abriría el chat (main.ts), o una letra cualquiera
  // dispararía un atajo de torre por debajo (input.ts). Registrar en captura además
  // garantiza que cortamos el evento ANTES de que llegue a esos listeners de
  // `window`, sin depender de en qué orden se hayan montado.
  overlay.addEventListener(
    'keydown',
    (e) => {
      if (!active) return; // overlay montado pero sin modal abierto: no interceptar nada
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        closeActive(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        closeActive(true);
      }
      // cualquier otra tecla sigue su curso normal DENTRO del modal (flechas, Ctrl+C
      // para copiar la selección del input de enlace, etc.): stopPropagation no evita
      // las acciones por defecto del navegador, solo que se filtren hacia el juego.
    },
    true,
  );

  document.body.appendChild(overlay);
}

function closeActive(confirmed: boolean): void {
  if (!active || !overlay) return;
  const a = active;
  active = null;
  overlay.hidden = true;
  a.close(confirmed);
}

async function doCopy(): Promise<void> {
  const original = copyBtn.textContent;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('sin Clipboard API');
    await navigator.clipboard.writeText(linkInput.value);
    copyBtn.textContent = 'Copiado ✓';
  } catch {
    // el iframe de Discord puede restringir el portapapeles: dejamos el enlace
    // seleccionado para que el usuario copie a mano con Ctrl+C.
    linkInput.focus();
    linkInput.select();
    copyBtn.textContent = 'Copia manual: Ctrl+C';
  }
  setTimeout(() => {
    if (copyBtn.textContent !== original) copyBtn.textContent = original;
  }, 2200);
}

type OpenOpts = {
  message: string;
  okLabel: string;
  danger?: boolean;
  showCancel: boolean;
  link?: string;
};

// arma y muestra el overlay; devuelve una promesa que se resuelve al cerrarse
// (true = OK/Enter, false = Cancelar/Escape/clic en el fondo).
function open(opts: OpenOpts): Promise<boolean> {
  build();
  // Solo un modal a la vez: si YA había uno abierto, se cancela de inmediato (sin
  // cola) y gana el nuevo. Es la opción más simple — nunca hay dos preguntas a la
  // vez en este juego, así que no vale la pena encolar.
  if (active) closeActive(false);

  msgEl.textContent = opts.message;
  okBtn.textContent = opts.okLabel;
  okBtn.className = `btn ${opts.danger ? 'danger' : 'primary'}`;
  cancelBtn.hidden = !opts.showCancel;

  if (opts.link !== undefined) {
    linkRow.hidden = false;
    linkInput.value = opts.link;
    copyBtn.textContent = '📋 Copiar';
  } else {
    linkRow.hidden = true;
  }

  overlay!.hidden = false; // quitar `hidden` ANTES de enfocar: si no, el elemento
  // aún no es enfocable. Se hace en el mismo tick (sin rAF/timeout): esperar al
  // siguiente frame depende de que la pestaña esté VISIBLE (rAF se pausa en
  // segundo plano), y entonces el foco no llegaría a tiempo — p. ej. si Discord
  // trae la pestaña al frente justo cuando se abre el modal.
  if (opts.link !== undefined) {
    // showLink: el enlace queda preseleccionado, listo para Ctrl+C de inmediato
    linkInput.focus();
    linkInput.select();
  } else {
    okBtn.focus();
  }

  return new Promise<boolean>((resolve) => {
    active = { close: resolve };
  });
}

/** Confirmación con Cancelar/OK. danger:true pinta el OK en rojo (acciones destructivas). */
export function ask(msg: string, opts?: { okLabel?: string; danger?: boolean }): Promise<boolean> {
  return open({ message: msg, okLabel: opts?.okLabel ?? 'Aceptar', danger: opts?.danger, showCancel: true });
}

/** Modal informativo con un solo botón. */
export async function tell(msg: string): Promise<void> {
  await open({ message: msg, okLabel: 'Aceptar', showCancel: false });
}

/** Reemplazo de prompt(): muestra `url` en un input de solo lectura con botón de copiar. */
export async function showLink(msg: string, url: string): Promise<void> {
  await open({ message: msg, okLabel: 'Cerrar', showCancel: false, link: url });
}
