import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, mergeHazard } from '@lubak/shared';
import { HazardStore, MAX_HAZARDS, SNAPSHOT_FILE } from '../src/store.js';
import { hazard, T0, tempDir } from './harness.js';

describe('HazardStore', () => {
  it('merges every ingested hazard with the shared merge and reports what changed', () => {
    const store = new HazardStore({ now: () => T0 + 10 });
    const a = hazard({ deviceId: 'dev-a', now: T0, confidence: 0.6 });
    const b = hazard({ deviceId: 'dev-b', now: T0 + 5, confidence: 0.9 });

    const first = store.ingest(a)!;
    expect(first.changed).toBe(true);
    const second = store.ingest(b)!;
    expect(second.changed).toBe(true);
    expect(second.merged).toEqual(mergeHazard(a, b));
    expect(store.get(a.id)?.deviceIds).toEqual(['dev-a', 'dev-b']);

    const again = store.ingest(second.merged)!;
    expect(again.changed).toBe(false); // idempotent re-delivery of the merged state: nothing to broadcast
    expect(again.senderBehind).toBe(false);

    const staleSender = store.ingest(b)!; // a sender holding less than the store does...
    expect(staleSender.changed).toBe(false);
    expect(staleSender.senderBehind).toBe(true); // ...must be corrected, but nothing needs broadcasting
  });

  it('refuses hazards that are already expired', () => {
    const store = new HazardStore({ now: () => T0 + 7 * HOUR_MS });
    expect(store.ingest(hazard({ cls: 'flooded_road', now: T0 }))).toBeNull();
    expect(store.size).toBe(0);
  });

  it('sweep drops expired hazards and keeps live ones; all() never returns expired ones even before a sweep', () => {
    let clock = T0;
    const store = new HazardStore({ now: () => clock });
    store.ingest(hazard({ cls: 'flooded_road', lat: 14.585, now: T0 }));
    store.ingest(hazard({ cls: 'pothole', lat: 14.586, now: T0 }));
    expect(store.size).toBe(2);

    clock = T0 + 6 * HOUR_MS; // exactly the flood TTL
    expect(store.all().map((h) => h.cls)).toEqual(['pothole']);
    expect(store.summary()).toHaveLength(1);
    expect(store.sweep()).toBe(1);
    expect(store.size).toBe(1);

    clock = T0 + 21 * DAY_MS;
    expect(store.sweep()).toBe(1);
    expect(store.size).toBe(0);
  });

  it('diffFor offers exactly what a peer summary lacks', () => {
    const store = new HazardStore({ now: () => T0 });
    const h1 = hazard({ lat: 14.585 });
    const h2 = hazard({ lat: 14.586 });
    store.ingest(h1);
    store.ingest(h2);
    expect(store.diffFor([])).toHaveLength(2);
    expect(store.diffFor(store.summary())).toEqual([]);
    expect(store.diffFor(store.summary().filter((e) => e.id === h1.id)).map((h) => h.id)).toEqual([h2.id]);
  });

  it('caps the number of distinct hazards', () => {
    const store = new HazardStore({ now: () => T0 });
    for (let i = 0; i < MAX_HAZARDS; i++) store.ingest(hazard({ lat: 10 + i * 0.0005, lon: 100 + (i % 50) * 0.01 }));
    expect(store.size).toBe(MAX_HAZARDS);
    expect(store.ingest(hazard({ lat: 50, lon: 50 }))).toBeNull();
    // existing ids can still be updated when full
    const existing = store.all()[0]!;
    expect(store.ingest({ ...existing, deviceIds: [...existing.deviceIds, 'dev-z'].sort() })?.changed).toBe(true);
  });
});

describe('snapshot', () => {
  it('round-trips through the JSON file, writes only when dirty, and leaves no temp file behind', async () => {
    const dir = tempDir();
    const a = new HazardStore({ dataDir: dir, now: () => T0 });
    expect(await a.snapshot()).toBe(false); // nothing to save yet
    a.ingest(hazard({ lat: 14.585 }));
    a.ingest(hazard({ lat: 14.586, cls: 'crack', deviceId: 'dev-b' }));
    expect(a.isDirty).toBe(true);
    expect(await a.snapshot()).toBe(true);
    expect(a.isDirty).toBe(false);
    expect(await a.snapshot()).toBe(false); // unchanged since last write
    expect(fs.readdirSync(dir)).toEqual([SNAPSHOT_FILE]);

    const b = new HazardStore({ dataDir: dir, now: () => T0 });
    expect(b.load()).toBe(2);
    expect(b.all().sort((x, y) => x.id.localeCompare(y.id))).toEqual(a.all().sort((x, y) => x.id.localeCompare(y.id)));
    expect(b.isDirty).toBe(false);
  });

  it('skips expired and invalid records when loading, and says nothing is wrong with a missing file', () => {
    const dir = tempDir();
    expect(new HazardStore({ dataDir: dir, now: () => T0 }).load()).toBe(0);
    const good = hazard({ lat: 14.585 });
    const stale = hazard({ lat: 14.586, cls: 'flooded_road', now: T0 - 7 * HOUR_MS });
    const forged = { ...hazard({ lat: 14.587 }), geohash: 'zzzzzzzz' };
    fs.writeFileSync(path.join(dir, SNAPSHOT_FILE), JSON.stringify({ version: 1, savedAt: T0, hazards: [good, stale, forged, 'junk'] }));
    const s = new HazardStore({ dataDir: dir, now: () => T0 });
    expect(s.load()).toBe(1);
    expect(s.get(good.id)).toEqual(good);
  });

  it('moves an unreadable snapshot aside instead of overwriting it', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, SNAPSHOT_FILE), '{ this is not json');
    const s = new HazardStore({ dataDir: dir, now: () => T0 });
    expect(s.load()).toBe(0);
    const files = fs.readdirSync(dir);
    expect(files.some((f) => f.startsWith(`${SNAPSHOT_FILE}.corrupt-`))).toBe(true);
    expect(files).not.toContain(SNAPSHOT_FILE);
  });

  it('is purely in-memory without a data directory', async () => {
    const s = new HazardStore({ now: () => T0 });
    s.ingest(hazard());
    expect(await s.snapshot()).toBe(false);
    expect(s.load()).toBe(0);
  });

  it('snapshotSync (used on shutdown) writes the same format', () => {
    const dir = tempDir();
    const a = new HazardStore({ dataDir: dir, now: () => T0 });
    a.ingest(hazard());
    expect(a.snapshotSync()).toBe(true);
    expect(new HazardStore({ dataDir: dir, now: () => T0 }).load()).toBe(1);
  });
});
