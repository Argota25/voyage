# Deploying the public beta (Railway)

The server binds to `127.0.0.1` unless told otherwise, so a local run is never exposed. On Railway it detects `RAILWAY_ENVIRONMENT` and switches on public mode by itself: it binds `0.0.0.0`, trusts Railway's proxy, and allows the generated `*.up.railway.app` domain. The variables below override those defaults.

## Environment variables

| Variable | Value | Why |
|---|---|---|
| `HOST` | `0.0.0.0` (automatic on Railway) | Listen on the host's network interface. Railway sets `PORT` itself. |
| `TRUST_PROXY` | `1` (automatic on Railway) | Read the real visitor IP from Railway's `X-Forwarded-For` (rightmost entry) for rate limiting, and send HSTS. |
| `VOYAGE_ORIGINS` | `https://<your-domain>,https://www.<your-domain>` | Only these sites may call the API, and only these hostnames are served. The Railway domain is added automatically. Needed once a custom domain is attached. Comma separated, no trailing slashes. |
| `VOYAGE_CONTACT` | an email you read | Goes in the User-Agent sent to OpenStreetMap services. Their usage policy requires a way to reach the operator. Defaults to the GitHub repo URL. |
| `YOUTUBE_API_KEY` | from `secrets.json` (`youtube`) | Travel videos. Capped in code at 90 lookups a day (the free quota is about 99). |
| `GOOGLE_CSE_CX` | from `secrets.json` (`google_cx`) | Web results band. `GOOGLE_API_KEY` falls back to the YouTube key. Capped at 95 a day. |
| `TICKETMASTER_KEY`, `AMADEUS_CLIENT_ID`, `AMADEUS_CLIENT_SECRET`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | optional | Each one lights up a band. Leave unset and the app shows plain links instead. |

Never commit `secrets.json`. It is in `.gitignore`.

## Steps

1. Push this repo to GitHub.
2. Railway: New Project, Deploy from GitHub repo, pick the repo. Railway detects Node from `package.json` and runs `npm start`.
3. Variables tab: add the variables above.
4. Settings, Networking: Generate Domain. The app allows that address automatically.
5. `railway.json` points the health check at `/healthz`.
6. Custom domain: Settings, Networking, Custom Domain. Add the CNAME record Railway shows at your registrar, then add `https://<your-domain>` to `VOYAGE_ORIGINS` and redeploy.

## After each deploy

- Open `https://<domain>/healthz` and expect `{"ok":true}`.
- Plan one drive, one flight, and one boat trip on a phone and on a laptop.
- `https://<domain>/secrets.json` must answer 403.

## Limits to watch during a launch spike

The free upstreams are shared community servers. A burst of traffic from one Reddit post all arrives from the single Railway IP.

- **Nominatim** is queued to 1 request a second. Photon and the Census geocoder take over when it cools down.
- **Overpass** throttles busy IPs. Empty answers are never cached, so it recovers on its own.
- **Valhalla (FOSSGIS)** is fair-use. Routes are cached 6 hours by stop list.
- **OpenStreetMap tiles** load straight from each visitor's browser, so tile load spreads across visitor IPs rather than ours.
- The in-memory cache resets on every deploy, so the first plans after a deploy are slower.
