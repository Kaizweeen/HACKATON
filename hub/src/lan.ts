import os from 'node:os';

export interface LanAddress {
  iface: string;
  address: string;
  /** A well-known gateway address: this computer is probably the one sharing the hotspot. */
  hint?: string;
}

const HOTSPOT_GATEWAYS: Record<string, string> = {
  '192.168.137.1': 'Windows Mobile Hotspot: this PC is the hotspot',
  '192.168.43.1': 'Android-style hotspot gateway',
  '172.20.10.1': 'iPhone-style hotspot gateway',
  '10.42.0.1': 'NetworkManager shared hotspot: this PC is the hotspot',
  '192.168.2.1': 'macOS Internet Sharing: this Mac is the hotspot',
};

const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|utun|awdl|llw|tailscale|zt|wg|tun|tap)/i;

function isPrivate(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Non-loopback IPv4 addresses, most likely to be the hotspot / Wi-Fi LAN first. */
export function lanAddresses(interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): LanAddress[] {
  const found: (LanAddress & { rank: number })[] = [];
  for (const [iface, entries] of Object.entries(interfaces)) {
    for (const e of entries ?? []) {
      const isV4 = e.family === 'IPv4' || (e.family as unknown) === 4;
      if (!isV4 || e.internal) continue;
      if (e.address.startsWith('169.254.')) continue; // link-local: not a usable LAN address
      const hint = HOTSPOT_GATEWAYS[e.address];
      const rank = (isPrivate(e.address) ? 0 : 2) + (VIRTUAL_IFACE.test(iface) ? 1 : 0) + (hint ? -1 : 0);
      found.push({ iface, address: e.address, rank, ...(hint ? { hint } : {}) });
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map(({ rank: _rank, ...rest }) => rest);
}
