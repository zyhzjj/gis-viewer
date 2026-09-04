/* =============================================================================
 *  loader.js —— 多格式空间数据解析
 *
 *  纯浏览器端解析，无需任何后端服务（这是整个项目能直接托管到 GitHub Pages
 *  的前提）。支持：
 *
 *   矢量：Shapefile（.shp + .dbf + .prj，或打包成 .zip）、GeoJSON、CSV
 *   栅格：GeoTIFF（.tif / .tiff）
 *
 *  解析产物统一为 dataset 对象，交由 app.js 建图层：
 *    { id, name, kind:'vector'|'raster', geojson|raster, crs, crsName,
 *      crsSource, featureCount, geomTypes, warnings[] }
 *
 *  注意：若坐标系无法自动确定，dataset.crs 会置为 null 且
 *  crsSource='unknown'，由上层弹窗让用户手动指定后再重投影。
 * ========================================================================== */
(function (global) {
  "use strict";

  let seq = 0;
  const uid = () => `lyr_${++seq}_${Date.now().toString(36)}`;

  /* ------------------------------ 工具函数 ------------------------------ */
  const extOf = name => (name.split(".").pop() || "").toLowerCase();
  const baseOf = name => name.replace(/\.[^.]+$/, "");

  /** 计算数组的 2% / 98% 分位数（大数组自动抽样，避免卡顿） */
  function percentileRange(arr, nodata) {
    const n = arr.length;
    if (!n) return [0, 1];
    const step = Math.max(1, Math.floor(n / 200000));   // 最多抽 20 万个样本
    const sample = [];
    const nd = nodata === null || nodata === undefined ? null : Number(nodata);
    for (let i = 0; i < n; i += step) {
      const v = arr[i];
      if (Number.isFinite(v) && (nd === null || v !== nd)) sample.push(v);
    }
    if (!sample.length) return [0, 1];
    sample.sort((a, b) => a - b);
    const q = p => sample[Math.min(sample.length - 1, Math.max(0, Math.floor(p * sample.length)))];
    let lo = q(0.02), hi = q(0.98);
    if (hi <= lo) { lo = sample[0]; hi = sample[sample.length - 1]; }
    if (hi <= lo) hi = lo + 1;
    return [lo, hi];
  }

  /** 生成 256 级色带查找表 */
  const RAMPS = {
    gray:    [[0, 0, 0], [255, 255, 255]],
    heat:    [[49, 54, 149], [69, 117, 180], [116, 173, 209], [171, 217, 233], [224, 243, 248],
              [254, 224, 144], [253, 174, 97], [244, 109, 67], [215, 48, 39], [165, 0, 38]],
    viridis: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
    terrain: [[26, 102, 168], [70, 168, 205], [134, 208, 165], [212, 226, 155],
              [236, 216, 154], [185, 154, 105], [148, 109, 78], [255, 255, 255]],
    ndvi:    [[165, 0, 38], [215, 48, 39], [244, 109, 67], [253, 174, 97], [254, 224, 144],
              [224, 243, 248], [171, 217, 233], [116, 173, 209], [69, 117, 180], [49, 54, 149]]
  };
  function buildLUT(rampName) {
    const stops = RAMPS[rampName] || RAMPS.gray;
    const lut = new Uint8Array(256 * 3);
    const seg = stops.length - 1;
    for (let i = 0; i < 256; i++) {
      const t = i / 255 * seg;
      const k = Math.min(seg - 1, Math.floor(t));
      const f = t - k;
      for (let c = 0; c < 3; c++) {
        lut[i * 3 + c] = Math.round(stops[k][c] * (1 - f) + stops[k + 1][c] * f);
      }
    }
    return lut;
  }
  const RAMP_NAMES = { gray: "灰度", heat: "热力", viridis: "Viridis", terrain: "地形", ndvi: "NDVI(红绿反转)" };

  /* =========================================================================
   *  一、Shapefile 解析
   * ======================================================================= */
  function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error(`读取失败：${file.name}`));
      r.readAsArrayBuffer(file);
    });
  }
  function readAsText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error(`读取失败：${file.name}`));
      r.readAsText(file, "utf-8");
    });
  }

  /** 把多文件拖入的 shp / dbf / prj 按主文件名配对 */
  function groupShapefiles(files) {
    const groups = {};
    files.forEach(f => {
      const ext = extOf(f.name);
      if (!["shp", "dbf", "prj", "shx", "cpg", "sbn", "sbx", "xml"].includes(ext)) return;
      const key = baseOf(f.name).toLowerCase();
      (groups[key] = groups[key] || {})[ext] = f;
    });
    return Object.values(groups).filter(g => g.shp);
  }

  /** 从已读取的二进制/文本缓冲区解析一个 Shapefile（可被 zip 复用） */
  async function parseShpFromBuffers({ shpBuf, dbfBuf, prjText, cpgText, name }) {
    const warnings = [];
    let geojson = null;
    // shpjs 的调用链：parseShp → 几何数组，parseDbf → 属性数组，combine → 合成
    // 注意 combine 接收的是【已解析的数组】，不是原始 ArrayBuffer（传 buffer 会得到 0 要素）
    const geoms = await shp.parseShp(shpBuf);
    if (!Array.isArray(geoms)) throw new Error("Shapefile 几何解析失败");
    let props = [];
    if (dbfBuf) {
      try {
        props = await shp.parseDbf(dbfBuf, cpgText ? cpgText.trim() : undefined);
      } catch (e) {
        warnings.push(`属性表(.dbf)读取失败（${e.message}），仅显示几何`);
        props = [];
      }
    } else {
      warnings.push("缺少 .dbf 文件，要素将没有属性字段");
    }
    if (!Array.isArray(props)) props = [];
    geojson = shp.combine([geoms, props]);

    // combine 可能返回数组（多图层）或单个 FeatureCollection
    if (Array.isArray(geojson)) {
      const merged = geojson.filter(Boolean);
      geojson = { type: "FeatureCollection", features: merged.flatMap(g => g.features || []) };
      if (merged.length > 1) warnings.push(`该文件包含 ${merged.length} 个子图层，已合并显示`);
    }
    if (!geojson || !geojson.type) throw new Error("Shapefile 解析结果不是合法的 GeoJSON");
    if (!geojson.features) geojson = { type: "FeatureCollection", features: [] };

    // 坐标系：优先 .prj 里的 EPSG 编号，其次关键字推断
    let crs = null, crsName = "", crsSource = "unknown";
    if (prjText) {
      const code = CRSUtil.parseEpsgFromWkt(prjText);
      if (code) {
        const ok = await CRSUtil.ensureDef(code);
        crs = code;
        crsName = code;
        crsSource = ok ? "prj" : "prj-undefined";
        if (!ok) warnings.push(`检测到坐标系 ${code}，但缺少转换参数，请手动指定`);
      } else {
        const inf = CRSUtil.inferFromWkt(prjText);
        if (inf) {
          const ok = await CRSUtil.ensureDef(inf.code);
          crs = inf.code; crsName = inf.name;
          crsSource = ok ? "inferred" : "inferred-undefined";
          if (!inf.confident) warnings.push(`根据 .prj 推断为 ${inf.name}，请确认是否正确`);
        } else {
          warnings.push("无法识别 .prj 中的坐标系，请手动指定");
        }
      }
    } else {
      warnings.push("缺少 .prj 文件，无法确定坐标系，请手动指定");
    }

    return { geojson, crs, crsName, crsSource, warnings };
  }

  /** 从多文件拖入的 shp 组（File 对象）解析 */
  async function parseShapefileGroup(group) {
    const shpBuf = await readAsArrayBuffer(group.shp);
    const dbfBuf = group.dbf ? await readAsArrayBuffer(group.dbf) : null;
    const prjText = group.prj ? await readAsText(group.prj) : null;
    const cpgText = group.cpg ? await readAsText(group.cpg) : null;
    return parseShpFromBuffers({ shpBuf, dbfBuf, prjText, cpgText, name: group.shp.name });
  }

  /** zip 包（内含 shp 全套，含 .prj） */
  async function parseZip(file) {
    const buf = await readAsArrayBuffer(file);
    const zip = await JSZip.loadAsync(buf);
    // 收集同名主文件的 .shp/.dbf/.prj（忽略路径差异）
    const byBase = {};
    zip.forEach((path, entry) => {
      const name = path.split("/").pop();
      const ext = extOf(name);
      if (!["shp", "dbf", "prj", "shx", "cpg"].includes(ext)) return;
      const key = baseOf(name).toLowerCase();
      (byBase[key] = byBase[key] || {})[ext] = entry;
    });
    const entries = Object.values(byBase).filter(g => g.shp);
    if (!entries.length) throw new Error("zip 中未找到 Shapefile（.shp）");

    const warnings = [];
    let merged = { type: "FeatureCollection", features: [] };
    let crs = null, crsName = "", crsSource = "unknown";
    const crsCodes = new Set();
    let hasUnresolvedCrs = false;

    for (const grp of entries) {
      // 用 uint8array 而非 arraybuffer：避免个别环境下 Blob→ArrayBuffer 的异步转换卡死，
      // 且 shpjs 的 parseShp/parseDbf 同样接受 Uint8Array。
      const shpBuf = await grp.shp.async("uint8array");
      const dbfBuf = grp.dbf ? await grp.dbf.async("uint8array") : null;
      const prjText = grp.prj ? await grp.prj.async("string") : null;
      const cpgText = grp.cpg ? await grp.cpg.async("string") : null;
      const r = await parseShpFromBuffers({ shpBuf, dbfBuf, prjText, cpgText, name: file.name });
      merged.features = merged.features.concat(r.geojson.features || []);
      if (r.crs) {
        crsCodes.add(r.crs);
        crs = r.crs; crsName = r.crsName; crsSource = r.crsSource;
      }
      if (!r.crs || String(r.crsSource || "").endsWith("-undefined")) hasUnresolvedCrs = true;
      warnings.push(...r.warnings);
    }
    if (!merged.features.length) throw new Error("zip 中的 Shapefile 解析结果为空");
    if (crsCodes.size > 1) throw new Error(`zip 中包含不同坐标系：${[...crsCodes].join("、")}，请分别导入`);
    if (hasUnresolvedCrs) {
      crs = null; crsName = ""; crsSource = "unknown";
      warnings.push("压缩包内至少一个图层缺少可用坐标系，请确认所有图层使用同一 CRS 后手动指定");
    }
    return { geojson: merged, crs, crsName, crsSource, warnings };
  }

  /* =========================================================================
   *  二、GeoJSON 解析
   * ======================================================================= */
  async function parseGeoJSON(file) {
    const txt = (await readAsText(file)).replace(/^\uFEFF/, "");
    let gj;
    try {
      gj = JSON.parse(txt);
    } catch (e) {
      // 兼容换行分隔的 GeoJSON（NDJSON）
      const lines = txt.split(/\r?\n/).filter(l => l.trim());
      try {
        gj = { type: "FeatureCollection", features: lines.map(l => JSON.parse(l)) };
      } catch (e2) {
        throw new Error("不是合法的 GeoJSON：" + e.message);
      }
    }
    let crs = "EPSG:4326", crsName = "WGS 84 经纬度（GeoJSON 规范默认）", crsSource = "default";
    const warnings = [];
    if (gj.crs) {
      // 老版 GeoJSON 的 crs 字段
      const m = JSON.stringify(gj.crs).match(/(\d{4,6})/);
      if (m) {
        const code = "EPSG:" + m[1];
        if (await CRSUtil.ensureDef(code)) { crs = code; crsName = code; crsSource = "geojson-crs"; }
        else {
          crs = code; crsName = code; crsSource = "geojson-crs-undefined";
          warnings.push(`GeoJSON 声明坐标系 ${code}，但缺少转换参数，请手动指定`);
        }
      }
    }
    if (gj.type === "Feature") {
      gj = { type: "FeatureCollection", features: [gj] };
    } else if (gj.type !== "FeatureCollection" && gj.type && (gj.coordinates || gj.geometries)) {
      gj = { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: gj }] };
    }
    if (gj.type !== "FeatureCollection" || !Array.isArray(gj.features)) {
      throw new Error("GeoJSON 顶层必须是 FeatureCollection、Feature 或 Geometry");
    }
    return { geojson: gj, crs, crsName, crsSource, warnings };
  }

  /* =========================================================================
   *  三、CSV 解析（自动识别经纬度列）
   * ======================================================================= */
  const LON_KEYS = ["lon", "lng", "long", "longitude", "x", "经度", "经度(度)", "lond", "center_lon"];
  const LAT_KEYS = ["lat", "latitude", "y", "纬度", "纬度(度)", "latd", "center_lat"];

  /** RFC 4180 风格的轻量分隔文本解析，支持引号、转义引号和单元格内换行。 */
  function parseDelimitedRows(txt, delim) {
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < txt.length; i++) {
      const ch = txt[i];
      if (quoted) {
        if (ch === '"' && txt[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"' && field.length === 0) {
        quoted = true;
      } else if (ch === delim) {
        row.push(field); field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && txt[i + 1] === "\n") i++;
        row.push(field); rows.push(row);
        row = []; field = "";
      } else {
        field += ch;
      }
    }
    if (quoted) throw new Error("CSV/文本文件存在未闭合的引号");
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function detectDelimiter(txt) {
    const choices = [",", "\t", ";", "|"];
    const counts = new Map(choices.map(d => [d, 0]));
    let quoted = false;
    for (let i = 0; i < txt.length; i++) {
      const ch = txt[i];
      if (ch === '"') {
        if (quoted && txt[i + 1] === '"') i++;
        else quoted = !quoted;
      } else if (!quoted && (ch === "\r" || ch === "\n")) {
        break;
      } else if (!quoted && counts.has(ch)) {
        counts.set(ch, counts.get(ch) + 1);
      }
    }
    return choices.reduce((best, d) => counts.get(d) > counts.get(best) ? d : best, ",");
  }

  async function parseCSV(file) {
    const txt = (await readAsText(file)).replace(/^\uFEFF/, "");
    const warnings = [];
    const delim = detectDelimiter(txt);
    const rows = parseDelimitedRows(txt, delim).filter(r => r.some(v => v.trim() !== ""));
    if (rows.length < 2) throw new Error("CSV 内容为空或只有表头");
    const header = rows[0].map(h => h.trim().replace(/^"|"$/g, ""));
    const li = header.findIndex(h => LON_KEYS.includes(h.toLowerCase()));
    const la = header.findIndex(h => LAT_KEYS.includes(h.toLowerCase()));

    const lonIdx = li, latIdx = la;
    if (lonIdx < 0 || latIdx < 0) throw new Error("无法识别经纬度列，请确认表头包含 lon/lat 或 x/y");

    const xKey = header[lonIdx] ? header[lonIdx].trim().toLowerCase() : "";
    const yKey = header[latIdx] ? header[latIdx].trim().toLowerCase() : "";
    const projectedXY = xKey === "x" || yKey === "y";
    if (projectedXY) warnings.push("检测到 x/y 坐标列，无法仅凭列名判断坐标系，请手动选择");

    const features = [];
    let skipped = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const lonRaw = r[lonIdx] === undefined ? "" : String(r[lonIdx]).trim();
      const latRaw = r[latIdx] === undefined ? "" : String(r[latIdx]).trim();
      const lon = lonRaw === "" ? NaN : Number(lonRaw);
      const lat = latRaw === "" ? NaN : Number(latRaw);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) ||
          (!projectedXY && (lon < -180 || lon > 180 || lat < -90 || lat > 90))) {
        skipped++; continue;
      }
      const props = {};
      header.forEach((h, c) => { if (c !== lonIdx && c !== latIdx) props[h] = r[c] === undefined ? "" : r[c]; });
      features.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [lon, lat] } });
    }
    if (skipped) warnings.push(`跳过 ${skipped} 行无法解析坐标的记录`);
    if (!features.length) throw new Error("CSV 中没有可用的坐标记录");
    return {
      geojson: { type: "FeatureCollection", features },
      crs: projectedXY ? null : "EPSG:4326",
      crsName: projectedXY ? "" : "WGS 84 经纬度（假定）",
      crsSource: projectedXY ? "unknown" : "default",
      warnings
    };
  }

  /* =========================================================================
   *  四、GeoTIFF 解析
   * ======================================================================= */
  const MAX_RENDER_PIXELS = 2048;   // 渲染画布上限，超出则重采样，防止内存爆炸

  async function parseGeoTIFF(file) {
    const buf = await readAsArrayBuffer(file);
    const warnings = [];

    const tiff = await GeoTIFF.fromArrayBuffer(buf);
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    const samples = image.getSamplesPerPixel();
    const bbox = image.getBoundingBox();     // [minX, minY, maxX, maxY]
    const nodata = image.getGDALNoData();
    const nodataValue = nodata === null || nodata === undefined ? null : Number(nodata);
    const invalidSample = value => !Number.isFinite(value) || (nodataValue !== null && value === nodataValue);
    const fileDirectory = image.getFileDirectory ? image.getFileDirectory() : (image.fileDirectory || {});
    const transform = fileDirectory.ModelTransformation || null;
    const rotated = !!(transform && (Math.abs(transform[1] || 0) > 1e-12 || Math.abs(transform[4] || 0) > 1e-12));
    if (rotated) warnings.push("影像包含旋转/倾斜仿射变换，当前以外接矩形近似预览，不能替代专业栅格纠正");

    // 坐标系：GeoKeys 中读取 EPSG 编号
    let crs = null, crsName = "", crsSource = "unknown";
    const gk = image.geoKeys || {};
    const rawCode = gk.ProjectedCSTypeGeoKey || gk.GeographicTypeGeoKey || null;
    if (rawCode && rawCode !== 32767) {
      crs = "EPSG:" + rawCode;
      crsName = crs;
      if (!(await CRSUtil.ensureDef(crs))) {
        warnings.push(`GeoTIFF 声明坐标系 ${crs}，但缺少转换参数，请手动指定`);
        crsSource = "geotiff-undefined";
      } else crsSource = "geotiff";
    } else {
      warnings.push("GeoTIFF 未标注坐标系，请手动指定");
    }

    // 大图重采样，避免 readRasters 直接吃掉几百 MB 内存
    let rw = width, rh = height, resampled = false;
    const scale = Math.sqrt(MAX_RENDER_PIXELS * MAX_RENDER_PIXELS / (width * height));
    if (scale < 1) {
      rw = Math.max(1, Math.round(width * scale));
      rh = Math.max(1, Math.round(height * scale));
      resampled = true;
      warnings.push(`影像原始尺寸 ${width}×${height}，已重采样为 ${rw}×${rh} 显示（不影响文件本身）`);
    }

    const rasters = await image.readRasters({ width: rw, height: rh, interleave: false });
    const canvas = document.createElement("canvas");
    canvas.width = rw;
    canvas.height = rh;
    const ctx = canvas.getContext("2d");
    const imgData = ctx.createImageData(rw, rh);
    const out = imgData.data;

    const isRGB = samples >= 3;
    let stats = null;

    if (isRGB) {
      // 多波段：按 R/G/B 三波段合成（各自做 2%~98% 拉伸，遥感影像常用）
      const ranges = [];
      for (let b = 0; b < 3; b++) ranges.push(percentileRange(rasters[b], nodata));
      stats = { mode: "rgb", ranges };
      for (let i = 0; i < rw * rh; i++) {
        let r, g, bl;
        if (invalidSample(rasters[0][i]) || invalidSample(rasters[1][i]) || invalidSample(rasters[2][i])) {
          out[i * 4 + 3] = 0; continue;                 // NoData → 透明
        }
        r = (rasters[0][i] - ranges[0][0]) / (ranges[0][1] - ranges[0][0]);
        g = (rasters[1][i] - ranges[1][0]) / (ranges[1][1] - ranges[1][0]);
        bl = (rasters[2][i] - ranges[2][0]) / (ranges[2][1] - ranges[2][0]);
        out[i * 4] = Math.max(0, Math.min(255, r * 255));
        out[i * 4 + 1] = Math.max(0, Math.min(255, g * 255));
        out[i * 4 + 2] = Math.max(0, Math.min(255, bl * 255));
        out[i * 4 + 3] = 255;
      }
    } else {
      // 单波段：色带渲染 + 2%~98% 拉伸
      const range = percentileRange(rasters[0], nodata);
      stats = { mode: "single", range };
      const lut = buildLUT("gray");
      // 保留归一化值（0~255）以便后续换色带，避免反复读原始栅格
      const normData = new Uint8Array(rw * rh);
      for (let i = 0; i < rw * rh; i++) {
        const v = rasters[0][i];
        if (invalidSample(v)) { out[i * 4 + 3] = 0; normData[i] = 0; continue; }
        const t = Math.max(0, Math.min(255, (v - range[0]) / (range[1] - range[0]) * 255)) | 0;
        normData[i] = t;
        out[i * 4] = lut[t * 3];
        out[i * 4 + 1] = lut[t * 3 + 1];
        out[i * 4 + 2] = lut[t * 3 + 2];
        out[i * 4 + 3] = 255;
      }
      stats.normData = normData;
    }
    ctx.putImageData(imgData, 0, 0);

    // 把 bbox 从数据坐标系转换到 WGS84。未知 CRS 时等待上层让用户指定。
    let bounds = null;
    if (crs && crsSource !== "geotiff-undefined") {
      bounds = CRSUtil.projectBoundsToWgs84(bbox, crs);
      if (crs !== "EPSG:4326") {
        warnings.push("投影栅格当前按 WGS84 外接矩形近似显示；大范围或强非线性投影建议先离线重投影");
      }
    }

    return {
      raster: {
        canvas, bounds, sourceBounds: bbox.slice(), width, height, rw, rh,
        bands: samples, nodata, stats, resampled,
        ramp: isRGB ? null : "gray", rotated
      },
      crs, crsName, crsSource, warnings
    };
  }

  /** 用户手动指定栅格 CRS 后，重新计算 Leaflet 所需的 WGS84 显示范围。 */
  function applyRasterCRS(dataset, crs) {
    if (!dataset || !dataset.raster || !dataset.raster.sourceBounds) {
      throw new Error("栅格缺少源坐标范围");
    }
    dataset.raster.bounds = CRSUtil.projectBoundsToWgs84(dataset.raster.sourceBounds, crs);
    dataset.crs = crs;
    dataset.crsSource = "manual";
    if (crs !== "EPSG:4326" && !(dataset.warnings || []).some(w => w.includes("外接矩形近似显示"))) {
      dataset.warnings = (dataset.warnings || []).concat(
        "投影栅格当前按 WGS84 外接矩形近似显示；大范围或强非线性投影建议先离线重投影");
    }
    return dataset.raster.bounds;
  }

  /** 重新给栅格换色带（单波段时可用） */
  function recolorRaster(dataset, rampName) {
    const r = dataset.raster;
    if (!r || r.bands >= 3 || !r.stats || !r.stats.normData) return false;
    const normData = r.stats.normData;
    const ctx = r.canvas.getContext("2d");
    const img = ctx.getImageData(0, 0, r.rw, r.rh);
    const d = img.data;
    const lut = buildLUT(rampName);
    for (let i = 0; i < r.rw * r.rh; i++) {
      if (d[i * 4 + 3] === 0) continue;                  // 保持 NoData 透明
      const t = normData[i];
      d[i * 4] = lut[t * 3];
      d[i * 4 + 1] = lut[t * 3 + 1];
      d[i * 4 + 2] = lut[t * 3 + 2];
    }
    ctx.putImageData(img, 0, 0);
    r.ramp = rampName;
    return true;
  }

  /* =========================================================================
   *  五、统一入口
   * ======================================================================= */
  async function loadFiles(fileList, onProgress) {
    const files = Array.from(fileList || []);
    if (!files.length) return [];
    const datasets = [];
    const consumed = new Set();

    // 1) 先处理成组的 Shapefile（.shp + .dbf + .prj）
    const groups = groupShapefiles(files);
    for (const g of groups) {
      try {
        onProgress && onProgress(`解析 Shapefile：${g.shp.name}`);
        const r = await parseShapefileGroup(g);
        [g.shp, g.dbf, g.prj, g.shx, g.cpg, g.sbn, g.sbx, g.xml].forEach(f => f && consumed.add(f));
        datasets.push(Object.assign({
          id: uid(), name: g.shp.name, kind: "vector"
        }, r, { featureCount: r.geojson.features.length, geomTypes: collectGeomTypes(r.geojson) }));
      } catch (e) {
        datasets.push({ id: uid(), name: g.shp.name, kind: "error", error: e.message });
      }
    }

    // 2) 其余文件按类型逐个处理
    for (const f of files) {
      if (consumed.has(f)) continue;
      const ext = extOf(f.name);
      try {
        if (ext === "zip") {
          onProgress && onProgress(`解析压缩包：${f.name}`);
          const r = await parseZip(f);
          datasets.push(Object.assign({
            id: uid(), name: f.name, kind: "vector",
            featureCount: r.geojson.features.length, geomTypes: collectGeomTypes(r.geojson)
          }, r));
        } else if (ext === "geojson" || ext === "json") {
          onProgress && onProgress(`解析 GeoJSON：${f.name}`);
          const r = await parseGeoJSON(f);
          datasets.push(Object.assign({
            id: uid(), name: f.name, kind: "vector",
            featureCount: r.geojson.features.length, geomTypes: collectGeomTypes(r.geojson)
          }, r));
        } else if (ext === "csv" || ext === "txt") {
          onProgress && onProgress(`解析 CSV：${f.name}`);
          const r = await parseCSV(f);
          datasets.push(Object.assign({
            id: uid(), name: f.name, kind: "vector",
            featureCount: r.geojson.features.length, geomTypes: ["Point"]
          }, r));
        } else if (ext === "tif" || ext === "tiff") {
          onProgress && onProgress(`解析 GeoTIFF：${f.name}`);
          const r = await parseGeoTIFF(f);
          datasets.push(Object.assign({
            id: uid(), name: f.name, kind: "raster", featureCount: 1, geomTypes: ["Raster"]
          }, r));
        } else if (ext === "shp") {
          continue;                 // 已在分组阶段处理（无 dbf 也能单独解析）
        } else {
          datasets.push({
            id: uid(), name: f.name, kind: "error",
            error: `暂不支持的文件类型：.${ext}（当前支持 shp/zip/geojson/csv/tif）`
          });
        }
      } catch (e) {
        datasets.push({ id: uid(), name: f.name, kind: "error", error: e.message });
      }
    }
    return datasets;
  }

  function collectGeomTypes(geojson) {
    const s = new Set();
    (geojson.features || []).forEach(f => f && f.geometry && s.add(f.geometry.type));
    return [...s];
  }

  global.DataLoader = {
    loadFiles,
    applyRasterCRS,
    recolorRaster,
    RAMP_NAMES,
    percentileRange,
    _test: { parseDelimitedRows, detectDelimiter }
  };
})(window);
