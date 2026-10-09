/**
 * Minimal geohash encoder/decoder (base-32, interleaved lon/lat bits).
 *
 * Written in-house so the shared package has zero dependencies. Checked against
 * published reference vectors in test/geohash.test.ts.
 */

/** Hazard ids use precision-8 cells: roughly 38 m x 19 m at the equator, ~37 m x 19 m near Antipolo. */
export const GEOHASH_PRECISION = 8;

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export interface GeohashBounds {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

/** Encode a WGS84 coordinate. Throws RangeError for non-finite or out-of-range input. */
export function encodeGeohash(lat: number, lon: number, precision: number = GEOHASH_PRECISION): string {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new RangeError(`latitude out of range: ${lat}`);
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new RangeError(`longitude out of range: ${lon}`);
  if (!Number.isInteger(precision) || precision < 1 || precision > 12) {
    throw new RangeError(`geohash precision must be an integer in 1..12, got ${precision}`);
  }

  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let hash = '';
  let bitCount = 0;
  let index = 0;
  let evenBit = true; // geohash interleaves longitude first

  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        index = index * 2 + 1;
        lonMin = mid;
      } else {
        index = index * 2;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        index = index * 2 + 1;
        latMin = mid;
      } else {
        index = index * 2;
        latMax = mid;
      }
    }
    evenBit = !evenBit;
    bitCount += 1;
    if (bitCount === 5) {
      hash += BASE32.charAt(index);
      bitCount = 0;
      index = 0;
    }
  }
  return hash;
}

/** Bounding box of a geohash cell. Throws on an empty string or an invalid character. */
export function decodeGeohashBounds(hash: string): GeohashBounds {
  if (hash.length === 0) throw new RangeError('empty geohash');
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let evenBit = true;

  for (const ch of hash) {
    const value = BASE32.indexOf(ch);
    if (value < 0) throw new RangeError(`invalid geohash character: ${ch}`);
    for (let mask = 16; mask > 0; mask >>= 1) {
      const bit = (value & mask) !== 0;
      if (evenBit) {
        const mid = (lonMin + lonMax) / 2;
        if (bit) lonMin = mid;
        else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit) latMin = mid;
        else latMax = mid;
      }
      evenBit = !evenBit;
    }
  }
  return { latMin, latMax, lonMin, lonMax };
}

/** Centre point of a geohash cell. */
export function decodeGeohash(hash: string): { lat: number; lon: number } {
  const b = decodeGeohashBounds(hash);
  return { lat: (b.latMin + b.latMax) / 2, lon: (b.lonMin + b.lonMax) / 2 };
}

/** True when the string is a syntactically valid geohash of exactly `precision` characters. */
export function isGeohash(value: unknown, precision: number = GEOHASH_PRECISION): value is string {
  if (typeof value !== 'string' || value.length !== precision) return false;
  for (const ch of value) if (BASE32.indexOf(ch) < 0) return false;
  return true;
}
