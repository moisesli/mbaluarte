import type { ClientMsg, ServerMsg } from '@td/shared';

type Handler = (msg: ServerMsg) => void;

// Cliente WebSocket con reconexión automática y auto-reparable:
// - se conecta bajo demanda a una sala concreta (crear o unirse), no al arrancar
// - la URL lleva el código para que el backend enrute la conexión a la sala
//   (Cloudflare: al Durable Object; Node: lo ignora y usa el mensaje join/create)
// - reintentos con backoff (máx 4s) + watchdog que revive la cadena
// - al volver el foco a la pestaña (móviles que congelan tabs) reconecta al instante
export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Handler[]>();
  private wantOpen = false;
  private retryMs = 500;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private path = '/ws';
  private firstMsg: ClientMsg | null = null;
  onOpen: () => void = () => {};
  onDrop: () => void = () => {};
  // el servidor cerró la sala/al jugador A PROPÓSITO (código 4001 = inactividad,
  // 4002 = expulsado por el anfitrión): NO reconectar — sin este respeto, la
  // auto-reconexión revivía la sala/sesión al instante. `code` distingue el motivo.
  onKicked: (code: number) => void = () => {};

  // Abre (o reabre) una conexión a una sala. `firstMsg` se envía en cuanto abre
  // y se reenvía en cada reconexión (create_room al crear, join_room al unirse).
  connect(path: string, firstMsg: ClientMsg): void {
    this.path = path;
    this.firstMsg = firstMsg;
    this.wantOpen = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryMs = 500;
    this.close(false);
    this.open();
    this.ensureWatchdog();
  }

  // Cambia lo que se reenvía al reconectar (tras crear la sala pasamos a unirnos).
  setReconnect(path: string, firstMsg: ClientMsg): void {
    this.path = path;
    this.firstMsg = firstMsg;
  }

  disconnect(): void {
    this.wantOpen = false;
    this.firstMsg = null;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.close(true);
  }

  private ensureWatchdog(): void {
    if (this.watchdog) return;
    // si estamos desconectados y sin reintento pendiente, reintentar
    this.watchdog = setInterval(() => {
      if (this.wantOpen && !this.connected && !this.connecting && !this.retryTimer) {
        this.open();
      }
    }, 3000);
    // el navegador congela pestañas en segundo plano; al volver, reconectar ya
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.wantOpen && !this.connected && !this.connecting) {
        if (this.retryTimer) {
          clearTimeout(this.retryTimer);
          this.retryTimer = null;
        }
        this.retryMs = 500;
        this.open();
      }
    });
  }

  private close(silent: boolean): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      if (silent) ws.onclose = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }

  private open(): void {
    if (!this.wantOpen) return;
    let ws: WebSocket;
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}${this.path}`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retryMs = 500;
      if (this.firstMsg) this.send(this.firstMsg);
      this.onOpen();
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string) as ServerMsg;
      } catch {
        return;
      }
      for (const h of this.handlers.get(msg.type) ?? []) h(msg);
    };
    ws.onclose = (ev) => {
      this.ws = null;
      if (!this.wantOpen) return;
      // 4001 (sala inactiva) / 4002 (expulsado): cierre deliberado del servidor.
      // Obedecer y NO reconectar; el motivo lo distingue el código.
      if (ev.code === 4001 || ev.code === 4002) {
        this.wantOpen = false;
        this.firstMsg = null;
        this.onKicked(ev.code);
        return;
      }
      this.onDrop();
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.wantOpen) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wantOpen && !this.connected && !this.connecting) this.open();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 1.7, 4000);
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  on<T extends ServerMsg['type']>(type: T, handler: (msg: Extract<ServerMsg, { type: T }>) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as Handler);
    this.handlers.set(type, list);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get connecting(): boolean {
    return this.ws?.readyState === WebSocket.CONNECTING;
  }
}

export const net = new Net();

// URL del WebSocket para crear (código libre asignado por el backend) o unirse.
export const wsPathCreate = (): string => '/ws?create=1';
export const wsPathJoin = (code: string): string => `/ws?code=${encodeURIComponent(code)}`;
