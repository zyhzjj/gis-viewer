"use strict";

const assert = require("assert");
const path = require("path");

global.window = global;
const values = new Map();
global.localStorage = {
  getItem: key => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key)
};

require(path.join(__dirname, "..", "assets", "js", "amap.js"));

const test = AMapAdapter._test;

assert.strictEqual(AMapAdapter.getSiteConfig(), null);
global.GIS_VIEWER_CONFIG = {
  amap: {
    key: " site-key ",
    serviceHost: "https://maps.example.com/_AMapService/"
  }
};
assert.deepStrictEqual(AMapAdapter.getSiteConfig(), {
  key: "site-key",
  securityJsCode: "",
  serviceHost: "https://maps.example.com/_AMapService"
});
assert.deepStrictEqual(AMapAdapter.getEffectiveConfig(), AMapAdapter.getSiteConfig());
global.GIS_VIEWER_CONFIG.amap.securityJsCode = "must-not-leak";
assert.throws(() => AMapAdapter.getSiteConfig(), /不能填写 securityJsCode/);
delete global.GIS_VIEWER_CONFIG;

const plaintext = test.normalizeConfig({ key: " demo-key ", securityJsCode: " demo-secret " });
assert.deepStrictEqual(plaintext, {
  key: "demo-key",
  securityJsCode: "demo-secret",
  serviceHost: ""
});
assert.deepStrictEqual(test.buildSecurityConfig(plaintext), { securityJsCode: "demo-secret" });

const proxy = test.normalizeConfig({
  key: "proxy-key",
  securityJsCode: "should-not-be-kept",
  serviceHost: "https://maps.example.com/_AMapService/"
});
assert.strictEqual(proxy.serviceHost, "https://maps.example.com/_AMapService");
assert.strictEqual(proxy.securityJsCode, "");
assert.deepStrictEqual(test.buildSecurityConfig(proxy), {
  serviceHost: "https://maps.example.com/_AMapService"
});

assert.throws(() => test.normalizeConfig({ securityJsCode: "x" }), /Key/);
assert.throws(() => test.normalizeConfig({ key: "x" }), /安全密钥/);
assert.throws(() => test.normalizeConfig({ key: "x", serviceHost: "https://example.com/proxy" }), /_AMapService/);

AMapAdapter.saveConfig(plaintext);
assert.deepStrictEqual(AMapAdapter.getConfig(), plaintext);
assert.deepStrictEqual(AMapAdapter.getEffectiveConfig(), plaintext);
AMapAdapter.clearConfig();
assert.strictEqual(AMapAdapter.getConfig(), null);

assert.deepStrictEqual(test.wgs84ToGcj02(2.3522, 48.8566), [2.3522, 48.8566]);
const beijing = test.wgs84ToGcj02(116.397389, 39.908722);
assert.ok(beijing[0] > 116.403 && beijing[0] < 116.405);
assert.ok(beijing[1] > 39.909 && beijing[1] < 39.911);
assert.ok(Math.abs(beijing[0] - 116.397389) > 0.004);

const view = test.normalizedView({ lng: 116.397389, lat: 39.908722 }, 30);
assert.strictEqual(view.zoom, 20);
assert.deepStrictEqual(view.center, beijing);

const containerClasses = new Set();
const container = {
  classList: {
    add: value => containerClasses.add(value),
    remove: value => containerClasses.delete(value)
  }
};
let createdOptions = null;
global.document = { getElementById: id => id === "amapBase" ? container : null };
global.AMapLoader = {
  load: async () => ({
    Map: class {
      constructor(_container, options) { createdOptions = options; }
    }
  })
};

(async () => {
  await AMapAdapter.show({
    containerId: "amapBase",
    config: plaintext,
    center: { lng: 116.397389, lat: 39.908722 },
    zoom: 7
  });
  assert.strictEqual(createdOptions.dragEnable, true);
  assert.strictEqual(createdOptions.zoomEnable, true);
  assert.strictEqual(createdOptions.scrollWheel, false);
  assert.strictEqual(createdOptions.touchZoom, false);
  assert.strictEqual(containerClasses.has("show"), true);
  console.log("OK amap.js");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
