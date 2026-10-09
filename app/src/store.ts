/**
 * store.ts: the phone's hazard database (IndexedDB through `idb`).
 *
 * Every write goes through the shared reconcile()/mergeHazard, so the stored record is always the merge of
 * everything this phone has seen. Each record carries a `pending` flag (0/1): 1 means "the hub may not have
 * this yet". Pending records are the offline queue: nothing else is kept, and nothing is lost while the hub is unreachable.
 *
 *   putLocal(h)      a detection made on this phone   -> pending = 1 when it changed the record
 *   applyRemote(h)   a hazard that came from the hub  -> pending = 1 only if we hold MORE than the hub just told us
 *                    (so the hub's echo of our own push clears the flag, and a stale hub copy keeps it)
 *
 * If IndexedDB is blocked (some webviews / private modes) the app keeps working with an in-memory backend.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { isExpired, reconcile, summarize, type Hazard, type SummaryEntry } from '@lubak/shared';

export type StoredHazard = Hazard & { pending: 0 | 1 };

export type WriteOrigin = 'local' | 'remote';

export interface WriteResult {
  /** The record as stored after merging. */
  hazard: Hazard;
  /** True when the stored hazard changed (new, or merged new information). */
  changed: boolean;
  /** True when this phone holds more than what it was just sent: the sender should be corrected. */
  senderBehind: boolean;
}

export type StoreChange =
  | { kind: 'upsert'; hazard: Hazard; origin: WriteOrigin }
  | { kind: 'remove'; ids: string[] }
  | { kind: 'clear' };

const stripPending = ({ pending: _pending, ...hazard }: StoredHazard): Hazard => hazard;

export interface WritePlan extends WriteResult {
  /** What to write, or null when nothing needs writing. */
  record: StoredHazard | null;
}

/** Pure decision logic behind every write; exported for tests. */
export function planWrite(existing: StoredHazard | undefined, incoming: Hazard, origin: WriteOrigin): WritePlan {
  const r = reconcile(existing ? stripPending(existing) : undefined, incoming);
  const pending: 0 | 1 = origin === 'local' ? (r.changed ? 1 : (existing?.pending ?? 0)) : r.senderBehind ? 1 : 0;
  const needsWrite = existing === undefined || r.changed || pending !== existing.pending;
  return {
    hazard: r.merged,
    changed: r.changed,
    senderBehind: r.senderBehind,
    record: needsWrite ? { ...r.merged, pending } : null,
  };
}

// ---------------------------------------------------------------------------------------------------
// backends
// ---------------------------------------------------------------------------------------------------

interface Backend {
  readonly kind: 'indexeddb' | 'memory';
  get(id: string): Promise<StoredHazard | undefined>;
  put(record: StoredHazard): Promise<void>;
  delete(ids: readonly string[]): Promise<void>;
  all(): Promise<StoredHazard[]>;
  pending(): Promise<StoredHazard[]>;
  clear(): Promise<void>;
}

interface LubakDB extends DBSchema {
  hazards: {
    key: string;
    value: StoredHazard;
    indexes: { pending: number; lastSeen: number };
  };
}

class IdbBackend implements Backend {
  readonly kind = 'indexeddb' as const;
  constructor(private readonly db: IDBPDatabase<LubakDB>) {}

  static async open(name: string): Promise<IdbBackend> {
    const db = await openDB<LubakDB>(name, 1, {
      upgrade(database) {
        const hazards = database.createObjectStore('hazards', { keyPath: 'id' });
        hazards.createIndex('pending', 'pending'); // IndexedDB cannot index booleans, hence 0/1
        hazards.createIndex('lastSeen', 'lastSeen');
      },
    });
    return new IdbBackend(db);
  }
  get(id: string) {
    return this.db.get('hazards', id);
  }
  async put(record: StoredHazard) {
    await this.db.put('hazards', record);
  }
  async delete(ids: readonly string[]) {
    const tx = this.db.transaction('hazards', 'readwrite');
    await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
  }
  all() {
    return this.db.getAll('hazards');
  }
  pending() {
    return this.db.getAllFromIndex('hazards', 'pending', 1);
  }
  async clear() {
    await this.db.clear('hazards');
  }
}

class MemoryBackend implements Backend {
  readonly kind = 'memory' as const;
  private readonly map = new Map<string, StoredHazard>();
  async get(id: string) {
    return this.map.get(id);
  }
  async put(record: StoredHazard) {
    this.map.set(record.id, record);
  }
  async delete(ids: readonly string[]) {
    for (const id of ids) this.map.delete(id);
  }
  async all() {
    return [...this.map.values()];
  }
  async pending() {
    return [...this.map.values()].filter((r) => r.pending === 1);
  }
  async clear() {
    this.map.clear();
  }
}

// ---------------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------------

export class HazardStore {
  private listeners = new Set<(change: StoreChange) => void>();
  /** Writes run one at a time so read-modify-write never interleaves. */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly backend: Backend) {}

  /** Open the database; fall back to memory if IndexedDB is unavailable. */
  static async open(name = 'lubak-alert'): Promise<HazardStore> {
    try {
      const backend = await IdbBackend.open(name);
      void navigator.storage?.persist?.().catch(() => undefined); // ask the browser not to evict our offline queue
      return new HazardStore(backend);
    } catch (err) {
      console.warn('IndexedDB unavailable, using in-memory storage:', err);
      return new HazardStore(new MemoryBackend());
    }
  }

  /** For tests and tools: a store with no IndexedDB. */
  static inMemory(): HazardStore {
    return new HazardStore(new MemoryBackend());
  }

  get backendKind(): 'indexeddb' | 'memory' {
    return this.backend.kind;
  }

  subscribe(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A detection made on this phone. Marks the record pending when it changed anything. */
  putLocal(hazard: Hazard): Promise<WriteResult> {
    return this.write(hazard, 'local');
  }

  /** A hazard received from the hub. Expired ones are ignored (sync must not resurrect them). */
  applyRemote(hazard: Hazard, now = Date.now()): Promise<WriteResult> {
    if (isExpired(hazard, now)) return Promise.resolve({ hazard, changed: false, senderBehind: false });
    return this.write(hazard, 'remote');
  }

  /** Live (non-expired) hazards. */
  async getAll(now = Date.now()): Promise<Hazard[]> {
    return (await this.backend.all()).filter((r) => !isExpired(r, now)).map(stripPending);
  }

  async get(id: string): Promise<Hazard | undefined> {
    const r = await this.backend.get(id);
    return r ? stripPending(r) : undefined;
  }

  /** The offline queue: records the hub may not have yet. */
  async getPending(now = Date.now()): Promise<Hazard[]> {
    return (await this.backend.pending()).filter((r) => !isExpired(r, now)).map(stripPending);
  }

  async pendingCount(now = Date.now()): Promise<number> {
    return (await this.getPending(now)).length;
  }

  async summary(now = Date.now()): Promise<SummaryEntry[]> {
    return summarize(await this.getAll(now), now);
  }

  /** Delete expired records. Returns how many were removed. */
  sweep(now = Date.now()): Promise<number> {
    return this.enqueue(async () => {
      const expired = (await this.backend.all()).filter((r) => isExpired(r, now)).map((r) => r.id);
      if (expired.length === 0) return 0;
      await this.backend.delete(expired);
      this.emit({ kind: 'remove', ids: expired });
      return expired.length;
    });
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      await this.backend.clear();
      this.emit({ kind: 'clear' });
    });
  }

  private write(hazard: Hazard, origin: WriteOrigin): Promise<WriteResult> {
    return this.enqueue(async () => {
      const plan = planWrite(await this.backend.get(hazard.id), hazard, origin);
      if (plan.record) await this.backend.put(plan.record);
      if (plan.changed) this.emit({ kind: 'upsert', hazard: plan.hazard, origin }); // after the write is durable
      return { hazard: plan.hazard, changed: plan.changed, senderBehind: plan.senderBehind };
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private emit(change: StoreChange): void {
    for (const l of this.listeners) {
      try {
        l(change);
      } catch (err) {
        console.error('store listener failed:', err);
      }
    }
  }
}
