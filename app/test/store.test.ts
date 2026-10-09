import { describe, expect, it } from 'vitest';
import { createHazard, mergeHazard, DAY_MS, HOUR_MS, type Hazard } from '@lubak/shared';
import { HazardStore, planWrite, type StoreChange, type StoredHazard } from '../src/store.js';

const T = 1_760_000_000_000;
const mk = (deviceId: string, now = T, over: Partial<Parameters<typeof createHazard>[0]> = {}): Hazard =>
  createHazard({ cls: 'pothole', lat: 14.585, lon: 121.176, confidence: 0.7, deviceId, now, ...over });
const stored = (h: Hazard, pending: 0 | 1): StoredHazard => ({ ...h, pending });

describe('planWrite: merge on write + the pending flag', () => {
  it('a new local detection is written and pending', () => {
    const p = planWrite(undefined, mk('me'), 'local');
    expect(p.record?.pending).toBe(1);
    expect(p.changed).toBe(true);
  });

  it('a local re-report that adds nothing writes nothing and leaves the flag alone', () => {
    const existing = stored(mk('me'), 0);
    const p = planWrite(existing, mk('me'), 'local');
    expect(p.changed).toBe(false);
    expect(p.record).toBeNull();
  });

  it('a local report that adds information makes the record pending again', () => {
    const existing = stored(mk('me', T), 0);
    const p = planWrite(existing, mk('me', T + 1000, { confidence: 0.9 }), 'local');
    expect(p.changed).toBe(true);
    expect(p.record).toMatchObject({ pending: 1, confidence: 0.9, lastSeen: T + 1000 });
  });

  it('data from the hub for an unknown hazard is stored and NOT pending', () => {
    const p = planWrite(undefined, mk('other'), 'remote');
    expect(p.record?.pending).toBe(0);
    expect(p.senderBehind).toBe(false);
  });

  it('the hub echoing our own record back clears pending (that echo is the ack)', () => {
    const mine = stored(mk('me'), 1);
    const p = planWrite(mine, mk('me'), 'remote');
    expect(p.changed).toBe(false);
    expect(p.record).toMatchObject({ pending: 0 });
  });

  it('the hub sending MORE than we have merges it in and clears pending', () => {
    const mine = stored(mk('me'), 1);
    const hub = mergeHazard(mk('me'), mk('other', T + 5));
    const p = planWrite(mine, hub, 'remote');
    expect(p.record).toMatchObject({ pending: 0, deviceIds: ['me', 'other'] });
    expect(p.senderBehind).toBe(false);
  });

  it('the hub sending LESS than we have keeps us pending and flags the sender as behind', () => {
    const mine = stored(mergeHazard(mk('me'), mk('other', T + 5)), 0);
    const p = planWrite(mine, mk('other', T + 5), 'remote');
    expect(p.changed).toBe(false);
    expect(p.senderBehind).toBe(true);
    expect(p.record).toMatchObject({ pending: 1 });
  });
});

describe('HazardStore (in-memory backend, same logic as IndexedDB)', () => {
  it('queues local detections and drains the queue when the hub acknowledges them', async () => {
    const store = HazardStore.inMemory();
    const h = mk('me', Date.now()); // fresh relative to the real clock, which getPending() uses by default
    await store.putLocal(h);
    expect(await store.getPending()).toEqual([h]);
    expect(await store.pendingCount()).toBe(1);
    await store.applyRemote(h); // hub echo
    expect(await store.pendingCount()).toBe(0);
    expect(await store.getAll()).toEqual([h]);
  });

  it('merges concurrent writes instead of losing one (writes are serialised)', async () => {
    const store = HazardStore.inMemory();
    await Promise.all([store.putLocal(mk('a', T)), store.putLocal(mk('b', T + 1)), store.applyRemote(mk('c', T + 2), T + 10)]);
    const [h] = await store.getAll(T + 10);
    expect(h!.deviceIds).toEqual(['a', 'b', 'c']);
    expect(h!.lastSeen).toBe(T + 2);
  });

  it('never returns expired hazards, ignores expired ones arriving from the hub, and sweeps them out', async () => {
    const store = HazardStore.inMemory();
    const old = mk('me', T - 7 * HOUR_MS, { cls: 'flooded_road' });
    await store.putLocal(old); // we wrote it (while it was fresh) ...
    expect(await store.getAll(T)).toEqual([]); // ... but it is expired now
    expect(await store.getPending(T)).toEqual([]);

    const result = await store.applyRemote(mk('x', T - 22 * DAY_MS), T);
    expect(result.changed).toBe(false);
    expect(await store.get(mk('x', T).id)).toBeUndefined();

    const removed: string[] = [];
    store.subscribe((c) => c.kind === 'remove' && removed.push(...c.ids));
    expect(await store.sweep(T)).toBe(1);
    expect(removed).toEqual([old.id]);
    expect(await store.get(old.id)).toBeUndefined();
  });

  it('emits a change only when something actually changed, with the origin', async () => {
    const store = HazardStore.inMemory();
    const changes: StoreChange[] = [];
    store.subscribe((c) => changes.push(c));
    const h = mk('me');
    await store.putLocal(h);
    await store.putLocal(h); // no-op
    await store.applyRemote(mergeHazard(h, mk('you', T + 1)), T + 10);
    expect(changes.map((c) => (c.kind === 'upsert' ? `${c.origin}:${c.hazard.deviceIds.length}` : c.kind))).toEqual(['local:1', 'remote:2']);
  });

  it('summary lists id, lastSeen and digest of live hazards only', async () => {
    const store = HazardStore.inMemory();
    await store.putLocal(mk('me', T));
    await store.putLocal(mk('me', T - 30 * DAY_MS, { lat: 14.6 }));
    const summary = await store.summary(T);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ lastSeen: T });
    expect(summary[0]!.d).toMatch(/^[0-9a-z]+$/);
  });

  it('clear empties the store and announces it', async () => {
    const store = HazardStore.inMemory();
    await store.putLocal(mk('me'));
    let cleared = false;
    store.subscribe((c) => (cleared ||= c.kind === 'clear'));
    await store.clear();
    expect(cleared).toBe(true);
    expect(await store.getAll()).toEqual([]);
    expect(store.backendKind).toBe('memory');
  });
});
