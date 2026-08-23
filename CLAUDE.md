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
  the gateway UI is normal).
- Gateway auth: owner JWT bearer token, valid 1 year, self-signed TLS
  (`rejectUnauthorized: false` is intentional). Renewal URL:
  `https://enlighten.enphaseenergy.com/entrez-auth-token?serial_num=482513006020`
- Key endpoints: `/ivp/ensemble/secctrl` (agg_soc = battery %),
  `/production.json?details=1` (solar/load/grid W),
  `/ivp/livedata/status` (battery flow, milliwatts — divide by 1000).

## Architecture

- `server/` — TypeScript, compiled to `build-server/` by `tsc`. Zero runtime
  deps; plain Node 18+. Single process: polls gateway every 30 s, appends to
  `history.jsonl` (48 h rolling, hourly rewrite), serves UI + JSON API on
  `:8787`, auto-fails-over between LAN IP and hotspot IP.
- `src/` — React 19 + TypeScript UI, built by Vite into ONE self-contained
  `dist/index.html` (no external resources — must work with internet down).
- `server/token.ts` — TokenManager: monthly token re-mint using Enlighten
  credentials from `.enphase_credentials.json` (optional, chmod 600, not in
  git). Does NOT support Enphase accounts with MFA.
- API: `GET /api/status` (live sample + token status), `GET /api/history?hours=N`.
- Secrets/state never in git: `.enphase_token`, `.enphase_credentials.json`,
  `history.jsonl`, `*.log` (see .gitignore).

## Commands

- `npm run build` — typecheck app, bundle UI, compile server. Prebuilt output
  is committed, so build only after source changes; commit rebuilt output.
- `npm start` — run in foreground (dev).
- `npm run dev` — Vite hot reload on :5173, proxies /api to :8787.
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
   `http://<this-ip>:8787` with no login.

## Open verification items

- First run against the real gateway: confirm `/api/status` returns soc 100,
  offGrid false.
- Battery sign convention: `battW > 0` is rendered as "discharging"
  (from livedata `storage.agg_p_mw`). Verify next time the battery actually
  charges; if reversed, flip the comparisons where `battW` is consumed
  (`src/App.tsx` tile + `src/format.ts` netDrainW) — the server stores the
  raw signed value.
- Auto-refresh: first monthly token refresh happens ~30 days after token
  creation (2026-08-23); check `monitor.log` for `[token]` lines.

## Conventions

- Don't add runtime npm dependencies to the server — it must run on a bare
  Node install forever.
- The UI must stay a single self-contained HTML file (no CDN, no external
  fonts) — offline operation is the whole point.
- Chart colors follow the validated palette in `src/styles.css` (series-1/2/3
  CSS vars, light+dark); keep status colors (good/warning/critical) reserved
  for status, never as series colors, and never color-only (icon + label).
