import importlib.util
import json
import math
import tempfile
import unittest
from pathlib import Path

import geopandas as gpd
import numpy as np
from shapely.geometry import Point


MODULE_PATH = Path(__file__).resolve().parents[1] / "analyze" / "kde_hotspot.py"
SPEC = importlib.util.spec_from_file_location("kde_hotspot", MODULE_PATH)
kde = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(kde)


class KdeTests(unittest.TestCase):
    def test_kde_peak_for_one_unit_point(self):
        result = kde.gaussian_kde_on_grid(
            np.array([[0.0, 0.0]]), np.array([1.0]), np.array([[0.0, 0.0]]), 100.0
        )
        self.assertAlmostEqual(result[0], 1.0 / (2.0 * math.pi * 100.0 ** 2), places=12)

    def test_gcj_and_bd_conversion(self):
        lon, lat = kde.gcj02_to_wgs84(119.306, 26.075)
        self.assertTrue(0.0001 < abs(lon - 119.306) < 0.02)
        self.assertTrue(0.0001 < abs(lat - 26.075) < 0.02)
        self.assertEqual(kde.gcj02_to_wgs84(-73.98, 40.75), (-73.98, 40.75))
        bd_lon, bd_lat = kde.bd09_to_wgs84(119.3125, 26.081)
        self.assertTrue(0.001 < abs(bd_lon - 119.3125) < 0.03)
        self.assertTrue(0.001 < abs(bd_lat - 26.081) < 0.03)

    def test_multipoint_is_exploded(self):
        payload = {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "properties": {"weight": 2},
                "geometry": {"type": "MultiPoint", "coordinates": [[119.3, 26.0], [119.4, 26.1]]},
            }],
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "points.geojson"
            path.write_text(json.dumps(payload), encoding="utf-8")
            frame = kde.read_point_data(path)
        self.assertEqual(len(frame), 2)
        self.assertTrue((frame.geometry.type == "Point").all())

    def test_utm_guess_handles_both_hemispheres(self):
        north = gpd.GeoDataFrame(geometry=[Point(119.3, 26.1)], crs="EPSG:4326")
        south = gpd.GeoDataFrame(geometry=[Point(151.2, -33.9)], crs="EPSG:4326")
        self.assertEqual(kde.guess_metric_crs(north), "EPSG:32650")
        self.assertEqual(kde.guess_metric_crs(south), "EPSG:32756")


if __name__ == "__main__":
    unittest.main()
