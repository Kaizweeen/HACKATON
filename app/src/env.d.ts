/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/vanillajs" />

interface ImportMetaEnv {
  /** Build-time default detector: 'auto' (real model, fall back to mock), 'mock' or 'onnx'. */
  readonly VITE_DETECTOR?: 'auto' | 'mock' | 'onnx';
  /** Attribution shown on the map for the offline tiles. */
  readonly VITE_TILE_ATTRIBUTION?: string;
}
