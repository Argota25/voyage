# Voyage

Plan a trip by car, plane, or boat on one map. Type your stops, pick how you are getting there, and Voyage lays out the route, paces overnight stays on long drives, and pulls together places to stay, things to do, events, and travel videos for every stop. A running cost estimate sits at the top so you see the trip total as you plan.

**Status: public beta.** Things break. The "Beta / Send feedback" button in the corner goes straight to the builder.

## How it works

- **Drive:** real road routing on open map data, any distance, with overnight stops paced to the hours you want to drive each day.
- **Fly and boat:** a direct-line estimate between the places you list (no flight or sailing schedules, and the app says so).
- **Per stop:** stays, things to do, events, and videos, plus an editable cost estimate (stays, gas or rental car, food, tickets).
- **Shareable:** every plan is a link (`?mode=drive&stops=Austin, TX|Dallas, TX`).

No accounts, no tracking, no build step. The server is one Node file with zero npm dependencies. It proxies the free map services (OpenStreetMap, Valhalla, Overpass, the US Census geocoder) with caching and polite rate limits, and it keeps every API key on the server.

## Run it locally

Requires Node 20 or newer.

```bash
node server.js
# open http://127.0.0.1:8787/globe.html
```

Optional keys (YouTube, Google Programmable Search, Ticketmaster, Amadeus, Reddit) go in a local `secrets.json` or in environment variables. The app runs without any of them and swaps in plain links where a keyed source is missing. Names are listed in [DEPLOY.md](DEPLOY.md).

## Checks

```bash
python scripts/smoke_test.py   # 20 checks: hardening, API contracts, live drive/fly/boat flows
```

## Data and credits

Map data © OpenStreetMap contributors. Routing by Valhalla on the FOSSGIS public server. Places from Overpass and Wikipedia. Geocoding by Nominatim, Photon, and the US Census Bureau.
