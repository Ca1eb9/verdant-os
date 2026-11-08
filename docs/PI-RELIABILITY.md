# Keeping the Pi running

What keeps the farm's Pi up through freezes, power cuts and worn-out storage,
what's already set up, and what to add. Setting up the Pi itself is in
[PI-SERVICES.md](PI-SERVICES.md), FarmNet in [WIFI-SETUP.md](WIFI-SETUP.md).

## Already in place

These come with the normal setup; nothing to add.

| What can go wrong | What handles it | Where |
|---|---|---|
| The Pi freezes | The hardware watchdog reboots it within about 15 s | [PI-SERVICES.md step 5](PI-SERVICES.md#5-watchdog-and-logs) |
| A farm service crashes | systemd restarts it after 5 s, with no limit on retries | `deploy/systemd/*.service` |
| The Pi reboots | Every farm service starts at boot and waits for the broker | [PI-SERVICES.md step 9](PI-SERVICES.md#9-check-it-survives-a-reboot) |
| Logs fill the card | Capped at 100 MB and one month | [PI-SERVICES.md step 5](PI-SERVICES.md#5-watchdog-and-logs) |
| The database grows forever | The ingester keeps 7 days and deletes older rows daily | `RETENTION_DAYS` in `ingester.env` |
| The broker or uplink drops | Services reconnect on their own; the Supabase bridge holds its rows until the uplink is back | [PI-SERVICES.md](PI-SERVICES.md#things-to-know) |
| A robot can't rejoin FarmNet after a reset | `farmnet-stations` drops the stale entry within about 20 s (enable it) | [WIFI-SETUP.md](WIFI-SETUP.md#stale-stations) |
| A neighbour's WiFi crowds FarmNet's channel | `farmnet-channel` picks the quietest channel at boot (optional) | [WIFI-SETUP.md](WIFI-SETUP.md#farmnets-channel) |
| The shelf node hangs, unplugs or a sensor jams the I2C bus | Its watchdog, the bridge reopening the port, and the node clearing the bus | [shelf-sensors.md](shelf-sensors.md#what-happens-when-things-fail) |

## Power

Use the official 5 V / 3 A supply (5 V / 5 A on a Pi 5). Under-voltage causes
random crashes and corrupted files; `vcgencmd get_throttled` shows it
(`throttled=0x0` is good). The Uno and the WiFi adapter are powered from the
Pi's USB, so they're covered by whatever powers the Pi.

### A UPS

A UPS keeps the Pi, and the Uno and WiFi adapter it powers over USB, running
through a power cut. The farm's APC Back-UPS BW650U1 does only that: it has
**no data connection** (its USB port only charges phones), so the Pi can't
tell it's on battery. If the battery runs out, the Pi loses power as if
unplugged. In a long outage with someone there, shut it down by hand
(`sudo poweroff`) before then. If the battery ran out, the Pi boots by itself
when mains returns, as after any power cut. After a `poweroff` it stays off
until its power is cycled: unplug its supply and plug it back in.

A UPS with a USB **data** port can also tell the Pi when its battery runs low,
so it shuts down cleanly by itself: see "Safe shutdown" below. Look for "USB
data port", "PowerChute" or "HID" in a model's datasheet.

**Plugging it in**

- The Pi's official supply goes in an outlet marked **Battery Backup**, not a
  surge-only one.
- Leave the grow lights off it: they would drain it in minutes.
- Expect roughly 1.5–2.5 hours on battery. Time it once for the real figure:
  with it fully charged and the Pi running, unplug the UPS from the wall and
  note how long the Pi stays up.

#### Safe shutdown (only with a UPS that has a USB data port)

Connect the UPS's USB data cable to one of the Pi's USB ports, next to the Uno.

**Setting up NUT** (Network UPS Tools, which reads the UPS over USB):

```bash
sudo apt install -y nut
lsusb                              # the UPS should be listed, e.g. "American Power Conversion"
```

Then edit these four files under `/etc/nut/` (`sudo nano ...`). Pick your own
password for the monitor; it only works on the Pi itself.

`nut.conf`:

```
MODE=standalone
```

`ups.conf`: add at the end

```
[apc]
  driver = usbhid-ups
  port = auto
  desc = "Farm UPS"
```

`upsd.users`: add at the end

```
[upsmon]
  password = choose-a-password
  upsmon primary
```

`upsmon.conf`: add at the end

```
MONITOR apc@localhost 1 upsmon choose-a-password primary
```

Then start it and check it reads the UPS:

```bash
sudo systemctl restart nut-server nut-monitor
upsc apc@localhost ups.status        # OL: on mains. OB: on battery. LB: battery low
upsc apc@localhost battery.charge    # percent
```

**What happens in a power cut** (with NUT)

1. The UPS switches to battery (`OB`) and the farm carries on.
2. When the UPS reports its battery low (`LB`), NUT shuts the Pi down
   cleanly, then tells the UPS to switch its outlets off.
3. When mains returns, the UPS switches its outlets back on, the Pi boots,
   and systemd starts every farm service again, with nobody there.

If the power comes back before the battery runs low, nothing shuts down.

**Testing it** (with the UPS fully charged, not mid-demo):

- **Runtime and shutdown:** with the Pi running, unplug the UPS from the
  wall. `upsc apc@localhost ups.status` turns `OB`. Leave it: the Pi should
  shut itself down before the battery is empty. Note how long it lasted, then
  plug the UPS back in and check the Pi boots and `systemctl status 'farm-*'`
  is all running.
- `journalctl -u nut-monitor` shows each change (`on battery`, `on line
  power`, `battery is low`).

**Troubleshooting**

- `upsc` says `Driver not connected`: check `lsusb` lists the UPS, then
  `sudo systemctl restart nut-driver-enumerator nut-server` and look at
  `journalctl -u 'nut-*'`.
- The Pi stays off after the power returns: the UPS didn't switch its outlets
  off after the shutdown (it had power left, or the power came back while the
  Pi was shutting down). Switch the UPS off and on to boot the Pi.

## Storage

### SD card care

SD cards fail from sudden power loss during a write and from wear. With this setup:

- **Always shut down with `sudo poweroff`** before unplugging. This matters more than anything else here. A UPS with a data port does this for you in a power cut (above); the BW650U1 can't.
- Logs are capped ([PI-SERVICES.md step 5](PI-SERVICES.md#5-watchdog-and-logs)). The ingester's database is the main writer, about one row per robot per second, flushed to the card in batches (SQLite's `synchronous = NORMAL`: a power cut can lose the last moments of rows, never the file); it keeps 7 days (`RETENTION_DAYS` in `ingester.env`) and deletes older rows daily, so it stops growing after a week. Every service logs a recurring problem (bad messages, a broker that's down) once until it clears.
- Use a quality A2-rated card from a known brand, ideally a high-endurance one (below).
- Back up now and then:
  - the data: `sudo tar czf ~/verdant-backup-$(date +%F).tgz /var/lib/verdant /etc/verdant`, then copy it off the Pi
  - the whole card: Raspberry Pi OS's **SD Card Copier** onto a spare card, so a dead card is a two-minute swap

### Booting from a USB drive instead (optional)

A Pi 4 can boot from USB with no SD card. Only worth it with the right drive:

- **An ordinary USB flash drive isn't safer than an SD card.** Most use the
  same kind of cheap flash with little wear-levelling, run hot, and fail the
  same way. Don't switch to one for reliability.
- **What is safer:** a USB drive built like an SSD, sold as a "solid state
  flash drive" (e.g. SanDisk Extreme PRO USB 3.2), or a small SATA SSD in a
  USB 3 enclosure. Avoid no-name USB-to-SATA adapters: some chips hang on the
  Pi.
- **The cheapest real improvement:** a "high endurance" SD card (e.g. SanDisk
  High Endurance or MAX Endurance, Samsung PRO Endurance), made for dashcams
  that write all day. Clone onto it as below and swap the card.

To move the Pi onto a USB drive:

1. Make the Pi try USB first: `sudo raspi-config` → Advanced Options → Boot
   Order → **USB Boot**, then reboot. On an old Pi 4 run
   `sudo rpi-eeprom-update -a` and reboot first. It still boots from the SD
   card while there's no USB drive.
2. Plug the drive into a **blue USB 3 port** and copy the running system onto
   it: **SD Card Copier** on the desktop, or `rpi-clone` from the command line.
   Everything comes along: `/etc/verdant/`, the database, FarmNet's setup.
   Stop the services first so the database isn't mid-write:
   `sudo systemctl stop 'farm-*'`.
3. Shut down (`sudo poweroff`), take the SD card out, and power on. Check
   `systemctl status 'farm-*'` and the dashboard.

Keep the SD card: put it back in and the Pi boots from it as before. A drive
draws its power from the Pi; a USB SSD on a Pi 4 with the official supply is
fine, and the Uno and WiFi adapter share the USB ports with it.
