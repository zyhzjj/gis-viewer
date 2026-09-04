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
- **底图切换**：Sentinel-2 影像、OSM Japan 浅色街道、标准 OSM、高德地图、无底图；高德使用官方 JS API 2.0，其余瓦片源连续失败时自动回退
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

## 高德地图配置（可选）

项目现在支持“站长统一配置”和“访客本机试用”两种模式。正式发布建议使用站长统一配置：所有访客直接使用站长的 Key，不需要各自申请；调用量也计入站长账号。

### 站长统一配置（正式发布）

1. 在高德开放平台申请 **Web端（JS API）Key** 及配套的 `securityJsCode`，并按控制台要求限制站点使用域名。当前 GitHub Pages 域名是 `zyhzjj.github.io`。
2. 在服务器、云函数或边缘函数部署高德安全代理，把 `securityJsCode` 只保存在代理的 Secret/环境变量中。代理公开地址必须以 `/_AMapService` 结尾。
3. 编辑 `assets/js/site-config.js`，只填写 Web Key 和代理地址：

```js
window.GIS_VIEWER_CONFIG = {
  amap: {
    key: "你的 Web JS API Key",
    serviceHost: "https://你的代理域名/_AMapService"
  }
};
```

`securityJsCode` **绝对不要**填入网页、GitHub 仓库或 `site-config.js`。Web Key 会出现在浏览器请求中，这是 JS API 的正常工作方式；真正需要保密的是 `securityJsCode`。未填完整站点配置时，程序会自动退回访客本机试用模式。

### 访客本机试用（备用）

点击顶部「高德」，首次使用会要求填写高德开放平台的 **Web JS API Key**，以及以下两种鉴权方式之一：

1. 本机试用：填写与 Key 配套的 `securityJsCode`。配置只保存在当前浏览器的 `localStorage`，不会提交到仓库，但明文方式不适合生产环境。
2. 使用已有代理：填写以 `/_AMapService` 结尾的安全代理地址，把 `securityJsCode` 留在服务器端。

高德采用 GCJ-02，本项目中的业务数据与导出结果继续保持 WGS84。高德模式通过 WGS84→GCJ-02 转换同步两个地图引擎的视图中心，适合浏览和展示；精密叠加核验应使用 OSM 或无底图模式。使用站长配置时，再次点击已经激活的「高德」会提示配置来源；使用本机配置时则可修改或清除。

申请与配置说明：[高德 JS API 2.0 加载](https://lbs.amap.com/api/javascript-api-v2/guide/abc/load)、[安全密钥使用](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)。

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
- 可选国内底图：[高德地图 JS API 2.0](https://lbs.amap.com/api/javascript-api-v2/summary)
- 核心解析依赖以本地副本形式放在 `assets/js/vendor/`，离线可用；高德底图需要联网和开发者 Key

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
│       ├── site-config.js # 站点公开配置（不含安全密钥）
│       ├── amap.js        # 高德 JS API 加载、鉴权配置与视图同步
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
node tests/test_amap.js
python -m unittest tests/test_kde.py
```

也可以用 `npm test` 运行全部 JavaScript 检查。Python 分析依赖可通过
`pip install -r requirements-analysis.txt` 安装。

---

## 许可证

[MIT](LICENSE)
