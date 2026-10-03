# Pi services setup

How the Pi runs the farm services so they start at boot, restart when they crash and survive power cuts. Do [WIFI-SETUP.md](WIFI-SETUP.md) first: it sets up FarmNet, the `farmnet` hostname and Mosquitto.

Written for **Raspberry Pi OS Trixie** on a Pi with 4 GB of RAM booting from an SD card.

## What runs

Every service is a **systemd** unit. systemd is built into the OS, so there's nothing extra to install. It starts the services in order (after Mosquitto), restarts them when they crash, keeps their logs and reads their secrets from root-owned files.

| Service | Unit | What it does | Data |
|---|---|---|---|
| Mosquitto | `mosquitto` | MQTT broker, ports 1883 and 9001 (WebSockets) | — |
| Orchestrator | `farm-orchestrator` | Robot state, task queue, commands | `/var/lib/verdant/orchestrator-state.json` |
| Ingester | `farm-ingester` | Records telemetry to SQLite | `/var/lib/verdant/farm_telemetry.db` |
| Dashboard | `farm-dashboard` | Web app on `http://farmnet.local:3000` | — |

Where things live:

- `/opt/verdant-os`: the repo, owned by the `farm` user the services run as
- `/etc/verdant/*.env`: settings and secrets, one file per service (not in git)
- `/var/lib/verdant`: data the services write, kept outside the repo so a deploy never touches it
- `/etc/systemd/system/farm-*.service`: copies of `deploy/systemd/`, installed by the deploy script

## One-time setup

Run these on the Pi, logged in as your normal user.

### 1. Packages

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git build-essential python3 ufw
```

`build-essential` and `python3` are for `better-sqlite3` (the ingester), in case npm has to compile it.

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
for f in orchestrator ingester dashboard; do
  sudo install -m 640 -o root -g farm /opt/verdant-os/deploy/env/$f.env.example /etc/verdant/$f.env
done
sudo nano /etc/verdant/dashboard.env
```

In `dashboard.env`, set `OPERATOR_KEY` (the dashboard asks for it before sending robot commands; `openssl rand -hex 16` makes a good one) and the Supabase values. The orchestrator and ingester files work as they are.

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

The first run takes several minutes, mostly the dashboard build. It installs the unit files, enables them at boot and starts them. It ends by printing each service's status; all three should be `active (running)`.

### 7. Firewall

Mosquitto listens on every network interface. Allow everything on FarmNet, but only SSH and mDNS (`farmnet.local`) on the Ethernet side:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow in on wlan0
sudo ufw allow in on eth0 to any port 22 proto tcp
sudo ufw allow in on eth0 to any port 5353 proto udp
sudo ufw enable
```

Add the `eth0` SSH rule before `ufw enable`, or an SSH session over Ethernet drops.

### 8. SSH keys (recommended)

From your laptop, copy your key, check that it logs in without a password, then turn passwords off:

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

1. `systemctl status mosquitto farm-orchestrator farm-ingester farm-dashboard`: all `active (running)`
2. `journalctl -u farm-orchestrator -n 20`: connected to the broker
3. `curl -sI http://localhost:3000 | head -1`: `HTTP/1.1 200 OK`
4. `systemctl show -p RuntimeWatchdogUSec`: `14s`
5. `vcgencmd get_throttled`: `throttled=0x0` (anything else means the power supply is too weak)
6. `timedatectl`: `System clock synchronized: yes`
7. `sudo ufw status verbose`: the rules above

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

- **No real-time clock.** The Pi sets its clock over the internet (Ethernet) at boot. Without Ethernet it restores the time it last saved, which can be behind. The orchestrator doesn't care (it uses receive times), but timestamps in the ingester's database can be off after a long outage without Ethernet.
- **Power.** Use the official 5 V / 5 A (Pi 5) or 5 V / 3 A (Pi 4) supply. Under-voltage causes random crashes; `vcgencmd get_throttled` shows it.
- **Mosquitto** isn't a farm unit: it's the OS package's own `mosquitto.service`, configured in [WIFI-SETUP.md](WIFI-SETUP.md). The farm services wait for it and restart if it does.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `status=203/EXEC` | Node isn't at `/usr/bin/node`. Check `which node`; reinstall from step 2. |
| Orchestrator or ingester keeps restarting with `ECONNREFUSED` | Mosquitto isn't running: `systemctl status mosquitto`, `journalctl -u mosquitto -n 20`. |
| `Cannot find module` after an update | The build didn't finish. Run the deploy script again and read its output. |
| `EROFS: read-only file system` | A service tried to write outside its allowed folders. Data belongs in `/var/lib/verdant`; set the path in its env file. |
| Ingester fails on `better-sqlite3` | It was built for a different Node version. Rerun the deploy script (it reinstalls), and check step 1's packages are installed. |
| Dashboard shows old content | The deploy rebuilds it; make sure the script reached `== start`. |
| `farmnet.local` doesn't resolve over Ethernet | The mDNS firewall rule (step 7) is missing. |
| Robot commands fail with "Remote commands are turned off" | `OPERATOR_KEY` is empty in `/etc/verdant/dashboard.env`. Set it, then `sudo systemctl restart farm-dashboard`. |
