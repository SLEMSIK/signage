import type { PlayerToServer, ServerToPlayer } from '@signage/shared';
import { KEYS, store } from './store';

type Handler = (msg: ServerToPlayer) => void;

/**
 * Соединение с сервером: переподключение с экспоненциальной задержкой (до 30 с),
 * hello с токеном, оценка смещения часов по ping/pong.
 */
export class Connection {
  private ws: WebSocket | null = null;
  private retryMs = 1000;
  private timer: number | undefined;
  private offsets: number[] = [];
  connected = false;
  onMessage: Handler = () => undefined;
  onStatus: (connected: boolean) => void = () => undefined;

  constructor(private readonly url: string) {}

  /** Смещение часов сервера относительно локальных, мс (медиана последних измерений). */
  get clockOffset(): number {
    if (this.offsets.length === 0) return 0;
    const sorted = [...this.offsets].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }

  serverNow(): number {
    return Date.now() + this.clockOffset;
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    window.clearTimeout(this.timer);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retryMs = 1000;
      this.onStatus(true);
      this.send({ type: 'hello', token: store.get(KEYS.token) ?? undefined, build: __BUILD__ });
    };
    ws.onmessage = (e) => {
      let msg: ServerToPlayer;
      try {
        msg = JSON.parse(String(e.data)) as ServerToPlayer;
      } catch {
        return;
      }
      if (msg.type === 'ping') {
        // RTT присылает сервер (измерен по предыдущему pong); половина — задержка в одну сторону.
        const offset = msg.t + (msg.rtt ?? 0) / 2 - Date.now();
        this.offsets.push(offset);
        if (this.offsets.length > 7) this.offsets.shift();
        this.send({ type: 'pong', t: msg.t });
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.connected) {
        this.connected = false;
        this.onStatus(false);
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose придёт следом */
    };
  }

  private scheduleReconnect(): void {
    const jitter = Math.random() * 0.3 * this.retryMs;
    this.timer = window.setTimeout(() => this.connect(), this.retryMs + jitter);
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
  }

  send(msg: PlayerToServer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
