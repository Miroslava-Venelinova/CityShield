# ── Build stage ───────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

COPY . .
RUN dotnet publish CityShieldAPI/CityShieldAPI.csproj -c Release -o /app/publish

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app/publish .

# The app binds http://0.0.0.0:5276 itself (Program.cs). TLS is expected to be
# terminated by a reverse proxy (nginx/Caddy/Traefik) in front of this container.
EXPOSE 5276

# Firebase service-account key: mount at /app/fcm.json
# (or set Firebase__CredentialsFile to another mounted path).
ENTRYPOINT ["dotnet", "CityShieldAPI.dll"]
