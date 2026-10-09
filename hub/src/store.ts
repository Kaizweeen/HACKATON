/**
 * The hub's hazard store: a Map in memory, a JSON snapshot on disk.
 *
 * - every incoming hazard goes through the shared reconcile()/mergeHazard (the only write path)
 * - expired hazards are refused on the way in and dropped by sweep(); nothing is "deleted" over the wire
 * - the snapshot is written atomically (temp file + rename) and only when something changed
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  computeDiff,
  isExpired,
  reconcile,
  sanitizeHazard,
  summarize,
  type Hazard,
  type ReconcileResult,
  type SummaryEntry,
} from '@lubak/shared';
import { silentLogger, type Logger } from './log.js';

export const SNAPSHOT_FILE = 'hazards.json';
/** Protects the hub's memory from a client that invents unlimited distinct ids. */
export const MAX_HAZARDS = 20_000;

interface SnapshotFile {
  version: 1;
  savedAt: number;
  hazards: Hazard[];
}

export interface StoreOptions {
  /** Directory for the snapshot. Omit for a purely in-memory store (tests). */
  dataDir?: string;
  now?: () => number;
  log?: Logger;
}

export class HazardStore {
  private readonly map = new Map<string, Hazard>();
  private dirty = false;
  private readonly file: string | undefined;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(opts: StoreOptions = {}) {
    this.file = opts.dataDir ? path.join(opts.dataDir, SNAPSHOT_FILE) : undefined;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? silentLogger;
  }

  get size(): number {
    return this.map.size;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  get(id: string): Hazard | undefined {
    return this.map.get(id);
  }

  /** Live (non-expired) hazards. */
  all(): Hazard[] {
    const now = this.now();
    return [...this.map.values()].filter((h) => !isExpired(h, now));
  }

  summary(): SummaryEntry[] {
    return summarize(this.map.values(), this.now());
  }

  /** What a peer with this summary is missing or has older. */
  diffFor(summary: readonly SummaryEntry[]): Hazard[] {
    return computeDiff(this.map.values(), summary, this.now());
  }

  /**
   * Merge one validated hazard. Returns null when it was refused (already expired, or the store is full),
   * otherwise the reconcile result: `changed` says whether to broadcast, `merged` is what to echo to the sender.
   */
  ingest(hazard: Hazard): ReconcileResult | null {
    if (isExpired(hazard, this.now())) return null;
    const existing = this.map.get(hazard.id);
    if (existing === undefined && this.map.size >= MAX_HAZARDS) {
      this.log.warn(`store full (${MAX_HAZARDS}); refusing new hazard ${hazard.id}`);
      return null;
    }
    const result = reconcile(existing, hazard);
    if (result.changed) {
      this.map.set(hazard.id, result.merged);
      this.dirty = true;
    }
    return result;
  }

  /** Drop expired hazards. Returns how many were removed. */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [id, h] of this.map) {
      if (isExpired(h, now)) {
        this.map.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) this.dirty = true;
    return removed;
  }

  clear(): void {
    if (this.map.size > 0) this.dirty = true;
    this.map.clear();
  }

  /** Read the snapshot. Bad records are skipped; an unreadable file is moved aside, never overwritten silently. */
  load(): number {
    if (this.file === undefined) return 0;
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return 0; // first run
    }
    try {
      const data = JSON.parse(text) as Partial<SnapshotFile>;
      if (data.version !== 1 || !Array.isArray(data.hazards)) throw new Error('unexpected snapshot format');
      const now = this.now();
      let skipped = 0;
      for (const raw of data.hazards) {
        const r = sanitizeHazard(raw);
        if (r.ok && !isExpired(r.hazard, now)) this.map.set(r.hazard.id, r.hazard);
        else skipped += 1;
      }
      if (skipped > 0) this.log.info(`snapshot: skipped ${skipped} expired or invalid hazards`);
      return this.map.size;
    } catch (err) {
      const aside = `${this.file}.corrupt-${this.now()}`;
      try {
        fs.renameSync(this.file, aside);
      } catch {
        /* nothing more we can do */
      }
      this.log.warn(`could not read ${this.file} (${err instanceof Error ? err.message : String(err)}); moved it to ${aside} and starting empty`);
      return 0;
    }
  }

  /** Write the snapshot if anything changed since the last one. Returns true when a file was written. */
  async snapshot(): Promise<boolean> {
    if (this.file === undefined || !this.dirty) return false;
    this.dirty = false; // anything arriving while we write marks it dirty again
    const body: SnapshotFile = { version: 1, savedAt: this.now(), hazards: [...this.map.values()] };
    const tmp = `${this.file}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      await fs.promises.writeFile(tmp, JSON.stringify(body));
      await fs.promises.rename(tmp, this.file);
      return true;
    } catch (err) {
      this.dirty = true;
      this.log.error(`snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Synchronous variant for shutdown. */
  snapshotSync(): boolean {
    if (this.file === undefined || !this.dirty) return false;
    const body: SnapshotFile = { version: 1, savedAt: this.now(), hazards: [...this.map.values()] };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(body));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      return true;
    } catch (err) {
      this.log.error(`final snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Remove the snapshot file (used by --fresh). */
  deleteSnapshot(): void {
    if (this.file === undefined) return;
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      /* ignore */
    }
  }
}
