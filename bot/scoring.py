from math import asin, cos, exp, radians, sin, sqrt

EARTH_RADIUS_KM = 6371.0088
WORLD_MAP_SCALE_KM = 1492.7


def score_guess(
    guess_lat: float, guess_lon: float, target_lat: float, target_lon: float
) -> tuple[float, int]:
    lat1, lat2 = radians(guess_lat), radians(target_lat)
    d_lat, d_lon = lat2 - lat1, radians(target_lon - guess_lon)
    h = sin(d_lat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(d_lon / 2) ** 2
    distance = 2 * EARTH_RADIUS_KM * asin(sqrt(min(1.0, max(0.0, h))))
    return distance, round(5000 * exp(-distance / WORLD_MAP_SCALE_KM))
