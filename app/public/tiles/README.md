# Offline map tiles

Leaflet reads tiles from **`app/public/tiles/{z}/{x}/{y}.png`** (standard XYZ / "slippy map" layout, **not** TMS: row 0 is at
the top). The service worker precaches every tile here at build time, so the map works in airplane mode.

## What is here

**Real map tiles of Antipolo, Rizal**, rendered by [`app/scripts/offline_tiles.py`](../../scripts/offline_tiles.py) from
OpenStreetMap data as published by [Overture Maps](https://overturemaps.org) (roads with names, water, land use, buildings,
place names). Source release, area and licence: [`ATTRIBUTION.txt`](ATTRIBUTION.txt).

| zoom | area | contents |
| --- | --- | --- |
| 12-14 | 121.05-121.30 E, 14.48-14.70 N (Antipolo, Cainta, Taytay, Teresa, Angono) | roads, water, place names |
| 15-17 | 121.15-121.21 E, 14.56-14.615 N (the demo loop and around it) | every street with its name, buildings, land use |

About 840 tiles, 14 MB. The app keeps the map inside that area (`TILE_BOUNDS` in `app/src/config.ts`, zoom 12 to 19; beyond 17
Leaflet scales the zoom-17 tiles up). The Demo Mode loop (`shared/src/geo.ts`) follows real streets of this map.

**Attribution is required** (ODbL 1.0): the map shows "© OpenStreetMap contributors, Overture Maps Foundation" by default.
Keep it if you override it with `VITE_TILE_ATTRIBUTION`.

## Another area, or fresher data

```bash
python -m venv .venv-tiles && .venv-tiles/bin/pip install -r app/scripts/requirements-tiles.txt
# edit DETAIL_BBOX / WIDE_BBOX in app/scripts/offline_tiles.py and TILE_BOUNDS in app/src/config.ts
.venv-tiles/bin/python app/scripts/offline_tiles.py fetch     # GeoParquet from Overture's public S3 bucket, no key (internet once)
.venv-tiles/bin/python app/scripts/offline_tiles.py render    # offline from then on
.venv-tiles/bin/python app/scripts/offline_tiles.py route --center <lat,lon>   # a demo loop on that area's real streets
npm run build
```

Keep the area small: every tile is precached on every phone over the hotspot, next to the model and the onnxruntime WASM runtime.

**Do not bulk-download from `tile.openstreetmap.org`.** The OpenStreetMap Foundation's tile usage policy forbids scraping its
servers for offline use; that is why these tiles are rendered locally from the data.

## Placeholder tiles

`npm run tiles:placeholder -w @lubak/app` writes a hatched grid with no map data, for testing the tile pipeline somewhere
else (`--out <folder>`). It refuses to overwrite this folder while `ATTRIBUTION.txt` is here.
