/* =============================================================================
 * amap.js —— 高德 JS API 2.0 底图适配器
 *
 * 高德使用 GCJ-02，业务数据在主应用中仍保持 WGS84。适配器只转换并同步两个
 * 地图引擎的视图中心；Leaflet 继续负责数据图层、交互、坐标显示与导出。
 * ========================================================================== */
(function (global) {
  "use strict";

  const STORAGE_KEY = "gis-viewer.amap-config.v1";
  const LOADER_ID = "gis-amap-jsapi-loader";
  const LOADER_URL = "https://webapi.amap.com/loader.js";
  const A = 6378245.0;
  const EE = 0.00669342162296594323;

  let sdkPromise = null;
  let loadedSignature = null;
  let amapInstance = null;
  let activeContainer = null;

  function text(value) { return String(value == null ? "" : value).trim(); }

  function normalizeConfig(input) {
    const source = input || {};
    const config = {
      key: text(source.key),
      securityJsCode: text(source.securityJsCode),
      serviceHost: text(source.serviceHost).replace(/\/+$/, "")
    };
    if (!config.key) throw new Error("请填写高德 Web JS API Key");
    if (config.serviceHost) {
      let url;
      try { url = new URL(config.serviceHost); } catch (_) {
        throw new Error("安全代理地址不是有效 URL");
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("安全代理地址必须使用 http 或 https");
      }
      if (!/\/_AMapService$/i.test(url.pathname.replace(/\/+$/, ""))) {
        throw new Error("安全代理地址必须以 /_AMapService 结尾");
      }
      config.serviceHost = url.toString().replace(/\/+$/, "");
      config.securityJsCode = "";
    } else if (!config.securityJsCode) {
      throw new Error("请填写安全密钥，或填写服务端安全代理地址");
    }
    return config;
  }

  function configSignature(config) {
    return JSON.stringify(normalizeConfig(config));
  }

  function getStorage() {
    try { return global.localStorage || null; } catch (_) { return null; }
  }

  function getConfig() {
    const storage = getStorage();
    if (!storage) return null;
    try {
      const value = storage.getItem(STORAGE_KEY);
      return value ? normalizeConfig(JSON.parse(value)) : null;
    } catch (_) {
      return null;
    }
  }

  function getSiteConfig() {
    const root = global.GIS_VIEWER_CONFIG;
    const source = root && root.amap;
    if (!source) return null;

    const hasPublicValue = Boolean(text(source.key) || text(source.serviceHost));
    const exposedSecret = text(source.securityJsCode);
    if (!hasPublicValue && !exposedSecret) return null;
    if (exposedSecret) {
      throw new Error("站点公开配置中不能填写 securityJsCode，请把它保存在安全代理端");
    }
    return normalizeConfig({ key: source.key, serviceHost: source.serviceHost });
  }

  function getEffectiveConfig() {
    return getSiteConfig() || getConfig();
  }

  function saveConfig(input) {
    const config = normalizeConfig(input);
    const storage = getStorage();
    if (!storage) throw new Error("当前浏览器不允许保存高德配置");
    storage.setItem(STORAGE_KEY, JSON.stringify(config));
    return config;
  }

  function clearConfig() {
    const storage = getStorage();
    if (storage) storage.removeItem(STORAGE_KEY);
  }

  function buildSecurityConfig(config) {
    const normalized = normalizeConfig(config);
    return normalized.serviceHost
      ? { serviceHost: normalized.serviceHost }
      : { securityJsCode: normalized.securityJsCode };
  }

  function outOfChina(lng, lat) {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  }

  function transformLat(lng, lat) {
    let value = -100 + 2 * lng + 3 * lat + 0.2 * lat * lat +
      0.1 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng));
    value += (20 * Math.sin(6 * lng * Math.PI) + 20 * Math.sin(2 * lng * Math.PI)) * 2 / 3;
    value += (20 * Math.sin(lat * Math.PI) + 40 * Math.sin(lat / 3 * Math.PI)) * 2 / 3;
    value += (160 * Math.sin(lat / 12 * Math.PI) + 320 * Math.sin(lat * Math.PI / 30)) * 2 / 3;
    return value;
  }

  function transformLng(lng, lat) {
    let value = 300 + lng + 2 * lat + 0.1 * lng * lng +
      0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng));
    value += (20 * Math.sin(6 * lng * Math.PI) + 20 * Math.sin(2 * lng * Math.PI)) * 2 / 3;
    value += (20 * Math.sin(lng * Math.PI) + 40 * Math.sin(lng / 3 * Math.PI)) * 2 / 3;
    value += (150 * Math.sin(lng / 12 * Math.PI) + 300 * Math.sin(lng / 30 * Math.PI)) * 2 / 3;
    return value;
  }

  function wgs84ToGcj02(lng, lat) {
    lng = Number(lng); lat = Number(lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      throw new Error("地图中心坐标无效");
    }
    if (outOfChina(lng, lat)) return [lng, lat];
    let dLat = transformLat(lng - 105, lat - 35);
    let dLng = transformLng(lng - 105, lat - 35);
    const radLat = lat / 180 * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = dLat * 180 / ((A * (1 - EE)) / (magic * sqrtMagic) * Math.PI);
    dLng = dLng * 180 / (A / sqrtMagic * Math.cos(radLat) * Math.PI);
    return [lng + dLng, lat + dLat];
  }

  function loadLoaderScript() {
    if (global.AMapLoader) return Promise.resolve(global.AMapLoader);
    if (!global.document) return Promise.reject(new Error("当前环境不能加载高德 JS API"));
    return new Promise((resolve, reject) => {
      const existing = global.document.getElementById(LOADER_ID);
      if (existing) {
        existing.addEventListener("load", () => resolve(global.AMapLoader), { once: true });
        existing.addEventListener("error", () => reject(new Error("高德 Loader 加载失败")), { once: true });
        return;
      }
      const script = global.document.createElement("script");
      script.id = LOADER_ID;
      script.src = LOADER_URL;
      script.async = true;
      script.charset = "utf-8";
      script.onload = () => global.AMapLoader
        ? resolve(global.AMapLoader)
        : reject(new Error("高德 Loader 未正确初始化"));
      script.onerror = () => {
        script.remove();
        reject(new Error("高德 Loader 加载失败，请检查网络或域名白名单"));
      };
      global.document.head.appendChild(script);
    });
  }

  function loadSdk(input) {
    const config = normalizeConfig(input);
    const signature = configSignature(config);
    if (sdkPromise && loadedSignature !== signature) {
      return Promise.reject(new Error("高德配置已变更，请刷新页面后重试"));
    }
    if (sdkPromise) return sdkPromise;
    loadedSignature = signature;
    global._AMapSecurityConfig = buildSecurityConfig(config);
    sdkPromise = loadLoaderScript()
      .then(loader => {
        if (!loader || typeof loader.load !== "function") throw new Error("高德 Loader 不可用");
        return loader.load({ key: config.key, version: "2.0", plugins: [] });
      })
      .catch(error => {
        sdkPromise = null;
        loadedSignature = null;
        throw error;
      });
    return sdkPromise;
  }

  function normalizedView(center, zoom) {
    if (!center) throw new Error("缺少地图视图中心");
    const gcj = wgs84ToGcj02(center.lng, center.lat);
    return {
      center: gcj,
      zoom: Math.max(2, Math.min(20, Number(zoom) || 4))
    };
  }

  async function show(options) {
    const opts = options || {};
    if (!global.document) throw new Error("当前环境不能显示高德地图");
    const container = global.document.getElementById(opts.containerId || "amapBase");
    if (!container) throw new Error("缺少高德地图容器");
    container.classList.add("show");
    activeContainer = container;
    const view = normalizedView(opts.center, opts.zoom);
    try {
      const AMap = await loadSdk(opts.config);
      if (!amapInstance) {
        amapInstance = new AMap.Map(container, {
          viewMode: "2D",
          center: view.center,
          zoom: view.zoom,
          zooms: [2, 20],
          animateEnable: false,
          // 容器已由 CSS 禁止指针事件；这里必须保持可移动、可缩放，
          // 否则 AMap 也会拒绝 Leaflet 发出的程序化视图同步。
          dragEnable: true,
          zoomEnable: true,
          doubleClickZoom: false,
          keyboardEnable: false,
          scrollWheel: false,
          touchZoom: false
        });
      } else {
        sync(opts.center, opts.zoom);
        if (typeof amapInstance.resize === "function") amapInstance.resize();
      }
      return amapInstance;
    } catch (error) {
      container.classList.remove("show");
      throw error;
    }
  }

  function hide() {
    if (activeContainer) activeContainer.classList.remove("show");
  }

  function sync(center, zoom) {
    if (!amapInstance) return null;
    const view = normalizedView(center, zoom);
    if (typeof amapInstance.setZoomAndCenter === "function") {
      amapInstance.setZoomAndCenter(view.zoom, view.center);
    }
    return view;
  }

  global.AMapAdapter = {
    getConfig,
    getSiteConfig,
    getEffectiveConfig,
    saveConfig,
    clearConfig,
    show,
    hide,
    sync,
    isLoaded: () => Boolean(amapInstance),
    _test: {
      normalizeConfig,
      buildSecurityConfig,
      outOfChina,
      wgs84ToGcj02,
      normalizedView
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
