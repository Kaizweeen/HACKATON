#!/usr/bin/env python3
"""Real offline map tiles for Lubak Alert, rendered on this machine from OpenStreetMap data (as published by Overture Maps).

    python -m venv .venv-tiles && .venv-tiles/bin/pip install -r app/scripts/requirements-tiles.txt
    .venv-tiles/bin/python app/scripts/offline_tiles.py fetch    # GeoParquet for the demo area -> app/.tiles-cache/ (internet, once)
    .venv-tiles/bin/python app/scripts/offline_tiles.py render   # -> app/public/tiles/{z}/{x}/{y}.png (offline)
    .venv-tiles/bin/python app/scripts/offline_tiles.py route    # prints a demo loop that follows real roads (shared/src/geo.ts)

Why not tile.openstreetmap.org: its usage policy forbids bulk downloads for offline use. Overture Maps publishes the same
OpenStreetMap roads, water and buildings as open GeoParquet on S3 (anonymous, no key), and this script draws its own tiles from them.
Licence: the data is ODbL 1.0. The map must show "© OpenStreetMap contributors, Overture Maps Foundation" (the app's default
attribution). The rendered tiles are a Produced Work under the ODbL: keep the attribution, and the data source stays open.

Layout: standard XYZ ("slippy map", row 0 at the top), 256 px PNGs, what Leaflet reads from app/public/tiles. Zoom 12-14 cover the
wider area (roads, water, place names); 15-17 the demo area in detail (buildings, all streets, street names). The service worker
precaches every tile, so keep the area small: the defaults give about 700 tiles and a few MB.
Rendering is plain Pillow: features are projected to Web Mercator pixels, drawn on 8x8-tile metatiles at 2x and downsampled,
so lines are antialiased and street names can cross tile borders inside a metatile.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "app" / ".tiles-cache"
OUT = ROOT / "app" / "public" / "tiles"

RELEASE = "2026-09-23.1"  # Overture release; list others with: curl "https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&prefix=release/&delimiter=/"
# (west, south, east, north). DETAIL is drawn at zoom 15-17; WIDE at zoom 12-14 (the app's TILE_BOUNDS, minZoom 12).
DETAIL_BBOX = (121.150, 14.560, 121.210, 14.615)
WIDE_BBOX = (121.050, 14.480, 121.300, 14.700)
DETAIL_ZOOMS = range(15, 18)
WIDE_ZOOMS = range(12, 15)

LAYERS = {  # file -> (theme, type, bbox, columns)
    "segment": ("transportation", "segment", WIDE_BBOX, ["id", "geometry", "subtype", "class", "names", "connectors", "road_flags"]),
    "water": ("base", "water", WIDE_BBOX, ["geometry", "subtype", "class"]),
    "land_use": ("base", "land_use", DETAIL_BBOX, ["geometry", "subtype", "class"]),
    "building": ("buildings", "building", DETAIL_BBOX, ["geometry"]),
    "division": ("divisions", "division", WIDE_BBOX, ["geometry", "subtype", "names"]),
}


# ---------------------------------------------------------------------------------------------------------------- fetch


def fetch(args: argparse.Namespace) -> None:
    import pyarrow.compute as pc
    import pyarrow.dataset as pds
    import pyarrow.fs as pafs
    import pyarrow.parquet as pq

    CACHE.mkdir(parents=True, exist_ok=True)
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    s3 = pafs.S3FileSystem(anonymous=True, region="us-west-2", proxy_options=proxy, connect_timeout=30, request_timeout=120)
    for name, (theme, kind, bbox, columns) in LAYERS.items():
        west, south, east, north = bbox
        started = time.time()
        dataset = pds.dataset(f"overturemaps-us-west-2/release/{args.release}/theme={theme}/type={kind}/", filesystem=s3, format="parquet")
        # Overture files are spatially sorted and carry a bbox struct, so row-group statistics skip almost everything.
        where = (pc.field("bbox", "xmin") < east) & (pc.field("bbox", "xmax") > west) & (pc.field("bbox", "ymin") < north) & (pc.field("bbox", "ymax") > south)
        table = dataset.to_table(filter=where, columns=columns, batch_readahead=16, fragment_readahead=8)
        pq.write_table(table, CACHE / f"{name}.parquet", compression="zstd")
        print(f"{name:9} {table.num_rows:7} features  {time.time() - started:5.1f} s")
    (CACHE / "RELEASE").write_text(args.release + "\n")
    print(f"cached in {CACHE} (git-ignored). Next: offline_tiles.py render")


# ---------------------------------------------------------------------------------------------------------------- data


@dataclass
class Data:
    roads: list            # (shapely LineString, class, name or "")
    rails: list            # LineString
    water_areas: list      # Polygon / MultiPolygon
    water_lines: list      # (LineString, width class)
    land_use: list         # (Polygon / MultiPolygon, fill colour)
    buildings: list        # Polygon / MultiPolygon
    places: list           # (Point, subtype, name)


LAND_USE_FILL = {
    "residential": "#e8e6e1", "commercial": "#f2dfdc", "retail": "#f6dcd6", "industrial": "#ebe1e8", "school": "#f3f0d8",
    "college": "#f3f0d8", "university": "#f3f0d8", "education": "#f3f0d8", "hospital": "#f4e9e2", "park": "#cfeccd",
    "village_green": "#d4ecc9", "grass": "#d7edc4", "pitch": "#b9e3cf", "recreation_ground": "#ddf3df", "golf_course": "#c9e8c2",
    "cemetery": "#bcd3be", "religious": "#dedad3", "forest": "#b6d6a8", "wood": "#b6d6a8", "meadow": "#d7edc4", "farmland": "#e9eccb",
    "orchard": "#cfe5b4", "garden": "#cfeccd", "construction": "#dcdccb", "greenfield": "#dcdccb", "brownfield": "#d9d6c8",
    "quarry": "#d6d2cb", "resort": "#dcf2e3", "water_park": "#cde9ee", "military": "#efdcd8",
}


def load() -> Data:
    import pyarrow.parquet as pq
    import shapely

    if not (CACHE / "segment.parquet").exists():
        raise SystemExit(f"no data in {CACHE}: run `offline_tiles.py fetch` first (needs internet once)")

    def read(name: str):
        table = pq.read_table(CACHE / f"{name}.parquet")
        geoms = shapely.from_wkb(table["geometry"].to_numpy(zero_copy_only=False))
        return table, geoms

    t, g = read("segment")
    roads, rails = [], []
    for geom, subtype, cls, names in zip(g, t["subtype"].to_pylist(), t["class"].to_pylist(), t["names"].to_pylist()):
        if geom is None or geom.is_empty:
            continue
        if subtype == "road":
            roads.append((geom, cls or "unknown", ((names or {}).get("primary") or "").strip()))
        elif subtype == "rail":
            rails.append(geom)

    t, g = read("water")
    water_areas, water_lines = [], []
    for geom, subtype in zip(g, t["subtype"].to_pylist()):
        if geom is None or geom.is_empty:
            continue
        if geom.geom_type in ("Polygon", "MultiPolygon"):
            water_areas.append(geom)
        elif geom.geom_type in ("LineString", "MultiLineString"):
            water_lines.append((geom, "river" if subtype in ("river", "canal") else "stream"))

    t, g = read("land_use")
    land_use = [(geom, LAND_USE_FILL[cls]) for geom, cls in zip(g, t["class"].to_pylist())
                if geom is not None and cls in LAND_USE_FILL and geom.geom_type in ("Polygon", "MultiPolygon")]

    _, g = read("building")
    buildings = [geom for geom in g if geom is not None and geom.geom_type in ("Polygon", "MultiPolygon")]

    t, g = read("division")
    places = [(geom, subtype, (names or {}).get("primary") or "") for geom, subtype, names in zip(g, t["subtype"].to_pylist(), t["names"].to_pylist())
              if geom is not None and geom.geom_type == "Point" and subtype in ("locality", "macrohood", "neighborhood") and names]
    return Data(roads, rails, water_areas, water_lines, land_use, buildings, places)


# ---------------------------------------------------------------------------------------------------------------- render

TILE = 256
META = 8        # tiles per metatile side
SS = 2          # supersampling factor
BACKGROUND = "#f3f1ec"
WATER = "#a9d3e3"
BUILDING_FILL, BUILDING_LINE = "#dcd3cb", "#c8b9ad"

# class: (fill, casing, width at z17 in px, first zoom drawn, label from zoom)
ROAD_STYLE = {
    "motorway": ("#e990a0", "#c24e6b", 14, 10, 13),
    "trunk": ("#f7b59c", "#c0613f", 13, 10, 13),
    "primary": ("#fcd5a0", "#b07b2c", 12, 10, 14),
    "secondary": ("#f6f7bd", "#8f9437", 11, 11, 15),
    "tertiary": ("#ffffff", "#a39e93", 10, 12, 15),
    "residential": ("#ffffff", "#bab5aa", 8, 14, 16),
    "unclassified": ("#ffffff", "#bab5aa", 8, 14, 16),
    "living_street": ("#f1f1f1", "#bab5aa", 7, 14, 16),
    "unknown": ("#ffffff", "#c4c0b7", 6, 15, 17),
    "service": ("#ffffff", "#c4c0b7", 5, 15, 17),
    "pedestrian": ("#e2e1ea", "#b4b3c2", 6, 15, 17),
    "track": ("#ffffff", "#b39c78", 3, 16, 99),
}
PATH_CLASSES = {"footway", "path", "steps", "cycleway", "bridleway", "sidewalk", "crosswalk"}
ROAD_ORDER = ["track", "pedestrian", "service", "unknown", "living_street", "unclassified", "residential", "tertiary", "secondary", "primary", "trunk", "motorway"]


def road_width(cls: str, z: int) -> float:
    base = ROAD_STYLE[cls][2]
    return max(1.0, base * 0.72 ** (17 - z))


def lonlat_to_px(coords, z: int):
    """Web Mercator: (lon, lat) array -> global pixel coordinates at zoom z (256 px tiles)."""
    import numpy as np

    n = TILE * (2 ** z)
    lon, lat = coords[:, 0], np.clip(coords[:, 1], -85.0511, 85.0511)
    x = (lon + 180.0) / 360.0 * n
    s = np.sin(np.radians(lat))
    y = (0.5 - np.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return np.column_stack([x, y])


def tile_range(bbox, z: int):
    import numpy as np

    west, south, east, north = bbox
    (x0, y0), (x1, y1) = lonlat_to_px(np.array([[west, north], [east, south]]), z) / TILE
    return int(x0), int(y0), int(x1), int(y1)


def font(size: int, bold: bool = False):
    from PIL import ImageFont

    candidates = ["DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                  "Arial Bold.ttf" if bold else "Arial.ttf", "arialbd.ttf" if bold else "arial.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"]
    for name in candidates:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


class Projected:
    """All features projected to one zoom's pixel space, with spatial indexes for metatile queries."""

    def __init__(self, data: Data, z: int):
        import shapely

        self.z = z
        tolerance = 0.35  # px: invisible, but keeps low zooms fast

        def project(geoms):
            if not geoms:
                return [], None
            out = shapely.simplify(shapely.transform(list(geoms), lambda c: lonlat_to_px(c, z)), tolerance, preserve_topology=True)
            return list(out), shapely.STRtree(out)

        road_items = [(geom, cls, name) for geom, cls, name in data.roads if (cls in ROAD_STYLE and z >= ROAD_STYLE[cls][3]) or (cls in PATH_CLASSES and z >= 16)]
        self.roads, self.road_tree = project([r[0] for r in road_items])
        self.road_meta = [(cls, name) for _, cls, name in road_items]
        self.rails, self.rail_tree = project(data.rails if z >= 12 else [])
        self.water_areas, self.water_tree = project(data.water_areas)
        wl = [w for w in data.water_lines if z >= 14 or w[1] == "river"]
        self.water_lines, self.water_line_tree = project([w[0] for w in wl])
        self.water_line_kind = [w[1] for w in wl]
        self.land, self.land_tree = project([l[0] for l in data.land_use] if z >= 13 else [])
        self.land_fill = [l[1] for l in data.land_use]
        self.buildings, self.building_tree = project(data.buildings if z >= 15 else [])
        wanted = {"locality"} if z <= 12 else {"locality", "macrohood"} if z <= 14 else {"macrohood", "neighborhood"}
        place_items = [p for p in data.places if p[1] in wanted]
        self.places, self.place_tree = project([p[0] for p in place_items])
        self.place_meta = [(p[1], p[2]) for p in place_items]


def render(args: argparse.Namespace) -> None:
    import numpy as np
    import shapely
    from PIL import Image, ImageDraw

    data = load()
    print(f"loaded {len(data.roads)} road segments, {len(data.buildings)} buildings, {len(data.water_areas) + len(data.water_lines)} water features, {len(data.places)} place names")
    if args.clean and OUT.exists():
        for child in OUT.iterdir():
            if child.is_dir() and child.name.isdigit():
                for p in sorted(child.rglob("*"), reverse=True):
                    p.unlink() if p.is_file() else p.rmdir()
                child.rmdir()

    total_tiles = total_bytes = 0
    zooms = sorted(set(args.zooms))
    for z in zooms:
        bbox = DETAIL_BBOX if z in DETAIL_ZOOMS else WIDE_BBOX
        tx0, ty0, tx1, ty1 = tile_range(bbox, z)
        proj = Projected(data, z)
        z_tiles = z_bytes = 0
        for mx in range(tx0, tx1 + 1, META):
            for my in range(ty0, ty1 + 1, META):
                tiles = [(x, y) for x in range(mx, min(mx + META, tx1 + 1)) for y in range(my, min(my + META, ty1 + 1))]
                image = draw_metatile(proj, z, mx, my, np, shapely, Image, ImageDraw)
                for x, y in tiles:
                    left, top = (x - mx) * TILE, (y - my) * TILE
                    tile = image.crop((left, top, left + TILE, top + TILE)).quantize(colors=96, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
                    path = OUT / str(z) / str(x) / f"{y}.png"
                    path.parent.mkdir(parents=True, exist_ok=True)
                    tile.save(path, optimize=True)
                    z_tiles += 1
                    z_bytes += path.stat().st_size
        total_tiles += z_tiles
        total_bytes += z_bytes
        print(f"z{z:<2} x {tx0}..{tx1}  y {ty0}..{ty1}  {z_tiles:4} tiles  {z_bytes / 1e6:6.2f} MB")
    release = (CACHE / "RELEASE").read_text().strip() if (CACHE / "RELEASE").exists() else "unknown"
    (OUT / "ATTRIBUTION.txt").write_text(
        "Map tiles rendered by app/scripts/offline_tiles.py from OpenStreetMap data published by Overture Maps\n"
        f"(release {release}; transportation, base, buildings and divisions themes).\n"
        "Data: (c) OpenStreetMap contributors, Overture Maps Foundation. Licence: ODbL 1.0, https://opendatacommons.org/licenses/odbl/\n"
        f"Area: detail {DETAIL_BBOX} at zoom {min(DETAIL_ZOOMS)}-{max(DETAIL_ZOOMS)}, wider area {WIDE_BBOX} at zoom {min(WIDE_ZOOMS)}-{max(WIDE_ZOOMS)} (west, south, east, north).\n"
        "Real tiles: app/scripts/make-placeholder-tiles.mjs refuses to overwrite this folder while this file exists.\n"
    )
    print(f"wrote {total_tiles} tiles, {total_bytes / 1e6:.1f} MB, to {OUT}")


def draw_metatile(proj: Projected, z: int, mx: int, my: int, np, shapely, Image, ImageDraw):
    size = META * TILE * SS
    ox, oy = mx * TILE, my * TILE  # metatile origin in global pixels
    image = Image.new("RGB", (size, size), BACKGROUND)
    draw = ImageDraw.Draw(image)
    window = shapely.box(ox - 64, oy - 64, ox + META * TILE + 64, oy + META * TILE + 64)

    def local(coords):
        return [((x - ox) * SS, (y - oy) * SS) for x, y in coords]

    def query(tree, geoms):
        if tree is None:
            return []
        return [int(i) for i in tree.query(window)]

    def fill_polygons(polys, color):
        """Fill with holes cut out, through a mask, so a courtyard or an island shows what is underneath."""
        if not polys:
            return
        mask = Image.new("L", (size, size), 0)
        md = ImageDraw.Draw(mask)
        for poly in polys:
            for part in getattr(poly, "geoms", [poly]):
                if part.geom_type != "Polygon" or part.is_empty:
                    continue
                md.polygon(local(part.exterior.coords), fill=255)
                for hole in part.interiors:
                    md.polygon(local(hole.coords), fill=0)
        image.paste(color, (0, 0), mask)

    def lines_of(geom):
        return [g for g in getattr(geom, "geoms", [geom]) if g.geom_type == "LineString" and len(g.coords) >= 2]

    def stroke(geom, color, width, round_ends=True):
        w = max(1, round(width * SS))
        for line in lines_of(geom):
            pts = local(line.coords)
            draw.line(pts, fill=color, width=w, joint="curve")
            if round_ends and w > 3:
                r = w / 2
                for px, py in (pts[0], pts[-1]):
                    draw.ellipse((px - r, py - r, px + r, py + r), fill=color)

    # land use, water areas, buildings
    by_colour: dict[str, list] = {}
    for i in query(proj.land_tree, proj.land):
        by_colour.setdefault(proj.land_fill[i], []).append(proj.land[i])
    for colour, polys in by_colour.items():
        fill_polygons(polys, colour)
    fill_polygons([proj.water_areas[i] for i in query(proj.water_tree, proj.water_areas)], WATER)
    for i in query(proj.water_line_tree, proj.water_lines):
        kind = proj.water_line_kind[i]
        stroke(proj.water_lines[i], WATER, (3.0 if kind == "river" else 1.4) * (0.8 ** max(0, 16 - z)) + 0.6)
    if proj.buildings:
        for i in query(proj.building_tree, proj.buildings):
            for part in getattr(proj.buildings[i], "geoms", [proj.buildings[i]]):
                if part.geom_type == "Polygon" and not part.is_empty:
                    draw.polygon(local(part.exterior.coords), fill=BUILDING_FILL, outline=BUILDING_LINE if z >= 16 else None)

    # paths (thin dashes), rails, then roads: all casings first, then fills, minor classes under major ones
    road_ids = query(proj.road_tree, proj.roads)
    for i in road_ids:
        cls, _ = proj.road_meta[i]
        if cls in PATH_CLASSES:
            for line in lines_of(proj.roads[i]):
                dashed(draw, local(line.coords), "#e3826f", max(1, round(1.2 * SS)), 4 * SS, 3 * SS)
    for i in query(proj.rail_tree, proj.rails):
        stroke(proj.rails[i], "#9a9a9a", 2.2 if z >= 15 else 1.4, round_ends=False)
    ordered = sorted((i for i in road_ids if proj.road_meta[i][0] in ROAD_STYLE), key=lambda i: ROAD_ORDER.index(proj.road_meta[i][0]))
    cased = z >= 13
    for pass_ in ("casing", "fill"):
        if pass_ == "casing" and not cased:
            continue
        for i in ordered:
            cls = proj.road_meta[i][0]
            fill, casing, *_ = ROAD_STYLE[cls]
            w = road_width(cls, z)
            if pass_ == "casing":
                stroke(proj.roads[i], casing, w + (1.6 if z >= 15 else 1.0))
            else:
                stroke(proj.roads[i], fill if (cased or cls not in ("tertiary", "residential", "unclassified")) else "#d9d4c8", w)

    # labels: place names, then street names, never overlapping each other or leaving the metatile
    placed: list[tuple[float, float, float, float]] = []
    inner = (2 * SS, 2 * SS, size - 2 * SS, size - 2 * SS)
    for i in query(proj.place_tree, proj.places):
        subtype, name = proj.place_meta[i]
        p = proj.places[i]
        big = subtype in ("locality", "macrohood")
        text_label(image, name, ((p.x - ox) * SS, (p.y - oy) * SS), 0.0, font((13 if big else 11) * SS, bold=big),
                   "#55505a" if big else "#77707d", placed, inner)
    named: dict[tuple[str, str], list] = {}
    for i in road_ids:
        cls, name = proj.road_meta[i]
        if name and cls in ROAD_STYLE and z >= ROAD_STYLE[cls][4]:
            named.setdefault((name, cls), []).extend(lines_of(proj.roads[i]))
    for (name, cls), parts in sorted(named.items(), key=lambda kv: ROAD_ORDER.index(kv[0][1]), reverse=True):
        merged = shapely.line_merge(shapely.MultiLineString(parts)) if len(parts) > 1 else parts[0]
        for line in sorted(lines_of(merged), key=lambda l: -l.length):
            place_street_label(image, line, name, z, ox, oy, placed, inner, shapely)
    return image.resize((META * TILE, META * TILE), Image.Resampling.LANCZOS)


def dashed(draw, pts, color, width, on, off):
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        length = math.hypot(x1 - x0, y1 - y0)
        if length == 0:
            continue
        ux, uy = (x1 - x0) / length, (y1 - y0) / length
        t = 0.0
        while t < length:
            e = min(length, t + on)
            draw.line([(x0 + ux * t, y0 + uy * t), (x0 + ux * e, y0 + uy * e)], fill=color, width=width)
            t = e + off


def overlaps(box, placed, pad=6.0):
    return any(not (box[2] + pad < b[0] or box[0] - pad > b[2] or box[3] + pad < b[1] or box[1] - pad > b[3]) for b in placed)


def text_label(image, text, centre, angle_deg, fnt, colour, placed, inner) -> bool:
    from PIL import Image, ImageDraw

    stroke_w = max(2, fnt.size // 7)
    left, top, right, bottom = fnt.getbbox(text, stroke_width=stroke_w)
    w, h = right - left, bottom - top
    canvas = Image.new("RGBA", (w + 4, h + 4), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).text((2 - left, 2 - top), text, font=fnt, fill=colour, stroke_width=stroke_w, stroke_fill=(255, 255, 255, 235))
    if angle_deg:
        canvas = canvas.rotate(angle_deg, resample=Image.Resampling.BICUBIC, expand=True)
    cx, cy = centre
    box = (cx - canvas.width / 2, cy - canvas.height / 2, cx + canvas.width / 2, cy + canvas.height / 2)
    if box[0] < inner[0] or box[1] < inner[1] or box[2] > inner[2] or box[3] > inner[3] or overlaps(box, placed):
        return False
    image.paste(canvas, (round(box[0]), round(box[1])), canvas)
    placed.append(box)
    return True


def place_street_label(image, line, name, z, ox, oy, placed, inner, shapely) -> None:
    """Put the name along the straightest stretch of `line` (global px), upright, once per ~700 px of road."""
    fnt = font((11 if z >= 16 else 10) * SS)
    text_w = fnt.getlength(name) / SS + 8  # in global (1x) px
    if line.length < text_w * 1.15:
        return
    step = max(text_w * 1.5, 700.0)
    d = line.length / 2 if line.length < 2 * step else step / 2
    while d < line.length - text_w / 2:
        a = line.interpolate(max(0.0, d - text_w / 2))
        b = line.interpolate(min(line.length, d + text_w / 2))
        mid = line.interpolate(d)
        chord = math.hypot(b.x - a.x, b.y - a.y)
        if chord > text_w * 0.9:  # fairly straight here
            angle = math.degrees(math.atan2(b.y - a.y, b.x - a.x))
            if angle > 90:
                angle -= 180
            elif angle < -90:
                angle += 180
            text_label(image, name, ((mid.x - ox) * SS, (mid.y - oy) * SS), -angle, fnt, "#3d3a36", placed, inner)
        d += step


# ---------------------------------------------------------------------------------------------------------------- route


def route(args: argparse.Namespace) -> None:
    """A loop of real, drivable roads through the road point nearest the requested centre, printed as the (north, east) metre
    offsets of shared/src/geo.ts. The first ~450 m (one Demo Mode lap at 7 m/s) are what Demo Mode drives, so the start is
    snapped to a tertiary-or-bigger road."""
    import networkx as nx
    import numpy as np
    import pyarrow.parquet as pq
    import shapely
    from shapely.ops import substring

    lat0, lon0 = args.center
    R = 6_371_008.8
    kx, ky = math.radians(1) * R * math.cos(math.radians(lat0)), math.radians(1) * R

    def to_m(c):
        return np.column_stack([(c[:, 0] - lon0) * kx, (c[:, 1] - lat0) * ky])

    table = pq.read_table(CACHE / "segment.parquet")
    geoms = shapely.from_wkb(table["geometry"].to_numpy(zero_copy_only=False))
    drivable = {"motorway": 1.0, "trunk": 1.0, "primary": 1.0, "secondary": 1.1, "tertiary": 1.25, "residential": 2.2, "unclassified": 2.0, "living_street": 3.0}
    major = {"motorway", "trunk", "primary", "secondary", "tertiary"}
    graph = nx.Graph()
    for geom, subtype, cls, connectors, flags in zip(geoms, table["subtype"].to_pylist(), table["class"].to_pylist(), table["connectors"].to_pylist(), table["road_flags"].to_pylist()):
        if subtype != "road" or cls not in drivable or geom is None or not connectors:
            continue
        line_m = shapely.transform(geom, to_m)
        if shapely.distance(line_m, shapely.Point(0, 0)) > 2500:
            continue
        stops = sorted(connectors, key=lambda c: c["at"])
        for a, b in zip(stops, stops[1:]):
            piece = substring(line_m, a["at"], b["at"], normalized=True)
            if piece.length <= 0:
                continue
            u, v = a["connector_id"], b["connector_id"]
            cost = piece.length * drivable[cls]
            if not graph.has_edge(u, v) or graph[u][v]["cost"] > cost:
                coords = list(piece.coords)
                graph.add_edge(u, v, cost=cost, length=piece.length, cls=cls, coords={u: coords, v: coords[::-1]})
    graph = graph.subgraph(max(nx.connected_components(graph), key=len)).copy()
    pos = {}
    for u, v, e in graph.edges(data=True):
        pos[u], pos[v] = e["coords"][u][0], e["coords"][v][0]

    starts = [n for n in graph if any(graph[n][m]["cls"] in major for m in graph[n])]
    start = min(starts, key=lambda n: math.hypot(*pos[n]))
    best = None
    targets = [n for n in graph if 700 <= math.hypot(pos[n][0] - pos[start][0], pos[n][1] - pos[start][1]) <= 1250]
    for target in targets[:: max(1, len(targets) // 400)]:
        try:
            out = nx.shortest_path(graph, start, target, weight="cost")
        except nx.NetworkXNoPath:
            continue
        used = set(zip(out, out[1:])) | set(zip(out[1:], out))
        back_graph = nx.restricted_view(graph, set(out[1:-1]), list(used))
        try:
            back = nx.shortest_path(back_graph, target, start, weight="cost")
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            continue
        nodes = out + back[1:]
        edges = list(zip(nodes, nodes[1:]))
        length = sum(graph[u][v]["length"] for u, v in edges)
        if not 2800 <= length <= 3800:
            continue
        coords = [p for u, v in edges for p in graph[u][v]["coords"][u]]
        far = max(math.hypot(x - pos[start][0], y - pos[start][1]) for x, y in coords)
        if far > 1400:
            continue
        major_share = sum(graph[u][v]["length"] for u, v in edges if graph[u][v]["cls"] in major) / length
        first = 0.0
        first_major = 0.0
        for u, v in edges:  # how much of the first lap (450 m) is on a real street with a name-worthy class
            if first >= 450:
                break
            take = min(graph[u][v]["length"], 450 - first)
            first += take
            first_major += take if graph[u][v]["cls"] in major else 0
        score = major_share + first_major / 450
        if best is None or score > best[0]:
            best = (score, length, nodes, coords, major_share)
    if best is None:
        raise SystemExit("no loop of 2.8-3.8 km found; try another --center")
    score, length, nodes, coords, major_share = best
    line = shapely.LineString([(x - pos[start][0], y - pos[start][1]) for x, y in coords]).simplify(args.tolerance)
    pts = [(round(y, 1), round(x, 1)) for x, y in line.coords]  # (north, east)
    pts[0], pts[-1] = (0.0, 0.0), (0.0, 0.0)
    start_lat = lat0 + math.degrees(pos[start][1] / R)
    start_lon = lon0 + math.degrees(pos[start][0] / (R * math.cos(math.radians(lat0))))
    print(f"// loop {length:.0f} m, {major_share * 100:.0f}% on tertiary-or-bigger roads, {len(pts)} points; start snapped to a road at:")
    print(f"export const DEMO_CENTER: Readonly<LatLon> = Object.freeze({{ lat: {start_lat:.6f}, lon: {start_lon:.6f} }});")
    print("export const DEMO_ROUTE_OFFSETS_M: readonly (readonly [number, number])[] = [")
    row = []
    for n, e in pts:
        row.append(f"[{n:g}, {e:g}]")
        if len(row) == 6:
            print("  " + ", ".join(row) + ",")
            row = []
    if row:
        print("  " + ", ".join(row) + ",")
    print("];")


# ---------------------------------------------------------------------------------------------------------------- main


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)
    f = sub.add_parser("fetch", help="download the Overture data for the demo area")
    f.add_argument("--release", default=RELEASE)
    r = sub.add_parser("render", help="render XYZ PNG tiles into app/public/tiles")
    r.add_argument("--zooms", type=lambda s: list(range(int(s.split("-")[0]), int(s.split("-")[-1]) + 1)), default=list(range(12, 18)))
    r.add_argument("--no-clean", dest="clean", action="store_false", help="keep existing tiles (default: replace every numbered zoom folder)")
    t = sub.add_parser("route", help="print a demo loop on real roads (for shared/src/geo.ts)")
    t.add_argument("--center", type=lambda s: tuple(float(v) for v in s.split(",")), default=(14.585, 121.176))
    t.add_argument("--tolerance", type=float, default=2.0, help="simplification in metres")
    args = p.parse_args()
    {"fetch": fetch, "render": render, "route": route}[args.command](args)


if __name__ == "__main__":
    try:
        main()
    except ImportError as err:
        sys.exit(f"missing dependency: {err}. Install with: pip install -r app/scripts/requirements-tiles.txt")
