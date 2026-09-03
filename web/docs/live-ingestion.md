# Live Ingestion Setup

This setup uses an Arduino Uno R3 over USB serial as the live sensor source and Supabase as the sensor event store.

## Install

```bash
npm ci
```

## Supabase Table

Create the table by running the SQL in:

```bash
supabase/sensor_events.sql
```

Paste it into the Supabase SQL editor. It creates `sensor_events` with parsed sensor columns, `raw_text`, row-level-security read policy, and indexes for latest-row reads.

## Environment

Copy `.env.example` to `.env.local` and set real values:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-publishable-or-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-server-only-service-role-key

SERIAL_PORT=/dev/ttyACM0
SERIAL_BAUD=9600
DEVICE_ID=arduino-uno-r3-1
```

`SUPABASE_SERVICE_ROLE_KEY` is used only by the local serial bridge for inserts. Do not expose it in browser-prefixed variables.

## Find Arduino Uno R3 Serial Port On Fedora KDE

Connect the Arduino Uno R3 over USB, then check that Fedora sees the USB device:

```bash
lsusb
```

Check available serial ports:

```bash
ls /dev/ttyACM* /dev/ttyUSB*
```

Watch plug-in logs if the port is unclear:

```bash
sudo dmesg -w
```

Use the detected port as `SERIAL_PORT`. The default is `/dev/ttyACM0`, but an Uno R3 may also appear as `/dev/ttyUSB0`.

If the port exists but cannot be opened, add your user to the serial group:

```bash
sudo usermod -aG dialout $USER
```

Then log out and back in.

## Run The Bridge

```bash
npm run bridge:serial
```

The bridge reads complete Arduino blocks ending in `-----------------------------------`, parses them, converts `light_ppfd = light_lux / 54`, and inserts one row per block into Supabase.

That PPFD conversion is approximate and depends on the grow light spectrum.

## Run The App

```bash
npm run dev
```

Open the local Next.js URL. The dashboard polls `/api/sensor-events/latest`, which reads Supabase on the server. The browser never receives the service role key.

## Full Ingestion Flow

1. Arduino Uno R3 runs `Sensors.ino` at `9600` baud and prints a sensor block about every 2 seconds.
2. Laptop runs `npm run bridge:serial`.
3. Bridge parses each full serial block and inserts into Supabase `sensor_events`.
4. Dashboard polls the server API route for the newest event.
5. Dashboard displays the latest readings, PPFD light value, last received time, and a stale indicator when the newest row is older than about 10 seconds.
