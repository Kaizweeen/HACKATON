/** Map screen: Leaflet map fed by the local store, with the sync/online banner. */

import { HazardMap } from '../map.js';
import type { AppContext } from './context.js';
import { h } from './dom.js';

export class MapScreen {
  readonly el = h('section', { class: 'screen map-screen', id: 'screen-map' });
  readonly map: HazardMap;
  private fitted = false;

  constructor(ctx: AppContext) {
    this.map = new HazardMap(this.el, ctx.config.tiles, ctx.config.mapCenter);

    void ctx.store.getAll().then((hazards) => this.map.setHazards(hazards));
    ctx.store.subscribe((change) => {
      if (change.kind === 'upsert') this.map.upsert(change.hazard);
      else if (change.kind === 'remove') for (const id of change.ids) this.map.remove(id);
      else this.map.clear();
    });

    const refreshStatus = (): void => {
      const s = ctx.sync.status;
      this.map.setStatus({ online: navigator.onLine, hub: s.state, pending: s.pending });
    };
    ctx.sync.onStatus(refreshStatus);
    window.addEventListener('online', refreshStatus);
    window.addEventListener('offline', refreshStatus);
    refreshStatus();

    ctx.position.on((fix) => this.map.setPosition(fix));
  }

  onShow(): void {
    // Leaflet measured a hidden (0x0) container at creation time.
    this.map.invalidateSize();
    if (!this.fitted && this.map.count > 0) {
      this.fitted = true;
      this.map.fitToHazards();
    }
  }
}
