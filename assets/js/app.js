/* =============================================================================
 *  app.js —— 主应用逻辑
 *
 *  职责：地图初始化、文件拖放上传、图层管理、属性查看、坐标系确认交互。
 *  数据解析交给 loader.js，坐标转换交给 projection.js。
 * ========================================================================== */
(function () {
  "use strict";

  /* =========================================================================
   *  1. 地图与底图
   * ======================================================================= */
  const map = L.map("map", {
    center: [32.5, 114.0],        // 默认视野：中国中部
    zoom: 4,
    minZoom: 2,
    maxZoom: 19,
    zoomControl: false,
    preferCanvas: true,
    attributionControl: false
  });

  // 栅格影像单独一个 pane，压在矢量之下（overlayPane=400）
  map.createPane("rasterPane");
  map.getPane("rasterPane").style.zIndex = 350;
  map.getPane("rasterPane").style.pointerEvents = "none";

  const BASEMAPS = {
    imagery: L.tileLayer(
      "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg",
      {
        maxNativeZoom: 14, maxZoom: 19,
        attribution: 'Sentinel-2 cloudless &copy; <a href="https://s2maps.eu">EOX</a>, Copernicus 2020'
      }
    ),
    osm: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }),
    none: L.tileLayer("")     // 空白底图，便于只看自己的数据
  };
  // 透明道路覆盖层，独立于底图层，可单独开关
  BASEMAPS.labels = L.tileLayer(
    "https://tiles.maps.eox.at/wmts/1.0.0/streets_3857/default/g/{z}/{y}/{x}.png",
    { maxZoom: 20, opacity: 0.8, attribution: '&copy; EOX, OpenStreetMap contributors' }
  );

  let currentBase = "imagery";
  let showLabels = true;

  function activateBase(key) {
    if (!BASEMAPS[key] || key === "labels") return;
    document.querySelectorAll("[data-base]").forEach(btn =>
      btn.classList.toggle("active", btn.dataset.base === key));
    Object.keys(BASEMAPS).forEach(k => {
      if (k !== "labels" && map.hasLayer(BASEMAPS[k])) map.removeLayer(BASEMAPS[k]);
    });
    if (key !== "none") BASEMAPS[key].addTo(map);
    currentBase = key;
    // 透明路网始终压在底图之上。
    if (showLabels && map.hasLayer(BASEMAPS.labels)) {
      map.removeLayer(BASEMAPS.labels);
      BASEMAPS.labels.addTo(map);
    }
  }

  const failureCount = {};
  const baseNames = { imagery: "影像", osm: "OSM", none: "无底图" };
  [["imagery", "影像", "osm"], ["osm", "OSM", "none"]]
    .forEach(([key, name, fallback]) => {
      BASEMAPS[key].on("tileload", () => { failureCount[key] = 0; });
      BASEMAPS[key].on("tileerror", () => {
        failureCount[key] = (failureCount[key] || 0) + 1;
        if (failureCount[key] === 3 && currentBase === key) {
          activateBase(fallback);
          toast(`${name}底图连接失败，已自动切换到${baseNames[fallback]}`, "err");
        }
      });
    });
  BASEMAPS.labels.on("tileerror", () => {
    failureCount.labels = (failureCount.labels || 0) + 1;
    if (failureCount.labels === 3 && showLabels) {
      showLabels = false;
      map.removeLayer(BASEMAPS.labels);
      document.getElementById("btnLabel").classList.remove("active");
      toast("道路覆盖层连接失败，已自动关闭", "err");
    }
  });
  BASEMAPS.labels.on("tileload", () => { failureCount.labels = 0; });

  BASEMAPS.imagery.addTo(map);
  BASEMAPS.labels.addTo(map);

  L.control.zoom({ position: "topright" }).addTo(map);
  L.control.scale({ position: "bottomright", imperial: false, maxWidth: 130 }).addTo(map);
  L.control.attribution({ position: "bottomright", prefix: false }).addTo(map);

  /* =========================================================================
   *  2. 栅格图层（自定义 Layer：直接把 canvas 铺到地理范围上）
   * ======================================================================= */
  const RasterLayer = L.Layer.extend({
    initialize(dataset) { this._ds = dataset; },

    getPane() { return map.getPane("rasterPane"); },

    onAdd() {
      const c = this._ds.raster.canvas;
      c.style.position = "absolute";
      c.style.opacity = this._ds.opacity != null ? this._ds.opacity : 0.85;
      this.getPane().appendChild(c);
      map.on("zoomend moveend viewreset resize", this._reset, this);
      this._reset();
    },

    onRemove() {
      map.off("zoomend moveend viewreset resize", this._reset, this);
      const c = this._ds.raster.canvas;
      if (c.parentNode) c.parentNode.removeChild(c);
    },

    setOpacity(o) { this._ds.raster.canvas.style.opacity = o; },

    _reset() {
      const b = L.latLngBounds(this._ds.raster.bounds);
      const nw = map.latLngToLayerPoint(b.getNorthWest());
      const se = map.latLngToLayerPoint(b.getSouthEast());
      const c = this._ds.raster.canvas;
      c.style.left = nw.x + "px";
      c.style.top = nw.y + "px";
      c.style.width = Math.max(1, se.x - nw.x) + "px";
      c.style.height = Math.max(1, se.y - nw.y) + "px";
    }
  });

  /* =========================================================================
   *  3. 全局状态
   * ======================================================================= */
  const layers = [];                 // 所有已加载图层
  const PALETTE = ["#3388ff", "#e8382f", "#f9a825", "#2e7d32", "#8e24aa",
                   "#00838f", "#ef6c00", "#5d4037", "#0277bd", "#c2185b"];
  let colorCursor = 0;
  const nextColor = () => PALETTE[colorCursor++ % PALETTE.length];

  const el = id => document.getElementById(id);
  const escapeHtml = value => String(value == null ? "" : value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));

  /* =========================================================================
   *  4. 矢量图层构建
   * ======================================================================= */
  function styleByGeom(feature, color, opacity) {
    const t = feature && feature.geometry ? feature.geometry.type : "";
    if (t === "Point" || t === "MultiPoint") {
      return { color: "#ffffff", weight: 1, opacity: 0.9, fillColor: color, fillOpacity: opacity };
    }
    if (t.indexOf("LineString") >= 0) {
      return { color: color, weight: 2, opacity: opacity + 0.15, fillOpacity: 0 };
    }
    return { color: color, weight: 1, opacity: 0.9, fillColor: color, fillOpacity: opacity * 0.75 };
  }

  function buildVectorLayer(ds) {
    const color = ds.color || (ds.color = nextColor());
    const layer = L.geoJSON(ds.geojson, {
      style: f => styleByGeom(f, color, ds.opacity != null ? ds.opacity : 0.75),
      pointToLayer: (f, ll) => L.circleMarker(ll, {
        radius: 4, color: "#ffffff", weight: 1, opacity: 0.9,
        fillColor: color, fillOpacity: ds.opacity != null ? ds.opacity : 0.85
      }),
      onEachFeature: (f, l) => {
        l.on("click", () => showProperties(ds, f));
        if (f.geometry && f.geometry.type.indexOf("Point") < 0) {
          l.on({
            mouseover: e => e.target.setStyle({ weight: 3, fillOpacity: 0.95 }),
            mouseout: e => layer.resetStyle(e.target)
          });
        }
      }
    });
    return layer;
  }

  /* =========================================================================
   *  5. 属性查看
   * ======================================================================= */
  function showProperties(ds, feature) {
    const p = feature.properties || {};
    const keys = Object.keys(p);
    let rows = keys.slice(0, 60).map(k => {
      let v = p[k];
      if (v === null || v === undefined) v = "";
      return `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`;
    }).join("");
    if (!keys.length) rows = `<tr><td class="empty">该要素没有属性字段</td></tr>`;
    if (keys.length > 60) rows += `<tr><td class="empty">… 另有 ${keys.length - 60} 个字段未显示</td></tr>`;

    const geom = feature.geometry ? feature.geometry.type : "-";
    el("propTitle").textContent = ds.name;
    el("propMeta").textContent = `${geom} · 共 ${keys.length} 个字段`;
    el("propBody").innerHTML = `<table>${rows}</table>`;
    el("propPanel").classList.add("show");
  }

  el("propClose").addEventListener("click", () => el("propPanel").classList.remove("show"));

  /* =========================================================================
   *  6. 图层面板渲染
   * ======================================================================= */
  function renderLayerList() {
    const box = el("layerList");
    if (!layers.length) {
      box.innerHTML = `<div class="empty-tip">还没有图层<br/>把 .shp / .geojson / .csv / .tif 拖进地图，或点击「导入数据」</div>`;
      el("layerCount").textContent = "0";
      return;
    }
    el("layerCount").textContent = String(layers.length);
    box.innerHTML = "";

    // 后加入的图层显示在列表最上方（与视觉叠加顺序一致）
    layers.slice().reverse().forEach(ds => {
      const item = document.createElement("div");
      item.className = "layer-item" + (ds.visible ? "" : " off");
      const isRaster = ds.kind === "raster";
      const geomLabel = (ds.geomTypes || []).join("/") || "-";
      const safeName = escapeHtml(ds.name);
      const safeGeom = escapeHtml(geomLabel);
      const safeCrs = escapeHtml(ds.crsName || "");
      const safeWarnings = (ds.warnings || []).map(escapeHtml).join("<br/>");

      item.innerHTML = `
        <div class="li-head">
          <label class="li-check">
            <input type="checkbox" ${ds.visible ? "checked" : ""} data-act="toggle" />
          </label>
          <div class="li-main">
            <div class="li-name" title="${safeName}">${safeName}</div>
            <div class="li-meta">
              <span class="tag ${isRaster ? "t-raster" : "t-vector"}">${isRaster ? "栅格" : "矢量"}</span>
              <span>${safeGeom}</span>
              <span>·</span>
              <span>${isRaster ? ds.raster.rw + "×" + ds.raster.rh : (ds.featureCount + " 要素")}</span>
            </div>
            ${ds.crsName ? `<div class="li-crs" title="坐标系：${safeCrs}">${safeCrs}</div>` : ""}
          </div>
          <div class="li-tools">
            <button data-act="zoom" title="缩放到该图层">⤢</button>
            <button data-act="del" title="移除图层">✕</button>
          </div>
        </div>
        <div class="li-body">
          <div class="li-row">
            <span>透明度</span>
            <input type="range" min="0" max="100" value="${Math.round((ds.opacity != null ? ds.opacity : 0.8) * 100)}" data-act="opacity" />
          </div>
          ${isRaster && ds.raster.bands < 3 ? `
          <div class="li-row">
            <span>色带</span>
            <select data-act="ramp">
              ${Object.entries(DataLoader.RAMP_NAMES).map(([k, n]) =>
                `<option value="${k}" ${ds.raster.ramp === k ? "selected" : ""}>${n}</option>`).join("")}
            </select>
          </div>` : ""}
          ${!isRaster ? `
          <div class="li-row">
            <span>颜色</span>
            <input type="color" value="${ds.color}" data-act="color" />
          </div>` : ""}
          ${ds.warnings && ds.warnings.length ? `
          <div class="li-warn">${safeWarnings}</div>` : ""}
        </div>`;

      // 事件绑定
      const q = sel => item.querySelector(sel);
      q('[data-act="toggle"]').addEventListener("change", e => setVisible(ds, e.target.checked));
      q('[data-act="zoom"]').addEventListener("click", () => zoomToLayer(ds));
      q('[data-act="del"]').addEventListener("click", () => removeLayer(ds));
      const op = q('[data-act="opacity"]');
      if (op) op.addEventListener("input", e => setOpacity(ds, +e.target.value / 100));
      const ramp = q('[data-act="ramp"]');
      if (ramp) ramp.addEventListener("change", e => {
        DataLoader.recolorRaster(ds, e.target.value);
        ds.leaflet._reset && ds.leaflet._reset();
      });
      const col = q('[data-act="color"]');
      if (col) col.addEventListener("input", e => setColor(ds, e.target.value));

      box.appendChild(item);
    });
  }

  function setVisible(ds, visible) {
    ds.visible = visible;
    if (visible) { if (!map.hasLayer(ds.leaflet)) ds.leaflet.addTo(map); }
    else if (map.hasLayer(ds.leaflet)) map.removeLayer(ds.leaflet);
    renderLayerList();
  }
  function setOpacity(ds, o) {
    ds.opacity = o;
    if (ds.kind === "raster") ds.leaflet.setOpacity(o);
    else ds.leaflet.setStyle(f => styleByGeom(f, ds.color, o));
  }
  function setColor(ds, c) {
    ds.color = c;
    if (ds.kind === "vector") ds.leaflet.setStyle(f => styleByGeom(f, c, ds.opacity));
  }
  function removeLayer(ds) {
    if (map.hasLayer(ds.leaflet)) map.removeLayer(ds.leaflet);
    const i = layers.indexOf(ds);
    if (i >= 0) layers.splice(i, 1);
    renderLayerList();
    updateStats();
    toast(`已移除图层：${ds.name}`);
  }
  function zoomToLayer(ds) {
    if (!ds.visible) setVisible(ds, true);
    if (ds.kind === "raster") {
      const b = ds.raster.bounds;
      if (b && b.length === 2) map.fitBounds(b, { padding: [30, 30] });
      else toast("该图层没有有效的地理范围");
      return;
    }
    const b = ds.leaflet.getBounds();
    if (b && b.isValid()) map.fitBounds(b, { padding: [30, 30] });
    else toast("该图层没有有效的地理范围");
  }

  /* =========================================================================
   *  7. 文件导入流程
   * ======================================================================= */
  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    showLoading(`正在解析 ${files.length} 个文件 …`);

    let datasets = [];
    try {
      datasets = await DataLoader.loadFiles(files, msg => showLoading(msg));
    } catch (e) {
      hideLoading(); toast("解析失败：" + e.message, "err"); return;
    }
    hideLoading();

    for (const ds of datasets) {
      if (ds.kind === "error") { toast(`${ds.name}：${ds.error}`, "err"); continue; }

      // 坐标系未确定或缺少定义 → 弹窗让用户指定
      const needsManualCRS = !ds.crs || ds.crsSource === "unknown" ||
        String(ds.crsSource || "").endsWith("-undefined");
      if (needsManualCRS) {
          const picked = await askCRS(ds);
          if (picked === null) { toast(`已跳过 ${ds.name}（未指定坐标系）`); continue; }
          ds.crs = picked.code; ds.crsName = picked.name; ds.crsSource = "manual";
      }

      if (ds.kind === "vector") {
        // 重投影到 WGS84
        try {
          if (ds.crs && ds.crs !== "EPSG:4326") {
            CRSUtil.reprojectGeoJSON(ds.geojson, ds.crs);
          }
        } catch (e) {
          toast(`${ds.name} 坐标转换失败：${e.message}`, "err");
          continue;
        }
      } else if (ds.kind === "raster") {
        try {
          if (!ds.raster.bounds || needsManualCRS) DataLoader.applyRasterCRS(ds, ds.crs);
        } catch (e) {
          toast(`${ds.name} 栅格范围转换失败：${e.message}`, "err");
          continue;
        }
      }

      // 建图层
      ds.visible = true;
      ds.opacity = ds.kind === "raster" ? 0.85 : 0.75;
      if (ds.kind === "raster") ds.leaflet = new RasterLayer(ds);
      else ds.leaflet = buildVectorLayer(ds);
      ds.leaflet.addTo(map);
      layers.push(ds);

      if (ds.kind === "vector" && ds.featureCount > 50000) {
        ds.warnings = (ds.warnings || []).concat(
          `要素数量 ${ds.featureCount.toLocaleString()}，渲染可能较慢`);
      }
      toast(`已加载：${ds.name}`);
    }

    renderLayerList();
    // 自动缩放到刚加载的数据范围
    const vis = layers.filter(d => d.visible);
    if (vis.length) {
      const target = vis[vis.length - 1];
      try { zoomToLayer(target); } catch (_) {}
    }
    updateStats();
  }

  function updateStats() {
    const f = layers.reduce((s, d) => s + (d.kind === "vector" ? (d.featureCount || 0) : 0), 0);
    el("statFeatures").textContent = f.toLocaleString();
    el("statLayers").textContent = String(layers.length);
  }

  /* =========================================================================
   *  8. 坐标系选择对话框
   * ======================================================================= */
  function askCRS(ds) {
    return new Promise(resolve => {
      const modal = el("crsModal");
      const sel = el("crsSelect");
      sel.innerHTML = CRSUtil.COMMON_CRS
        .map((c, i) => `<option value="${escapeHtml(c.code)}" ${i === 0 ? "selected" : ""}>${escapeHtml(c.name)}</option>`)
        .join("") + `<option value="__none__">不做转换（按文件原坐标直接显示）</option>
                     <option value="__custom__">手动输入 EPSG 编号 …</option>`;

      el("crsFile").textContent = ds.name;
      el("crsHint").innerHTML = (ds.warnings && ds.warnings.length)
        ? ds.warnings.map(escapeHtml).join("<br/>")
        : "该文件没有明确的坐标系信息，请选择数据实际使用的坐标系。";
      modal.classList.add("show");

      function cleanup() {
        modal.classList.remove("show");
        el("crsOk").removeEventListener("click", onOk);
        el("crsSkip").removeEventListener("click", onSkip);
      }
      function onSkip() { cleanup(); resolve(null); }
      function onOk() {
        const v = sel.value;
        cleanup();
        if (v === "__none__") resolve({ code: "EPSG:4326", name: "未转换（原坐标）" });
        else if (v === "__custom__") {
          const code = prompt("请输入 EPSG 编号（例如 4549、32650）：", "4326");
          if (!code) { resolve(null); return; }
          const match = code.trim().toUpperCase().match(/^(?:EPSG:)?(\d{3,6})$/);
          if (!match) { alert("EPSG 编号格式无效，请输入纯数字或 EPSG:数字"); resolve(null); return; }
          const full = "EPSG:" + match[1];
          CRSUtil.ensureDef(full).then(ok => {
            if (!ok) { alert(`无法获取 ${full} 的转换参数，将按原坐标显示`); resolve({ code: "EPSG:4326", name: "未转换（参数缺失）" }); }
            else resolve({ code: full, name: full });
          });
        } else {
          const c = CRSUtil.COMMON_CRS.find(x => x.code === v);
          resolve({ code: v, name: c ? c.name : v });
        }
      }
      el("crsOk").addEventListener("click", onOk);
      el("crsSkip").addEventListener("click", onSkip);
    });
  }

  /* =========================================================================
   *  9. 交互：拖放 / 按钮 / 底图 / 坐标
   * ======================================================================= */
  const drop = el("dropZone");
  ["dragenter", "dragover"].forEach(ev =>
    window.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("on"); }));
  ["dragleave", "drop"].forEach(ev =>
    window.addEventListener(ev, e => { e.preventDefault(); if (ev === "drop" || e.target === document.documentElement) drop.classList.remove("on"); }));
  window.addEventListener("drop", e => {
    e.preventDefault();
    drop.classList.remove("on");
    if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });
  el("btnImport").addEventListener("click", () => el("fileInput").click());
  el("fileInput").addEventListener("change", e => { handleFiles(e.target.files); e.target.value = ""; });

  // 底图切换
  document.querySelectorAll("[data-base]").forEach(btn => {
    btn.addEventListener("click", () => activateBase(btn.dataset.base));
  });
  el("btnLabel").addEventListener("click", () => {
    showLabels = !showLabels;
    el("btnLabel").classList.toggle("active", showLabels);
    if (showLabels) BASEMAPS.labels.addTo(map); else map.removeLayer(BASEMAPS.labels);
  });

  // 坐标显示
  map.on("mousemove", e => {
    el("cLon").textContent = e.latlng.lng.toFixed(5);
    el("cLat").textContent = e.latlng.lat.toFixed(5);
  });
  map.on("zoomend", () => { el("cZoom").textContent = map.getZoom(); });
  el("cZoom").textContent = map.getZoom();

  /* =========================================================================
   * 10. 提示与遮罩
   * ======================================================================= */
  let toastTimer = null;
  function toast(msg, type) {
    const t = el("toast");
    t.textContent = msg;
    t.className = "toast show" + (type === "err" ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = "toast"; }, 4200);
  }
  function showLoading(msg) { el("loadingMsg").textContent = msg; el("loading").classList.add("show"); }
  function hideLoading() { el("loading").classList.remove("show"); }

  /* =========================================================================
   * 11. 启动
   * ======================================================================= */
  CRSUtil.registerBuiltins();
  renderLayerList();
  updateStats();

  // 供调试使用
  window.__gis = { map, layers, handleFiles };
})();
