from geopy.geocoders import Nominatim

geolocator = Nominatim(user_agent="city_shield", domain="localhost:8080", scheme="http")

location = geolocator.geocode("бул. 8-ми Приморски Полк Варна Варна България")

if location:
    print("Address:", location.address)
    print("Latitude:", location.latitude)
    print("Longitude:", location.longitude)
    print(f"Cords to copy: {location.latitude} {location.longitude}")
else:
    print("Location not found")