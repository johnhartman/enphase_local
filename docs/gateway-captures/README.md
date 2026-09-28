# Gateway captures

Snapshots of the IQ Gateway's JSON endpoints, taken with
`deploy/capture-gateway.sh`, for replaying a real system state through the
server without hardware: `./test/replay.sh docs/gateway-captures/<dir>`.

| Directory | Taken | State |
|---|---|---|
| `2026-09-28-islanded` | 2026-09-28, about an hour into a grid outage | Islanded on battery: relay `mains_oper_state` "open", livedata `main_relay_state` 0, SOC 92 %, house load 734 W all from the batteries, solar 0. secctrl's `offgrid_secctrl.is_active` reads false even so, and every production.json meter reads 0 W. home.json timed out and is absent. |
| `2026-09-28T1209Z-on-grid` | 2026-09-28, about 25 min after the same outage ended | On grid, batteries recharging: relay `mains_oper_state` "closed", `Enchg_grid_mode` "multimode-ongrid", livedata `main_relay_state` 1, SOC 81 %, load 1935 W, grid import 2262 W, battery −437 W (charging), solar 110 W. `offgrid_secctrl.is_active` is false here too, so it never distinguished the two states. production.json total-consumption reads 2373 W against livedata's 1935 W load. |

Still wanted: a capture taken during the drop or restore itself. Take one from
the appliance with
`ssh willow-server 'cd ~/enphase_local && ./deploy/capture-gateway.sh <label>'`.
