/* =============================================================================
 *  projection.js —— 坐标系识别与重投影
 *
 *  为什么需要这个模块：
 *    Shapefile 的坐标值本身不带坐标系含义，坐标系写在同名的 .prj 文件里。
 *    国内数据尤其混乱：CGCS2000 / 西安80 / 北京54 / 地方独立坐标系混用，
 *    且大量数据缺失 .prj。若不处理就直接画到 WGS84 底图上，会整体偏移
 *    几十米到几百米（投影坐标忘记转换时甚至会偏到地球另一边）。
 *
 *  处理策略（按优先级）：
 *    1. .prj 中能提取到 EPSG 编号 → 用内置定义或在线查询后转换
 *    2. 提取不到编号 → 从 WKT 关键字推断（ datum / 投影方式 / 中央经线）
 *    3. 都失败或没有 .prj → 弹窗让用户手动指定
 * ========================================================================== */
(function (global) {
  "use strict";

  /* ---------------------------------------------------------------------------
   * 内置 proj4 定义：覆盖国内常用坐标系，保证离线可用
   * ------------------------------------------------------------------------ */
  const BUILTIN_DEFS = {
    // —— 地理坐标系（经纬度）——
    "EPSG:4326": "+proj=longlat +datum=WGS84 +no_defs",
    // CGCS2000 与 WGS84 椭球差异极小（厘米级），用 GRS80 椭球 + 零转换参数近似
    "EPSG:4490": "+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs",
    "EPSG:4214": "+proj=longlat +ellps=krass +towgs84=15.8,-154.4,-82.3,0,0,0,0 +no_defs", // 北京54
    "EPSG:4610": "+proj=longlat +ellps=IAH76 +towgs84=0,0,0,0,0,0,0 +no_defs",             // 西安80
    // —— 投影坐标系 ——
    "EPSG:3857": "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs",
    // UTM (WGS84) 北半球 43N~53N（覆盖中国全境所在的 UTM 带）
    "EPSG:32643": "+proj=utm +zone=43 +datum=WGS84 +units=m +no_defs",
    "EPSG:32644": "+proj=utm +zone=44 +datum=WGS84 +units=m +no_defs",
    "EPSG:32645": "+proj=utm +zone=45 +datum=WGS84 +units=m +no_defs",
    "EPSG:32646": "+proj=utm +zone=46 +datum=WGS84 +units=m +no_defs",
    "EPSG:32647": "+proj=utm +zone=47 +datum=WGS84 +units=m +no_defs",
    "EPSG:32648": "+proj=utm +zone=48 +datum=WGS84 +units=m +no_defs",
    "EPSG:32649": "+proj=utm +zone=49 +datum=WGS84 +units=m +no_defs",
    "EPSG:32650": "+proj=utm +zone=50 +datum=WGS84 +units=m +no_defs",
    "EPSG:32651": "+proj=utm +zone=51 +datum=WGS84 +units=m +no_defs",
    "EPSG:32652": "+proj=utm +zone=52 +datum=WGS84 +units=m +no_defs",
    "EPSG:32653": "+proj=utm +zone=53 +datum=WGS84 +units=m +no_defs"
  };

  // CGCS2000 六度带高斯克吕格：带号坐标（东坐标含带号）
  // EPSG:4491~4501 对应 13~23 带。
  for (let zone = 13; zone <= 23; zone++) {
    const cm = zone * 6 - 3;
    BUILTIN_DEFS[`EPSG:${4491 + (zone - 13)}`] =
      `+proj=tmerc +lat_0=0 +lon_0=${cm} +k=1 +x_0=${zone * 1000000 + 500000} +y_0=0 ` +
      `+ellps=GRS80 +units=m +no_defs`;
  }
  // CGCS2000 六度带中央经线坐标（东坐标不含带号），EPSG:4502~4512。
  for (let zone = 13; zone <= 23; zone++) {
    const cm = zone * 6 - 3;
    BUILTIN_DEFS[`EPSG:${4502 + (zone - 13)}`] =
      `+proj=tmerc +lat_0=0 +lon_0=${cm} +k=1 +x_0=500000 +y_0=0 ` +
      `+ellps=GRS80 +units=m +no_defs`;
  }
  // CGCS2000 三度带高斯克吕格：带号坐标，EPSG:4513~4533。
  for (let zone = 25; zone <= 45; zone++) {
    const cm = zone * 3;
    BUILTIN_DEFS[`EPSG:${4513 + (zone - 25)}`] =
      `+proj=tmerc +lat_0=0 +lon_0=${cm} +k=1 +x_0=${zone * 1000000 + 500000} +y_0=0 ` +
      `+ellps=GRS80 +units=m +no_defs`;
  }
  // CGCS2000 三度带中央经线坐标（东坐标不含带号），EPSG:4534~4554。
  for (let zone = 25; zone <= 45; zone++) {
    const cm = zone * 3;
    BUILTIN_DEFS[`EPSG:${4534 + (zone - 25)}`] =
      `+proj=tmerc +lat_0=0 +lon_0=${cm} +k=1 +x_0=500000 +y_0=0 ` +
      `+ellps=GRS80 +units=m +no_defs`;
  }

  // 手动指定时展示给用户的常用选项
  const COMMON_CRS = [
    { code: "EPSG:4326", name: "WGS 84 经纬度（GPS、在线地图通用）" },
    { code: "EPSG:4490", name: "CGCS 2000 经纬度（国家大地坐标系）" },
    { code: "EPSG:3857", name: "Web 墨卡托（在线瓦片底图）" },
    { code: "EPSG:32649", name: "WGS 84 / UTM 49N（西北、四川西部一带）" },
    { code: "EPSG:32650", name: "WGS 84 / UTM 50N（华东、福建、广东东部）" },
    { code: "EPSG:32651", name: "WGS 84 / UTM 51N（东北、山东、江苏一带）" },
    { code: "EPSG:4509", name: "CGCS 2000 六度带 CM 117°E（不含带号）" },
    { code: "EPSG:4547", name: "CGCS 2000 三度带 CM 114°E（湖北、湖南一带）" },
    { code: "EPSG:4548", name: "CGCS 2000 三度带 CM 117°E（安徽、江西一带）" },
    { code: "EPSG:4549", name: "CGCS 2000 三度带 CM 120°E（福建、江苏南部）" },
    { code: "EPSG:4550", name: "CGCS 2000 三度带 CM 123°E（浙江东部海域）" },
    { code: "EPSG:4214", name: "北京 1954 经纬度" },
    { code: "EPSG:4610", name: "西安 1980 经纬度" }
  ];

  let registered = false;
  function registerBuiltins() {
    if (registered) return;
    Object.keys(BUILTIN_DEFS).forEach(code => proj4.defs(code, BUILTIN_DEFS[code]));
    registered = true;
  }

  /* ---------------------------------------------------------------------------
   * 从 WKT（.prj 文件内容）中提取 EPSG 编号。
   * WKT1/WKT2 会先写椭球、基准面、地理坐标系等内层对象，最外层 CRS 的
   * AUTHORITY/ID 通常位于最后，因此不能简单取遇到的第一个编号。
   * ------------------------------------------------------------------------ */
  function parseEpsgFromWkt(wkt) {
    if (!wkt) return null;
    const re = /(?:AUTHORITY|ID)\s*\[\s*["']EPSG["']\s*,\s*["']?(\d+)["']?\s*\]/gi;
    const codes = [];
    let m;
    while ((m = re.exec(wkt)) !== null) codes.push(m[1]);
    if (!codes.length) return null;
    return "EPSG:" + codes[codes.length - 1];
  }

  /* ---------------------------------------------------------------------------
   * 无法拿到编号时，从 WKT 关键字推断坐标系
   * 返回 { code, name, confident }
   * ------------------------------------------------------------------------ */
  function inferFromWkt(wkt) {
    if (!wkt) return null;
    const w = wkt.toUpperCase();

    // 投影坐标系：从中央经线 + 尺度因子反推带号
    const isTmerc = /PROJECTION\s*\[\s*["'](TRANSVERSE_MERCATOR|GAUSS_KRUGER|TMERC)/i.test(wkt);
    const lon0Match = wkt.match(/PARAMETER\s*\[\s*["'](CENTRAL_MERIDIAN|LONGITUDE_OF_CENTER)["']\s*,\s*([-\d.]+)\s*\]/i);
    const lon0 = lon0Match ? parseFloat(lon0Match[2]) : null;
    const x0Match = wkt.match(/PARAMETER\s*\[\s*["']FALSE_EASTING["']\s*,\s*([-\d.]+)\s*\]/i);
    const x0 = x0Match ? parseFloat(x0Match[1]) : null;

    let datum = "unknown";
    if (/D_CHINA_2000|CHINA_2000|CGCS2000/.test(w)) datum = "CGCS2000";
    else if (/D_WGS_1984|WGS_1984|WGS84/.test(w)) datum = "WGS84";
    else if (/D_XIAN_1980|XIAN_1980|XI\'AN 1980/.test(w)) datum = "Xian80";
    else if (/D_BEIJING_1954|BEIJING_1954/.test(w)) datum = "Beijing54";

    if (isTmerc && lon0 !== null) {
      if (datum === "CGCS2000") {
        const isThreeDegree = /3[-_ ]?DEGREE|3\s*度|三度/.test(w);
        const zone3 = Math.round(lon0 / 3);
        const zone6 = Math.round((lon0 + 3) / 6);
        const hasZonePrefix = x0 !== null && Math.abs(x0) >= 10000000;

        if (hasZonePrefix) {
          const prefixZone = Math.floor(Math.abs(x0) / 1000000);
          if (prefixZone >= 25 && prefixZone <= 45 && Math.abs(lon0 - prefixZone * 3) < 1e-6) {
            return { code: `EPSG:${4513 + (prefixZone - 25)}`,
              name: `CGCS 2000 三度带 ${prefixZone} 带（含带号）`, confident: true };
          }
          if (prefixZone >= 13 && prefixZone <= 23 && Math.abs(lon0 - (prefixZone * 6 - 3)) < 1e-6) {
            return { code: `EPSG:${4491 + (prefixZone - 13)}`,
              name: `CGCS 2000 六度带 ${prefixZone} 带（含带号）`, confident: true };
          }
        } else if (Math.abs((x0 === null ? 500000 : x0) - 500000) < 1) {
          if (isThreeDegree || Math.abs(lon0 - (zone6 * 6 - 3)) >= 1e-6) {
            if (zone3 >= 25 && zone3 <= 45 && Math.abs(lon0 - zone3 * 3) < 1e-6) {
              return { code: `EPSG:${4534 + (zone3 - 25)}`,
                name: `CGCS 2000 三度带 CM ${lon0}°E（不含带号）`, confident: true };
            }
          } else if (zone6 >= 13 && zone6 <= 23) {
            return { code: `EPSG:${4502 + (zone6 - 13)}`,
              name: `CGCS 2000 六度带 CM ${lon0}°E（不含带号）`, confident: true };
          }
        }
      }
      // UTM 带：中央经线 = 6n - 183
      const utmZone = Math.round((lon0 + 183) / 6);
      if (utmZone >= 43 && utmZone <= 53 && datum === "WGS84") {
        return {
          code: `EPSG:326${utmZone}`,
          name: `WGS 84 / UTM ${utmZone}N（CM ${lon0}°E）`,
          confident: true
        };
      }
    }

    // 只有地理坐标系信息
    if (/GEOGCS/.test(w) && !/PROJCS/.test(w)) {
      if (datum === "CGCS2000") return { code: "EPSG:4490", name: "CGCS 2000 经纬度", confident: true };
      if (datum === "WGS84") return { code: "EPSG:4326", name: "WGS 84 经纬度", confident: true };
      if (datum === "Xian80") return { code: "EPSG:4610", name: "西安 1980 经纬度", confident: false };
      if (datum === "Beijing54") return { code: "EPSG:4214", name: "北京 1954 经纬度", confident: false };
    }
    return null;
  }

  /* ---------------------------------------------------------------------------
   * 确保某个 EPSG 编号的转换定义可用；内置没有时尝试在线查询（epsg.io）
   * ------------------------------------------------------------------------ */
  async function ensureDef(code) {
    registerBuiltins();
    if (!code) return false;
    if (proj4.defs(code)) return true;
    try {
      const res = await fetch(`https://epsg.io/${code.split(":")[1]}.proj4`);
      if (res.ok) {
        const txt = (await res.text()).trim();
        if (txt && /\+proj=/.test(txt)) {
          proj4.defs(code, txt);
          return true;
        }
      }
    } catch (_) { /* 离线时忽略，交由调用方提示手动指定 */ }
    return false;
  }

  /* ---------------------------------------------------------------------------
   * 坐标转换：单点 [x, y] 从 fromCrs 转到 WGS84 经纬度
   * ------------------------------------------------------------------------ */
  function toWgs84(x, y, fromCrs) {
    if (!fromCrs || fromCrs === "EPSG:4326") return [x, y];
    const p = proj4(fromCrs, "EPSG:4326", [x, y]);
    return [p[0], p[1]];
  }

  /**
   * 把源坐标系中的轴对齐包围框转换为 WGS84 包围框。
   * 对四条边加密采样，避免只转换两个对角点时低估非线性投影的范围。
   */
  function projectBoundsToWgs84(bbox, fromCrs, segments) {
    if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error("无效的栅格包围框");
    const n = Math.max(1, Number.isFinite(segments) ? Math.floor(segments) : 16);
    const minX = bbox[0], minY = bbox[1], maxX = bbox[2], maxY = bbox[3];
    const points = [];

    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = minX + (maxX - minX) * t;
      const y = minY + (maxY - minY) * t;
      points.push(toWgs84(x, minY, fromCrs));
      points.push(toWgs84(x, maxY, fromCrs));
      points.push(toWgs84(minX, y, fromCrs));
      points.push(toWgs84(maxX, y, fromCrs));
    }

    const xs = points.map(p => p[0]).filter(Number.isFinite);
    const ys = points.map(p => p[1]).filter(Number.isFinite);
    if (!xs.length || !ys.length) throw new Error("栅格范围坐标转换失败");
    return [[Math.min(...ys), Math.min(...xs)], [Math.max(...ys), Math.max(...xs)]];
  }

  /* ---------------------------------------------------------------------------
   * 对整个 GeoJSON 做重投影（原地修改坐标数组，避免深拷贝大对象）
   * 支持 Point / LineString / Polygon / MultiPolygon 等任意嵌套深度
   * ------------------------------------------------------------------------ */
  function reprojectGeoJSON(geojson, fromCrs) {
    if (!fromCrs || fromCrs === "EPSG:4326") return geojson;
    const conv = proj4(fromCrs, "EPSG:4326");
    let n = 0;

    // 递归下降：坐标数组的最内层是 [x, y] 或 [x, y, z]
    function walk(coords) {
      if (typeof coords[0] === "number") {
        const p = conv.forward([coords[0], coords[1]]);
        coords[0] = p[0];
        coords[1] = p[1];
        n++;
        return;
      }
      for (let i = 0; i < coords.length; i++) walk(coords[i]);
    }

    function eachGeom(g) {
      if (!g) return;
      if (g.type === "GeometryCollection") {
        (g.geometries || []).forEach(eachGeom);
        return;
      }
      if (g.coordinates) walk(g.coordinates);
    }

    if (geojson.type === "FeatureCollection") {
      (geojson.features || []).forEach(f => f && f.geometry && eachGeom(f.geometry));
    } else if (geojson.type === "Feature") {
      eachGeom(geojson.geometry);
    } else {
      eachGeom(geojson);
    }
    return geojson;
  }

  global.CRSUtil = {
    COMMON_CRS,
    registerBuiltins,
    parseEpsgFromWkt,
    inferFromWkt,
    ensureDef,
    toWgs84,
    projectBoundsToWgs84,
    reprojectGeoJSON,
    hasDef: code => { registerBuiltins(); return !!proj4.defs(code); }
  };
})(window);
