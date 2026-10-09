import { describe, expect, it } from 'vitest';
import { videoConstraints } from '../src/camera.js';
import { clampFps, defaultHubUrl, loadConfig, normalizeHubUrl, normalizePin, SAMPLE_FPS_MAX, SAMPLE_FPS_MIN } from '../src/config.js';

const https = { protocol: 'https:', host: '192.168.43.2:8443' };

describe('config', () => {
  it('clamps the sampling rate to 5..10 fps', () => {
    expect([clampFps(1), clampFps(5), clampFps(7.6), clampFps(10), clampFps(60), clampFps(Number.NaN)]).toEqual([5, 5, 8, 10, 10, 8]);
    expect([SAMPLE_FPS_MIN, SAMPLE_FPS_MAX]).toEqual([5, 10]);
  });

  it('defaults: auto detector, 8 fps, hub on the same origin', () => {
    const c = loadConfig('', https);
    expect(c).toMatchObject({ detector: 'auto', sampleFps: 8, inputSize: 320, demo: false });
    expect(c.hubUrl).toBe('wss://192.168.43.2:8443/ws');
    expect(c.modelUrl).toBe('/models/lubak.onnx');
    expect(c.tiles.urlTemplate).toBe('/tiles/{z}/{x}/{y}.png');
  });

  it('looks at the road with the rear camera unless asked otherwise, and only accepts the two known values', () => {
    expect(loadConfig('', https).camera).toBe('rear');
    expect(loadConfig('?camera=front', https).camera).toBe('front');
    expect(loadConfig('?camera=rear', https).camera).toBe('rear');
    expect(loadConfig('?camera=selfie', https).camera).toBe('rear');
  });

  it('asks the browser for the camera it was configured with, as a preference (a laptop has only one)', () => {
    expect(videoConstraints('rear').facingMode).toEqual({ ideal: 'environment' });
    expect(videoConstraints('front').facingMode).toEqual({ ideal: 'user' });
  });

  it('takes the hub event PIN from ?pin= when it looks like one, and has none by default', () => {
    expect(loadConfig('', https).hubPin).toBeNull();
    expect(loadConfig('?pin=antipolo-26', https).hubPin).toBe('antipolo-26');
    expect(loadConfig('?pin=12', https).hubPin).toBeNull();
    expect(loadConfig('?pin=a%20b%26c', https).hubPin).toBeNull();
    expect([normalizePin(' 4821 '), normalizePin(''), normalizePin(null), normalizePin('x'.repeat(33))]).toEqual(['4821', null, null, null]);
  });

  it('plain http pages use ws://', () => {
    expect(defaultHubUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws');
  });

  it('URL parameters override', () => {
    const c = loadConfig('?detector=mock&fps=6&demo=1&model=/models/x.onnx&hub=https://10.0.0.5:8443', https);
    expect(c).toMatchObject({ detector: 'mock', sampleFps: 6, demo: true, modelUrl: '/models/x.onnx', hubUrl: 'wss://10.0.0.5:8443/ws' });
  });

  it('rejects nonsense instead of passing it through', () => {
    const c = loadConfig('?detector=banana&fps=abc&hub=ftp://x', https);
    expect(c.detector).toBe('auto');
    expect(c.sampleFps).toBe(8);
    expect(c.hubUrl).toBe('wss://192.168.43.2:8443/ws');
    expect(normalizeHubUrl('not a url', 'wss://fallback/ws')).toBe('wss://fallback/ws');
  });
});
