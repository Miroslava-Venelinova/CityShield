"""
Wrapper module for geocoding.
NOTE: with the current approach this module is useless
"""

import logging
from geopy.geocoders import Nominatim

from config import cfg

log = logging.getLogger(__name__)

_SEARCH_SUFFIX = " Варна Варна България"
_PREFIXES = ("кв. ", "ж.к. ", "м-т ", "с. ", "гр. ", "к.к. ")


def _make_geolocator() -> Nominatim:
    return Nominatim(
        user_agent=cfg.NOMINATIM_USER_AGENT,
        domain=cfg.NOMINATIM_HOST,
        scheme=cfg.NOMINATIM_SCHEME,
    )


def geocode_location(location_name: str):
    """
    Geocode a city, village, locality, district, or residential complex.
    Tries up to three strategies before giving up.
    """
    geolocator = _make_geolocator()

    # First attempt — geocode the location name as-is
    location = geolocator.geocode(location_name + _SEARCH_SUFFIX)
    if location:
        return location

    # Second attempt — strip any known prefix then retry
    stripped = location_name
    for p in _PREFIXES:
        stripped = stripped.removeprefix(p)
    location = geolocator.geocode(stripped + _SEARCH_SUFFIX)
    if location:
        return location

    # Third attempt — try prepending every possible prefix
    for p in _PREFIXES:
        candidate = p + stripped
        location = geolocator.geocode(candidate + _SEARCH_SUFFIX)
        if location:
            return location

    return None


def geocode_sublocation(sublocation_name: str):
    """
    Geocode a street or boulevard.
    """
    geolocator = _make_geolocator()

    # First attempt — geocode as-is
    location = geolocator.geocode(sublocation_name + _SEARCH_SUFFIX)
    if location:
        return location

    # Second attempt — strip "ул." prefix (OSM streets omit it)
    stripped = sublocation_name.replace("ул.", "").strip()
    return geolocator.geocode(stripped + _SEARCH_SUFFIX)
