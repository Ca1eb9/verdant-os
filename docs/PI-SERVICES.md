# Pi services setup

How the Pi runs the farm services so they start at boot, restart when they crash and survive power cuts. Do [WIFI-SETUP.md](WIFI-SETUP.md) first: it sets up FarmNet, the `farmnet` hostname and Mosquitto.

Written for **Raspberry Pi OS Trixie** on a Pi with 4 GB of RAM booting from an SD card.

## What runs

Every service is a **systemd** unit. systemd is built into the OS, so there's nothing extra to install. It starts the services in order (after Mosquitto), restarts them when they crash, keeps their logs and reads their secrets from root-owned files.

| Service | Unit | What it does | Data |
|---|---|---|---|
| Mosquitto | `mosquitto` | MQTT broker, ports 1883 and 9001 (WebSockets) | — |
| Orchestrator | `farm-orchestrator` | Robot state, task queue, commands | `/var/lib/verdant/orchestrator-state.json` |
| Ingester | `farm-ingester` | Records telemetry and operator commands to SQLite | `/var/lib/verdant/farm_telemetry.db` |
| Shelf bridge | `farm-shelf-bridge` | Reads the shelf sensor node over USB serial and publishes its readings ([shelf-sensors.md](shelf-sensors.md)) | — |
| Dashboard | `farm-dashboard` | Web app on `http://farmnet.local:3000` | — |

Networks (set up in [WIFI-SETUP.md](WIFI-SETUP.md)):

- `wlan0`: FarmNet, for robots and laptops. Everything above is reachable here.
- **Uplink** to the internet: `wlan1` (a USB WiFi adapter, the plan) or `eth0` (Ethernet). Only the Pi itself uses it, for `apt`, the clock and the Supabase bridge. The farm keeps running without it.

This doc works with either uplink, or both.

Where things live:

- `/opt/verdant-os`: the repo, owned by the `farm` user the services run as
- `/etc/verdant/*.env`: settings and secrets, one file per service (not in git)
- `/var/lib/verdant`: data the services write, kept outside the repo so a deploy never touches it
- `/etc/systemd/system/farm-*.service`: copies of `deploy/systemd/`, installed by the deploy script

## One-time setup

Run these on the Pi, logged in as your normal user, with the uplink connected (`ping google.com` works).

### 1. Packages

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git build-essential python3 ufw
```

`build-essential` and `python3` are for `better-sqlite3` (the ingester) and `serialport` (the shelf bridge), in case npm has to compile them.

### 2. Node.js 22

Debian's `nodejs` package is too old for the dashboard. Install the current LTS from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
```

`node --version` should print `v22.x`.

### 3. Service user and repo

```bash
sudo useradd --system --create-home --home-dir /var/lib/farm --shell /usr/sbin/nologin farm
sudo git clone https://github.com/Ca1eb9/verdant-os.git /opt/verdant-os
sudo chown -R farm:farm /opt/verdant-os
```

The services run as `farm`, which can't log in and can only write to its own folders.

### 4. Settings and secrets

```bash
sudo install -d -m 750 -o root -g farm /etc/verdant
for f in orchestrator ingester shelf-bridge dashboard; do
  sudo install -m 640 -o root -g farm /opt/verdant-os/deploy/env/$f.env.example /etc/verdant/$f.env
done
sudo install -m 640 -o root -g farm /opt/verdant-os/farm-controller/shelf-bridge-config.json /etc/verdant/shelf-bridge-config.json
sudo nano /etc/verdant/dashboard.env
sudo nano /etc/verdant/shelf-bridge-config.json
```

In `dashboard.env`, set the Supabase values (the URL and the publishable key, never the secret key: [SUPABASE-SETUP.md](SUPABASE-SETUP.md) step 5). It needs no `OPERATOR_KEY`: on FarmNet the dashboard sends commands straight over MQTT. `NEXT_PUBLIC_MQTT_WS_URL` (the broker's WebSocket listener) gives the dashboard live farm data on FarmNet; the example's `ws://192.168.4.1:9001` is right for the setup in [WIFI-SETUP.md](WIFI-SETUP.md). Set `NEXT_PUBLIC_FARM_ID` and `NEXT_PUBLIC_FARM_NAME` to this farm's row in Supabase's `farms` table ([SUPABASE-SETUP.md](SUPABASE-SETUP.md)): the dashboard shows only this farm. These are fixed when the dashboard is built, so after changing them run the deploy script, not just a restart. Leave `NEXT_PUBLIC_DASHBOARD_API_URL` unset until the Dashboard API exists. The deploy script reads this file with bash, so quote any value with spaces: `NEXT_PUBLIC_FARM_NAME="North Farm"`.

In `shelf-bridge-config.json`, set each shelf's `port` to its node's stable path (plug the Uno in, then `ls /dev/serial/by-id/`) and its pH calibration ([shelf-sensors.md](shelf-sensors.md#ph-calibration)). This copy belongs to this Pi; the repo's file is only the template, and a deploy never touches this one. The service can open serial ports through the `dialout` group (set in its unit).

The orchestrator, ingester and shelf bridge `.env` files work as they are.

These files are readable by root and the `farm` user only. Never copy them into the repo; it's public.

### 5. Watchdog and logs

```bash
cd /opt/verdant-os
sudo install -D -m 644 deploy/systemd/watchdog.conf /etc/systemd/system.conf.d/verdant-watchdog.conf
sudo install -D -m 644 deploy/systemd/journald.conf /etc/systemd/journald.conf.d/verdant.conf
sudo systemctl daemon-reexec
sudo systemctl restart systemd-journald
```

- **Watchdog:** if the Pi freezes, the hardware watchdog reboots it within about 15 seconds, and the services come back on their own.
- **Logs:** kept across reboots (so you can see what happened before a crash) but capped at 100 MB and one month, to limit SD card writes.

### 6. Build and start the services

```bash
sudo bash /opt/verdant-os/scripts/pi-deploy.sh
```

The first run takes several minutes, mostly the dashboard build. It installs the unit files, enables them at boot and starts them. It ends by printing each service's status; all four should be `active (running)`.

### 7. Firewall

Mosquitto and the dashboard listen on every network interface. Allow everything on FarmNet (`wlan0`), but only SSH and mDNS (`farmnet.local`) on the uplink, so nothing on your home or school network can reach the broker:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow in on wlan0
for uplink in wlan1 eth0; do
  sudo ufw allow in on $uplink to any port 22 proto tcp
  sudo ufw allow in on $uplink to any port 5353 proto udp
done
sudo ufw enable
```

The rules cover both uplinks, so they keep working if you switch between the USB adapter and Ethernet; a rule for an interface that isn't there does nothing. Add the SSH rules before `ufw enable`, or an SSH session over the uplink drops.

### 8. SSH keys (recommended)

From your laptop (on FarmNet, or on the same network as the uplink), copy your key, check that it logs in without a password, then turn passwords off:

```bash
ssh-copy-id <user>@farmnet.local
```

```bash
echo "PasswordAuthentication no" | sudo tee /etc/ssh/sshd_config.d/no-passwords.conf
sudo systemctl restart ssh
```

Keep a keyboard and monitor handy the first time, in case the key doesn't work.

### 9. Check it survives a reboot

```bash
sudo reboot
```

After it's back:

1. `systemctl status mosquitto farm-orchestrator farm-ingester farm-shelf-bridge farm-dashboard`: all `active (running)`
2. `journalctl -u farm-orchestrator -n 20`: connected to the broker
3. `curl -sI http://localhost:3000 | head -1`: `HTTP/1.1 200 OK`
4. `systemctl show -p RuntimeWatchdogUSec`: `14s`
5. `vcgencmd get_throttled`: `throttled=0x0` (anything else means the power supply is too weak)
6. `timedatectl`: `System clock synchronized: yes`
7. `sudo ufw status verbose`: the rules above
8. `nmcli device`: `wlan0` on `FarmNet`, and the uplink (`wlan1` or `eth0`) connected; `ip route show default` goes out the uplink

## Day to day

| To | Run |
|---|---|
| See if everything is running | `systemctl status 'farm-*' mosquitto` |
| Follow a service's logs | `journalctl -u farm-orchestrator -f` |
| Follow all farm logs | `journalctl -u 'farm-*' -f` |
| Errors since the last boot | `journalctl -b -p err` |
| Restart a service | `sudo systemctl restart farm-orchestrator` |
| Update to the latest code | `sudo bash /opt/verdant-os/scripts/pi-deploy.sh` |
| Try a branch | `sudo bash /opt/verdant-os/scripts/pi-deploy.sh <branch>` |
| Watch MQTT traffic | `mosquitto_sub -t 'farm/#' -v` |
| Turn the Pi off | `sudo poweroff`, then wait for the green LED to stop before unplugging |

The deploy script stops the services while it installs (a few minutes). That's safe: the robots keep working without the Pi and report their real state when it's back.

### Running a service by hand

To debug with your own terminal, stop the unit and run the same thing as the `farm` user:

```bash
sudo systemctl stop farm-orchestrator
sudo -u farm -H bash -c 'cd /opt/verdant-os/farm-controller/orchestrator && set -a && . /etc/verdant/orchestrator.env && npx tsx src/index.ts'
```

`Ctrl+C` stops it; `sudo systemctl start farm-orchestrator` puts it back.

### Adding a service (e.g. the Supabase bridge)

The Dashboard API is added the same way, as `farm-dashboard-api` on its own port. It serves data only; the dashboard stays on `farm-dashboard`. Once it runs, set `NEXT_PUBLIC_DASHBOARD_API_URL` in `dashboard.env` to `http://192.168.4.1:<its port>` and deploy.

1. Copy `deploy/systemd/farm-ingester.service` to `farm-<name>.service` and change the description, `WorkingDirectory` and `EnvironmentFile`.
2. Add `deploy/env/<name>.env.example`, and create `/etc/verdant/<name>.env` from it on the Pi (step 4).
3. Add `farm-<name>` to `SERVICES` in `scripts/pi-deploy.sh`, then deploy.

## SD card care

SD cards fail from sudden power loss during a write and from wear. With this setup:

- **Always shut down with `sudo poweroff`** before unplugging. This matters more than anything else here.
- Logs are capped (step 5). The ingester's database is the main writer, about one row per robot per second, which a good card handles for years.
- Use a quality A2-rated card from a known brand.
- Back up now and then:
  - the data: `sudo tar czf ~/verdant-backup-$(date +%F).tgz /var/lib/verdant /etc/verdant`, then copy it off the Pi
  - the whole card: Raspberry Pi OS's **SD Card Copier** onto a spare card, so a dead card is a two-minute swap

## Things to know

- **No real-time clock.** The Pi sets its clock over the uplink at boot. Without the uplink it restores the time it last saved, which can be behind. The orchestrator doesn't care (it uses receive times), but timestamps in the ingester's database can be off after a long time without the uplink.
- **A WiFi uplink drops more often than Ethernet.** Nothing on the farm depends on it; only `apt`, the clock and the Supabase bridge do, and the bridge has to reconnect on its own when it comes back.
- **Power.** Use the official 5 V / 5 A (Pi 5) or 5 V / 3 A (Pi 4) supply. Under-voltage causes random crashes; `vcgencmd get_throttled` shows it.
- **Mosquitto** isn't a farm unit: it's the OS package's own `mosquitto.service`, configured in [WIFI-SETUP.md](WIFI-SETUP.md). The farm services start after it; while it's down they keep retrying every 5 seconds, and they reconnect on their own when it restarts.
- **Retained messages.** The orchestrator publishes the farm layout and each robot's state as retained messages, which the dashboard reads when it connects. Mosquitto keeps them across its own restarts only with persistence on: check `grep persistence /etc/mosquitto/mosquitto.conf` shows `persistence true` (the default).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `status=203/EXEC` | Node isn't at `/usr/bin/node`. Check `which node`; reinstall from step 2. |
| Orchestrator or ingester keeps restarting with `ECONNREFUSED` | Mosquitto isn't running: `systemctl status mosquitto`, `journalctl -u mosquitto -n 20`. |
| `Cannot find module` after an update | The build didn't finish. Run the deploy script again and read its output. |
| `EROFS: read-only file system` | A service tried to write outside its allowed folders. Data belongs in `/var/lib/verdant`; set the path in its env file. |
| Ingester fails on `better-sqlite3` | It was built for a different Node version. Rerun the deploy script (it reinstalls), and check step 1's packages are installed. |
| Dashboard shows old content | The deploy rebuilds it; make sure the script reached `== start`. |
| `farmnet.local` doesn't resolve over the uplink | The mDNS firewall rule (step 7) is missing. |
| FarmNet missing after a reboot, or the uplink on the wrong radio | `wlan0` and `wlan1` swapped names. See step 4 of the USB adapter section in [WIFI-SETUP.md](WIFI-SETUP.md#no-ethernet-use-a-usb-wifi-adapter). |
| Can't SSH over the uplink | The uplink's address changes with DHCP; use `farmnet.local`, or SSH over FarmNet at `192.168.4.1`. |
| Shelf bridge logs `can't open /dev/...` | The node isn't plugged in, or `port` in `/etc/verdant/shelf-bridge-config.json` is wrong (`ls /dev/serial/by-id/`). It keeps retrying every few seconds. |
| Shelf readings never appear | The node needs the shelf firmware (`firmware/shelf-sensor`); see "What happens when things fail" in [shelf-sensors.md](shelf-sensors.md). |
| Deploy prints `dashboard.env: line N: ...: command not found` | A value on that line has a space and no quotes, so it wasn't set. Quote it (`NEXT_PUBLIC_FARM_NAME="North Farm"`) and rerun the deploy script. |
| Dashboard still shows the old farm id or name after editing `dashboard.env` | `NEXT_PUBLIC_*` values are fixed at build time: rerun the deploy script (a restart isn't enough), then hard-refresh the page. |
| Dashboard says "No farm to show" on FarmNet | `NEXT_PUBLIC_FARM_ID` is empty or not a valid id (lowercase letters, digits, dashes) in `/etc/verdant/dashboard.env`. Set it and rerun the deploy script. |
| Dashboard says "Disconnected" on FarmNet | Mosquitto is down or its port 9001 listener is missing ([WIFI-SETUP.md](WIFI-SETUP.md) step 5), or `NEXT_PUBLIC_MQTT_WS_URL` is wrong in `/etc/verdant/dashboard.env`; fix it and rerun the deploy script (it's fixed at build time). |
| Dashboard map shows "Default farm layout" | The orchestrator isn't running, or Mosquitto lost its retained messages (persistence off): restart the orchestrator. |
