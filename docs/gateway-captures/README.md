# Gateway captures

Snapshots of the IQ Gateway's JSON endpoints, taken with
`deploy/capture-gateway.sh`, for replaying a real system state through the
server without hardware: `./test/replay.sh docs/gateway-captures/<dir>`.

| Directory | Taken | State |
|---|---|---|
| `2026-09-28-islanded` | 2026-09-28, about an hour into a grid outage | Islanded on battery: relay `mains_oper_state` "open", livedata `main_relay_state` 0, SOC 92 %, house load 734 W all from the batteries, solar 0. secctrl's `offgrid_secctrl.is_active` reads false even so, and every production.json meter reads 0 W. home.json timed out and is absent. |

Still wanted: the same endpoints on grid (baseline), and captures across the
grid-restore transition. Take them from the appliance:
`ssh willow-server 'cd ~/enphase_local && ./deploy/capture-gateway.sh on-grid'`.
