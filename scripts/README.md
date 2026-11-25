# scripts

Helper scripts for the Pi. They aren't service code. Each script's header
comment says how to run it and what it needs.

| Script | What it does | Docs |
|---|---|---|
| `pi-deploy.sh` | Pulls the latest code (or a branch), builds, installs the systemd units and restarts the farm services | [PI-SERVICES.md](../docs/PI-SERVICES.md) |
| `pi-env-sync.sh` | Adds settings a newer `deploy/env/*.env.example` has to the Pi's `/etc/verdant/*.env` | [PI-SERVICES.md](../docs/PI-SERVICES.md#new-settings-after-an-update) |
| `farmnet-channel.sh` | Starts FarmNet on the quietest 2.4 GHz channel at boot (`farmnet-channel.service`) | [WIFI-SETUP.md](../docs/WIFI-SETUP.md#farmnets-channel) |
| `farmnet-stations.sh` | Drops FarmNet stations that stopped answering, so a reset robot can rejoin (`farmnet-stations.service`) | [WIFI-SETUP.md](../docs/WIFI-SETUP.md#stale-stations) |

Each `*-test.sh` tests its script against fakes, with no Pi or WiFi needed:

```bash
bash scripts/pi-env-sync-test.sh
bash scripts/farmnet-channel-test.sh
bash scripts/farmnet-stations-test.sh
```
