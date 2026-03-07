from geopy.geocoders import Nominatim

geolocator = Nominatim(user_agent="city_shield")

location = geolocator.geocode("Индустриална зона 'Планова', Варна, България")

if location:
    print("Address:", location.address)
    print("Latitude:", location.latitude)
    print("Longitude:", location.longitude)
    print(f"Cords to copy: {location.latitude} {location.longitude}")
else:
    print("Location not found")