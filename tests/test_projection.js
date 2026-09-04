"use strict";

const assert = require("assert");
const path = require("path");

global.window = global;
global.proj4 = require(path.join(__dirname, "..", "assets", "js", "vendor", "proj4.js"));
require(path.join(__dirname, "..", "assets", "js", "projection.js"));

const wkt32650 = 'PROJCS["WGS 84 / UTM zone 50N",GEOGCS["WGS 84",' +
  'DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],' +
  'AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],' +
  'UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]],' +
  'PROJECTION["Transverse_Mercator"],PARAMETER["central_meridian",117],' +
  'UNIT["metre",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","32650"]]';

assert.strictEqual(CRSUtil.parseEpsgFromWkt(wkt32650), "EPSG:32650");
assert.strictEqual(
  CRSUtil.parseEpsgFromWkt('GEOGCRS["WGS 84",DATUM["x",ID["EPSG",6326]],ID["EPSG",4326]]'),
  "EPSG:4326"
);

CRSUtil.registerBuiltins();
const bounds = CRSUtil.projectBoundsToWgs84([500000, 2850000, 501000, 2851000], "EPSG:32650", 4);
assert.ok(bounds.flat().every(Number.isFinite));
assert.ok(bounds[0][0] < bounds[1][0]);
assert.ok(bounds[0][1] < bounds[1][1]);

const sixDegreeWithZone = CRSUtil.inferFromWkt(
  'PROJCS["CGCS2000_GK_Zone_20",GEOGCS["CGCS2000"],PROJECTION["Gauss_Kruger"],' +
  'PARAMETER["Central_Meridian",117],PARAMETER["False_Easting",20500000]]'
);
assert.strictEqual(sixDegreeWithZone.code, "EPSG:4498");
const threeDegreeWithZone = CRSUtil.inferFromWkt(
  'PROJCS["CGCS2000_3_Degree_GK_Zone_39",GEOGCS["CGCS2000"],PROJECTION["Gauss_Kruger"],' +
  'PARAMETER["Central_Meridian",117],PARAMETER["False_Easting",39500000]]'
);
assert.strictEqual(threeDegreeWithZone.code, "EPSG:4527");
const threeDegreeCm = CRSUtil.inferFromWkt(
  'PROJCS["CGCS2000_3_Degree_GK_CM_117E",GEOGCS["CGCS2000"],PROJECTION["Gauss_Kruger"],' +
  'PARAMETER["Central_Meridian",117],PARAMETER["False_Easting",500000]]'
);
assert.strictEqual(threeDegreeCm.code, "EPSG:4548");

const sixA = CRSUtil.toWgs84(20500000, 2850000, "EPSG:4498");
const sixB = CRSUtil.toWgs84(500000, 2850000, "EPSG:4509");
assert.ok(Math.abs(sixA[0] - sixB[0]) < 1e-9 && Math.abs(sixA[1] - sixB[1]) < 1e-9);
const threeA = CRSUtil.toWgs84(39500000, 2850000, "EPSG:4527");
const threeB = CRSUtil.toWgs84(500000, 2850000, "EPSG:4548");
assert.ok(Math.abs(threeA[0] - threeB[0]) < 1e-9 && Math.abs(threeA[1] - threeB[1]) < 1e-9);

console.log("OK projection.js");
