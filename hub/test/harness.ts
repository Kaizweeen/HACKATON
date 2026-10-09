import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import {
  createHazard,
  encodeWsMessage,
  parseWsMessage,
  type Hazard,
  type NewHazardInput,
  type WsMessage,
} from '@lubak/shared';

export const T0 = 1_760_000_000_000;

export function tempDir(prefix = 'lubak-hub-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function hazard(over: Partial<NewHazardInput> = {}): Hazard {
  return createHazard({ cls: 'pothole', lat: 14.585, lon: 121.176, confidence: 0.8, deviceId: 'dev-a', now: T0, ...over });
}

/** A WebSocket client that records everything it receives, with promise-based waiting. */
export class TestClient {
  readonly inbox: WsMessage[] = [];
  private waiters: { match: (m: WsMessage) => boolean; resolve: (m: WsMessage) => void }[] = [];
  closedWith: { code: number; reason: string } | null = null;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const parsed = parseWsMessage(data.toString());
      if (!parsed.ok) return;
      this.inbox.push(parsed.message);
      for (const w of [...this.waiters]) {
        if (w.match(parsed.message)) {
          this.waiters = this.waiters.filter((x) => x !== w);
          w.resolve(parsed.message);
        }
      }
    });
    ws.on('close', (code, reason) => {
      this.closedWith = { code, reason: reason.toString() };
    });
  }

  static connect(url: string, options: { ca?: string; rejectUnauthorized?: boolean } = {}): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, options);
      const client = new TestClient(ws);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  send(message: WsMessage): void {
    this.ws.send(encodeWsMessage(message));
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  /** Resolve with the first message (already received or future) matching the predicate. */
  waitFor<T extends WsMessage['type']>(type: T, match: (m: Extract<WsMessage, { type: T }>) => boolean = () => true, timeoutMs = 2000): Promise<Extract<WsMessage, { type: T }>> {
    const test = (m: WsMessage): m is Extract<WsMessage, { type: T }> => m.type === type && match(m as Extract<WsMessage, { type: T }>);
    const existing = this.inbox.find(test);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for a "${type}" message; inbox: ${JSON.stringify(this.inbox.map((m) => m.type))}`)), timeoutMs);
      this.waiters.push({
        match: test,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<WsMessage, { type: T }>);
        },
      });
    });
  }

  /** Assert nothing matching arrives within `ms`. */
  async expectNone(type: WsMessage['type'], ms = 150): Promise<void> {
    const before = this.inbox.filter((m) => m.type === type).length;
    await new Promise((r) => setTimeout(r, ms));
    const after = this.inbox.filter((m) => m.type === type).length;
    if (after !== before) throw new Error(`unexpected "${type}" message(s): ${JSON.stringify(this.inbox.slice(-(after - before)))}`);
  }

  /** Forget everything received so far. */
  clear(): void {
    this.inbox.length = 0;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}
