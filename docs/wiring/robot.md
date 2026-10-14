# Wiring — robot (ESP32-S3)

The robot's electronics in three diagrams: the 12 V power side, the 3.3 V
logic side on a breadboard, and the same logic side soldered onto a perfboard.
If you haven't read [README.md](README.md) yet, start there: it covers how a
breadboard is connected inside and what pull-up and pull-down resistors are.
The pins come from `firmware/esp32/src/config.h`; the firmware is in
[firmware/esp32](../../firmware/esp32).

## Parts

| Part | Does | Notes |
|---|---|---|
| ESP32-S3-DevKitC-1 v1.1 (Espressif) | Runs the firmware | Use the port marked **USB** |
| Elechouse PN532 NFC Module V3 | Reads the RFID tags at each node | SPI mode: switch **SEL0 off, SEL1 on** |
| 2× Adafruit VL53L4CX ToF ([5425](https://www.adafruit.com/product/5425)) | Front and rear obstacle distance | Each on its own I2C bus (they share one address) |
| AHT20 breakout with STEMMA QT, e.g. Adafruit [4566](https://www.adafruit.com/product/4566) | Air temperature and humidity, for the dashboard | **Optional.** Joins the rear VL53L4CX's bus |
| Adafruit DRV8871 ([3190](https://www.adafruit.com/product/3190)) | Drives the motor | Limits motor current to about 2 A |
| Pololu 47:1 gearmotor, 12 V ([4845](https://www.pololu.com/product/4845)) | Moves the robot | 0.3 A free-running, about 5 A if stalled |
| UBEC buck converter, 5 V 3 A ([1385](https://www.adafruit.com/product/1385)) | Powers the ESP32 from the battery | Fixed 5 V. Bare input wires, 3-pin servo plug out |
| 3S Li-ion pack, 10.8 V 6 Ah, BMS inside | Power | 12.6 V full, 9.6 V empty |
| 3 A fuse in an inline holder | Battery protection | |
| Power switch, rated 3 A DC or more | Turns the robot off | |
| 5 V switch, rated 1 A DC or more | Between the converter's 5 V and the ESP32 | Off whenever USB is plugged in |
| 100 kΩ + 22 kΩ resistors | Battery divider | |
| Two copper tape pads + wires | Touch the dock's two pogo pins | **Docking only.** The dock charger gives 12.6 V, 2 A |
| 1N5822 Schottky diode (3 A, 40 V) | Charging path | **Docking only.** Keeps the pads dead off the dock |
| 100 kΩ + 22 kΩ + 10 kΩ resistors | Charge contact divider, and a pull-down on pad + | **Docking only** |
| 2× 0.1 µF ceramic capacitors | Steady the divider readings | **Optional** |
| 0.01–0.047 µF ceramic capacitor | Across the motor's two terminals: soaks up its electrical noise | **Optional** |
| STEMMA QT cable | Rear VL53L4CX → AHT20 | **Optional**, with the AHT20 |
| Jumper wires; 20–22 AWG wire for the 12 V side | | |

A proof-of-concept demo can leave out the **Optional** parts: the firmware runs
without them. **Docking only** parts let the robot charge itself on the dock;
without them, charge the pack off the robot with its charger. The fuse is not
optional: it's what stops a short from overheating the pack and wiring.

## ESP32 pins

| ESP32 pin | Goes to |
|---|---|
| **3V3** | 3.3 V for the PN532, both VL53L4CX and the AHT20 (VCC / VIN) |
| **GND** | Ground, shared with everything |
| **5V** | The buck converter's 5 V output, through the 5 V switch (on the bench, USB powers it and the 5 V switch is off) |
| **GPIO 12 / 13 / 11 / 10** | PN532 SCK / MISO / MOSI / SS |
| **GPIO 8 / 9** | Front VL53L4CX SDA / SCL (`Wire`) |
| **GPIO 17 / 18** | Rear VL53L4CX SDA / SCL (`Wire1`), and the AHT20 through it |
| **GPIO 5 / 6** | DRV8871 IN1 / IN2 |
| **GPIO 4** | Battery divider tap (battery voltage) |
| **GPIO 1** | Charge contact divider tap |
| GPIO 38 | The on-board status LED; nothing to wire |

GPIO 4 and 1 are ADC1 pins, the only ones that can still read a voltage while
WiFi is on. Leave alone: GPIO 0, 3, 45, 46 (they decide how the chip boots),
19/20 (USB), 43/44 (UART0) and 35–37 (the extra memory uses them on boards
with 8 MB PSRAM, such as N8R8).

## Power and charging (12 V side)

![Robot power and charging](robot-power.svg)

Wire this side with real wire, not on the breadboard. A tag like **to GPIO 4**
continues on the ESP32, and every ground symbol is the same shared ground.

- **Fuse, then switch.** The fuse sits right at the battery's + wire, so a
  short anywhere after it blows the fuse instead of damaging the pack or the
  wiring. The switch turns everything after it off.
- **Buck converter → ESP32 5V pin.** It turns 9.6–12.6 V into a steady 5 V; the
  DevKit makes its own 3.3 V from that. Its bare wires are the input (red +,
  black −); the 5 V comes out of its 3-pin servo plug. Before the plug goes
  near the ESP32, switch on and find the 5 V and GND pins with a multimeter;
  usually red is 5 V and black or brown is GND. Its label says "7–12 V input"
  and a full pack is 12.6 V; Adafruit recommends 6–16 V, so it's fine.
- **5 V switch.** It sits on the converter's 5 V wire, between the converter
  and the ESP32's 5V pin; the converter's ground stays connected. Turn it off
  whenever USB is plugged in. Espressif's guide says to power the board from
  USB or the 5V pin, one at a time, and with both connected, USB's 5 V can
  also leak backwards through the converter onto the 12 V side. With the 5 V
  switch off, the main switch can stay on: the ESP32 runs from USB with the
  serial monitor open while the motor and the dividers run from the battery.
- **DRV8871 → motor.** VM takes the battery after the switch. GPIO 5 and 6
  drive IN1 and IN2: one held high while the other is switched on and off
  rapidly (PWM) sets direction and speed; both high brakes. Holding one high
  rather than low (slow decay) makes speed follow the PWM evenly, where the
  other way the motor barely moves below half speed. Both inputs have
  pull-downs inside the chip, so the motor stays off while the ESP32 boots.
  Its ~2 A limit also protects a jammed motor. If the robot drives the wrong
  way, swap the motor's red and black wires. The motor's other four wires are
  an encoder the firmware doesn't use: insulate them and leave them
  unconnected.
- **Capacitor across the motor (optional).** Inside a brushed motor, carbon
  brushes slide over a spinning copper ring that's split into segments; each
  time a brush crosses a gap, the current breaks for an instant, making a tiny
  spark and a sharp voltage spike. Those spikes travel down the motor wires
  and can upset nearby signal wires (I2C, SPI) or reset the ESP32. A small
  ceramic capacitor soldered straight across the motor's two terminals
  absorbs them where they're made. It doesn't make the motor quieter to the
  ear. Keep it small, 0.01–0.047 µF: the driver charges and empties it on
  every PWM pulse, 20 000 times a second, and the usual 0.1 µF would waste
  about 0.3 W in the driver. Twisting the two motor wires together and keeping
  them away from the I2C cables helps too.
- **Shared ground.** Battery −, pad −, the converter, the driver, the ESP32
  and both dividers all join. Signals only mean something relative to a
  shared ground.

### Charging: pads, diode, charge contact (docking only)

Leave this whole section out if the demo charges the pack off the robot.

The dock has two pogo pins wired to its charger (12.6 V, 2 A): one +, one −.
The robot has two copper tape pads that land on them.

- **Pad −** goes straight to ground.
- **Pad +** goes through the **Schottky diode** to the battery side of the
  switch (between the fuse and the switch), so the robot charges even while
  switched off. The diode's band (cathode) faces the fuse.

**Mounting the diode.** At 2 A it drops about 0.45 V, so it turns about 0.9 W
into heat for the whole charge (hours), and runs at 60–70 °C in open air.
PLA starts to soften around 60 °C, so:

- **Its leads are its heatsink.** An axial diode like the 1N5822 loses most of
  its heat through its leads, not its body; its 3 A rating assumes about 10 mm
  of lead on each side, soldered to something with copper to spread the heat.
  Leave about 10 mm of lead each side, and solder each to a short length of
  the 20 AWG wire (or a screw terminal) rather than to a thin trace.
- **Keep the body in free air**, at least 5 mm from the printed body, tape,
  heat-shrink or other wires, and where some air can move (near a vent or
  opening, not sealed in a box). Don't press it against the plastic.
- **A piece of metal doesn't help this part much**: there's nothing on it to
  bolt down, and its body passes little heat. If, right after a long charge,
  it's too hot to keep a finger on for a second (over about 60 °C), or the
  plastic near it has softened, swap it for a Schottky in a TO-220 package,
  such as an MBR1045 (10 A, 45 V), bolted by its metal tab to a small
  aluminium heatsink. The tab is connected to the cathode (the battery side),
  so the heatsink mustn't touch anything else.

**Why the diode, when the pack already has a BMS?** The BMS protects the cells
(overcharge, over-discharge, a hard short) but its output is live whenever the
pack isn't faulted. Wired straight to the pads, they'd carry 10–12.6 V all the
time, and the danger here isn't a hard short but a wet one: a splash or
condensation bridging the pads lets only milliamps through, far too little for
the BMS to notice, while the copper corrodes and the pack drains. The diode
only lets current flow *into* the battery, so off the dock the pads are dead.
It also blocks a charger wired backwards.

The diode costs 0.3–0.5 V, so the 12.6 V charger fills the pack to about
4.1 V a cell instead of 4.2 V. The firmware and the orchestrator call charging
complete at **85%** (`CHARGE_COMPLETE_PCT`, `charge_complete_pct`) for that
reason.

### The two voltage dividers

The ESP32 can only read up to about 3.1 V, so each 12 V signal goes through
two resistors that scale it down: `V_pin = V_in × 22k / (100k + 22k)`, about
0.18 of the input.

| Divider | In | Out | Pin |
|---|---|---|---|
| **Battery** | BATT+ after the switch: 9.6–12.6 V | 1.73–2.27 V | GPIO 4 |
| **Charge contact** | Pad +: 10–12.6 V docked, nothing off the dock | 1.8–2.3 V docked, under 0.5 V off | GPIO 1 |

Docked, the pad reads below 12.6 V while the pack charges: the charger's
output sits just above the pack's voltage until the pack is nearly full.

- **Why 22 kΩ, not 33 kΩ:** 33 kΩ put a full pack at 3.13 V, the edge of what
  the ADC can read. 22 kΩ leaves headroom (`BATTERY_R2_OHMS` in `config.h`).
- **Why so large:** 122 kΩ in total lets only 0.1 mA through, so the dividers
  barely drain the battery. The battery divider sits after the switch, so a
  switched-off robot doesn't drain at all. On the charge side, pad + only has
  power while docked, from the charger, so its 10 kΩ pull-down (1.3 mA there)
  costs the battery nothing.
- **The 0.1 µF capacitor** across each 22 kΩ steadies the reading: the ADC
  takes a quick gulp of charge each time it samples, and through 100 kΩ the
  pin can't refill fast enough without it. **It's optional:** without it the
  readings are noisier and may sit a little low, but the firmware averages 16
  reads and `BATTERY_CAL_FACTOR` corrects a steady offset, and docked versus
  off the dock is still obvious.
- **Why pad + has a 10 kΩ to ground:** a Schottky diode leaks a little
  current backwards, from the battery into pad +: about 20 µA at room
  temperature, and ten times that or more while it's hot from charging.
  Through the 122 kΩ divider alone, that puts pad + at a few volts off the
  dock, and GPIO 1 at up to 1–2 V with a hot diode: close enough to the docked
  1.8 V that the robot could think it was already on the pins and stop short.
  The 10 kΩ soaks up the leak: pad + stays under about 3 V even with a hot
  diode, GPIO 1 under 0.5 V, and docked readings don't change (the charger
  drives pad + directly).
- **Why not just smaller divider resistors (10 kΩ / 2.2 kΩ):** that fixes the
  leak too, but the robot charges with its switch off, and then pad + would
  push up to about 1 mA into the switched-off ESP32's GPIO 1 through the
  divider, ten times what the 100 kΩ allows. Adding the separate 10 kΩ keeps
  that at 0.1 mA.

## Breadboard (3.3 V logic side)

![Robot breadboard wiring](robot-breadboard.svg)

The DevKit straddles the middle channel of a full-size breadboard with its
antenna toward row 20 and its pins in rows 20–41: the bottom row (J1) in hole
b, the top row (J3) in hole i. That leaves **one free hole per pin**: a below,
j above. 12 V reaches the breadboard on two wires only, both in row 4: BATT+
on its 100 kΩ, pad + on its 100 kΩ and the 10 kΩ to ground.

**Split rails:** on some full-size boards each rail is split halfway along
(the red and blue lines have a gap in the middle). This layout uses both
halves of the bottom rails, so on such a board add the two bridge jumpers
drawn from row 28 to row 39. On a board with unbroken lines they're harmless.

| Where | What |
|---|---|
| Row 20, hole a → bottom + rail | 3V3: the bottom + rail is 3.3 V |
| Row 41, hole a → bottom − rail; row 20, hole j → top − rail | GND on both − rails |
| Row 28 → row 39 on the bottom + rail, and again on the − rail | Bridges a split rail (see above) |
| Rows 4–12, bottom half | Battery divider: BATT+ in at row 4 hole e; 100 kΩ rows 4–8 (hole b); 22 kΩ rows 8–12 (hole d); 0.1 µF rows 8–12 (hole c, optional); row 8 hole a → row 23 hole a (GPIO 4); row 12 hole a → − rail |
| Rows 4–12, top half | Charge contact divider (docking only): pad + in at row 4 hole f; 100 kΩ rows 4–8 (hole i); 22 kΩ rows 8–12 (hole g); 0.1 µF rows 8–12 (hole h, optional); 10 kΩ from row 4 hole j, bent across to the top − rail; row 8 hole j → row 23 hole j (GPIO 1); row 12 hole j → top − rail |
| DRV8871 | IN1 ← row 24 hole a (GPIO 5), IN2 ← row 25 (GPIO 6), GND ← − rail |
| VL53L4CX rear | SDA ← row 29 (GPIO 17), SCL ← row 30 (GPIO 18), VIN ← + rail, GND ← − rail |
| VL53L4CX front | SDA ← row 31 (GPIO 8), SCL ← row 34 (GPIO 9), VIN ← + rail, GND ← − rail |
| AHT20 (optional) | STEMMA QT cable from the rear VL53L4CX's second port: it carries 3V3, GND, SDA and SCL |
| PN532 | SS ← row 35 (GPIO 10), MOSI ← row 36 (GPIO 11), SCK ← row 37 (GPIO 12), MISO ← row 38 (GPIO 13), VCC ← + rail, GND ← − rail |

The modules connect with jumper wires; leave each VL53L4CX's GPIO and XSHUT
pins and the PN532's IRQ and RSTO unconnected. A module's pins may not be in
the order drawn: go by the names printed on its board.

### Why the modules need no resistors

- **VL53L4CX:** I2C lines need pull-up resistors, and Adafruit's board has
  them, along with its own regulator ("VLogic/Vcc 3–5VDC"). The two sensors
  share one fixed address, which is why each has its own bus.
- **AHT20:** it shares the rear VL53L4CX's bus, which works because the two
  answer to different addresses (0x38 and 0x29). Its board has pull-ups
  too; two boards' pull-ups side by side are still well within what
  I2C allows. The cable powers it from 3V3, so its pull-ups pull to 3.3 V, as
  the ESP32's pins need.
- **I2C cable length:** each I2C line is pulled up by those resistors, and
  every bit of cable adds capacitance they have to charge, slowing each
  signal edge. At 400 kHz an edge must rise within 300 ns, which allows
  roughly 30–50 cm of cable. The front sensor's 400 mm STEMMA QT cable is
  over that, so the front bus runs at 100 kHz (1000 ns, about 2.5× margin):
  `I2C_FRONT_HZ` in `config.h`. The rear bus has short cables and stays at
  400 kHz (`I2C_REAR_HZ`), the most the AHT20 on it takes. A slower bus only
  adds a few milliseconds per distance reading.
- **PN532:** SPI lines are driven both ways by the chips, so they need none.
- **DRV8871:** its inputs have pull-downs built in.

## Before you power it

- **Battery polarity and the diode's direction.** The band faces the fuse.
- **No 12 V near 3.3 V.** BATT+ and pad + touch only their 100 kΩ resistors
  (and pad +'s 10 kΩ to ground) and the power side.
- **The rails.** With a multimeter on Ω, + and − must not read near 0 Ω.
- **The converter's plug.** The pin going to the ESP32's 5V reads +5 V
  against the one going to GND. Reversed, it destroys the board.
- **The PN532's switches:** SEL0 off, SEL1 on (SPI).
- **The 5 V switch is off before USB goes in.** Espressif's guide lists USB
  and the 5V pin as power sources to use one at a time.

## Bring it up one part at a time

Flash the bench firmware (sensors and comms, no motor) and watch the serial
monitor and the broker
([COMMS-SENSOR.md](../../firmware/esp32/COMMS-SENSOR.md#running-the-bench-test)):

```bash
cd firmware/esp32
pio run -e bench -t upload && pio device monitor -e bench
```

On the bench, USB powers the ESP32 and the 5 V switch stays off. Unplug USB
(and switch the main switch off) before adding each part:

| Add | Then check |
|---|---|
| The ESP32 alone | Boots, joins WiFi, sends telemetry once a second |
| PN532 | The monitor prints its firmware version; a tag held to it prints its UID |
| Front VL53L4CX | "front VL53L4CX ready"; a hand within 15 cm prints "obstacle flag SET", away past 20 cm "cleared" |
| Rear VL53L4CX | The same, for "rear" |
| AHT20 | "AHT20 ready"; telemetry carries `temperature_c` and `humidity_pct`, and breathing on it raises the humidity |
| Battery divider (+ the power side) | 5 V switch off, USB in, main switch on. With a multimeter, GPIO 4 reads 0.18 × the pack voltage, and `battery_pct` in telemetry matches the pack. Tune `BATTERY_CAL_FACTOR` if it's off. Then USB out, 5 V switch on: the converter powers the ESP32 by itself |
| Charge contact divider | Pads on the dock: GPIO 1 reads 1.8–2.3 V; off the dock, under 0.5 V (close to 0 V with a cool diode) |
| DRV8871 + motor | Flash the full firmware (`pio run -e esp32 -t upload`) and follow "Motor driver" in [firmware/esp32/README.md](../../firmware/esp32/README.md#motor-driver). With USB in and the 5 V switch off, switch the main switch on: the motor runs from the battery while the serial monitor stays open |

## Moving to the perfboard

![Robot perfboard layout](robot-perfboard.svg)

The same circuit on an
[Adafruit Perma-Proto half-sized board](https://www.adafruit.com/product/1609)
(30 rows, wired like half a breadboard). The DevKit plugs into two 1×22 female
header sockets in rows 9–30, so it can be swapped, with its USB end past the
board's edge so the cable still plugs in. The dividers stand on end in rows
1–3, away from the antenna end.

| Where | What |
|---|---|
| Rows 9–30, holes b and i | The DevKit's two sockets (J1 in b, J3 in i) |
| Row 9 hole a → + rail; row 30 hole a → − rail; row 9 hole j → top − rail | 3V3 and GND, as on the breadboard |
| Rows 1–3, bottom half | Battery divider: BATT+ wire into row 1 hole e; 100 kΩ rows 1–2 (hole c); 22 kΩ and 0.1 µF (optional) rows 2–3 (holes d, e); row 2 hole a → row 12 hole a (GPIO 4); row 3 hole a → − rail |
| Rows 1–3, top half | Charge contact divider (docking only): pad + wire into row 1 hole f; 100 kΩ rows 1–2 (hole h); 22 kΩ and 0.1 µF (optional) rows 2–3 (holes g, f); 10 kΩ on end in row 1 hole j, its bent lead in the top − rail; row 2 hole j → row 12 hole j (GPIO 1); row 3 hole j → top − rail |
| Male header pins, hole a | Row 13 (GPIO 5), 14 (GPIO 6), 18 (GPIO 17), 19 (GPIO 18), 20 (GPIO 8), 23 (GPIO 9), 24 (GPIO 10), 25 (GPIO 11), 26 (GPIO 12), 27 (GPIO 13) |
| Male header pins on the rails | + rail rows 4–6 (3V3 for the three modules), − rail rows 4–7 (their GND and the DRV8871's) |
| Wires in | The converter's 5 V, through the 5 V switch, into row 29 hole a (the DevKit's 5V); the shared ground onto the − rail |

Extra parts: the board, two 1×22 female header sockets, a strip of male
header pins, insulated wire for the links, and female jumper wires to the
modules (or, for the VL53L4CX, STEMMA QT to female socket cables). The AHT20
needs nothing on the board: it stays on its cable from the rear VL53L4CX.

Solder in this order: the links and the standing resistors and capacitors,
then the sockets and pins. Before plugging the DevKit in, check with a
multimeter: the rails don't read near 0 Ω between + and −; in the bottom
half, rows 1 and 2 read about 100 kΩ and rows 2 and 3 about 22 kΩ; in the top
half, where the 10 kΩ joins in, about 24 kΩ and 18 kΩ (with a capacitor
there, give the reading a second to settle); and no neighbouring rows are
joined by solder.
Then repeat [Before you power it](#before-you-power-it) and the bring-up checks.
