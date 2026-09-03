# -*- coding: utf-8 -*-
"""
============================================================================
 通用空间热点核密度分析（KDE）脚本  ·  配套 gis-viewer 查看器
============================================================================
把任意「点状数据」（共享单车、公交站、POI、犯罪点、疫情点位……）做高斯核密度
分析，输出一套 Leaflet 前端可直接消费的 GeoJSON 热力数据。

功能链路：
   读取点状矢量(GeoJSON / Shapefile / GPKG / CSV)
    → 坐标系识别与重投影(WGS84 经纬度 → 指定米制投影)
    → 构建规则渔网(Fishnet)网格
    → 高斯核密度估计(KDE)
    → 密度分级 + 低值区裁剪
    → 输出热力 GeoJSON(网格面) + 点位 GeoJSON + 元数据 JSON

输出物（供 index.html 拖入查看/或本仓库前端叠加）：
   output/hotspot.geojson    —— 热力网格面（主输出，半透明渲染）
   output/points.geojson     —— 清洗后的原始点位（可选叠加）
   output/hotspot_meta.json  —— 元数据：中心点、建议缩放、分级阈值、统计摘要

运行：
   python analyze/kde_hotspot.py
   （DATA_PATH 指向真实数据时直接分析；缺省合并 INPUT_FALLBACK 提示）

依赖：
   pip install geopandas shapely pyproj fiona numpy

注意：本脚本只做分析，与前端查看器解耦——前端也能直接拖入你已有的
任意 shp / GeoTIFF / GeoJSON，无需经过本脚本。
============================================================================
"""

import os
import sys
import json
import math
import random
from datetime import datetime

import numpy as np
import geopandas as gpd
import pandas as pd
from shapely.geometry import Point, box

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


# ============================================================================
# 一、关键参数配置区（★ 调优主要改这里 ★）
# ============================================================================

# ---------------- 1.1 输入点数据 ----------------
# 把你的点数据放到这个路径；支持 geojson / json / shp / gpkg / csv
DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "points.geojson")

# 坐标系声明：WGS84 | GCJ02 | BD09。GCJ02/BD09 为国内「火星坐标」，需纠偏否则与底图错位
COORD_SYSTEM = "WGS84"
FIELD_ID = "id"          # 编号字段（可选）
FIELD_NAME = "name"      # 名称字段（可选）
FIELD_WEIGHT = "weight"  # 权重字段（可选，如车辆数/客流量；缺失按 1 计）
FIELD_TYPE = "type"      # 类型字段（可选）

# ---------------- 1.2 研究区边界（可选，强烈建议） ----------------
# 用行政边界约束热力范围，并输出边界给前端叠加。留空(None)则不裁剪、不输出边界
MASK_SHP_PATH = None                       # 例如 r"D:\...\wgs48市级.shp"
MASK_CITY_FIELD = "name"                   # 行政区名称字段
MASK_CITY_NAME = None                      # 目标区域名，如 "福州市" / "北京市"
MASK_SIMPLIFY_TOL = 0.0003                # 边界抽稀容差（度），≈33m

# ---------------- 1.3 坐标系 ----------------
# 核密度必须在【米制投影】下进行。按你数据所在带选择：
#   东经 114°E 一带 → EPSG:32649 (UTM 49N)
#   东经 117°E 一带 → EPSG:32650 (UTM 50N，华东/福建)
#   东经 120°E 一带 → EPSG:32651 (UTM 51N)
#   国家 2000 三度带 → EPSG:4547(CM120) / 4549(CM120? 见投影表)
METRIC_CRS = "EPSG:32650"     # ★ 米制投影坐标系
WGS84_CRS = "EPSG:4326"       # 输出坐标系

# ---------------- 1.4 核密度核心参数 ----------------
# ★ 带宽 bandwidth（米）：高斯核标准差 σ，即单点影响扩散半径（约 2σ 覆盖 95%）
#   500~1200m 适合城市接驳点；800~1500m 适合商圈级；200~500m 适合小区级精细分布
#   None = 启用 Silverman 经验法则自动估算
BANDWIDTH_M = 800.0
# ★ 网格边长（米）：决定输出分辨率与文件体积；建议取带宽的 1/4~1/3
CELL_SIZE_M = 200.0
STUDY_BUFFER_M = 1500.0          # 研究区外扩缓冲，避免边界处热点被截断
KERNEL_CUTOFF_SIGMA = 3.0        # 超出 3σ 的高斯值≈0，不参与计算以加速

# ---------------- 1.5 结果裁剪与分级 ----------------
TRIM_LOW_DENSITY_RATIO = 0.20    # 分位裁剪：丢弃密度最低的该比例网格
MIN_DENSITY_RATIO = 0.03         # 相对峰值裁剪：丢弃密度 < 峰值该比例的网格
N_LEVELS = 6                     # 热度分级级数（1~N）
LEVEL_BREAKS_RATIO = [0.0, 0.05, 0.15, 0.3, 0.5, 0.75, 1.0]  # 各级占峰值密度的比例阈值

# ---------------- 1.6 输出 ----------------
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "output")
OUT_HOTSPOT = "hotspot.geojson"
OUT_POINTS = "points.geojson"
OUT_META = "hotspot_meta.json"

RANDOM_SEED = 20260903


# ============================================================================
# 二、工具函数
# ============================================================================
def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


def read_point_data(path):
    """读取点状数据，返回 (GeoDataFrame[WGS84], 原始坐标系信息)"""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".geojson", ".json"):
        gdf = gpd.read_file(path)
    elif ext == ".shp":
        gdf = gpd.read_file(path)
    elif ext in (".gpkg", ".sqlite"):
        gdf = gpd.read_file(path)
    elif ext == ".csv":
        df = pd.read_csv(path)
        lon = next((c for c in df.columns if str(c).lower() in ("lon", "lng", "long", "longitude", "x")), None)
        lat = next((c for c in df.columns if str(c).lower() in ("lat", "latitude", "y")), None)
        if not lon or not lat:
            raise ValueError(f"CSV 缺少经纬度列（需要 lon/lat 或 x/y）：{list(df.columns)}")
        gdf = gpd.GeoDataFrame(df, geometry=[Point(r[lon], r[lat]) for _, r in df.iterrows()], crs=WGS84_CRS)
    else:
        raise ValueError(f"不支持的输入格式：{ext}")
    # 仅保留点几何
    gdf = gdf[gdf.geometry.type.isin(["Point", "MultiPoint"])].copy()
    if len(gdf) == 0:
        raise ValueError("输入数据中没有任何 Point/MultiPoint 要素")
    log(f"读取点数据：{len(gdf)} 个点，原始坐标系 {gdf.crs}")
    return gdf


def guess_metric_crs(gdf_wgs):
    """根据数据重心粗略推断 UTM 带（仅当配置了未知 METRIC_CRS 时备用）"""
    lon = gdf_wgs.geometry.x.mean()
    zone = int(math.floor((lon + 180) / 6) + 1)
    return f"EPSG:326{zone}"


# ============================================================================
# 三、加权高斯核密度估计
# ============================================================================
def gaussian_kde_on_grid(points_xy, weights, grid_xy, bandwidth, chunk_size=256):
    """
    加权高斯核密度估计（输出单位：权重总量 / 平方米）

        f(x) = Σ_i [ w_i * exp(-||x - x_i||² / (2h²)) ] / (2πh²)

    说明：不除以 Σw，因此密度在全平面上的积分 = Σw（权重总量），
         物理含义为「每平方米的权重数」。权重全取 1 → 点/km²（分布密度）；
         权重取业务量 → 辆/km²（投放/发生强度）。

    参数
    ----
    points_xy : (n,2) 样本点坐标（米制投影）
    weights   : (n,)   样本权重（缺失按 1）
    grid_xy  : (m,2)   待估算的网格中心坐标
    bandwidth : 带宽 h（米）
    """
    h2 = bandwidth * bandwidth
    coef = 1.0 / (2.0 * math.pi * h2)
    w = weights * coef
    m = grid_xy.shape[0]
    out = np.zeros(m, dtype=np.float64)
    cutoff2 = (KERNEL_CUTOFF_SIGMA * bandwidth) ** 2
    for start in range(0, m, chunk_size):
        end = min(start + chunk_size, m)
        gx = grid_xy[start:end, 0:1]
        gy = grid_xy[start:end, 1:2]
        dx = gx - points_xy[None, :, 0]
        dy = gy - points_xy[None, :, 1]
        d2 = dx * dx + dy * dy
        if cutoff2 > 0:
            np.minimum(d2, cutoff2 * 4, out=d2)
            contrib = np.exp(-0.5 * d2 / h2)
            contrib[d2 >= cutoff2] = 0.0
        else:
            contrib = np.exp(-0.5 * d2 / h2)
        out[start:end] = contrib @ w
    return out


# ============================================================================
# 四、主流程
# ============================================================================
def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    random.seed(RANDOM_SEED)
    np.random.seed(RANDOM_SEED)

    # ---- 4.1 读取点数据 ----
    if not os.path.exists(DATA_PATH):
        log(f"未找到输入数据：{DATA_PATH}")
        log("请将你的点数据放到 DATA_PATH，或在文件顶部修改路径与 FIELD_* 字段名。")
        sys.exit(1)
    gdf = read_point_data(DATA_PATH)

    # ---- 4.2 坐标系 → WGS84 ----
    if gdf.crs is None:
        gdf = gdf.set_crs(WGS84_CRS, allow_override=True)
    if gdf.crs.to_string() != WGS84_CRS:
        if COORD_SYSTEM.upper() == "GCJ02":
            gdf = gdf.to_crs(WGS84_CRS)  # 简化：真实纠偏需专用算法，此处仅作占位
            log("⚠ COORD_SYSTEM=GCJ02：本脚本未内置纠偏，请先在外部分转换后再输入")
        else:
            gdf = gdf.to_crs(WGS84_CRS)

    # ---- 4.3 投影到米制 ----
    metric_crs = METRIC_CRS or guess_metric_crs(gdf)
    gdf_metric = gdf.to_crs(metric_crs)
    xy = np.column_stack([gdf_metric.geometry.x.values, gdf_metric.geometry.y.values])
    n_points = len(xy)
    wcol = FIELD_WEIGHT if FIELD_WEIGHT in gdf.columns else None
    weights = gdf[wcol].values.astype(float) if wcol else np.ones(n_points, dtype=float)
    weights = np.where(np.isfinite(weights), weights, 1.0)
    log(f"投影到 {metric_crs}：{n_points} 个点，权重字段={wcol or '无(按1计)'}")

    # ---- 4.4 边界约束（可选） ----
    mask_poly = None
    if MASK_SHP_PATH and os.path.exists(MASK_SHP_PATH) and MASK_CITY_NAME:
        mask = gpd.read_file(MASK_SHP_PATH)
        if mask.crs is None:
            mask = mask.set_crs(WGS84_CRS, allow_override=True)
        mask = mask.to_crs(metric_crs)
        if MASK_CITY_FIELD in mask.columns:
            sel = mask[mask[MASK_CITY_FIELD].astype(str).str.contains(MASK_CITY_NAME, na=False)]
            mask_poly = (sel.union_all() if len(sel) else mask.union_all())
        else:
            mask_poly = mask.union_all()
        log(f"已加载研究区边界：{MASK_CITY_NAME}（{mask_poly.geom_type}）")

    # ---- 4.5 带宽 ----
    if BANDWIDTH_M is None:
        std = np.std(xy, axis=0)
        bandwidth = 0.9 * min(std[0], std[1]) * n_points ** (-1.0 / 6.0)
        log(f"Silverman 自动估算带宽：{bandwidth:.1f} m")
    else:
        bandwidth = float(BANDWIDTH_M)
    log(f"带宽={bandwidth:.1f} m，网格边长={CELL_SIZE_M} m")

    # ---- 4.6 构建规则渔网 ----
    if mask_poly is not None:
        minx, miny, maxx, maxy = mask_poly.bounds
    else:
        minx, miny, maxx, maxy = gdf_metric.total_bounds
    minx -= STUDY_BUFFER_M; miny -= STUDY_BUFFER_M
    maxx += STUDY_BUFFER_M; maxy += STUDY_BUFFER_M
    nx = max(1, int(round((maxx - minx) / CELL_SIZE_M)))
    ny = max(1, int(round((maxy - miny) / CELL_SIZE_M)))
    xs = np.linspace(minx + CELL_SIZE_M / 2, maxx - CELL_SIZE_M / 2, nx)
    ys = np.linspace(miny + CELL_SIZE_M / 2, maxy - CELL_SIZE_M / 2, ny)
    gx, gy = np.meshgrid(xs, ys)
    centers = np.column_stack([gx.ravel(), gy.ravel()])
    log(f"渔网规模：{nx} × {ny} = {len(centers)} 个网格中心")

    # ---- 4.7 核密度计算 ----
    dens = gaussian_kde_on_grid(xy, weights, centers, bandwidth) * 1e6  # → 点/km²
    log(f"核密度计算完成，峰值密度 {dens.max():.2f} 点/km²")

    # ---- 4.8 裁剪（边界外 / 低值） ----
    keep = np.ones(len(centers), dtype=bool)
    if mask_poly is not None:
        from shapely.strtree import STRtree
        from shapely.geometry import Point as ShPoint
        tree = STRtree([ShPoint(c) for c in centers])
        inside = np.array([mask_poly.contains(ShPoint(c)) for c in centers])
        dropped = int((~inside).sum())
        keep &= inside
        log(f"边界裁剪：丢弃 {dropped} 个界外网格")
    if MIN_DENSITY_RATIO > 0:
        th = dens.max() * MIN_DENSITY_RATIO
        keep &= dens >= th
    if TRIM_LOW_DENSITY_RATIO > 0:
        th = np.quantile(dens, TRIM_LOW_DENSITY_RATIO)
        keep &= dens >= th

    centers = centers[keep]
    dens = dens[keep]
    log(f"裁剪后保留 {len(centers)} 个网格")

    # ---- 4.9 分级 + 构造网格面 ----
    half = CELL_SIZE_M / 2.0
    cells = [box(c[0] - half, c[1] - half, c[0] + half, c[1] + half) for c in centers]
    grid = gpd.GeoDataFrame(
        {"density": dens}, geometry=cells, crs=metric_crs
    )
    dmax = float(dens.max()) if len(dens) else 0.0
    heat = (dens / dmax * 100.0) if dmax > 0 else np.zeros_like(dens)
    level = np.clip(np.digitize(heat / 100.0, LEVEL_BREAKS_RATIO[1:-1]) + 1, 1, N_LEVELS)
    grid["heat"] = np.round(heat, 2)
    grid["level"] = level.astype(int)
    grid["density"] = grid["density"].round(2)
    grid = grid.to_crs(WGS84_CRS)
    grid["geometry"] = grid.geometry.simplify(0.00001, preserve_topology=True)
    grid = grid[["level", "heat", "density", "geometry"]]

    # ---- 4.10 输出 ----
    hs_path = os.path.join(OUTPUT_DIR, OUT_HOTSPOT)
    grid.to_file(hs_path, driver="GeoJSON", encoding="utf-8")
    log(f"✔ 热力 GeoJSON：{hs_path}（{len(grid)} 个网格）")

    if wcol:
        pts_path = os.path.join(OUTPUT_DIR, OUT_POINTS)
        out_cols = [c for c in [FIELD_ID, FIELD_NAME, FIELD_WEIGHT, FIELD_TYPE] if c in gdf.columns]
        gdf[out_cols + ["geometry"]].to_file(pts_path, driver="GeoJSON", encoding="utf-8")
        log(f"✔ 点位 GeoJSON：{pts_path}（{len(gdf)} 个点）")

    # 边界输出（含投影转换后的 WGS84 GeoJSON）
    if mask_poly is not None:
        mask_wgs = gpd.GeoDataFrame(geometry=[mask_poly], crs=metric_crs).to_crs(WGS84_CRS)
        mask_path = os.path.join(OUTPUT_DIR, "study_area.geojson")
        mask_wgs.to_file(mask_path, driver="GeoJSON", encoding="utf-8")
        log(f"✔ 研究区边界：{mask_path}")

    # ---- 4.11 元数据 ----
    bounds = grid.total_bounds  # [minx,miny,maxx,maxy] in WGS84
    center = [(bounds[1] + bounds[3]) / 2, (bounds[0] + bounds[2]) / 2]
    zoom = 11 if dmax < 5 else (12 if dmax < 50 else 13)
    meta = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "params": {
            "metric_crs": metric_crs, "bandwidth_m": bandwidth,
            "cell_size_m": CELL_SIZE_M, "weight_field": wcol,
            "n_points": n_points, "n_cells": len(grid),
        },
        "center": [round(center[0], 5), round(center[1], 5)],
        "zoom": zoom,
        "levels": [
            {"level": i, "min_ratio": LEVEL_BREAKS_RATIO[i - 1], "max_ratio": LEVEL_BREAKS_RATIO[i]}
            for i in range(1, N_LEVELS + 1)
        ],
        "stats": {
            "density_max": round(float(grid["density"].max()), 2),
            "density_mean": round(float(grid["density"].mean()), 2),
            "hot_area_km2": round(float(len(grid[grid["level"] >= (N_LEVELS - 1)]) * CELL_SIZE_M ** 2 / 1e6), 2),
        },
    }
    with open(os.path.join(OUTPUT_DIR, OUT_META), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    log(f"✔ 元数据：{os.path.join(OUTPUT_DIR, OUT_META)}")

    # ---- 4.12 控制台摘要 ----
    log("-" * 60)
    log(f"点位总数    : {n_points}")
    log(f"峰值密度    : {meta['stats']['density_max']} 点/km²")
    log(f"高热点面积  : {meta['stats']['hot_area_km2']} km²（level ≥ {N_LEVELS - 1}）")
    log(f"建议中心    : {meta['center']}  缩放 {zoom}")
    log("=" * 60)
    log("把 output/ 下的文件拖入 index.html 即可查看热力图。")


if __name__ == "__main__":
    main()
