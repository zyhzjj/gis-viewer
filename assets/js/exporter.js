/* =============================================================================
 * exporter.js —— 浏览器端图层导出
 *
 * 矢量：导出 UTF-8 CSV。点要素提供经纬度列，所有几何同时保存在
 *       __geometry_geojson 列中，因此线、面也不会丢失空间信息。
 * 栅格：导出当前画布的 RGBA 渲染结果，并写入 EPSG:4326 地理参考。
 *       这是可视化预览 TIFF，不是原始科学像元值。
 * ========================================================================== */
(function (global) {
  "use strict";

  const META_COLUMNS = ["__crs", "__geometry_type", "__longitude", "__latitude", "__geometry_geojson"];

  function normalizeValue(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") {
      try { return JSON.stringify(value); } catch (_) { return String(value); }
    }
    return String(value);
  }

  function csvCell(value) {
    const text = normalizeValue(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function safeStem(name) {
    const stem = String(name || "layer").replace(/\.[^.]+$/, "");
    return stem.replace(/[\\/:*?"<>|%]/g, "_").trim() || "layer";
  }

  function propertyColumns(features) {
    const seen = new Set();
    const columns = [];
    (features || []).forEach(feature => {
      Object.keys((feature && feature.properties) || {}).forEach(key => {
        if (!seen.has(key)) { seen.add(key); columns.push(key); }
      });
    });
    return columns;
  }

  function vectorToCsv(dataset) {
    if (!dataset || !dataset.geojson || !Array.isArray(dataset.geojson.features)) {
      throw new Error("矢量图层缺少可导出的 GeoJSON 要素");
    }
    const features = dataset.geojson.features;
    if (!features.length) throw new Error("矢量图层没有要素");
    const props = propertyColumns(features);
    const headers = META_COLUMNS.concat(props);
    const lines = [headers.map(csvCell).join(",")];

    features.forEach(feature => {
      const geometry = feature && feature.geometry ? feature.geometry : null;
      const isPoint = geometry && geometry.type === "Point" && Array.isArray(geometry.coordinates);
      const row = [
        "EPSG:4326",
        geometry ? geometry.type : "",
        isPoint ? geometry.coordinates[0] : "",
        isPoint ? geometry.coordinates[1] : "",
        geometry ? JSON.stringify(geometry) : ""
      ];
      const values = props.map(key => feature && feature.properties ? feature.properties[key] : "");
      lines.push(row.concat(values).map(csvCell).join(","));
    });

    return {
      filename: `${safeStem(dataset.name)}_wgs84.csv`,
      text: "\uFEFF" + lines.join("\r\n") + "\r\n",
      featureCount: features.length
    };
  }

  function buildGeoTiffMetadata(width, height, bounds) {
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw new Error("栅格尺寸无效");
    }
    if (!Array.isArray(bounds) || bounds.length !== 2 || !bounds[0] || !bounds[1]) {
      throw new Error("栅格缺少 WGS84 地理范围");
    }
    const south = Number(bounds[0][0]);
    const west = Number(bounds[0][1]);
    const north = Number(bounds[1][0]);
    const east = Number(bounds[1][1]);
    if (![south, west, north, east].every(Number.isFinite) || east <= west || north <= south) {
      throw new Error("栅格 WGS84 地理范围无效");
    }
    return {
      width,
      height,
      SamplesPerPixel: 4,
      BitsPerSample: [8, 8, 8, 8],
      SampleFormat: [1, 1, 1, 1],
      PhotometricInterpretation: 2,
      PlanarConfiguration: 1,
      ExtraSamples: [2],
      Compression: 1,
      GeographicTypeGeoKey: 4326,
      GTModelTypeGeoKey: 2,
      GTRasterTypeGeoKey: 1,
      GeogCitationGeoKey: "WGS 84",
      ModelPixelScale: [(east - west) / width, (north - south) / height, 0],
      ModelTiepoint: [0, 0, 0, west, north, 0],
      Software: "GIS Viewer"
    };
  }

  async function writeRgbaGeoTiff(rgba, width, height, bounds) {
    if (!global.GeoTIFF || typeof global.GeoTIFF.writeArrayBuffer !== "function") {
      throw new Error("当前 GeoTIFF 库不支持写入");
    }
    if (!rgba || rgba.length !== width * height * 4) {
      throw new Error("栅格 RGBA 数据长度与尺寸不匹配");
    }
    const metadata = buildGeoTiffMetadata(width, height, bounds);
    const buffer = await global.GeoTIFF.writeArrayBuffer(rgba, metadata);
    return { buffer, metadata };
  }

  async function rasterToGeoTiff(dataset) {
    const raster = dataset && dataset.raster;
    if (!raster || !raster.canvas) throw new Error("栅格图层缺少可导出的渲染画布");
    const width = raster.canvas.width;
    const height = raster.canvas.height;
    const ctx = raster.canvas.getContext("2d");
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const result = await writeRgbaGeoTiff(rgba, width, height, raster.bounds);
    return {
      filename: `${safeStem(dataset.name)}_preview_wgs84.tif`,
      buffer: result.buffer,
      width,
      height
    };
  }

  function downloadBlob(blob, filename) {
    if (!global.document || !global.URL || typeof global.URL.createObjectURL !== "function") {
      throw new Error("当前环境不支持浏览器下载");
    }
    const url = global.URL.createObjectURL(blob);
    const link = global.document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    global.document.body.appendChild(link);
    link.click();
    link.remove();
    global.setTimeout(() => global.URL.revokeObjectURL(url), 1000);
  }

  async function exportDataset(dataset) {
    if (!dataset) throw new Error("没有可导出的图层");
    if (dataset.kind === "vector") {
      const csv = vectorToCsv(dataset);
      downloadBlob(new Blob([csv.text], { type: "text/csv;charset=utf-8" }), csv.filename);
      return { filename: csv.filename, description: `${csv.featureCount} 个要素` };
    }
    if (dataset.kind === "raster") {
      const tiff = await rasterToGeoTiff(dataset);
      downloadBlob(new Blob([tiff.buffer], { type: "image/tiff" }), tiff.filename);
      return { filename: tiff.filename, description: `${tiff.width}×${tiff.height} 渲染预览` };
    }
    throw new Error("该图层类型暂不支持导出");
  }

  global.GISExporter = {
    exportDataset,
    vectorToCsv,
    rasterToGeoTiff,
    _test: { csvCell, safeStem, buildGeoTiffMetadata, writeRgbaGeoTiff }
  };
})(typeof window !== "undefined" ? window : globalThis);
