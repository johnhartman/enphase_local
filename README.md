# Enphase local monitor

A small dashboard for your Enphase system that talks **directly to the IQ
Gateway on your LAN** — no internet, no Enphase cloud. Built for outages:
as long as the gateway and this machine have power, you can see battery
charge, solar, house load, and a runtime estimate.

- **Server** (`server/`, TypeScript, zero runtime dependencies): holds your
  token, polls the gateway every 30 s, keeps 48 h of history on disk, serves
  the UI to every device on your network.
- **UI** (`src/`, React + TypeScript): live status, charge + power-flow
  charts, sample table, and threshold alerts — bundled into a single HTML
  file with no external resources, so it loads with the internet down.

## Quick start

Prebuilt output is included — you don't need `npm install` to run it.

```bash
cd ~/enphase_local

# 1. Save your gateway token (the one in your password manager)
echo 'eyJraWQi...' > .enphase_token
chmod 600 .enphase_token

# 2. Start
npm start
```

Then open **http://localhost:8787** on this Mac, or the LAN URL the server
prints (e.g. `http://192.168.0.x:8787`) on any phone or tablet on your
Wi-Fi. Add it to a phone home screen for one-tap access.

## During an outage

- Router still up (on backed-up circuits): everything just works.
- Router down: join this machine to the gateway's own Wi-Fi hotspot
  (`Envoy_XXXXXX` — press the AP-mode button inside the combiner if it isn't
  broadcasting). The server automatically fails over to the gateway's
  hotspot address `172.30.1.1`; the UI shows a "hotspot" chip when it does.

## Monthly token refresh (recommended)

Gateway tokens last a year. The server re-mints one **every 30 days**
whenever the internet is available, so the token on disk always has ~11
months banked and an outage can never catch you with a stale one.

To enable it, create `.enphase_credentials.json` next to the server:

```json
{ "username": "your-enlighten-email", "password": "your-enlighten-password" }
```

```bash
chmod 600 .enphase_credentials.json
```

These are your Enphase (Enlighten) login credentials. They are read from
this file only and sent only to `enphaseenergy.com`, over HTTPS, using the
same two calls the Enphase website makes. Skip this if you'd rather renew
by hand — the UI and server logs will tell you when the token is rejected,
and the renewal URL is:

```
https://enlighten.enphaseenergy.com/entrez-auth-token?serial_num=482513006020
```

Paste the new token into `.enphase_token` and restart.

## Start automatically (macOS)

```bash
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.enphase.localmonitor.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.enphase.localmonitor</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(which node)</string>
    <string>/Users/john/enphase_local/build-server/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/john/enphase_local</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/john/enphase_local/monitor.log</string>
  <key>StandardErrorPath</key><string>/Users/john/enphase_local/monitor.log</string>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/com.enphase.localmonitor.plist
```

It will start at login and restart if it crashes. `launchctl unload …` stops it.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_HOST` | `192.168.0.148` | Gateway LAN IP (reserve it in your router) |
| `GATEWAY_FALLBACK` | `172.30.1.1` | Gateway hotspot address |
| `PORT` | `8787` | Dashboard port |
| `SAMPLE_SECONDS` | `30` | Poll interval |
| `HISTORY_HOURS` | `48` | History retention |
| `GATEWAY_SERIAL` | `482513006020` | Used in renewal URLs |

## Rebuilding after changes

```bash
npm install        # once
npm run build      # type-checks, bundles the UI, compiles the server
npm start
```

`npm run dev` gives hot reload at http://localhost:5173 (proxying `/api` to a
running server).

## Files the server writes

- `.enphase_token` — current gateway token (auto-updated when refresh is on)
- `history.jsonl` — rolling sample history
- `.enphase_credentials.json` — only if you created it; never written by the server

## Notes

- The gateway serves a self-signed certificate; the server expects that and
  authenticates with the bearer token instead.
- The battery charge/discharge sign convention was verified against
  Enphase's `livedata` reporting, but glance at the app the first time the
  battery is actively charging — if the label reads backwards, flip the
  comparison in `server/server.ts` where `battW` is derived.
- The runtime estimate is `available energy ÷ current net drain` — it
  moves with clouds and appliance cycles. Treat it as a guide.
