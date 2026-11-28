from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import threading
import re
import requests
import os
import math
from datetime import datetime
import time
import hashlib
from difflib import SequenceMatcher

import pandas as pd


# ============================================================
# EXISTING SAFEROUTE SERVICES
# ============================================================

from lighting_service import calculate_route_lighting
from traffic_service import calculate_route_traffic
from weather_service import calculate_route_weather
from crime_service import calculate_route_crime


# ============================================================
# V1 DEEP LEARNING MODEL
# ============================================================

from v1_model_service import predict_route_safety
from route_feedback_service import make_route_key, get_route_rating, save_route_rating
from location_share_service import router as location_share_router


# ============================================================
# FASTAPI
# ============================================================

app = FastAPI()

app.include_router(location_share_router)


# ============================================================
# CORS
# ============================================================

FRONTEND_URL = os.getenv("FRONTEND_URL")

app.add_middleware(
    CORSMiddleware,

    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        *([FRONTEND_URL] if FRONTEND_URL else [])
    ],

    allow_credentials=True,

    allow_methods=["*"],

    allow_headers=["*"],
)


# ============================================================
# URLs
# ============================================================

GRAPHOPPER_URL = os.getenv(
    "GRAPHOPPER_URL",
    "http://localhost:8989/route"
)

GRAPHHOPPER_API_KEY = os.getenv(
    "GRAPHHOPPER_API_KEY",
    ""
)

GEOCODING_URL = (
    "https://nominatim.openstreetmap.org/search"
)

OPEN_METEO_URL = (
    "https://api.open-meteo.com/v1/forecast"
)


# ============================================================
# PATHS
# ============================================================

BASE_DIR = os.path.dirname(
    os.path.abspath(__file__)
)


TRAINING_DATA_PATH = os.path.join(
    BASE_DIR,
    "datasets",
    "training",
    "route_safety_dataset_cleaned.csv"
)


CRIME_DATA_PATH = os.path.join(
    BASE_DIR,
    "datasets",
    "crime",
    "ap_district_city_crime_2026_project.csv"
)


# ============================================================
# LOAD TRAINING DATA
#
# Used only for the emergency-access baseline because the
# trained V1 model expects:
#
# nearest_police_km
# nearest_hospital_km
# emergency_access_score
#
# These values are not currently returned by your live API.
# ============================================================

print("\nLoading SafeRoute training dataset...")

try:

    training_df = pd.read_csv(
        TRAINING_DATA_PATH
    )

    print(
        "Training dataset loaded:",
        len(training_df),
        "rows"
    )

except Exception as error:

    print(
        "Training dataset loading error:",
        error
    )

    training_df = pd.DataFrame()


# ============================================================
# LOAD PROJECT CRIME DATASET
#
# This contains the individual crime fields needed by V1.
# ============================================================

print("\nLoading SafeRoute crime dataset...")

try:

    crime_df = pd.read_csv(
        CRIME_DATA_PATH
    )

    print(
        "Crime dataset loaded:",
        len(crime_df),
        "rows"
    )

except Exception as error:

    print(
        "Crime dataset loading error:",
        error
    )

    crime_df = pd.DataFrame()


# ============================================================
# REQUEST MODEL
# ============================================================

class RouteRequest(BaseModel):

    source: str

    destination: str

    # Optional current GPS origin as [latitude, longitude].
    # When supplied, this takes priority over geocoding the source text.
    source_coordinates: list[float] | None = None

    # Number of distinct routes requested by the frontend (1 to 10).
    max_routes: int = 10

    excluded_route_keys: list[str] = []


class RouteRatingRequest(BaseModel):

    route_key: str
    rating: float
    comment: str = ""
    source: str = ""
    destination: str = ""


class RerouteRequest(BaseModel):

    latitude: float

    longitude: float

    destination_latitude: float

    destination_longitude: float


# ============================================================
# GEOCODING
# ============================================================

GEOCODING_CACHE = {}
GEOCODING_LOCK = threading.Lock()
LAST_GEOCODING_REQUEST = 0.0

# Andhra Pradesh search-area bias for Nominatim.
# Format: west, north, east, south
AP_VIEWBOX = "76.7,19.2,84.8,12.5"

# Manual fallback for the confirmed Yellayapalli village.
# These are approximate village-level coordinates, not a house address.
# Verify the snapped point on the map before using this in production.
YELLAYAPALLI_COORDINATES = (14.06048, 79.301944)

VILLAGE_COORDINATES = {
    "yellayapalli": YELLAYAPALLI_COORDINATES,
    "yellaiahpalli": YELLAYAPALLI_COORDINATES,
    "yallayapalli": YELLAYAPALLI_COORDINATES,
    "yellayapalli mw": YELLAYAPALLI_COORDINATES,
}


def normalize_geocoding_name(value):
    """Normalize a place name for spelling-tolerant matching."""
    value = str(value or "").strip().lower()
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def get_spelling_variants(place_name):
    """Create common transliteration variants without a manual place dictionary.

    Examples:
      Tirupathi -> Tirupati
      Thirupathi -> Tirupati
      Tirupathy -> Tirupaty / Tirupati-like matching

    The original spelling is always searched as well.
    """
    original = str(place_name or "").strip()
    # Only the first comma-separated part is the actual place name. Remaining
    # parts (mandal/district/state) are retained as search context separately.
    place_part = original.split(",", 1)[0].strip()
    normalized = normalize_geocoding_name(place_part)

    variants = [place_part]
    canonical = normalized

    # Common Indian-English transliteration differences.
    replacements = [
        (r"^th", "t"),
        (r"th", "t"),
        (r"dh", "d"),
        (r"ph", "p"),
        (r"bh", "b"),
        (r"kh", "k"),
        (r"sh", "s"),
        (r"aa", "a"),
        (r"ee", "i"),
        (r"oo", "u"),
        (r"iy", "i"),
        (r"y$", "i"),
    ]

    for pattern, replacement in replacements:
        canonical = re.sub(pattern, replacement, canonical)

    if canonical and canonical != normalized:
        variants.append(canonical)

    # Also try a compact spelling to handle spaces/hyphens in village names.
    compact = normalized.replace(" ", "")
    if compact and compact not in variants:
        variants.append(compact)

    # Preserve any supplied administrative context while keeping requests few.
    context = original.split(",", 1)[1].strip() if "," in original else ""
    queries = []
    for variant in variants:
        queries.append(f"{variant}, {context}" if context else variant)
        queries.append(
            f"{variant}, Andhra Pradesh, India"
        )

    # Nominatim public endpoint should not be hammered. A small, deduplicated
    # set of spelling attempts is enough for this fallback geocoder.
    return list(dict.fromkeys(q for q in queries if q))[:4]


def _place_name_similarity(query_name, result):
    """Compare the requested name with names returned by Nominatim."""
    query = normalize_geocoding_name(query_name)
    address = result.get("address", {}) or {}

    candidate_names = [
        result.get("name", ""),
        result.get("display_name", "").split(",")[0],
        address.get("village", ""),
        address.get("town", ""),
        address.get("city", ""),
        address.get("hamlet", ""),
        address.get("municipality", ""),
        address.get("suburb", ""),
        address.get("county", ""),
    ]

    best = 0.0
    for candidate in candidate_names:
        candidate = normalize_geocoding_name(candidate)
        if not candidate:
            continue
        if candidate == query:
            return 1.0
        score = SequenceMatcher(None, query, candidate).ratio()
        # Token comparison helps when the geocoder includes a suffix/prefix.
        query_tokens = set(query.split())
        candidate_tokens = set(candidate.split())
        if query_tokens and candidate_tokens:
            token_score = len(query_tokens & candidate_tokens) / len(query_tokens | candidate_tokens)
            score = max(score, token_score)
        best = max(best, score)
    return best


def get_coordinates(place_name):
    global LAST_GEOCODING_REQUEST

    if not place_name or not str(place_name).strip():
        return None

    place_name = str(place_name).strip()
    normalized_name = normalize_geocoding_name(place_name)

    # 1. Keep the project's verified Yellayapalli fallback.
    for alias, coordinates in VILLAGE_COORDINATES.items():
        if normalized_name == alias or normalized_name.startswith(alias + " "):
            print(
                f"Using SafeRoute village fallback: {place_name} "
                f"-> {coordinates}"
            )
            return coordinates

    # 2. Cache successful lookups by normalized input.
    cache_key = normalized_name
    if cache_key in GEOCODING_CACHE:
        print(f"Geocoding cache hit: {place_name}")
        return GEOCODING_CACHE[cache_key]

    # 3. Search original spelling and common transliteration variants.
    queries = get_spelling_variants(place_name)
    requested_place = place_name.split(",", 1)[0].strip()
    headers = {
        # Configure SAFEROUTE_CONTACT_EMAIL with a real project contact email.
        "User-Agent": (
            "SafeRouteFinder/1.0 "
            f"(contact: {os.getenv('SAFEROUTE_CONTACT_EMAIL', 'contact-not-configured')})"
        )
    }

    best_match = None
    best_score = 0.0

    for query in queries:
        params = {
            "q": query,
            "format": "jsonv2",
            "limit": 8,
            "countrycodes": "in",
            "viewbox": AP_VIEWBOX,
            "addressdetails": 1,
        }

        try:
            # Respect Nominatim's public-service rate limit.
            with GEOCODING_LOCK:
                wait_time = 1.1 - (time.time() - LAST_GEOCODING_REQUEST)
                if wait_time > 0:
                    time.sleep(wait_time)

                response = requests.get(
                    GEOCODING_URL,
                    params=params,
                    headers=headers,
                    timeout=20,
                )
                LAST_GEOCODING_REQUEST = time.time()

            response.raise_for_status()
            results = response.json()
            if not isinstance(results, list) or not results:
                print(f"No geocoding result for: {query}")
                continue

            for item in results:
                address = item.get("address", {}) or {}
                state = str(address.get("state", "")).strip().lower()
                country = str(address.get("country", "")).strip().lower()

                try:
                    latitude = float(item["lat"])
                    longitude = float(item["lon"])
                except (KeyError, TypeError, ValueError):
                    continue

                if not (math.isfinite(latitude) and math.isfinite(longitude)):
                    continue
                if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
                    continue
                if country and country not in {"india", "भारत"}:
                    continue

                inside_ap_bounds = (
                    12.0 <= latitude <= 20.0
                    and 76.0 <= longitude <= 85.5
                )
                is_ap = "andhra pradesh" in state or inside_ap_bounds
                if not is_ap:
                    continue

                # Compare the returned locality with the requested locality,
                # not with the entire "village, mandal, district" input.
                score = _place_name_similarity(requested_place, item)

                # The generated spelling variant may exactly match the result
                # even when the original user spelling differs.
                query_place = query.split(",", 1)[0].strip()
                score = max(score, _place_name_similarity(query_place, item))

                # Prefer explicit Andhra Pradesh state metadata when scores tie.
                if "andhra pradesh" in state:
                    score += 0.03

                if score > best_score:
                    best_score = score
                    best_match = (latitude, longitude, item)

        except requests.RequestException as error:
            print(f"Nominatim request failed for '{query}': {error}")
            # Stop on network/service errors; do not send repeated requests.
            break
        except (ValueError, TypeError) as error:
            print("Geocoding response error:", error)

    # Do not silently route to an unrelated result just because it is in AP.
    # A score of 0.68 allows common spelling differences but rejects weak matches.
    if best_match and best_score >= 0.68:
        latitude, longitude, result = best_match
        coordinates = (latitude, longitude)
        GEOCODING_CACHE[cache_key] = coordinates

        print(
            f"Location found: {place_name} -> {coordinates} "
            f"(match score: {best_score:.2f})"
        )
        print("Matched place:", result.get("display_name", ""))
        return coordinates

    print(
        f"Location not found with a reliable AP spelling match: {place_name}. "
        f"Best match score: {best_score:.2f}"
    )
    return None


# ============================================================
# GRAPHHOPPER ROUTING
# ============================================================

def get_route(points):

    params = [

        (
            "profile",
            "car"
        ),

        (
            "points_encoded",
            "false"
        ),

        (
            "instructions",
            "true"
        ),

        (
            "locale",
            "en"
        ),

        (
            "via_point_instructions",
            "false"
        )

    ]


    for lat, lon in points:

        params.append(

            (
                "point",
                f"{lat},{lon}"
            )

        )


    # Hosted GraphHopper Directions API requires an API key.
    # Local GraphHopper does not require one.
    if "graphhopper.com" in GRAPHOPPER_URL and GRAPHHOPPER_API_KEY:
        params.append(

            (
                "key",
                GRAPHHOPPER_API_KEY
            )

        )


    try:

        response = requests.get(

            GRAPHOPPER_URL,

            params=params,

            timeout=120

        )


        if response.status_code != 200:

            print(
                "GraphHopper Error:",
                response.text
            )

            return None


        data = response.json()


        if not data.get("paths"):

            return None


        return data["paths"][0]


    except Exception as error:

        print(
            "GraphHopper connection error:",
            error
        )

        return None


# ============================================================
# ROUTE ENDPOINT SAFETY CHECK
# ============================================================

def haversine_km(lat1, lon1, lat2, lon2):

    radius_km = 6371.0

    lat1_rad = math.radians(lat1)
    lat2_rad = math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)

    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1_rad)
        * math.cos(lat2_rad)
        * math.sin(dlon / 2) ** 2
    )

    return 2 * radius_km * math.asin(math.sqrt(a))


def ensure_route_matches_endpoints(
    route,
    source,
    destination,
    source_tolerance_km=0.50,
    destination_tolerance_km=0.15
):
    """Accept a route only when its geometry starts and ends at this journey's
    requested road-access points. Never join or extend a bad route artificially.
    GraphHopper geometry coordinates are [longitude, latitude].
    """
    if route is None:
        return None

    coordinates = route.get("points", {}).get("coordinates", [])
    if not isinstance(coordinates, list) or len(coordinates) < 2:
        print("Rejecting route: missing or incomplete route geometry.")
        return None

    try:
        first_lon, first_lat = map(float, coordinates[0][:2])
        last_lon, last_lat = map(float, coordinates[-1][:2])
        source_lat, source_lon = map(float, source[:2])
        destination_lat, destination_lon = map(float, destination[:2])
    except (TypeError, ValueError, IndexError):
        print("Rejecting route: invalid endpoint coordinates.")
        return None

    start_gap_km = haversine_km(
        first_lat, first_lon, source_lat, source_lon
    )
    end_gap_km = haversine_km(
        last_lat, last_lon, destination_lat, destination_lon
    )

    print(
        "Route endpoint validation: "
        f"start gap={start_gap_km:.3f} km, "
        f"destination gap={end_gap_km:.3f} km"
    )

    if start_gap_km > source_tolerance_km:
        print(
            "Rejecting route: it starts at a different location "
            f"({start_gap_km:.3f} km from requested source)."
        )
        return None

    if end_gap_km > destination_tolerance_km:
        print(
            "Rejecting route: it ends at a different location "
            f"({end_gap_km:.3f} km from requested destination)."
        )
        return None

    return route


# ============================================================
# SNAP DETOUR POINTS TO THE CAR ROAD NETWORK
# ============================================================

def get_nearest_road_point(point):
    """Snap a candidate (latitude, longitude) to GraphHopper's car network."""
    latitude, longitude = point
    nearest_url = GRAPHOPPER_URL.rsplit("/", 1)[0] + "/nearest"
    params = [
        ("profile", "car"),
        ("point", f"{latitude},{longitude}"),
    ]

    if "graphhopper.com" in GRAPHOPPER_URL and GRAPHHOPPER_API_KEY:
        params.append(("key", GRAPHHOPPER_API_KEY))

    try:
        response = requests.get(nearest_url, params=params, timeout=20)
        if response.status_code != 200:
            print("GraphHopper nearest error:", response.text[:300])
            return None

        data = response.json()
        snapped = data.get("coordinates")
        if not snapped and isinstance(data.get("geometry"), dict):
            snapped = data["geometry"].get("coordinates")
        if not isinstance(snapped, (list, tuple)) or len(snapped) < 2:
            print("GraphHopper nearest returned no usable coordinates.")
            return None

        snapped_lon, snapped_lat = float(snapped[0]), float(snapped[1])
        snap_gap = haversine_km(latitude, longitude, snapped_lat, snapped_lon)
        if snap_gap > 3.0:
            print(f"Rejecting detour point: nearest car road is {snap_gap:.2f} km away.")
            return None

        return (snapped_lat, snapped_lon)
    except Exception as error:
        print("GraphHopper nearest request failed:", error)
        return None


# ============================================================
# CREATE REALISTIC ALTERNATIVE ROUTE CANDIDATES
# ============================================================

def create_candidate_points(route):
    """Create small lateral detour candidates along the main route.

    Candidate points are placed 750 metres to either side of the route at
    25%, 50%, and 75% of its geometry, then snapped to the car road network.
    """
    coordinates = route.get("points", {}).get("coordinates", [])
    total_points = len(coordinates)
    if total_points < 20:
        return []

    candidates = []
    # Spread candidate detours across the route and vary their distance
    # from the original road. Both sides are explored so GraphHopper can
    # discover genuinely different road corridors.
    patterns = [
        (fraction, offset_km)
        for fraction in (0.15, 0.30, 0.45, 0.60, 0.75, 0.85)
        for offset_km in (0.50, 0.90, 1.30)
    ]

    for fraction, offset_km in patterns:
        index = max(2, min(int((total_points - 1) * fraction), total_points - 3))
        before = coordinates[max(0, index - 8)]
        after = coordinates[min(total_points - 1, index + 8)]
        lon, lat = coordinates[index]

        mean_lat_rad = math.radians(float(lat))
        east = (float(after[0]) - float(before[0])) * math.cos(mean_lat_rad)
        north = float(after[1]) - float(before[1])
        magnitude = math.hypot(east, north)
        if magnitude < 1e-9:
            continue

        perp_east = -north / magnitude
        perp_north = east / magnitude

        for side in (1.0, -1.0):
            east_offset = perp_east * offset_km * side
            north_offset = perp_north * offset_km * side
            candidate_lat = float(lat) + north_offset / 111.32
            longitude_scale = max(111.32 * math.cos(mean_lat_rad), 1.0)
            candidate_lon = float(lon) + east_offset / longitude_scale
            candidates.append((candidate_lat, candidate_lon))

    unique = []
    seen = set()
    for latitude, longitude in candidates:
        key = (round(latitude, 5), round(longitude, 5))
        if key not in seen:
            seen.add(key)
            unique.append((latitude, longitude))

    return unique


# ============================================================
# ROUTE SIMILARITY AND GEOMETRY CHECKS
# ============================================================

def _sample_route_coordinates(route, start_fraction=0.15, end_fraction=0.85, count=40):
    coordinates = route.get("points", {}).get("coordinates", [])
    if len(coordinates) < 2:
        return []
    start = int((len(coordinates) - 1) * start_fraction)
    end = max(start + 1, int((len(coordinates) - 1) * end_fraction))
    if end <= start:
        return []
    return [
        coordinates[round(start + (end - start) * i / (count - 1))]
        for i in range(count)
    ]


def _route_overlap_ratio(route1, route2, tolerance_km=0.15):
    """Estimate shared middle-route geometry, excluding shared endpoints."""
    points1 = _sample_route_coordinates(route1)
    points2 = _sample_route_coordinates(route2)
    if not points1 or not points2:
        return 0.0

    matched = 0
    for lon1, lat1 in points1:
        nearest = min(
            haversine_km(float(lat1), float(lon1), float(lat2), float(lon2))
            for lon2, lat2 in points2
        )
        if nearest <= tolerance_km:
            matched += 1
    return matched / len(points1)


def is_similar_route(route1, route2):
    distance1 = float(route1.get("distance", 0) or 0)
    distance2 = float(route2.get("distance", 0) or 0)
    time1 = float(route1.get("time", 0) or 0)
    time2 = float(route2.get("time", 0) or 0)

    distance_difference_km = abs(distance1 - distance2) / 1000.0
    time_difference_minutes = abs(time1 - time2) / 60000.0

    if distance_difference_km < 3 and time_difference_minutes < 8:
        return True

    return _route_overlap_ratio(route1, route2) >= 0.85


def is_reasonable_alternative(candidate_route, main_route):
    """Reject alternatives that are implausibly longer than the main route."""
    candidate_distance = float(candidate_route.get("distance", 0) or 0)
    main_distance = float(main_route.get("distance", 0) or 0)
    if candidate_distance <= 0 or main_distance <= 0:
        return False

    # Allow a genuine detour, but cap it at both +25% and +25 km.
    maximum_distance = min(main_distance * 1.25, main_distance + 25000)
    if candidate_distance > maximum_distance:
        print(
            "Rejecting excessive detour: "
            f"{candidate_distance / 1000:.2f} km vs "
            f"{main_distance / 1000:.2f} km main route."
        )
        return False

    return True


# ============================================================
# OPEN-METEO VISIBILITY
#
# V1 requires visibility_km.
#
# Open-Meteo provides visibility as a current weather variable.
# ============================================================

def get_current_visibility(
    latitude,
    longitude
):

    params = {

        "latitude":
            latitude,

        "longitude":
            longitude,

        "current":
            "visibility",

        "timezone":
            "auto"

    }


    try:

        response = requests.get(

            OPEN_METEO_URL,

            params=params,

            timeout=20

        )


        response.raise_for_status()


        data = response.json()


        current = data.get(
            "current",
            {}
        )


        visibility_m = current.get(
            "visibility"
        )


        if visibility_m is None:

            return None


        visibility_km = (

            float(
                visibility_m
            )
            /
            1000.0

        )


        return max(
            visibility_km,
            0.0
        )


    except Exception as error:

        print(
            "Visibility error:",
            error
        )

        return None


# ============================================================
# ROUTE VISIBILITY
#
# Sample up to 5 route points.
# ============================================================

def calculate_route_visibility(
    coordinates
):

    if not coordinates:

        return {

            "visibility_km":
                10.0,

            "visibility_sample_count":
                0,

            "visibility_data_available":
                False

        }


    total_points = len(
        coordinates
    )


    sample_count = min(
        5,
        total_points
    )


    if sample_count == 1:

        indices = [0]

    else:

        indices = [

            int(

                i
                *
                (
                    total_points - 1
                )
                /
                (
                    sample_count - 1
                )

            )

            for i in range(
                sample_count
            )

        ]


    visibility_values = []


    for index in indices:

        lon, lat = coordinates[
            index
        ]


        visibility = get_current_visibility(

            lat,

            lon

        )


        if visibility is not None:

            visibility_values.append(
                visibility
            )


    if not visibility_values:

        return {

            "visibility_km":
                10.0,

            "visibility_sample_count":
                0,

            "visibility_data_available":
                False

        }


    return {

        "visibility_km":
            round(

                sum(
                    visibility_values
                )
                /
                len(
                    visibility_values
                ),

                2

            ),

        "visibility_sample_count":
            len(
                visibility_values
            ),

        "visibility_data_available":
            True

    }


# ============================================================
# NORMALIZE LOCATION NAME
# ============================================================

def normalize_name(value):

    if value is None:

        return ""

    return (

        str(value)
        .strip()
        .lower()

    )


# ============================================================
# FIND CRIME RECORD
#
# Uses the location identified by crime_service.py.
#
# Preference:
# 1. Exact city
# 2. Exact district
# 3. District field
# ============================================================

def get_crime_record(
    crime_result
):

    if crime_df.empty:

        return None


    location = normalize_name(

        crime_result.get(
            "crime_location"
        )

    )


    location_type = normalize_name(

        crime_result.get(
            "crime_location_type"
        )

    )


    locations = crime_result.get(
        "crime_locations",
        []
    )


    # --------------------------------------------------------
    # Collect possible names
    # --------------------------------------------------------

    possible_names = []


    if location:

        possible_names.append(
            location
        )


    if isinstance(
        locations,
        list
    ):

        for item in locations:

            if isinstance(
                item,
                str
            ):

                possible_names.append(
                    normalize_name(
                        item
                    )
                )

            elif isinstance(
                item,
                dict
            ):

                for key in [

                    "location_name",

                    "name",

                    "district",

                    "location"

                ]:

                    if key in item:

                        possible_names.append(

                            normalize_name(
                                item[key]
                            )

                        )


    # Remove duplicates

    possible_names = list(
        dict.fromkeys(
            possible_names
        )
    )


    # --------------------------------------------------------
    # Exact location match
    # --------------------------------------------------------

    for name in possible_names:

        if not name:

            continue


        matches = crime_df[

            crime_df[
                "location_name"
            ]
            .astype(str)
            .str.strip()
            .str.lower()
            ==
            name

        ]


        if not matches.empty:

            if location_type == "city":

                city_matches = matches[

                    matches[
                        "location_type"
                    ]
                    .astype(str)
                    .str.lower()
                    ==
                    "city"

                ]


                if not city_matches.empty:

                    return city_matches.iloc[0]


            return matches.iloc[0]


    # --------------------------------------------------------
    # District fallback
    # --------------------------------------------------------

    district = crime_result.get(
        "district"
    )


    if district:

        district_name = normalize_name(
            district
        )


        matches = crime_df[

            (
                crime_df[
                    "location_name"
                ]
                .astype(str)
                .str.lower()
                ==
                district_name
            )

            |

            (

                crime_df[
                    "district"
                ]
                .astype(str)
                .str.lower()
                ==
                district_name

            )

        ]


        if not matches.empty:

            district_rows = matches[

                matches[
                    "location_type"
                ]
                .astype(str)
                .str.lower()
                ==
                "district"

            ]


            if not district_rows.empty:

                return district_rows.iloc[0]


            return matches.iloc[0]


    return None


# ============================================================
# GET NUMERIC VALUE FROM CRIME RECORD
# ============================================================

def crime_value(
    record,
    column
):

    if record is None:

        return 0.0


    try:

        value = float(
            record[column]
        )


        if math.isnan(
            value
        ):

            return 0.0


        return max(
            value,
            0.0
        )


    except Exception:

        return 0.0


# ============================================================
# PREPARE V1 CRIME FEATURES
# ============================================================

def get_v1_crime_features(
    crime_result
):

    record = get_crime_record(
        crime_result
    )


    if record is None:

        print(
            "WARNING: No matching crime record "
            "found for V1."
        )


        return {

            "violent_crime_count":
                0.0,

            "property_crime_count":
                0.0,

            "women_crime_count":
                0.0,

            "other_crime_count":
                0.0,

            "total_crime_count":
                0.0,

            "crime_rate_per_1000_exposure":
                0.0,

            "crime_record_found":
                False

        }


    violent = crime_value(

        record,

        "violent_crime_cases"

    )


    property_crime = crime_value(

        record,

        "property_crime_cases"

    )


    women = crime_value(

        record,

        "women_safety_crime_cases"

    )


    total = crime_value(

        record,

        "total_ipc_crimes"

    )


    # --------------------------------------------------------
    # V1 needs "other crime".
    #
    # We calculate it from total minus the three main
    # categories, preventing negative values.
    # --------------------------------------------------------

    other = max(

        total
        -
        violent
        -
        property_crime
        -
        women,

        0.0

    )


    # --------------------------------------------------------
    # The project crime dataset does not contain the same
    # exposure-rate field used by the V1 training CSV.
    #
    # Therefore use a stable project-derived rate based on
    # total crime count rather than inventing a population.
    #
    # This is clearly labelled in the API response.
    # --------------------------------------------------------

    crime_rate = (

        total
        /
        1000.0

    )


    return {

        "violent_crime_count":
            violent,

        "property_crime_count":
            property_crime,

        "women_crime_count":
            women,

        "other_crime_count":
            other,

        "total_crime_count":
            total,

        "crime_rate_per_1000_exposure":
            crime_rate,

        "crime_record_found":
            True

    }


# ============================================================
# EMERGENCY FEATURES
#
# V1 requires:
# nearest_police_km
# nearest_hospital_km
# emergency_access_score
# emergency_distance
#
# Your current API has no live police/hospital service.
# We therefore use the district baseline from the V1 training
# dataset instead of inventing coordinates.
# ============================================================

def get_emergency_features(
    crime_result
):

    if training_df.empty:

        return {

            "nearest_police_km":
                5.0,

            "nearest_hospital_km":
                5.0,

            "emergency_access_score":
                50.0,

            "emergency_data_type":
                "fallback_baseline"

        }


    district = crime_result.get(
        "district"
    )


    if not district:

        district = crime_result.get(
            "crime_location"
        )


    district_name = normalize_name(
        district
    )


    if district_name:

        matches = training_df[

            training_df[
                "district"
            ]
            .astype(str)
            .str.strip()
            .str.lower()
            ==
            district_name

        ]

    else:

        matches = pd.DataFrame()


    # --------------------------------------------------------
    # If no exact district match exists, use overall training
    # median.
    # --------------------------------------------------------

    if matches.empty:

        nearest_police = float(

            training_df[
                "nearest_police_km"
            ].median()

        )


        nearest_hospital = float(

            training_df[
                "nearest_hospital_km"
            ].median()

        )


        emergency_score = float(

            training_df[
                "emergency_access_score"
            ].median()

        )


        data_type = (
            "training_dataset_overall_baseline"
        )


    else:

        nearest_police = float(

            matches[
                "nearest_police_km"
            ].median()

        )


        nearest_hospital = float(

            matches[
                "nearest_hospital_km"
            ].median()

        )


        emergency_score = float(

            matches[
                "emergency_access_score"
            ].median()

        )


        data_type = (
            "training_dataset_district_baseline"
        )


    return {

        "nearest_police_km":
            round(
                max(
                    nearest_police,
                    0
                ),
                2
            ),

        "nearest_hospital_km":
            round(
                max(
                    nearest_hospital,
                    0
                ),
                2
            ),

        "emergency_access_score":
            round(

                min(

                    max(
                        emergency_score,
                        0
                    ),

                    100

                ),

                2

            ),

        "emergency_data_type":
            data_type

    }


# ============================================================
# SAFETY RANK
# ============================================================

def get_ranked_routes(
    routes
):
    """Rank primarily by AI safety, with historical user ratings as a secondary signal."""
    for route in routes:
        safety = float(route.get("safety_score", 0) or 0)
        rating_count = int(route.get("rating_count", 0) or 0)
        rating_score = float(route.get("rating_score", 0) or 0)

        # Ratings should help, but must not overpower the safety model.
        # Influence grows with feedback and caps at 20%.
        rating_weight = 0.0 if rating_count == 0 else min(0.20, 0.05 + (rating_count * 0.03))
        ranking_score = safety * (1.0 - rating_weight) + rating_score * rating_weight
        route["rating_weight"] = round(rating_weight, 3)
        route["ranking_score"] = round(ranking_score, 2)

    sorted_routes = sorted(
        routes,
        key=lambda route: (route.get("ranking_score", 0), route.get("safety_score", 0)),
        reverse=True
    )

    for rank, route in enumerate(sorted_routes, start=1):
        route["safety_rank"] = rank
        route["recommended"] = rank == 1

    return sorted_routes


# ============================================================
# HOME
# ============================================================

@app.get("/")
def home():

    return {

        "message":
            "Safe Route Finder API is running!",

        "model":
            "SafeRoute V1 Multi-Branch Deep Learning",

        "status":
            "ready"

    }


# ============================================================
# MAIN ROUTE API
# ============================================================

@app.post("/routes")
def generate_routes(
    request: RouteRequest
):

    print(
        "\n"
        +
        "=" * 70
    )


    print(
        "SAFE ROUTE REQUEST RECEIVED"
    )


    print(
        "Source:",
        request.source
    )


    print(
        "Destination:",
        request.destination
    )


    print(
        "=" * 70
    )


    # ========================================================
    # VALIDATION
    # ========================================================

    if not request.source.strip():

        return {

            "success":
                False,

            "message":
                "Please enter a source location."

        }


    if not request.destination.strip():

        return {

            "success":
                False,

            "message":
                "Please enter a destination location."

        }


    # ========================================================
    # SOURCE
    # ========================================================

    source = None

    if request.source_coordinates is not None:
        try:
            if len(request.source_coordinates) != 2:
                raise ValueError("GPS coordinates must contain latitude and longitude.")

            gps_latitude = float(request.source_coordinates[0])
            gps_longitude = float(request.source_coordinates[1])

            if not (
                math.isfinite(gps_latitude)
                and math.isfinite(gps_longitude)
                and -90 <= gps_latitude <= 90
                and -180 <= gps_longitude <= 180
            ):
                raise ValueError("GPS coordinates are outside valid latitude/longitude ranges.")

            source = (gps_latitude, gps_longitude)
            print(f"Using current GPS source: {source}")

        except (TypeError, ValueError) as error:
            return {
                "success": False,
                "message": f"Invalid current GPS coordinates: {error}"
            }

    else:
        source = get_coordinates(request.source.strip())

    if source is None:
        return {
            "success": False,
            "message": (
                "Could not find source location: "
                + request.source
            )
        }

    # Snap the source village/place centroid or GPS point to a nearby
    # routable car road before requesting routes from GraphHopper.
    original_source = source
    source = get_nearest_road_point(original_source)

    if source is None:
        return {
            "success": False,
            "message": (
                "Could not find a nearby car road for the source location. "
                "Please choose a more specific source or nearby landmark."
            )
        }

    source_snap_gap = haversine_km(
        original_source[0],
        original_source[1],
        source[0],
        source[1]
    )
    print(
        "Source road snap:",
        source,
        f"(geocoded point is {source_snap_gap:.3f} km away)"
    )

    # ========================================================
    # DESTINATION
    # ========================================================

    destination = get_coordinates(

        request.destination.strip()

    )


    if destination is None:

        return {

            "success":
                False,

            "message":
                (
                    "Could not find destination location: "
                    +
                    request.destination
                )

        }

    # Snap the geocoded destination (which may be a town/place centroid)
    # to a nearby routable car road. Use this same point for every route
    # candidate and for the destination marker returned to the frontend.
    original_destination = destination
    destination = get_nearest_road_point(original_destination)

    if destination is None:
        return {
            "success": False,
            "message": (
                "Could not find a nearby car road for the destination. "
                "Please enter a more specific destination or nearby address."
            )
        }

    destination_snap_gap = haversine_km(
        original_destination[0],
        original_destination[1],
        destination[0],
        destination[1]
    )
    print(
        "Destination road snap:",
        destination,
        f"(geocoded point is {destination_snap_gap:.3f} km away)"
    )

    print(
        "\nSource coordinates:",
        source
    )


    print(
        "Destination coordinates:",
        destination
    )

    # Support up to 10 total routes, including the main route.
    try:
        target_route_count = min(max(int(request.max_routes or 10), 1), 10)
    except (TypeError, ValueError):
        target_route_count = 10
    excluded_route_keys = set(request.excluded_route_keys or [])

    print(f"Requested route limit: {target_route_count}")
    print(f"Excluded existing routes: {len(excluded_route_keys)}")


    # ========================================================
    # MAIN ROUTE
    # ========================================================

    print(
        "\nFinding main route..."
    )


    main_route = get_route([

        source,

        destination

    ])


    if main_route is None:

        return {

            "success":
                False,

            "message":
                (
                    "Could not find a road route "
                    "between these locations."
                )

        }


    print(
        "Main route found!"
    )


    # Validate the main route endpoint as well.
    main_route = ensure_route_matches_endpoints(
        main_route,
        source,
        destination
    )

    if main_route is None:
        return {
            "success": False,
            "message": "The calculated route did not reach the requested destination. Please try another location."
        }

    main_route_key = make_route_key(request.source, request.destination, main_route.get("points", {}).get("coordinates", []))

    routes = [] if main_route_key in excluded_route_keys else [main_route]

    if main_route_key in excluded_route_keys:
        print("Main route already known by the client; searching for additional routes.")


    # ========================================================
    # ALTERNATIVE ROUTES
    # ========================================================

    print(
        "\nGenerating alternative routes..."
    )


    candidates = create_candidate_points(

        main_route

    )


    print(

        f"Generated "
        f"{len(candidates)} "
        f"candidate detour points."

    )


    # Try the full candidate set until the requested number of distinct
    # routes is reached. Candidate generation creates up to 36 detour points.
    # The similarity and distance checks below prevent near-duplicate or
    # excessively long alternatives from being returned.

    for candidate_number, candidate in enumerate(candidates, start=1):

        print(
            f"Trying route candidate "
            f"{candidate_number}/{len(candidates)}..."
        )

        if len(routes) >= target_route_count:
            break


        snapped_candidate = get_nearest_road_point(candidate)
        if snapped_candidate is None:
            continue

        candidate_route = get_route([
            source,
            snapped_candidate,
            destination
        ])


        if candidate_route is None:

            continue


        # Reject candidates that do not finish near the requested destination.
        candidate_route = ensure_route_matches_endpoints(
            candidate_route,
            source,
            destination
        )


        if candidate_route is None:
            continue

        if not is_reasonable_alternative(candidate_route, main_route):
            continue

        candidate_coordinates = candidate_route.get("points", {}).get("coordinates", [])
        candidate_route_key = make_route_key(request.source, request.destination, candidate_coordinates)

        if candidate_route_key in excluded_route_keys:
            print("Skipping route already shown to the user.")
            continue

        duplicate = False


        for existing_route in routes:

            if is_similar_route(

                candidate_route,

                existing_route

            ):

                duplicate = True

                break


        if not duplicate:

            routes.append(

                candidate_route

            )


            distance_km = (

                candidate_route[
                    "distance"
                ]
                /
                1000

            )


            time_minutes = (

                candidate_route[
                    "time"
                ]
                /
                60000

            )


            print(

                f"Alternative route found: "
                f"{distance_km:.2f} km, "
                f"{time_minutes:.2f} minutes"

            )


    # Final endpoint gate: only score and return routes that connect
    # this exact source and destination.
    validated_routes = []
    for route in routes:
        checked = ensure_route_matches_endpoints(
            route,
            source,
            destination
        )
        if checked is not None:
            validated_routes.append(checked)

    routes = validated_routes

    if not routes:
        return {
            "success": False,
            "message": (
                "No complete routes were found between the selected source "
                "and destination. Please choose a more precise destination "
                "or try another journey."
            )
        }

    # ========================================================
    # ANALYZE EACH ROUTE
    # ========================================================

    result = []


    for i, route in enumerate(

        routes,

        start=1

    ):

        print()
        print(
            "=" * 70
        )

        print(
            f"ROUTE {i}"
        )

        print(
            "=" * 70
        )


        coordinates = route[
            "points"
        ][
            "coordinates"
        ]


        # ====================================================
        # NASA NIGHTTIME LIGHTING
        # ====================================================

        print(
            f"\n[Route {i}] "
            "Calculating NASA nighttime lighting..."
        )


        try:

            lighting = calculate_route_lighting(

                coordinates

            )


        except Exception as error:

            print(

                f"Lighting error Route {i}:",

                error

            )


            lighting = {

                "lighting_value":
                    0,

                "lighting_score":
                    0,

                "sample_count":
                    0

            }


        lighting_score = float(

            lighting.get(
                "lighting_score",
                0
            )

        )


        print(

            f"Lighting Score: "
            f"{lighting_score:.2f}/100"

        )


        # ====================================================
        # TOMTOM TRAFFIC
        # ====================================================

        print(
            f"\n[Route {i}] "
            "Calculating TomTom traffic..."
        )


        try:

            traffic = calculate_route_traffic(

                coordinates

            )


        except Exception as error:

            print(

                f"Traffic error Route {i}:",

                error

            )


            traffic = {

                "traffic_score":
                    0,

                "average_current_speed_kmph":
                    0,

                "average_free_flow_speed_kmph":
                    0,

                "average_delay_seconds":
                    0,

                "average_speed_ratio":
                    0,

                "average_confidence":
                    0,

                "road_closure_count":
                    0,

                "traffic_sample_count":
                    0

            }


        traffic_score = float(

            traffic.get(
                "traffic_score",
                0
            )

        )


        print(

            f"Traffic Score: "
            f"{traffic_score:.2f}/100"

        )


        # ====================================================
        # OPEN-METEO WEATHER
        # ====================================================

        print(
            f"\n[Route {i}] "
            "Calculating Open-Meteo weather..."
        )


        try:

            weather = calculate_route_weather(

                coordinates

            )


        except Exception as error:

            print(

                f"Weather error Route {i}:",

                error

            )


            weather = {

                "weather_score":
                    0,

                "weather_condition":
                    "Unavailable",

                "average_temperature_c":
                    0,

                "average_humidity_percent":
                    0,

                "average_precipitation_mm":
                    0,

                "average_rain_mm":
                    0,

                "average_wind_speed_kmph":
                    0,

                "average_wind_gusts_kmph":
                    0,

                "average_cloud_cover_percent":
                    0,

                "weather_sample_count":
                    0

            }


        rainfall_mm = float(

            weather.get(

                "average_precipitation_mm",

                0

            )

        )


        weather_score = float(

            weather.get(

                "weather_score",

                0

            )

        )


        print(

            f"Weather Score: "
            f"{weather_score:.2f}/100"

        )


        # ====================================================
        # VISIBILITY
        # ====================================================

        print(
            f"\n[Route {i}] "
            "Calculating Open-Meteo visibility..."
        )


        visibility = calculate_route_visibility(

            coordinates

        )


        visibility_km = float(

            visibility[
                "visibility_km"
            ]

        )


        print(

            f"Visibility: "
            f"{visibility_km:.2f} km"

        )


        # ====================================================
        # CRIME
        # ====================================================

        print(
            f"\n[Route {i}] "
            "Calculating crime..."
        )


        try:

            crime = calculate_route_crime(

                coordinates

            )


        except Exception as error:

            print(

                f"Crime error Route {i}:",

                error

            )


            crime = {

                "crime_risk_score":
                    0,

                "crime_safety_score":
                    0,

                "crime_location":
                    "Unknown",

                "crime_location_type":
                    "unknown",

                "crime_data_type":
                    "unavailable",

                "crime_sample_count":
                    0,

                "crime_locations":
                    []

            }


        print(

            f"Crime Risk: "
            f"{crime.get('crime_risk_score', 0)}/100"

        )


        print(

            f"Crime Safety: "
            f"{crime.get('crime_safety_score', 0)}/100"

        )


        print(

            "Crime Location:",
            crime.get(
                "crime_location",
                "Unknown"
            )

        )


        # ====================================================
        # V1 CRIME FEATURES
        # ====================================================

        v1_crime = get_v1_crime_features(

            crime

        )


        print(
            "\nV1 crime features:"
        )


        print(

            "Violent:",
            v1_crime[
                "violent_crime_count"
            ]

        )


        print(

            "Property:",
            v1_crime[
                "property_crime_count"
            ]

        )


        print(

            "Women:",
            v1_crime[
                "women_crime_count"
            ]

        )


        print(

            "Other:",
            v1_crime[
                "other_crime_count"
            ]

        )


        print(

            "Total:",
            v1_crime[
                "total_crime_count"
            ]

        )


        # ====================================================
        # EMERGENCY
        # ====================================================

        emergency = get_emergency_features(

            crime

        )


        print(
            "\nEmergency features:"
        )


        print(

            "Nearest Police:",
            emergency[
                "nearest_police_km"
            ],
            "km"

        )


        print(

            "Nearest Hospital:",
            emergency[
                "nearest_hospital_km"
            ],
            "km"

        )


        print(

            "Emergency Access:",
            emergency[
                "emergency_access_score"
            ],
            "/100"

        )


        # ====================================================
        # V1 DEEP LEARNING PREDICTION
        # ====================================================

        print(
            f"\n[Route {i}] "
            "Running SafeRoute V1 deep-learning model..."
        )


        try:

            current_month = datetime.now().month


            v1_prediction = predict_route_safety(

                traffic_index=
                    traffic_score,

                lighting_score=
                    lighting_score,

                rainfall_mm=
                    rainfall_mm,

                visibility_km=
                    visibility_km,

                violent_crime_count=
                    v1_crime[
                        "violent_crime_count"
                    ],

                property_crime_count=
                    v1_crime[
                        "property_crime_count"
                    ],

                women_crime_count=
                    v1_crime[
                        "women_crime_count"
                    ],

                other_crime_count=
                    v1_crime[
                        "other_crime_count"
                    ],

                total_crime_count=
                    v1_crime[
                        "total_crime_count"
                    ],

                crime_rate_per_1000_exposure=
                    v1_crime[
                        "crime_rate_per_1000_exposure"
                    ],

                nearest_police_km=
                    emergency[
                        "nearest_police_km"
                    ],

                nearest_hospital_km=
                    emergency[
                        "nearest_hospital_km"
                    ],

                emergency_access_score=
                    emergency[
                        "emergency_access_score"
                    ],

                month=
                    current_month

            )


            safety_score = float(

                v1_prediction[
                    "safety_score"
                ]

            )


            risk_level = (

                v1_prediction[
                    "risk_level"
                ]

            )


        except Exception as error:

            print(

                f"V1 model error Route {i}:",

                error

            )


            safety_score = 0.0

            risk_level = "Unavailable"


        print()
        print(
            "------------------------------------------"
        )


        print(
            f"V1 SAFETY SCORE: "
            f"{safety_score:.2f}/100"
        )


        print(
            f"V1 RISK LEVEL: "
            f"{risk_level}"
        )


        print(
            "------------------------------------------"
        )


        # ====================================================
        # ROUTE RESPONSE
        # ====================================================

        route_data = {

            # ------------------------------------------------
            # ROUTE
            # ------------------------------------------------

            "route_id":
                i,

            "distance_km":
                round(

                    route[
                        "distance"
                    ]
                    /
                    1000,

                    2

                ),

            "time_minutes":
                round(

                    route[
                        "time"
                    ]
                    /
                    60000,

                    2

                ),


            # ------------------------------------------------
            # NASA
            # ------------------------------------------------

            "lighting_value":
                lighting.get(
                    "lighting_value",
                    0
                ),

            "lighting_score":
                round(
                    lighting_score,
                    2
                ),

            "lighting_sample_count":
                lighting.get(
                    "sample_count",
                    0
                ),


            # ------------------------------------------------
            # TRAFFIC
            # ------------------------------------------------

            "traffic_score":
                round(
                    traffic_score,
                    2
                ),

            "average_current_speed_kmph":
                traffic.get(
                    "average_current_speed_kmph",
                    0
                ),

            "average_free_flow_speed_kmph":
                traffic.get(
                    "average_free_flow_speed_kmph",
                    0
                ),

            "average_delay_seconds":
                traffic.get(
                    "average_delay_seconds",
                    0
                ),

            "average_speed_ratio":
                traffic.get(
                    "average_speed_ratio",
                    0
                ),

            "traffic_confidence":
                traffic.get(
                    "average_confidence",
                    0
                ),

            "road_closure_count":
                traffic.get(
                    "road_closure_count",
                    0
                ),

            "traffic_sample_count":
                traffic.get(
                    "traffic_sample_count",
                    0
                ),


            # ------------------------------------------------
            # WEATHER
            # ------------------------------------------------

            "weather_score":
                round(
                    weather_score,
                    2
                ),

            "weather_condition":
                weather.get(
                    "weather_condition",
                    "Unknown"
                ),

            "average_temperature_c":
                weather.get(
                    "average_temperature_c",
                    0
                ),

            "average_humidity_percent":
                weather.get(
                    "average_humidity_percent",
                    0
                ),

            "average_precipitation_mm":
                weather.get(
                    "average_precipitation_mm",
                    0
                ),

            "average_rain_mm":
                weather.get(
                    "average_rain_mm",
                    0
                ),

            "average_wind_speed_kmph":
                weather.get(
                    "average_wind_speed_kmph",
                    0
                ),

            "average_wind_gusts_kmph":
                weather.get(
                    "average_wind_gusts_kmph",
                    0
                ),

            "average_cloud_cover_percent":
                weather.get(
                    "average_cloud_cover_percent",
                    0
                ),

            "weather_sample_count":
                weather.get(
                    "weather_sample_count",
                    0
                ),


            # ------------------------------------------------
            # VISIBILITY
            # ------------------------------------------------

            "visibility_km":
                visibility_km,

            "visibility_sample_count":
                visibility[
                    "visibility_sample_count"
                ],

            "visibility_data_available":
                visibility[
                    "visibility_data_available"
                ],


            # ------------------------------------------------
            # CRIME
            # ------------------------------------------------

            "crime_risk_score":
                crime.get(
                    "crime_risk_score",
                    0
                ),

            "crime_safety_score":
                crime.get(
                    "crime_safety_score",
                    0
                ),

            "crime_location":
                crime.get(
                    "crime_location",
                    "Unknown"
                ),

            "crime_location_type":
                crime.get(
                    "crime_location_type",
                    "unknown"
                ),

            "crime_data_type":
                crime.get(
                    "crime_data_type",
                    "unknown"
                ),

            "crime_sample_count":
                crime.get(
                    "crime_sample_count",
                    0
                ),

            "crime_locations":
                crime.get(
                    "crime_locations",
                    []
                ),


            # ------------------------------------------------
            # V1 CRIME FEATURES
            # ------------------------------------------------

            "violent_crime_count":
                v1_crime[
                    "violent_crime_count"
                ],

            "property_crime_count":
                v1_crime[
                    "property_crime_count"
                ],

            "women_crime_count":
                v1_crime[
                    "women_crime_count"
                ],

            "other_crime_count":
                v1_crime[
                    "other_crime_count"
                ],

            "total_crime_count":
                v1_crime[
                    "total_crime_count"
                ],

            "crime_rate_per_1000_exposure":
                v1_crime[
                    "crime_rate_per_1000_exposure"
                ],


            # ------------------------------------------------
            # EMERGENCY
            # ------------------------------------------------

            "nearest_police_km":
                emergency[
                    "nearest_police_km"
                ],

            "nearest_hospital_km":
                emergency[
                    "nearest_hospital_km"
                ],

            "emergency_access_score":
                emergency[
                    "emergency_access_score"
                ],

            "emergency_data_type":
                emergency[
                    "emergency_data_type"
                ],


            # ------------------------------------------------
            # V1 FINAL DEEP LEARNING RESULT
            # ------------------------------------------------

            "safety_score":
                round(
                    safety_score,
                    2
                ),

            "risk_level":
                risk_level,

            "model":
                "SafeRoute V1 Multi-Branch Deep Learning",


            # ------------------------------------------------
            # USER RATINGS / LEARNING SIGNAL
            # ------------------------------------------------

            "route_key":
                make_route_key(
                    request.source,
                    request.destination,
                    coordinates
                ),

            **get_route_rating(
                make_route_key(
                    request.source,
                    request.destination,
                    coordinates
                )
            ),

            # ------------------------------------------------
            # ROUTE COORDINATES
            # ------------------------------------------------

            "coordinates":
                coordinates,

            # ------------------------------------------------
            # TURN-BY-TURN NAVIGATION
            # ------------------------------------------------

            "navigation_instructions": [

                {

                    "text":
                        instruction.get(
                            "text",
                            ""
                        ),

                    "street_name":
                        instruction.get(
                            "street_name",
                            ""
                        ),

                    "distance_m":
                        round(
                            float(
                                instruction.get(
                                    "distance",
                                    0
                                )
                            ),
                            1
                        ),

                    "time_ms":
                        int(
                            instruction.get(
                                "time",
                                0
                            )
                        ),

                    "sign":
                        int(
                            instruction.get(
                                "sign",
                                0
                            )
                        ),

                    "interval":
                        instruction.get(
                            "interval",
                            [0, 0]
                        ),

                    "exit_number":
                        instruction.get(
                            "exit_number"
                        )

                }

                for instruction in route.get(
                    "instructions",
                    []
                )

                # Hide GraphHopper's artificial via-point
                # instructions from the user-facing navigator.
                if int(
                    instruction.get(
                        "sign",
                        0
                    )
                ) != 5

            ]

        }


        result.append(
            route_data
        )


    # ========================================================
    # RANK ROUTES USING V1 SAFETY SCORE
    # ========================================================

    result = get_ranked_routes(
        result
    )


    # ========================================================
    # FINAL OUTPUT
    # ========================================================

    print(
        "\n"
        +
        "=" * 70
    )


    print(
        "FINAL SAFEROUTE RANKING"
    )


    print(
        "=" * 70
    )


    for route in result:

        print(

            f"Rank {route['safety_rank']} "
            f"| Route {route['route_id']} "
            f"| Safety "
            f"{route['safety_score']:.2f} "
            f"| {route['risk_level']}"

        )


    print(
        "=" * 70
    )


    return {

        "success":
            True,


        "model":
            "SafeRoute V1 Multi-Branch Deep Learning",


        "source_coordinates": {

            "latitude":
                source[0],

            "longitude":
                source[1]

        },


        "destination_coordinates": {

            "latitude":
                destination[0],

            "longitude":
                destination[1]

        },


        "recommended_route_id":

            result[0][
                "route_id"
            ]
            if result
            else None,


        "routes":
            result

    }


# ============================================================
# LIVE SAFETY CHECKPOINT API
#
# Called while the user is moving.  Unlike /routes, this endpoint
# evaluates the user's CURRENT location instead of averaging the
# entire selected route.
# ============================================================

class LiveSafetyRequest(BaseModel):
    latitude: float
    longitude: float


def _live_feature_fallbacks():
    return {
        "lighting": {
            "lighting_value": 0,
            "lighting_score": 0,
            "sample_count": 0
        },
        "traffic": {
            "traffic_score": 0,
            "average_current_speed_kmph": 0,
            "average_free_flow_speed_kmph": 0,
            "average_delay_seconds": 0,
            "average_speed_ratio": 0,
            "average_confidence": 0,
            "road_closure_count": 0,
            "traffic_sample_count": 0
        },
        "weather": {
            "weather_score": 0,
            "weather_condition": "Unavailable",
            "average_temperature_c": 0,
            "average_humidity_percent": 0,
            "average_precipitation_mm": 0,
            "average_rain_mm": 0,
            "average_wind_speed_kmph": 0,
            "average_wind_gusts_kmph": 0,
            "average_cloud_cover_percent": 0,
            "weather_sample_count": 0
        },
        "crime": {
            "crime_risk_score": 0,
            "crime_safety_score": 0,
            "crime_location": "Unknown",
            "crime_location_type": "unknown",
            "crime_data_type": "unavailable",
            "crime_sample_count": 0,
            "crime_locations": []
        }
    }


@app.post("/rate-route")
def rate_route(request: RouteRatingRequest):
    try:
        result = save_route_rating(
            request.route_key,
            request.rating,
            request.comment,
            request.source,
            request.destination
        )
        return {
            "success": True,
            "message": "Route rating saved.",
            "route_key": request.route_key,
            **result
        }
    except Exception as error:
        return {
            "success": False,
            "message": str(error)
        }


@app.post("/reroute")
def reroute(request: RerouteRequest):
    """
    Google-Maps-style rerouting:
    calculate a fresh road route from the user's current GPS
    position to the original destination.
    """

    values = [
        float(request.latitude),
        float(request.longitude),
        float(request.destination_latitude),
        float(request.destination_longitude)
    ]

    if not all(math.isfinite(value) for value in values):
        return {
            "success": False,
            "message": "Invalid coordinates."
        }

    current = (values[0], values[1])
    destination = (values[2], values[3])

    print(
        "\nREROUTE REQUEST"
        f"\nCurrent: {current}"
        f"\nDestination: {destination}"
    )

    route = get_route([
        current,
        destination
    ])

    if route is None:
        return {
            "success": False,
            "message": "GraphHopper could not calculate a new route."
        }

    route = ensure_route_reaches_destination(
        route,
        destination
    )

    instructions = [
        {
            "text": instruction.get("text", ""),
            "street_name": instruction.get("street_name", ""),
            "distance_m": round(
                float(instruction.get("distance", 0) or 0),
                1
            ),
            "time_ms": int(
                instruction.get("time", 0) or 0
            ),
            "sign": int(
                instruction.get("sign", 0) or 0
            ),
            "interval": instruction.get(
                "interval",
                [0, 0]
            ),
            "exit_number": instruction.get(
                "exit_number"
            )
        }
        for instruction in route.get(
            "instructions",
            []
        )
        if int(
            instruction.get("sign", 0) or 0
        ) != 5
    ]

    return {
        "success": True,
        "route": {
            "distance_km": round(
                float(route.get("distance", 0) or 0) / 1000,
                2
            ),
            "time_minutes": round(
                float(route.get("time", 0) or 0) / 60000,
                2
            ),
            "coordinates": route.get(
                "points",
                {}
            ).get(
                "coordinates",
                []
            ),
            "navigation_instructions": instructions
        }
    }


@app.post("/live-safety")
def live_safety(request: LiveSafetyRequest):
    """Return current-area safety information for live navigation."""

    latitude = float(request.latitude)
    longitude = float(request.longitude)

    # Keep coordinates inside valid geographic bounds.
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return {
            "success": False,
            "message": "Invalid GPS coordinates."
        }

    point = [[longitude, latitude]]
    fallbacks = _live_feature_fallbacks()

    print(
        f"\\nLIVE SAFETY CHECK -> {latitude:.6f}, {longitude:.6f}"
    )

    # ------------------------------------------------------------
    # NASA NIGHTTIME LIGHTING
    # ------------------------------------------------------------
    try:
        lighting = calculate_route_lighting(point)
    except Exception as error:
        print("Live lighting error:", error)
        lighting = fallbacks["lighting"]

    lighting_score = float(lighting.get("lighting_score", 0) or 0)

    # ------------------------------------------------------------
    # TOMTOM TRAFFIC
    # ------------------------------------------------------------
    try:
        traffic = calculate_route_traffic(point)
    except Exception as error:
        print("Live traffic error:", error)
        traffic = fallbacks["traffic"]

    traffic_score = float(traffic.get("traffic_score", 0) or 0)

    # ------------------------------------------------------------
    # OPEN-METEO WEATHER
    # ------------------------------------------------------------
    try:
        weather = calculate_route_weather(point)
    except Exception as error:
        print("Live weather error:", error)
        weather = fallbacks["weather"]

    weather_score = float(weather.get("weather_score", 0) or 0)
    rainfall_mm = float(weather.get("average_precipitation_mm", 0) or 0)

    # ------------------------------------------------------------
    # OPEN-METEO VISIBILITY
    # ------------------------------------------------------------
    try:
        visibility = calculate_route_visibility(point)
        visibility_km = float(visibility.get("visibility_km", 0) or 0)
    except Exception as error:
        print("Live visibility error:", error)
        visibility_km = 0.0

    # ------------------------------------------------------------
    # CRIME AT CURRENT AREA
    # ------------------------------------------------------------
    try:
        crime = calculate_route_crime(point)
    except Exception as error:
        print("Live crime error:", error)
        crime = fallbacks["crime"]

    v1_crime = get_v1_crime_features(crime)

    # ------------------------------------------------------------
    # EMERGENCY ACCESS BASELINE
    # ------------------------------------------------------------
    emergency = get_emergency_features(crime)

    # ------------------------------------------------------------
    # SAFE ROUTE V1 DEEP-LEARNING PREDICTION
    # ------------------------------------------------------------
    try:
        v1_prediction = predict_route_safety(
            traffic_index=traffic_score,
            lighting_score=lighting_score,
            rainfall_mm=rainfall_mm,
            visibility_km=visibility_km,
            violent_crime_count=v1_crime["violent_crime_count"],
            property_crime_count=v1_crime["property_crime_count"],
            women_crime_count=v1_crime["women_crime_count"],
            other_crime_count=v1_crime["other_crime_count"],
            total_crime_count=v1_crime["total_crime_count"],
            crime_rate_per_1000_exposure=v1_crime["crime_rate_per_1000_exposure"],
            nearest_police_km=emergency["nearest_police_km"],
            nearest_hospital_km=emergency["nearest_hospital_km"],
            emergency_access_score=emergency["emergency_access_score"],
            month=datetime.now().month
        )

        safety_score = float(v1_prediction.get("safety_score", 0) or 0)
        risk_level = v1_prediction.get("risk_level", "Unknown")
    except Exception as error:
        print("Live V1 prediction error:", error)
        safety_score = 0.0
        risk_level = "Unavailable"

    crime_risk = float(crime.get("crime_risk_score", 0) or 0)
    crime_safety = float(crime.get("crime_safety_score", 0) or 0)

    # A clear alert is easier to understand on a phone.
    if crime_risk >= 60:
        safety_alert = "High crime risk detected in this area."
        alert_type = "crime"
    elif safety_score < 45:
        safety_alert = "Higher safety risk detected in this area."
        alert_type = "safety"
    elif weather_score < 60:
        safety_alert = "Weather conditions may require extra caution."
        alert_type = "weather"
    elif lighting_score < 40:
        safety_alert = "Low nighttime lighting detected in this area."
        alert_type = "lighting"
    elif traffic_score < 40:
        safety_alert = "Heavy traffic conditions detected in this area."
        alert_type = "traffic"
    else:
        safety_alert = "No major safety warning detected right now."
        alert_type = "none"

    return {
        "success": True,
        "timestamp": datetime.now().isoformat(),
        "location": {
            "latitude": latitude,
            "longitude": longitude
        },
        "safety_score": round(safety_score, 2),
        "risk_level": risk_level,
        "safety_alert": safety_alert,
        "alert_type": alert_type,
        "lighting": {
            "score": round(lighting_score, 2),
            "value": lighting.get("lighting_value", 0)
        },
        "traffic": {
            "score": round(traffic_score, 2),
            "current_speed_kmph": traffic.get("average_current_speed_kmph", 0),
            "free_flow_speed_kmph": traffic.get("average_free_flow_speed_kmph", 0),
            "delay_seconds": traffic.get("average_delay_seconds", 0),
            "confidence": traffic.get("average_confidence", 0)
        },
        "weather": {
            "score": round(weather_score, 2),
            "condition": weather.get("weather_condition", "Unavailable"),
            "temperature_c": weather.get("average_temperature_c", 0),
            "humidity_percent": weather.get("average_humidity_percent", 0),
            "precipitation_mm": weather.get("average_precipitation_mm", 0),
            "rain_mm": weather.get("average_rain_mm", 0),
            "wind_speed_kmph": weather.get("average_wind_speed_kmph", 0),
            "wind_gusts_kmph": weather.get("average_wind_gusts_kmph", 0),
            "cloud_cover_percent": weather.get("average_cloud_cover_percent", 0),
            "visibility_km": round(visibility_km, 2)
        },
        "crime": {
            "risk_score": round(crime_risk, 2),
            "safety_score": round(crime_safety, 2),
            "location": crime.get("crime_location", "Unknown"),
            "location_type": crime.get("crime_location_type", "unknown"),
            "data_type": crime.get("crime_data_type", "unavailable"),
            "violent_count": v1_crime["violent_crime_count"],
            "property_count": v1_crime["property_crime_count"],
            "women_count": v1_crime["women_crime_count"],
            "total_count": v1_crime["total_crime_count"]
        },
        "emergency": {
            "nearest_police_km": emergency["nearest_police_km"],
            "nearest_hospital_km": emergency["nearest_hospital_km"],
            "access_score": emergency["emergency_access_score"]
        },
        "model": "SafeRoute V1 Multi-Branch Deep Learning"
    }
