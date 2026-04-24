from __future__ import annotations

# Minimal Google Mapbox-style polyline precision-6 decode. Returns (lat, lng) in WGS84.
from typing import List, Tuple


def decode_path(encoded: str) -> List[Tuple[float, float]]:
    if not encoded:
        return []
    index = 0
    lat = 0
    lng = 0
    out: List[Tuple[float, float]] = []
    n = len(encoded)
    while index < n:
        b = 0
        shift = 0
        result = 0
        while True:
            b = ord(encoded[index]) - 63
            index += 1
            result |= (b & 0x1F) << shift
            shift += 5
            if b < 0x20:
                break
        dlat = ~(result >> 1) if (result & 1) else (result >> 1)
        lat += dlat
        b = 0
        shift = 0
        result = 0
        while index < n:
            b = ord(encoded[index]) - 63
            index += 1
            result |= (b & 0x1F) << shift
            shift += 5
            if b < 0x20:
                break
        dlon = ~(result >> 1) if (result & 1) else (result >> 1)
        lng += dlon
        out.append((lat * 1e-6, lng * 1e-6))
    return out
