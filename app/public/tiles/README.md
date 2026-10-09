# Offline map tiles

Leaflet reads tiles from **`app/public/tiles/{z}/{x}/{y}.png`** (standard XYZ / "slippy map" layout, **not** TMS: row 0 is at
the top). The service worker precaches every tile that exists here at build time, so the map works in airplane mode.

A missing tile is not an error: it shows as a transparent square over the neutral grid background, so an empty folder gives a
blank-but-working map and markers still appear in the right places. The app is configured for zoom 10 to 17
(`tiles` in `app/src/config.ts`); deeper zooms scale up the zoom-17 tiles.

## Try the pipeline now: placeholder tiles

```bash
npm run tiles:placeholder -w @lubak/app -- --radius-km 3 --zooms 12-16
```

writes a few hundred small hatched-grid tiles around Antipolo (14.585, 121.176) so you can check that tiles load offline and that markers
line up. They contain **no map data**. The generated folders are git-ignored; do not demo them as a map.

## Real tiles for the demo

Pick ONE way that fits the licence of your data, render only the area you need, and keep the folder small:

* **QGIS** (recommended): load OpenStreetMap-derived data for the Philippines (for example a Geofabrik `.osm.pbf` extract, clipped
  to Rizal), style it, then *Processing Toolbox → Raster tools → Generate XYZ tiles (Directory)*. Set the extent to your demo area and
  zoom 12 to 17, PNG output, and point the output directory at `app/public/tiles`.
* Any other renderer that produces a `{z}/{x}/{y}.png` directory (tilemaker + a style, Mapnik, an MBTiles unpacked to a folder, a tile
  server you run yourself).

**Do not bulk-download from `tile.openstreetmap.org`.** The OpenStreetMap Foundation's tile usage policy forbids scraping its servers for
offline use. Render your own tiles from the data instead.

**Attribution**: OpenStreetMap data requires "© OpenStreetMap contributors". The map shows that by default; override with
`VITE_TILE_ATTRIBUTION` if your tiles come from somewhere else.

### Size budget

Tiles are precached on first visit over the hotspot, and they sit next to a ~12 MB model and the onnxruntime WASM runtime. As a rule
of thumb a 4 km x 4 km area at zoom 12 to 17 is a few hundred tiles, tens of MB as PNG. Check `dist/` after `npm run build`.
