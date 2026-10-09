/**
 * Small geodesy helpers used by the hub's fake device and by the app's Demo Mode.
 * Distances use the haversine formula; offsets use a local flat-earth approximation, which is
 * accurate to well under a metre for the tens-of-metres offsets used here.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

export function haversineMeters(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Move a point by metres north / east (small distances only). */
export function offsetMeters(p: LatLon, northM: number, eastM: number): LatLon {
  return {
    lat: p.lat + toDeg(northM / EARTH_RADIUS_M),
    lon: p.lon + toDeg(eastM / (EARTH_RADIUS_M * Math.cos(toRad(p.lat)))),
  };
}

/** Initial bearing from a to b in degrees clockwise from north, 0..360. */
export function bearingDegrees(a: LatLon, b: LatLon): number {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function polylineLengthMeters(path: readonly LatLon[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += haversineMeters(path[i - 1]!, path[i]!);
  return total;
}

export interface PathPoint extends LatLon {
  /** Heading of the segment the point lies on, degrees clockwise from north. */
  headingDeg: number;
}

/**
 * Point `distanceM` metres along a polyline. With `loop` the distance wraps around the total
 * length, otherwise it is clamped to the end of the path.
 */
export function pointAlongPath(path: readonly LatLon[], distanceM: number, loop = true): PathPoint {
  if (path.length === 0) throw new RangeError('path is empty');
  if (path.length === 1) return { ...path[0]!, headingDeg: 0 };

  const total = polylineLengthMeters(path);
  let remaining = loop ? ((distanceM % total) + total) % total : Math.min(Math.max(distanceM, 0), total);

  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const seg = haversineMeters(a, b);
    if (remaining <= seg || i === path.length - 1) {
      const f = seg === 0 ? 0 : Math.min(1, remaining / seg);
      return {
        lat: a.lat + (b.lat - a.lat) * f,
        lon: a.lon + (b.lon - a.lon) * f,
        headingDeg: bearingDegrees(a, b),
      };
    }
    remaining -= seg;
  }
  /* c8 ignore next */
  return { ...path[path.length - 1]!, headingDeg: 0 };
}

// ---------------------------------------------------------------------------------------------------
// Synthetic test route near Antipolo, Rizal. Shared by the hub's fake device and the app's Demo Mode so
// both exercise the same stretch of "road". It is a made-up loop of about 3.3 km, NOT map-matched.
// ---------------------------------------------------------------------------------------------------

/** Centre of the test area (Antipolo, Rizal). */
/** Antipolo, Rizal: the corner of M. L. Quezon Street and Juan Sumulong Street, on the road. */
export const DEMO_CENTER: Readonly<LatLon> = Object.freeze({ lat: 14.58471, lon: 121.175709 });

/**
 * (north, east) metre offsets from the centre that make up the loop: 3.3 km of real streets (OpenStreetMap via Overture Maps,
 * traced by `app/scripts/offline_tiles.py route`), south on M. L. Quezon Street first, so Demo Mode's lap stays on one street.
 */
export const DEMO_ROUTE_OFFSETS_M: readonly (readonly [number, number])[] = [
  [0, 0], [-435.5, 7.3], [-1042.4, 104.8], [-1046.9, -291], [-961.9, -468.6], [-953.3, -451.5],
  [-937.3, -436.8], [-920.1, -426.8], [-893.7, -418.3], [-491.3, -374.6], [-466.9, -201.4], [-329.5, -221.5],
  [-254.8, -220.5], [-143.1, -270.7], [-73.7, -274.3], [120.7, -292.2], [129.4, -1.2], [0, 0],
];

export function demoRoute(center: LatLon = DEMO_CENTER): LatLon[] {
  return DEMO_ROUTE_OFFSETS_M.map(([north, east]) => offsetMeters(center, north, east));
}
