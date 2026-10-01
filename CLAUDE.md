# Enphase local monitor

Local dashboard for this house's Enphase solar + battery system. Polls the
IQ Gateway directly over the LAN so battery status stays visible during a
grid outage when the ISP (and Enphase cloud) are down. This box is meant to
run as an unattended appliance.

## System facts

- IQ Gateway: `192.168.0.148` (DHCP-reserved), serial `482524024519` is WRONG —
  correct serial is `482513006020`. Hotspot fallback address when joined to
  the gateway's own Wi-Fi (`Envoy_XXXXXX`): `172.30.1.1`.
- 2× IQ Battery 5P ≈ 10 kWh, reserve set to 100% (full-backup mode — the
  batteries idle at 100% and only discharge when islanded; "0 operating" on
  the gateway UI is normal). Measured 2026-09-28: they deliver ≈ 75 Wh of AC
  per SOC point, not the nominal 100 — the server re-learns this from every
  closed outage record and the on-grid runtime estimate uses it.
- Gateway auth: owner JWT bearer token, valid 1 year, self-signed TLS
  (`rejectUnauthorized: false` is intentional). Renewal URL:
  `https://enlighten.enphaseenergy.com/entrez-auth-token?serial_num=482513006020`
- Key endpoints: `/ivp/ensemble/secctrl` (agg_soc = battery %),
  `/ivp/ensemble/relay` (`mains_oper_state` "open" = islanded — verified in
  the 2026-09-28 outage; secctrl's `offgrid_secctrl.is_active` stayed false),
  `/ivp/livedata/status` (solar/load/grid/battery, milliwatts — divide by
  1000; `main_relay_state` 0 = islanded), `/production.json?details=1`
  (fallback only — its meters all read 0 W while islanded, and it answered
  in 4–10 s during the outage), `/admin/lib/tariff` (`tariff.storage_settings.mode`
  = battery profile: `backup` / `self-consumption` / `economy`, shown as the
  app's Full Backup / Self-Consumption / Savings; Storm Guard is NOT exposed
  by the gateway — verified 2026-09-29 against the gateway's UI bundle and
  the unofficial API docs).

## Architecture

- `server/` — TypeScript, compiled to `build-server/` by `tsc`. Zero runtime
  deps; plain Node 18+. Single process: polls gateway every 30 s, appends to
  `history.jsonl` (48 h rolling, hourly rewrite), serves UI + JSON API over
  HTTPS on `:443` (self-signed `cert.pem`/`key.pem` minted on first start
  with the system openssl; `:80` redirects), auto-fails-over between LAN IP
  and hotspot IP.
- `src/` — React 19 + TypeScript UI, built by Vite into ONE self-contained
  `dist/index.html` (no external resources — must work with internet down).
- `server/token.ts` — TokenManager: monthly token re-mint using Enlighten
  credentials from `.enphase_credentials.json` (optional, chmod 600, not in
  git). Does NOT support Enphase accounts with MFA.
- API: `GET /api/status` (live sample + token status), `GET /api/history?hours=N`,
  `GET /api/outages`.
- Grid outages (spans of `offGrid` samples) are logged to `outages.jsonl` —
  never pruned, rewritten atomically on every sample while an outage is open
  so it survives a restart. `[outage]` lines in `monitor.log` mark start/end.
- Secrets/state never in git: `.enphase_token`, `.enphase_credentials.json`,
  `history.jsonl`, `outages.jsonl`, `*.log`, `cert.pem`, `key.pem` (see .gitignore).

## Commands

- `npm run build` — typecheck app, bundle UI, compile server. Prebuilt output
  is committed, so build only after source changes; commit rebuilt output.
- `npm start` — run in foreground (dev).
- `npm run dev` — Vite hot reload on :5173, proxies /api to https://localhost:443.
- `sudo ./deploy/install-daemon.sh` — install/update the LaunchDaemon
  (starts at boot pre-login, runs as the invoking user, logs to
  `monitor.log`). `--status`, `--uninstall`, `--print-plist`.

## Appliance setup on this Mac (if not done yet)

1. `.enphase_token` in repo root (owner gets it from their password manager),
   chmod 600. Optionally `.enphase_credentials.json` for monthly refresh.
2. `sudo ./deploy/install-daemon.sh`
3. `sudo pmset -a sleep 0 disablesleep 1 autorestart 1`
4. FileVault must stay OFF (encrypted boot disk blocks unattended restart).
5. Software Update: disable automatic macOS installs (no surprise reboots).
6. Save the `Envoy_XXXXXX` Wi-Fi network with auto-join (hotspot failover);
   prefer Ethernet for normal operation. Give this Mac a DHCP reservation.
7. Acceptance test: pull power, box must boot to a working dashboard at
   `https://<this-ip>` with no login (accept the self-signed cert once per
   device; `http://<this-ip>` must redirect there).

## Open verification items

- Battery sign convention: verified 2026-09-28 while islanded — livedata
  `storage.agg_p_mw` was +734280 with load 734 W, solar 0, grid 0, so
  `battW > 0` really is discharging.
- Auto-refresh: verified — `/api/status` on 2026-09-28 showed lastRefresh ok
  on 2026-09-22, "new token valid until 2027-09-22".
- Grid restore: verified 2026-09-28 at 05:50 EDT — `mains_oper_state` went
  back to "closed", the dashboard flipped to "on grid", and the outage record
  closed itself (4 h 16 m, 100 % → 72 %, 1.97 kWh). Both states are captured
  under `docs/gateway-captures/` and replay with `test/replay.sh`.

## Conventions

- Don't add runtime npm dependencies to the server — it must run on a bare
  Node install forever.
- The UI must stay a single self-contained HTML file (no CDN, no external
  fonts) — offline operation is the whole point.
- Chart colors follow the validated palette in `src/styles.css` (series-1/2/3
  CSS vars, light+dark); keep status colors (good/warning/critical) reserved
  for status, never as series colors, and never color-only (icon + label).
