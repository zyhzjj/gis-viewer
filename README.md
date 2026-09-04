# GIS Viewer · 浏览器端空间数据查看器

纯浏览器端的 GIS 数据查看器：**拖入任意 Shapefile / GeoTIFF / GeoJSON / CSV，立刻在地图上看到结果**，无需任何后端服务、无需数据库、无需联网（底图除外）。

---

## 功能

- **拖拽即显示**：把文件拖到地图上，或点「导入数据」选择文件，支持多选。
- **矢量格式**
  - Shapefile：`.shp`+`.dbf`+`.prj`（可附 `.cpg` 字符编码文件，多文件一起拖入），或打包好的 `.zip`
  - GeoJSON / JSON
  - CSV（自动识别 `lon/lat` 或 `x/y` 经纬度列）
- **栅格格式**
  - GeoTIFF：`.tif` / `.tiff`，单波段自动 2%~98% 拉伸 + 色带，多波段 RGB 合成，NoData 透明
- **坐标系识别与重投影**
  - 从 `.prj` / GeoTIFF 元数据中读取 EPSG，识别不了时弹窗让你手选
  - 内置国内常用坐标系（CGCS2000 三度带/六度带、UTM、WGS84 等），自动重投影到 WGS84 叠加到在线底图上
- **图层管理**：开关、透明度、颜色、删除、缩放到范围；点要素可查看属性表
- **图层导出**：矢量图层导出为 UTF-8 CSV（含 WGS84 坐标与 GeoJSON 几何），栅格图层导出为带 WGS84 地理参考的渲染预览 TIFF
- **底图切换**：Sentinel-2 影像、OSM Japan 浅色街道、标准 OSM、无底图；影像可叠加透明路网，瓦片源连续失败时自动回退
- **配套分析脚本**：`analyze/kde_hotspot.py` 对任意点数据做高斯核密度热点分析，输出热力 GeoJSON 供前端叠加

---

## 快速开始

**方式一：直接打开**
双击 `index.html` 即可导入本地文件。文件由浏览器 File API 读取，不需要额外的数据服务；在线底图和未内置 EPSG 定义的查询仍需要联网。

**方式二：本地服务器（推荐，体验最完整）**
```bash
cd gis-viewer
python -m http.server 8080
# 浏览器打开 http://localhost:8080/index.html
```

---

## 数据格式支持

| 类型 | 格式 | 备注 |
|------|------|------|
| 矢量 | `.shp` + `.dbf` + `.prj` + 可选 `.cpg` | 多文件一起拖入（或打包 `.zip`） |
| 矢量 | `.geojson` / `.json` | 标准 GeoJSON，默认 WGS84 |
| 矢量 | `.csv` | 需含经纬度列（lon/lat、x/y、经度/纬度 等） |
| 栅格 | `.tif` / `.tiff` | GeoTIFF，含地理坐标与坐标系信息 |

导出说明：CSV 中的 `__longitude` / `__latitude` 仅对点要素填写，线和面通过 `__geometry_geojson` 保留完整几何。栅格导出的是当前拉伸和色带生成的画布像元配色（保留 NoData 透明，但不叠加图层显示透明度），并带 EPSG:4326 地理范围；它用于交流和预览，不能替代保留原始科学像元值的 GeoTIFF。

**坐标系说明**：Shapefile 的坐标本身不带坐标系含义，写在同名的 `.prj` 文件里。若缺少 `.prj`，地图会提示你手动选择数据实际使用的坐标系——选错会导致整体偏移，拿不准时先选「不做转换」看形状是否正确。

---

## 核密度热点分析（可选）

适合把「点状数据」变成「热力分布」。脚本与前端解耦，不用它也能直接拖入已有数据。

```bash
# 1. 把你的点数据放到 data/points.geojson（或改 analyze/kde_hotspot.py 顶部的 DATA_PATH）
# 2. 修改顶部参数（INPUT_CRS、COORD_SYSTEM、带宽、网格、研究区边界等）
# 3. 运行
python analyze/kde_hotspot.py
# 生成 output/hotspot.geojson、output/points.geojson、output/hotspot_meta.json
# 把 output/ 拖进 index.html 即可查看热力图
```

输入点数据要求：几何为 Point/MultiPoint；坐标系建议 WGS84；可选权重字段（如车辆数、客流量）。

`COORD_SYSTEM` 可设为 `WGS84`、`GCJ02` 或 `BD09`。输入文件缺少 CRS、或 CSV 使用投影 `x/y` 坐标时，请通过 `INPUT_CRS` 明确指定 EPSG 编号。

---

## 精度与规模说明

- 矢量数据会逐坐标重投影到 WGS84。
- 投影 GeoTIFF 当前用于快速预览：程序会加密采样边界后计算 WGS84 外接矩形，但不会逐像元重采样。旋转栅格、大范围栅格或强非线性投影，建议先用 GDAL/QGIS 重投影到 EPSG:4326。
- 超大矢量仍受浏览器内存和单线程渲染能力限制；数万要素以上建议先抽稀或切片。
- 未内置的 EPSG 定义会尝试从 epsg.io 查询；完全离线时可从常用列表手动选择内置坐标系。

---

## 技术栈

- 地图渲染：[Leaflet](https://leafletjs.com/)
- 矢量解析：[shpjs](https://github.com/calvinmetcalf/shapefile-js)（含 JSZip 解包）
- 坐标系：[Proj4js](https://proj4js.org/)
- 栅格解析：[GeoTIFF.js](https://geotiffjs.github.io/)
- 所有依赖以本地副本形式放在 `assets/js/vendor/`，离线可用

---

## 目录结构

```
gis-viewer/
├── index.html              # 前端入口
├── package.json            # JavaScript 回归检查入口
├── requirements-analysis.txt # Python 分析依赖
├── assets/
│   ├── css/               # 样式
│   └── js/
│       ├── projection.js  # 坐标系识别与重投影
│       ├── loader.js      # 多格式空间数据解析
│       ├── app.js         # 地图、图层管理、属性查看
│       └── vendor/        # 第三方库本地副本
├── analyze/
│   └── kde_hotspot.py     # 通用核密度热点分析脚本
├── data/                  # 你的数据放这里（可选）
├── output/                # 分析结果输出
└── tests/                 # JavaScript / Python 回归检查
```

---

## 回归检查

```bash
node tests/test_projection.js
node tests/test_loader.js
python -m unittest tests/test_kde.py
```

也可以用 `npm test` 运行全部 JavaScript 检查。Python 分析依赖可通过
`pip install -r requirements-analysis.txt` 安装。

---

## 许可证

[MIT](LICENSE)
