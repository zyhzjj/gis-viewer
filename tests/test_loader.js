"use strict";

const assert = require("assert");
const path = require("path");

global.window = global;
global.FileReader = class FakeFileReader {
  readAsText(file) { this.result = file.content; this.onload(); }
  readAsArrayBuffer() { throw new Error("本测试不读取二进制文件"); }
};
require(path.join(__dirname, "..", "assets", "js", "loader.js"));

const csv = 'lon,lat,name,remark\r\n119.3,26.1,"鼓楼,站点","第一行\n第二行"\r\n';
assert.strictEqual(DataLoader._test.detectDelimiter(csv), ",");
const rows = DataLoader._test.parseDelimitedRows(csv, ",");
assert.deepStrictEqual(rows[1], ["119.3", "26.1", "鼓楼,站点", "第一行\n第二行"]);

const range = DataLoader.percentileRange(new Float64Array([-9999, -9999, 1, 2, 3, 4]), -9999);
assert.deepStrictEqual(range, [1, 4]);

(async () => {
  const parsed = await DataLoader.loadFiles([{ name: "quoted.csv", content: csv }]);
  assert.strictEqual(parsed[0].kind, "vector");
  assert.strictEqual(parsed[0].geojson.features[0].properties.name, "鼓楼,站点");
  assert.strictEqual(parsed[0].geojson.features[0].properties.remark, "第一行\n第二行");

  const xy = await DataLoader.loadFiles([{ name: "projected.csv", content: "x,y\n500000,2850000\n" }]);
  assert.strictEqual(xy[0].crs, null);
  assert.strictEqual(xy[0].crsSource, "unknown");

  const bad = await DataLoader.loadFiles([{ name: "bad.csv", content: 'lon,lat,name\n119,26,"未闭合\n' }]);
  assert.strictEqual(bad[0].kind, "error");

  console.log("OK loader.js");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
