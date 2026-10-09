/**
 * map.ts: Leaflet map with colour-coded hazard markers, a legend, and an online / hub status banner.
 *
 * - Tiles come from the LOCAL folder public/tiles/{z}/{x}/{y}.png (precached by the service worker). A missing tile
 *   renders as a transparent square over the neutral background, so an empty tile folder gives a blank but fully
 *   working map instead of broken-image icons.
 * - Marker colour = class, letter = class initial, size and a corner badge = number of confirming devices.
 * - Hazard data arrives from the network, so popups are built with DOM nodes and textContent, never innerHTML.
 */

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { HAZARD_CLASSES, confirmationCount, expiresAt, type Hazard } from '@lubak/shared';
import { CLASS_STYLE } from './classes.js';
import type { TileConfig } from './config.js';
import type { SyncState } from './sync.js';

/** 1x1 transparent GIF: what Leaflet shows when a tile file is missing. */
const BLANK_TILE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export { CLASS_STYLE };

export const markerSize = (confirmations: number): number => 24 + Math.min(Math.max(confirmations, 1) - 1, 5) * 4;

export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 60_000) return `${Math.max(1, Math.round(abs / 1000))} s`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} min`;
  if (abs < 86_400_000) return `${(abs / 3_600_000).toFixed(abs < 36_000_000 ? 1 : 0)} h`;
  return `${Math.round(abs / 86_400_000)} days`;
}

export interface MapStatus {
  /** navigator.onLine. Note: true on a hotspot with no internet; the hub chip is the one that matters offline. */
  online: boolean;
  hub: SyncState;
  /** Records waiting to be sent to the hub. */
  pending: number;
}

export interface MapStats {
  markers: number;
  tilesLoaded: number;
  tilesMissing: number;
}

interface Entry {
  marker: L.Marker;
  hazard: Hazard;
  size: number;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export class HazardMap {
  private readonly map: L.Map;
  private readonly entries = new Map<string, Entry>();
  private readonly banner: HTMLElement;
  private readonly netChip: HTMLElement;
  private readonly hubChip: HTMLElement;
  private readonly queueChip: HTMLElement;
  private readonly countChip: HTMLElement;
  private me: { dot: L.CircleMarker; halo: L.Circle } | null = null;
  private lastFix: { lat: number; lon: number } | null = null;
  private tilesLoaded = 0;
  private tilesMissing = 0;

  constructor(container: HTMLElement, tiles: TileConfig, center: { lat: number; lon: number; zoom: number }) {
    container.classList.add('map-root');
    const canvas = el('div', 'map-canvas');
    // Set inline: the container may still be detached from the document here, in which case Leaflet cannot read the
    // stylesheet's `position: absolute`, falls back to `relative` and the map collapses to zero height.
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    this.banner = el('div', 'map-banner');
    this.banner.setAttribute('role', 'status');
    this.banner.setAttribute('aria-live', 'polite');
    this.netChip = el('span', 'chip');
    this.hubChip = el('span', 'chip');
    this.queueChip = el('span', 'chip warn');
    this.queueChip.hidden = true;
    this.countChip = el('span', 'chip');
    this.banner.append(this.netChip, this.hubChip, this.queueChip, this.countChip);
    container.append(canvas, this.banner);

    const covered = tiles.bounds
      ? L.latLngBounds([tiles.bounds.south, tiles.bounds.west], [tiles.bounds.north, tiles.bounds.east])
      : undefined;
    this.map = L.map(canvas, {
      center: [center.lat, center.lon],
      zoom: center.zoom,
      minZoom: tiles.minZoom,
      maxZoom: tiles.maxZoom,
      zoomControl: false, // added below at the bottom right: the top-left belongs to the status banner
      attributionControl: true,
      ...(covered ? { maxBounds: covered.pad(0.05), maxBoundsViscosity: 0.9 } : {}),
    });
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

    const layer = L.tileLayer(tiles.urlTemplate, {
      minZoom: tiles.minZoom,
      maxZoom: tiles.maxZoom,
      maxNativeZoom: tiles.maxNativeZoom,
      errorTileUrl: BLANK_TILE,
      attribution: tiles.attribution,
      keepBuffer: 2,
      ...(covered ? { bounds: covered } : {}),
    });
    layer.on('tileload', () => (this.tilesLoaded += 1));
    layer.on('tileerror', () => (this.tilesMissing += 1));
    layer.addTo(this.map);

    this.addLegend();
    this.addLocateButton();
    this.updateCount();
    this.setStatus({ online: navigator.onLine, hub: 'idle', pending: 0 });
  }

  // -----------------------------------------------------------------------------------------------
  // hazards
  // -----------------------------------------------------------------------------------------------

  setHazards(hazards: readonly Hazard[]): void {
    const keep = new Set(hazards.map((h) => h.id));
    for (const id of [...this.entries.keys()]) if (!keep.has(id)) this.remove(id);
    for (const h of hazards) this.upsert(h);
  }

  upsert(h: Hazard): void {
    const n = confirmationCount(h);
    const size = markerSize(n);
    const existing = this.entries.get(h.id);
    if (existing) {
      existing.marker.setLatLng([h.lat, h.lon]);
      if (existing.size !== size || confirmationCount(existing.hazard) !== n) existing.marker.setIcon(this.icon(h, size));
      existing.marker.setZIndexOffset(n * 10);
      existing.marker.setPopupContent(this.popup(h));
      existing.hazard = h;
      existing.size = size;
      return;
    }
    const marker = L.marker([h.lat, h.lon], {
      icon: this.icon(h, size),
      title: `${CLASS_STYLE[h.cls].label}, ${n} confirmation${n === 1 ? '' : 's'}`,
      zIndexOffset: n * 10,
      keyboard: true,
    });
    marker.bindPopup(this.popup(h), { closeButton: true, autoPan: true });
    marker.addTo(this.map);
    this.entries.set(h.id, { marker, hazard: h, size });
    this.updateCount();
  }

  remove(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.marker.remove();
    this.entries.delete(id);
    this.updateCount();
  }

  clear(): void {
    for (const id of [...this.entries.keys()]) this.remove(id);
  }

  get count(): number {
    return this.entries.size;
  }

  /** Marker size in px for a hazard currently on the map, or null. For tests / debugging. */
  sizeOf(id: string): number | null {
    return this.entries.get(id)?.size ?? null;
  }

  stats(): MapStats {
    return { markers: this.entries.size, tilesLoaded: this.tilesLoaded, tilesMissing: this.tilesMissing };
  }

  fitToHazards(): void {
    if (this.entries.size === 0) return;
    const bounds = L.latLngBounds([...this.entries.values()].map((e) => e.marker.getLatLng()));
    this.map.fitBounds(bounds.pad(0.2), { maxZoom: 17 });
  }

  // -----------------------------------------------------------------------------------------------
  // position, view, status
  // -----------------------------------------------------------------------------------------------

  setPosition(fix: { lat: number; lon: number; accuracy: number } | null): void {
    if (!fix) {
      this.me?.dot.remove();
      this.me?.halo.remove();
      this.me = null;
      return;
    }
    this.lastFix = { lat: fix.lat, lon: fix.lon };
    const radius = Math.min(Math.max(fix.accuracy, 3), 300);
    if (!this.me) {
      this.me = {
        halo: L.circle([fix.lat, fix.lon], { radius, color: '#1a73e8', weight: 1, fillColor: '#1a73e8', fillOpacity: 0.12, interactive: false }).addTo(this.map),
        dot: L.circleMarker([fix.lat, fix.lon], { radius: 7, color: '#ffffff', weight: 2, fillColor: '#1a73e8', fillOpacity: 1, interactive: false }).addTo(this.map),
      };
    } else {
      this.me.halo.setLatLng([fix.lat, fix.lon]).setRadius(radius);
      this.me.dot.setLatLng([fix.lat, fix.lon]);
    }
  }

  centerOn(lat: number, lon: number, zoom?: number): void {
    this.map.setView([lat, lon], zoom ?? this.map.getZoom());
  }

  /** Call when the container becomes visible (Leaflet measures it at creation, and hidden tabs measure 0). */
  invalidateSize(): void {
    this.map.invalidateSize();
  }

  setStatus(status: MapStatus): void {
    this.netChip.textContent = status.online ? '● Online' : '○ Offline';
    this.netChip.className = `chip ${status.online ? 'ok' : 'warn'}`;

    const hub = hubLabel(status.hub);
    this.hubChip.textContent = hub.text;
    this.hubChip.className = `chip ${hub.tone}`;

    this.queueChip.hidden = status.pending === 0;
    this.queueChip.textContent = `${status.pending} waiting to sync`;
  }

  // -----------------------------------------------------------------------------------------------
  // private
  // -----------------------------------------------------------------------------------------------

  private updateCount(): void {
    const n = this.entries.size;
    this.countChip.textContent = `${n} hazard${n === 1 ? '' : 's'}`;
  }

  private icon(h: Hazard, size: number): L.DivIcon {
    const style = CLASS_STYLE[h.cls];
    const n = confirmationCount(h);
    const html = document.createElement('div');
    html.className = `hz-dot hz-${h.cls}`;
    html.style.cssText = `width:${size}px;height:${size}px;background:${style.color};color:${style.ink};font-size:${Math.round(size * 0.5)}px`;
    html.append(el('span', 'hz-glyph', style.glyph));
    if (n >= 2) html.append(el('span', 'hz-badge', String(n)));
    return L.divIcon({ className: 'hz-marker', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2] });
  }

  private popup(h: Hazard): HTMLElement {
    const style = CLASS_STYLE[h.cls];
    const n = confirmationCount(h);
    const now = Date.now();
    const box = el('div', 'hz-popup');
    const title = el('strong', undefined, style.label);
    title.style.color = style.color === '#f9ab00' ? '#8a5d00' : style.color;
    box.append(
      title,
      el('div', undefined, `${n} confirmation${n === 1 ? '' : 's'} · best confidence ${Math.round(h.confidence * 100)}%`),
      el('div', undefined, `Last seen ${formatDuration(now - h.lastSeen)} ago`),
      el('div', 'muted', `Clears in ${formatDuration(expiresAt(h) - now)} unless seen again`),
    );
    return box;
  }

  private addLegend(): void {
    const legend = new L.Control({ position: 'bottomleft' });
    legend.onAdd = () => {
      const box = el('div', 'legend');
      box.append(el('div', 'legend-title', 'Legend'));
      for (const cls of HAZARD_CLASSES) {
        const s = CLASS_STYLE[cls];
        const row = el('div', 'legend-row');
        const dot = el('span', 'legend-dot', s.glyph);
        dot.style.background = s.color;
        dot.style.color = s.ink;
        row.append(dot, el('span', undefined, s.label));
        box.append(row);
      }
      const badge = el('div', 'legend-row');
      const b = el('span', 'legend-dot big', '3');
      badge.append(b, el('span', undefined, 'bigger + number = phones that confirmed it'));
      box.append(badge);
      L.DomEvent.disableClickPropagation(box);
      return box;
    };
    legend.addTo(this.map);
  }

  private addLocateButton(): void {
    const control = new L.Control({ position: 'topright' });
    control.onAdd = () => {
      const button = el('button', 'locate-btn', '◎');
      button.type = 'button';
      button.title = 'Center on my position';
      button.setAttribute('aria-label', 'Center on my position');
      button.addEventListener('click', () => {
        if (this.lastFix) this.centerOn(this.lastFix.lat, this.lastFix.lon, Math.max(this.map.getZoom(), 16));
      });
      L.DomEvent.disableClickPropagation(button);
      return button;
    };
    control.addTo(this.map);
  }
}

function hubLabel(state: SyncState): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  switch (state) {
    case 'connected':
      return { text: '⇄ Hub connected', tone: 'ok' };
    case 'connecting':
      return { text: '… Connecting to hub', tone: 'warn' };
    case 'backoff':
    case 'offline':
      return { text: '✕ Hub not connected, working offline', tone: 'bad' };
    case 'idle':
      return { text: '– Sync not started', tone: 'warn' };
  }
}
