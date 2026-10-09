import type { HazardClass } from '@lubak/shared';

export interface ClassStyle {
  label: string;
  /** Marker / box colour. Distinguishable by lightness and by the letter, not by hue alone. */
  color: string;
  /** Text colour on top of `color`. */
  ink: string;
  glyph: string;
}

export const CLASS_STYLE: Readonly<Record<HazardClass, ClassStyle>> = {
  pothole: { label: 'Pothole', color: '#d93025', ink: '#ffffff', glyph: 'P' },
  crack: { label: 'Road crack', color: '#f9ab00', ink: '#1b1b1b', glyph: 'C' },
  flooded_road: { label: 'Flooded road', color: '#1a73e8', ink: '#ffffff', glyph: 'F' },
};
