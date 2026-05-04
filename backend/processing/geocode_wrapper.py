"""
Wrapper module for geocoding
"""

from geopy.geocoders import Nominatim

def geocode_location(location_name: str):
    """
    Function used for geocoding: city, village, locality, district, and residential complex
    """
    geolocator = Nominatim(user_agent="city_shield", domain="localhost:8080", scheme="http")
    prefixes = ("кв. ", "ж.к. ", "м-т ", "с. ", "гр. ", "к.к. ")

    # first attempt - geocode the location name as it is
    location = geolocator.geocode(location_name + " Варна Варна България")

    if location:
        return location

    # second attempt - geocode without the prefix
    for p in prefixes:
        location_name = location_name.removeprefix(p)
    location = geolocator.geocode(location_name + " Варна Варна България")
    
    if location:
        return location
    
    # third attempt - try with every possible prefix
    for p in prefixes:
            location_name = p + location_name
            location = geolocator.geocode(location_name + " Варна Варна България")
            if location:
                return location
            location_name = location_name.removeprefix(p)

    return None
    
def geocode_sublocation(sublocation_name: str):
    """
    Function used for geocoding: streets and boulevards 
    """
    geolocator = Nominatim(user_agent="city_shield", domain="localhost:8080", scheme="http")

    # first attempt - geocode the location name as it is
    location = geolocator.geocode(sublocation_name + " Варна Варна България")
    if location:
         return location
    
    # second attempt - remove the prefix
    # in osm streets do not have "ул."
    sublocation_name = sublocation_name.replace("ул.", "").strip()
    location = geolocator.geocode(sublocation_name + " Варна Варна България")
    return location