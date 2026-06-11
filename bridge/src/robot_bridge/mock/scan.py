"""Vectorized ray-cast LiDAR scan synthesizer (Mid-360-like FOV).

Per frame: sample N random ray directions (azimuth 0-360 deg, elevation -7..+52 deg),
intersect against the world's planes / boxes / cylinders, keep the nearest hit
within MAX_RANGE, add gaussian range noise, and return map-frame float32 (M, 4)
[x, y, z, intensity].
"""

from __future__ import annotations

import numpy as np

from .world import Box, Cylinder, Plane

MAX_RANGE = 30.0
RANGE_NOISE_SIGMA = 0.01  # 1 cm
ELEV_LO = np.deg2rad(-7.0)
ELEV_HI = np.deg2rad(52.0)
EPS = 1e-9


class ScanSynthesizer:
    def __init__(self, planes: list[Plane], boxes: list[Box], cylinders: list[Cylinder],
                 rng: np.random.Generator):
        self.planes = planes
        self.boxes = boxes
        self.cylinders = cylinders
        self.rng = rng

    def scan(self, origin: np.ndarray, n_rays: int) -> np.ndarray:
        az = self.rng.uniform(0.0, 2 * np.pi, n_rays)
        el = self.rng.uniform(ELEV_LO, ELEV_HI, n_rays)
        cos_el = np.cos(el)
        dirs = np.stack([cos_el * np.cos(az), cos_el * np.sin(az), np.sin(el)], axis=1)

        best_t = np.full(n_rays, MAX_RANGE, dtype=np.float64)
        best_i = np.zeros(n_rays, dtype=np.float64)  # intensity of best hit

        for plane in self.planes:
            self._hit_plane(origin, dirs, plane, best_t, best_i)
        for box in self.boxes:
            self._hit_box(origin, dirs, box, best_t, best_i)
        for cyl in self.cylinders:
            self._hit_cylinder(origin, dirs, cyl, best_t, best_i)

        hit = best_t < MAX_RANGE
        t = best_t[hit] + self.rng.normal(0.0, RANGE_NOISE_SIGMA, int(hit.sum()))
        pts = origin[None, :] + dirs[hit] * t[:, None]
        # mild intensity falloff with range plus a little noise
        inten = best_i[hit] * (1.0 - 0.5 * best_t[hit] / MAX_RANGE)
        inten = np.clip(inten + self.rng.normal(0.0, 0.02, inten.shape), 0.0, 1.0)
        return np.concatenate([pts, inten[:, None]], axis=1).astype(np.float32)

    @staticmethod
    def _update(best_t, best_i, t, valid, intensity):
        closer = valid & (t > EPS) & (t < best_t)
        best_t[closer] = t[closer]
        best_i[closer] = intensity

    def _hit_plane(self, origin, dirs, plane: Plane, best_t, best_i):
        a = plane.axis
        denom = dirs[:, a]
        with np.errstate(divide="ignore", invalid="ignore"):
            t = (plane.offset - origin[a]) / denom
        valid = np.abs(denom) > EPS
        pts = origin[None, :] + dirs * np.where(valid, t, 0.0)[:, None]
        for ax in range(3):
            if ax == a:
                continue
            valid &= (pts[:, ax] >= plane.bounds_lo[ax] - EPS) & \
                     (pts[:, ax] <= plane.bounds_hi[ax] + EPS)
        self._update(best_t, best_i, t, valid, plane.intensity)

    def _hit_box(self, origin, dirs, box: Box, best_t, best_i):
        # slab method, vectorized
        with np.errstate(divide="ignore", invalid="ignore"):
            inv = 1.0 / dirs
        t1 = (box.lo[None, :] - origin[None, :]) * inv
        t2 = (box.hi[None, :] - origin[None, :]) * inv
        tmin = np.nanmax(np.minimum(t1, t2), axis=1)
        tmax = np.nanmin(np.maximum(t1, t2), axis=1)
        valid = (tmax >= tmin) & (tmax > EPS)
        t = np.where(tmin > EPS, tmin, tmax)  # inside-the-box rays exit through tmax
        self._update(best_t, best_i, t, valid, box.intensity)

    def _hit_cylinder(self, origin, dirs, cyl: Cylinder, best_t, best_i):
        # infinite vertical cylinder, then clamp z to [0, height]
        ox, oy = origin[0] - cyl.center[0], origin[1] - cyl.center[1]
        dx, dy = dirs[:, 0], dirs[:, 1]
        a = dx * dx + dy * dy
        b = 2 * (ox * dx + oy * dy)
        c = ox * ox + oy * oy - cyl.radius**2
        disc = b * b - 4 * a * c
        valid = (disc >= 0) & (a > EPS)
        sqrt_disc = np.sqrt(np.where(valid, disc, 0.0))
        with np.errstate(divide="ignore", invalid="ignore"):
            t = (-b - sqrt_disc) / (2 * a)
        z = origin[2] + dirs[:, 2] * t
        valid &= (z >= 0.0) & (z <= cyl.height)
        self._update(best_t, best_i, t, valid, cyl.intensity)
