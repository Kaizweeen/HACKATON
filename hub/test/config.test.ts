import { describe, expect, it } from 'vitest';
import { loadConfig, type HubConfig } from '../src/config.js';

const load = (argv: string[], env: NodeJS.ProcessEnv = {}): HubConfig => {
  const config = loadConfig(env, argv);
  if (config === 'help') throw new Error('unexpected help');
  return config;
};

describe('event PIN option', () => {
  it('is off unless asked for', () => {
    expect(load([]).pin).toBeNull();
    expect(load([], { HUB_PIN: '  ' }).pin).toBeNull();
  });

  it('comes from --pin or HUB_PIN, the flag winning', () => {
    expect(load(['--pin', 'antipolo-26']).pin).toBe('antipolo-26');
    expect(load([], { HUB_PIN: '4821' }).pin).toBe('4821');
    expect(load(['--pin', 'flag'], { HUB_PIN: 'envpin' }).pin).toBe('flag');
  });

  it('refuses PINs that are too short, too long or need URL escaping', () => {
    for (const bad of ['123', 'a'.repeat(33), 'with space', 'pin&x=1', 'ñandú']) {
      expect(() => load(['--pin', bad])).toThrow(/4 to 32/);
    }
  });
});
