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

console.log("OK amap.js");
