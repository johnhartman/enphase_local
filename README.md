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

Then open **https://localhost** on this Mac, or the LAN URL the server
prints (e.g. `https://192.168.0.x`) on any phone or tablet on your Wi-Fi.
Plain `http://` addresses redirect to `https://`. Add it to a phone home
screen for one-tap access.

The dashboard is served over TLS so the browser treats it as a secure
context, which desktop notifications require. On first start the server
mints a self-signed certificate (`cert.pem` / `key.pem` in the project
root, valid ten years, naming localhost, this machine's hostname and its
LAN addresses) using the system `openssl`. Each browser shows a one-time
"not private" warning until you trust that certificate on the device;
delete the two files and restart to mint a fresh one (for example after
the machine's IP changes).

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
sudo ./deploy/install-daemon.sh
```

This installs a **LaunchDaemon**: the monitor starts at boot — before anyone
logs in — restarts if it crashes, and runs as your normal user (not root).
That's what you want on a headless or appliance Mac; no auto-login needed.

```bash
./deploy/install-daemon.sh --status        # is it running?
tail -f monitor.log                        # server output
sudo ./deploy/install-daemon.sh            # re-run after npm run build to pick up changes
sudo ./deploy/install-daemon.sh --uninstall
```

For unattended recovery after a power cycle, also set the machine itself up
as an appliance: `sudo pmset -a sleep 0 disablesleep 1 autorestart 1`, and
leave FileVault off on this Mac — an encrypted boot disk stops at the unlock
screen and the daemon never starts. Saving the gateway's `Envoy_XXXXXX`
Wi-Fi network with auto-join gives you hands-off hotspot failover if the
router dies mid-outage.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_HOST` | `192.168.0.148` | Gateway LAN IP (reserve it in your router) |
| `GATEWAY_FALLBACK` | `172.30.1.1` | Gateway hotspot address |
| `PORT` | `443` | Dashboard (HTTPS) port |
| `HTTP_PORT` | `80` | Plain-HTTP port that redirects to the dashboard |
| `TLS_CERT` | `cert.pem` | Certificate to serve (minted if missing) |
| `TLS_KEY` | `key.pem` | Private key for `TLS_CERT` (minted if missing) |
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
