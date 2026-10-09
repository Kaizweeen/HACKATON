/** App shell: three screens (Drive, Map, Debug), a bottom tab bar and hash routing (#/drive, #/map, #/debug). */

import type { AppContext } from './context.js';
import { DebugScreen } from './debug.js';
import { h } from './dom.js';
import { DriveScreen } from './drive.js';
import { MapScreen } from './map-screen.js';

export type TabName = 'drive' | 'map' | 'debug';
const TABS: { name: TabName; label: string }[] = [
  { name: 'drive', label: 'Drive' },
  { name: 'map', label: 'Map' },
  { name: 'debug', label: 'Debug' },
];

interface Screen {
  el: HTMLElement;
  onShow?(): void;
  onHide?(): void;
}

export class Shell {
  readonly drive: DriveScreen;
  readonly map: MapScreen;
  readonly debug: DebugScreen;
  private readonly screens: Record<TabName, Screen>;
  private readonly buttons = new Map<TabName, HTMLButtonElement>();
  private current: TabName | null = null;

  constructor(root: HTMLElement, ctx: AppContext) {
    this.drive = new DriveScreen(ctx);
    this.map = new MapScreen(ctx);
    this.debug = new DebugScreen(ctx);
    this.screens = { drive: this.drive, map: this.map, debug: this.debug };

    const nav = h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Screens' });
    for (const tab of TABS) {
      const button = h('button', { type: 'button', role: 'tab', class: 'tab', 'data-tab': tab.name, onClick: () => { location.hash = `#/${tab.name}`; } }, tab.label);
      this.buttons.set(tab.name, button);
      nav.append(button);
    }
    root.replaceChildren(
      h('div', { class: 'app' }, h('main', { class: 'screens' }, this.drive.el, this.map.el, this.debug.el), nav),
    );

    for (const screen of Object.values(this.screens)) screen.el.hidden = true; // only the routed screen is shown
    window.addEventListener('hashchange', () => this.route());
    this.route();
  }

  show(name: TabName): void {
    if (name === this.current) return;
    if (this.current) {
      this.screens[this.current].el.hidden = true;
      this.screens[this.current].onHide?.();
    }
    this.current = name;
    const screen = this.screens[name];
    screen.el.hidden = false;
    for (const [tab, button] of this.buttons) {
      button.setAttribute('aria-selected', String(tab === name));
      button.classList.toggle('active', tab === name);
    }
    screen.onShow?.();
  }

  private route(): void {
    const name = location.hash.replace(/^#\/?/, '') as TabName;
    this.show(TABS.some((t) => t.name === name) ? name : 'drive');
  }
}
