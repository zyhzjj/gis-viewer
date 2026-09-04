"use strict";

const assert = require("assert");
const path = require("path");

global.window = global;
let capturedMetadata = null;
global.GeoTIFF = {
  writeArrayBuffer: async (rgba, metadata) => {
    capturedMetadata = metadata;
    return new ArrayBuffer(rgba.length + 32);
  }
};
require(path.join(__dirname, "..", "assets", "js", "exporter.js"));

const dataset = {
  name: "中文测试.geojson",
  kind: "vector",
  geojson: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "西安,站点", note: '含"引号"' },
        geometry: { type: "Point", coordinates: [108.94, 34.34] }
      },
      {
        type: "Feature",
        properties: { name: "范围" },
        geometry: { type: "Polygon", coordinates: [[[108, 34], [109, 34], [109, 35], [108, 34]]] }
      }
    ]
  }
};

const csv = GISExporter.vectorToCsv(dataset);
assert.strictEqual(csv.filename, "中文测试_wgs84.csv");
assert.ok(csv.text.startsWith("\uFEFF__crs,__geometry_type,__longitude,__latitude,__geometry_geojson,name,note"));
assert.ok(csv.text.includes("EPSG:4326,Point,108.94,34.34"));
assert.ok(csv.text.includes('"西安,站点"'));
assert.ok(csv.text.includes('"含""引号"""'));
assert.ok(csv.text.includes("Polygon,,,"));

(async () => {
  const rgba = new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 0
  ]);
  const result = await GISExporter._test.writeRgbaGeoTiff(rgba, 2, 2, [[34, 108], [35, 109]]);
  assert.ok(result.buffer instanceof ArrayBuffer);
  assert.ok(result.buffer.byteLength > rgba.byteLength);

  assert.strictEqual(capturedMetadata.width, 2);
  assert.strictEqual(capturedMetadata.height, 2);
  assert.strictEqual(capturedMetadata.SamplesPerPixel, 4);
  assert.deepStrictEqual(capturedMetadata.ModelPixelScale, [0.5, 0.5, 0]);
  assert.deepStrictEqual(capturedMetadata.ModelTiepoint, [0, 0, 0, 108, 35, 0]);
  assert.strictEqual(capturedMetadata.GeographicTypeGeoKey, 4326);
  console.log("OK exporter.js");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
