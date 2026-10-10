#!/usr/bin/env python3
"""Draws robot-breadboard.svg: the robot's 3.3 V logic side on a full-size
breadboard (ESP32-S3 DevKitC-1, PN532, two VL53L4CX, the AHT20, DRV8871
inputs and the two dividers). The 12 V side is robot-power.svg.

    python3 draw_robot_breadboard.py > robot-breadboard.svg

Plain Python, no packages. The DevKit straddles the channel with one free
hole per side (hole a below J1, hole j above J3). Keep robot.md's tables in
step with it.
"""
import sys

from wiring_svg import add, finish, resistor, text, wire

P = 17
ROWS = 63
BX = 210
def rx(r): return BX + 30 + (r - 1) * P

DY = -150   # everything sits this far up from where it was first laid out
RAIL_T = {"+": 300 + DY, "-": 320 + DY}
HOLE = {k: v + DY for k, v in {"j": 350, "i": 368, "h": 386, "g": 404, "f": 422,
                               "e": 458, "d": 476, "c": 494, "b": 512, "a": 530}.items()}
RAIL = {"+": 560 + DY, "-": 580 + DY}
BOARD_TOP, BOARD_BOT = 275 + DY, 600 + DY
NUM_TOP, NUM_BOT = 288 + DY, 596 + DY

C = {"3v3": "#d62728", "gnd": "#222222", "batt": "#c2185b", "pad": "#ef6c00", "spi": "#1f77b4",
     "i2c_r": "#9467bd", "i2c_f": "#2ca02c", "motor": "#8c564b", "sense": "#e6b800"}

# DevKitC-1 v1.1, pin 1 (3V3 / GND) at row DEV, antenna end to the left
DEV = 20
J1 = ["3V3", "3V3", "RST", "4", "5", "6", "7", "15", "16", "17", "18", "8", "3", "46", "9", "10", "11", "12",
      "13", "14", "5V", "GND"]
J3 = ["GND", "TX", "RX", "1", "2", "42", "41", "40", "39", "38", "37", "36", "35", "0", "45", "48", "47", "21",
      "20", "19", "GND", "GND"]
def j1(name): return DEV + J1.index(name)
def j3(name): return DEV + J3.index(name)

W, H = 1380, 880
add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
add(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')
text(40, 38, "Robot: breadboard wiring (3.3 V logic side)", 22, "start", "bold")
text(40, 62, "Full-size breadboard. The ESP32 straddles the middle channel; each of its pins has one free hole: "
     "hole a below the bottom row, hole j above the top row.", 13, "start", fill="#444")
text(40, 80, "Bottom rails: + is 3V3, − is GND. Top − rail is GND too. 12 V arrives on two wires only "
     "(rows 4); the rest of the 12 V side is robot-power.svg.", 13, "start", fill="#444")

# ---- breadboard
right = rx(ROWS) + 20
add(f'<rect x="{BX}" y="{BOARD_TOP}" width="{right - BX}" height="{BOARD_BOT - BOARD_TOP}" rx="8" fill="#f4f1ea" stroke="#c9c2b2"/>')
add(f'<rect x="{BX + 20}" y="{(HOLE["f"] + HOLE["e"]) / 2 - 6}" width="{right - BX - 34}" height="12" fill="#e4dfd3"/>')
for rails in (RAIL_T, RAIL):
    for sign, y in rails.items():
        col = "#d62728" if sign == "+" else "#1f4fbf"
        ly = y - 9 if sign == "+" else y + 9
        add(f'<line x1="{BX + 24}" y1="{ly}" x2="{right - 10}" y2="{ly}" stroke="{col}" stroke-width="1.5"/>')
        text(BX + 12, y + 5, sign if sign == "+" else "−", 14, weight="bold", fill=col)
        for r in range(1, ROWS + 1):
            add(f'<rect x="{rx(r) - 3}" y="{y - 3}" width="6" height="6" fill="#55524a"/>')
for letter, y in HOLE.items():
    text(BX + 12, y + 4, letter, 10, fill="#888")
    for r in range(1, ROWS + 1):
        add(f'<rect x="{rx(r) - 3}" y="{y - 3}" width="6" height="6" fill="#55524a"/>')
for r in range(1, ROWS + 1):
    if r == 1 or r % 5 == 0:
        for y in (NUM_TOP, NUM_BOT):
            text(rx(r), y, str(r), 9, fill="#7a7466", weight="bold")


def hole(r, h): return (rx(r), HOLE[h])
def rail(r, sign, top=False): return (rx(r), (RAIL_T if top else RAIL)[sign])


def jumper(a, b, color, lift=14):
    """A jumper between two holes, drawn as a gentle arc."""
    (x1, y1), (x2, y2) = a, b
    mx, my = (x1 + x2) / 2, min(y1, y2) - lift if y1 == y2 else (y1 + y2) / 2
    d = f"M {x1},{y1} Q {mx},{my} {x2},{y2}"
    add(f'<path d="{d}" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>')
    add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="3" stroke-linecap="round"/>')
    for px, py in (a, b):
        add(f'<circle cx="{px}" cy="{py}" r="3" fill="{color}" stroke="#fff" stroke-width="1"/>')


# ---- dividers, left of the ESP32
# Battery voltage (bottom half): 12 V in at row 4, 100k rows 4-8, tap row 8 -> GPIO 4, 22k + 0.1 uF rows 8-12
B_IN, B_TAP, B_GND = 4, 8, 12
BROWN_BLACK_YELLOW = ["#7a4a1e", "#111", "#e6b800", "#c9a227"]   # 100 kΩ
RED_RED_ORANGE = ["#d62728", "#d62728", "#ff7f0e", "#c9a227"]     # 22 kΩ
resistor(rx(B_IN), rx(B_TAP), HOLE["b"], BROWN_BLACK_YELLOW, "")
resistor(rx(B_TAP), rx(B_GND), HOLE["d"], RED_RED_ORANGE, "")
# Charge contact (top half): pad + in at row 4, 100k rows 4-8, tap row 8 -> GPIO 1, 22k + 0.1 uF rows 8-12
resistor(rx(B_IN), rx(B_TAP), HOLE["i"], BROWN_BLACK_YELLOW, "")
resistor(rx(B_TAP), rx(B_GND), HOLE["g"], RED_RED_ORANGE, "")


def capacitor(r1, r2, y, label):  # label: unused, parts are listed beside the board
    x1, x2 = rx(r1), rx(r2)
    mx = (x1 + x2) / 2
    add(f'<line x1="{x1}" y1="{y}" x2="{mx - 4}" y2="{y}" stroke="#888" stroke-width="2"/>')
    add(f'<line x1="{mx + 4}" y1="{y}" x2="{x2}" y2="{y}" stroke="#888" stroke-width="2"/>')
    add(f'<rect x="{mx - 9}" y="{y - 9}" width="18" height="18" rx="8" fill="#e8a33c" stroke="#9a6416"/>')
    for px in (x1, x2):
        add(f'<circle cx="{px}" cy="{y}" r="3" fill="#888"/>')


capacitor(B_TAP, B_GND, HOLE["c"], "")
capacitor(B_TAP, B_GND, HOLE["h"], "")
for y0, title, parts in ((HOLE["j"] - 4, "Charge contact divider", ["100 kΩ: rows 4–8, hole i", "22 kΩ: rows 8–12, hole g",
                                                                     "0.1 µF: rows 8–12, hole h", "pad + in: row 4, hole f"]),
                         (HOLE["e"] - 4, "Battery divider", ["100 kΩ: rows 4–8, hole b", "22 kΩ: rows 8–12, hole d",
                                                             "0.1 µF: rows 8–12, hole c", "BATT+ in: row 4, hole e"])):
    text(BX - 12, y0, title, 11, "end", "bold")
    for i, line in enumerate(parts):
        text(BX - 12, y0 + 15 + i * 14, line, 10, "end", fill="#444")

# ---- ESP32-S3 DevKitC-1 body over rows DEV..DEV+21, pins in holes b (J1) and i (J3)
x0, x1 = rx(DEV) - 12, rx(DEV + 21) + 12
add(f'<rect x="{x0 - 54}" y="{HOLE["i"] - 6}" width="{x1 - x0 + 54 + 22}" height="{HOLE["b"] - HOLE["i"] + 12}" rx="6" '
    f'fill="#1c1c1c" stroke="#000"/>')
add(f'<rect x="{x0 - 50}" y="{HOLE["h"] - 4}" width="64" height="{HOLE["c"] - HOLE["h"] + 8}" rx="3" fill="#a9b0b6" stroke="#6d757c"/>')
text(x0 - 18, (HOLE["h"] + HOLE["c"]) / 2 + 4, "module", 10, weight="bold", fill="#333")
for usb_y in (HOLE["g"], HOLE["d"]):
    add(f'<rect x="{x1 + 4}" y="{usb_y - 10}" width="22" height="20" rx="3" fill="#c0c0c0" stroke="#888"/>')
text(x1 + 30, HOLE["g"] + 4, "UART", 9, "start", fill="#666")
text(x1 + 30, HOLE["d"] + 4, "USB (use this one)", 9, "start", "bold", "#333")
text((x0 + x1) / 2, (HOLE["f"] + HOLE["e"]) / 2 + 4, "ESP32-S3-DevKitC-1 v1.1", 13, weight="bold", fill="#fff")
for i, name in enumerate(J1):
    r = DEV + i
    add(f'<rect x="{rx(r) - 4}" y="{HOLE["b"] - 4}" width="8" height="8" fill="#d9b44a"/>')
    text(rx(r) + 3, HOLE["b"] - 9, name, 9, "end", "bold", "#fff", rot=90)
for i, name in enumerate(J3):
    r = DEV + i
    add(f'<rect x="{rx(r) - 4}" y="{HOLE["i"] - 4}" width="8" height="8" fill="#d9b44a"/>')
    text(rx(r) + 3, HOLE["i"] + 9, name, 9, "start", "bold", "#fff", rot=90)

# ---- power rails from the ESP32, divider links
jumper(hole(j1("3V3"), "a"), rail(j1("3V3"), "+"), C["3v3"], 0)
jumper(hole(j1("GND"), "a"), rail(j1("GND"), "-"), C["gnd"], 0)
jumper(hole(j3("GND"), "j"), rail(j3("GND"), "-", top=True), C["gnd"], 0)
jumper(hole(B_GND, "a"), rail(B_GND, "-"), C["gnd"], 0)
jumper(hole(B_GND, "j"), rail(B_GND, "-", top=True), C["gnd"], 0)
jumper(hole(B_TAP, "a"), hole(j1("4"), "a"), C["sense"], 18)
jumper(hole(B_TAP, "j"), hole(j3("1"), "j"), C["sense"], 18)

# 12 V in: one wire each from the power side, arriving from the left
for col, y in ((C["batt"], HOLE["e"]), (C["pad"], HOLE["f"])):
    wire([(rx(B_IN), y), (BX - 6, y)], col, 3)

# ---- modules below the board, left to right in the order of the ESP32 pins
# they use. Wires drop to a lane, run across, then down to the pin; the
# leftmost sources take the deepest lanes, so few wires cross.
MOD_Y = 800 + DY
PITCH = 22


def module(x, title, pins, fill):
    """A module with its pin names along the top edge, in the board's order. Returns pin positions."""
    w = PITCH * len(pins)
    add(f'<rect x="{x}" y="{MOD_Y}" width="{w}" height="78" rx="6" fill="{fill}"/>')
    text(x + w / 2, MOD_Y + 62, title, 11, weight="bold", fill="#fff")
    pos = {}
    for i, name in enumerate(pins):
        px = x + PITCH * (i + 0.5)
        add(f'<circle cx="{px}" cy="{MOD_Y + 8}" r="4" fill="#d9b44a"/>')
        text(px + 3, MOD_Y + 16, name, 9, "start", "bold", "#fff", rot=90)
        pos[name] = (px, MOD_Y + 8)
    return pos


x = rx(22)
drv = module(x, "DRV8871", ["GND", "IN1", "IN2"], "#4b2a7a")
x += PITCH * 3 + 26
rear = module(x, "VL53L4CX rear", ["VIN", "GND", "SCL", "SDA", "GPIO", "XSHUT"], "#1a1a2e")
rear_x = x
x += PITCH * 6 + 26
# AHT20: no wires to the board, it hangs off the rear VL53L4CX's second
# STEMMA QT port, which carries the same 3V3, GND, SDA and SCL
AHT_W = PITCH * 4
add(f'<rect x="{x}" y="{MOD_Y}" width="{AHT_W}" height="78" rx="6" fill="#0f5e5a"/>')
text(x + AHT_W / 2, MOD_Y + 34, "AHT20", 11, weight="bold", fill="#fff")
text(x + AHT_W / 2, MOD_Y + 50, "air temp,", 9, fill="#dff3e6")
text(x + AHT_W / 2, MOD_Y + 62, "humidity", 9, fill="#dff3e6")
qt_a, qt_b = rear_x + PITCH * 6 - 16, x + 16
for qx in (qt_a, qt_b):
    add(f'<rect x="{qx - 8}" y="{MOD_Y + 72}" width="16" height="8" rx="1" fill="#eee" stroke="#555"/>')
add(f'<path d="M {qt_a},{MOD_Y + 80} C {qt_a},{MOD_Y + 112} {qt_b},{MOD_Y + 112} {qt_b},{MOD_Y + 80}" fill="none" '
    f'stroke="{C["i2c_r"]}" stroke-width="5" stroke-linecap="round"/>')
text((qt_a + qt_b) / 2, MOD_Y + 120, "STEMMA QT cable", 10, weight="bold", fill=C["i2c_r"])
x += AHT_W + 26
front = module(x, "VL53L4CX front", ["VIN", "GND", "SCL", "SDA", "GPIO", "XSHUT"], "#1a1a2e")
x += PITCH * 6 + 26
pn = module(x, "PN532", ["SCK", "MISO", "MOSI", "SS", "VCC", "GND", "IRQ", "RSTO"], "#b3262c")
text(x + PITCH * 4, MOD_Y + 96, "SPI mode: switch SEL0 off, SEL1 on", 10, fill="#555")
text(drv["IN1"][0], MOD_Y + 96, "VM, OUT1/2: power side", 10, fill="#555")

links = [  # (source, module pin, colour)
    (rail(22, "-"), drv["GND"], C["gnd"]),
    (hole(j1("5"), "a"), drv["IN1"], C["motor"]),
    (hole(j1("6"), "a"), drv["IN2"], C["motor"]),
    (rail(26, "+"), rear["VIN"], C["3v3"]),
    (rail(27, "-"), rear["GND"], C["gnd"]),
    (hole(j1("17"), "a"), rear["SDA"], C["i2c_r"]),
    (hole(j1("18"), "a"), rear["SCL"], C["i2c_r"]),
    (hole(j1("8"), "a"), front["SDA"], C["i2c_f"]),
    (rail(32, "+"), front["VIN"], C["3v3"]),
    (rail(33, "-"), front["GND"], C["gnd"]),
    (hole(j1("9"), "a"), front["SCL"], C["i2c_f"]),
    (hole(j1("10"), "a"), pn["SS"], C["spi"]),
    (hole(j1("11"), "a"), pn["MOSI"], C["spi"]),
    (hole(j1("12"), "a"), pn["SCK"], C["spi"]),
    (hole(j1("13"), "a"), pn["MISO"], C["spi"]),
    (rail(44, "+"), pn["VCC"], C["3v3"]),
    (rail(45, "-"), pn["GND"], C["gnd"]),
]
LANE_TOP, LANE_STEP = 618 + DY, 10
for depth, (src, dst, col) in enumerate(sorted(links, key=lambda link: -link[0][0])):
    lane = LANE_TOP + depth * LANE_STEP
    wire([src, (src[0], lane), (dst[0], lane), dst], col, 2.5)

# ---- legend
LY = 820
legend = [
    (C["3v3"], "3V3 (rail +)"), (C["gnd"], "GND (rail −)"), (C["motor"], "GPIO 5, 6 → DRV8871 IN1, IN2"),
    (C["i2c_f"], "GPIO 8, 9 → front SDA, SCL"), (C["i2c_r"], "GPIO 17, 18 → rear SDA, SCL, then AHT20"),
    (C["spi"], "GPIO 10–13 → PN532 SS, MOSI, SCK, MISO"), (C["sense"], "divider taps → GPIO 4 (battery), GPIO 1 (charge)"),
    (C["batt"], "BATT+ (switched) in, 12 V"), (C["pad"], "pad + in, 12.6 V when docked"),
]
for i, (col, label) in enumerate(legend):
    x = 40 + (i % 4) * 300
    y = LY + (i // 4) * 24
    add(f'<rect x="{x}" y="{y - 9}" width="22" height="6" rx="3" fill="{col}"/>')
    text(x + 30, y - 2, label, 11, "start")

sys.stdout.write(finish())
