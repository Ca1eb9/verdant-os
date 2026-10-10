#!/usr/bin/env python3
"""Draws robot-perfboard.svg: the robot's logic side soldered onto an Adafruit
Perma-Proto half-sized board (top view, parts side).

    python3 draw_robot_perfboard.py > robot-perfboard.svg

Plain Python, no packages. The DevKit plugs into two 1x22 female sockets in
rows 9-30, its USB end past the board's edge; the two dividers stand in rows
1-3. Keep robot.md's perfboard table in step with it.
"""
import sys

from wiring_svg import PermaProtoHalf, add, draw_standing_resistor, finish, text, wire

BX, BY = 160, 130
PP = PermaProtoHalf(BX, BY)
rx, HOLE, RAIL, RAIL_T = PP.rx, PP.hole, PP.rail, PP.rail_top

C = {"3v3": "#d62728", "5v": "#ff8a65", "gnd": "#222222", "batt": "#c2185b", "pad": "#ef6c00",
     "sense": "#e6b800", "motor": "#8c564b", "i2c_r": "#9467bd", "i2c_f": "#2ca02c", "spi": "#1f77b4"}

DEV = 9
J1 = ["3V3", "3V3", "RST", "4", "5", "6", "7", "15", "16", "17", "18", "8", "3", "46", "9", "10", "11", "12",
      "13", "14", "5V", "GND"]
J3 = ["GND", "TX", "RX", "1", "2", "42", "41", "40", "39", "38", "37", "36", "35", "0", "45", "48", "47", "21",
      "20", "19", "GND", "GND"]
def j1(name): return DEV + J1.index(name)
def j3(name): return DEV + J3.index(name)

BROWN_BLACK_YELLOW = ["#7a4a1e", "#111", "#e6b800", "#c9a227"]   # 100 kΩ
RED_RED_ORANGE = ["#d62728", "#d62728", "#ff7f0e", "#c9a227"]     # 22 kΩ

W, H = 1240, 780
add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
add(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')
text(40, 38, "Robot: perfboard layout (Adafruit Perma-Proto half-size)", 22, "start", "bold")
text(40, 62, "Top view, parts side. Same circuit as the breadboard: the ESP32 plugs into sockets, the dividers stand "
     "in rows 1–3, and every module plugs onto header pins.", 13, "start", fill="#444")
text(40, 80, "Bottom rails: + is 3V3, − is GND. Top − rail is GND.", 13, "start", fill="#444")

PP.draw()


def hole(r, h): return (rx(r), HOLE[h])


def jumper(a, b, color, lift):
    """Insulated wire on top of the board, drawn as an arc; it touches only its two holes."""
    (x1, y1), (x2, y2) = a, b
    d = f"M {x1},{y1} Q {(x1 + x2) / 2},{(y1 + y2) / 2 + lift} {x2},{y2}"
    add(f'<path d="{d}" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>')
    add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="3" stroke-linecap="round"/>')
    for px, py in (a, b):
        add(f'<circle cx="{px}" cy="{py}" r="3" fill="{color}" stroke="#fff" stroke-width="1"/>')


def standing_cap(r, y):
    x0, x1 = rx(r), rx(r + 1)
    add(f'<path d="M {x0},{y} C {x0},{y - 14} {x1},{y - 14} {x1},{y}" fill="none" stroke="#888" stroke-width="2"/>')
    add(f'<circle cx="{x0}" cy="{y}" r="8" fill="#e8a33c" stroke="#9a6416"/>')
    add(f'<circle cx="{x1}" cy="{y}" r="3" fill="#888"/>')


# ---- dividers, rows 1-3: in at row 1, 100k rows 1-2, tap row 2, 22k + 0.1 uF rows 2-3, ground row 3
# parts are named in the free rows 4-8 beside them, not on the crowded rows 1-3
draw_standing_resistor(rx(1), rx(2), HOLE["c"], BROWN_BLACK_YELLOW, "")
draw_standing_resistor(rx(2), rx(3), HOLE["d"], RED_RED_ORANGE, "")
standing_cap(2, HOLE["e"])
draw_standing_resistor(rx(1), rx(2), HOLE["h"], BROWN_BLACK_YELLOW, "")
draw_standing_resistor(rx(2), rx(3), HOLE["g"], RED_RED_ORANGE, "")
standing_cap(2, HOLE["f"])
for y0, lines in ((HOLE["h"] - 4, ["charge contact:", "100 kΩ rows 1–2, h", "22 kΩ rows 2–3, g", "0.1 µF rows 2–3, f"]),
                  (HOLE["e"] - 4, ["battery voltage:", "100 kΩ rows 1–2, c", "22 kΩ rows 2–3, d", "0.1 µF rows 2–3, e"])):
    add(f'<rect x="{rx(4) - 12}" y="{y0 - 12}" width="104" height="{len(lines) * 13 + 6}" rx="4" fill="#174a2d"/>', "late")
    for i, line in enumerate(lines):
        text(rx(4) - 7, y0 + i * 13, line, 9, "start", "bold" if i == 0 else "normal", "#fff", layer="late")

# 12 V wires in from the power side, soldered into row 1
for y, col, s in ((HOLE["e"], C["batt"], "BATT+ (switched)"), (HOLE["f"], C["pad"], "pad +")):
    wire([(rx(1), y), (BX - 2, y), (BX - 2, y)], col, 3)
    text(BX - 8, y + 4, s, 10, "end", "bold", col)

# ---- sockets for the DevKit: 1x22 female headers in holes b (J1) and i (J3)
for y, names, below in ((HOLE["b"], J1, True), (HOLE["i"], J3, False)):
    x0, x1 = rx(DEV) - 10, rx(DEV + 21) + 10
    add(f'<rect x="{x0}" y="{y - 9}" width="{x1 - x0}" height="18" rx="2" fill="#111"/>')
    for i, name in enumerate(names):
        r = DEV + i
        add(f'<rect x="{rx(r) - 3}" y="{y - 3}" width="6" height="6" fill="#444"/>')
        if below:
            text(rx(r) + 3, y - 14, name, 9, "end", "bold", "#fff", rot=90)
        else:
            text(rx(r) + 3, y + 14, name, 9, "start", "bold", "#fff", rot=90)
mid_y = (HOLE["f"] + HOLE["e"]) / 2
add(f'<rect x="{rx(DEV) - 12}" y="{HOLE["h"] - 4}" width="{rx(DEV + 21) - rx(DEV) + 82}" '
    f'height="{HOLE["c"] - HOLE["h"] + 8}" rx="6" fill="none" stroke="#bfe3cc" stroke-width="1.5" stroke-dasharray="6 4"/>')
text((rx(DEV) + rx(DEV + 21)) / 2, mid_y - 4, "ESP32-S3-DevKitC-1 plugs in here,", 12, weight="bold", fill="#fff")
text((rx(DEV) + rx(DEV + 21)) / 2, mid_y + 12, "antenna toward row 9, USB past the edge →", 11, fill="#dff3e6")

# ---- links (insulated wire on top), and power to the rails
jumper(hole(j1("3V3"), "a"), (rx(j1("3V3")), RAIL["+"]), C["3v3"], 0)
jumper(hole(j1("GND"), "a"), (rx(j1("GND")), RAIL["-"]), C["gnd"], 0)
jumper(hole(j3("GND"), "j"), (rx(j3("GND")), RAIL_T["-"]), C["gnd"], 0)
jumper(hole(3, "a"), (rx(3), RAIL["-"]), C["gnd"], 0)
jumper(hole(3, "j"), (rx(3), RAIL_T["-"]), C["gnd"], 0)
jumper(hole(2, "a"), hole(j1("4"), "a"), C["sense"], -26)
jumper(hole(2, "j"), hole(j3("1"), "j"), C["sense"], 26)

# ---- header pins: one in hole a per signal, and on the rails for module power
LABEL_Y = BY + PP.height + 46
pins = [("5", "DRV IN1", C["motor"]), ("6", "DRV IN2", C["motor"]), ("17", "rear SDA", C["i2c_r"]),
        ("18", "rear SCL", C["i2c_r"]), ("8", "front SDA", C["i2c_f"]), ("9", "front SCL", C["i2c_f"]),
        ("10", "SS", C["spi"]), ("11", "MOSI", C["spi"]), ("12", "SCK", C["spi"]), ("13", "MISO", C["spi"])]
for i, (gpio, name, col) in enumerate(pins):
    x, y = hole(j1(gpio), "a")
    ly = LABEL_Y + (i % 3) * 18
    wire([(x, y), (x, ly - 15)], col, 2.5)
    add(f'<rect x="{x - 4}" y="{y - 4}" width="8" height="8" fill="#e2c35a" stroke="#8a6d1e"/>')
    text(x, ly, name, 10, weight="bold", fill=col)

for r in (4, 5, 6):
    add(f'<rect x="{rx(r) - 4}" y="{RAIL["+"] - 4}" width="8" height="8" fill="#e2c35a" stroke="#8a6d1e"/>')
for r in (4, 5, 6, 7):
    add(f'<rect x="{rx(r) - 4}" y="{RAIL["-"] - 4}" width="8" height="8" fill="#e2c35a" stroke="#8a6d1e"/>')
text((rx(j1("10")) + rx(j1("13"))) / 2, LABEL_Y + 60, "PN532", 11, weight="bold", fill=C["spi"])
text(rx(5), LABEL_Y, "3V3 pins: rear VIN,", 11, weight="bold", fill=C["3v3"])
text(rx(5), LABEL_Y + 14, "front VIN, PN532 VCC", 11, weight="bold", fill=C["3v3"])
text(rx(5), LABEL_Y + 34, "GND pins: rear, front,", 11, weight="bold", fill=C["gnd"])
text(rx(5), LABEL_Y + 48, "PN532, DRV8871 GND", 11, weight="bold", fill=C["gnd"])

# 5 V from the converter into the DevKit's 5V row; shared ground onto the − rail
x5, y5 = hole(j1("5V"), "a")
wire([(x5, y5), (x5, LABEL_Y - 15)], C["5v"], 3)
text(x5, LABEL_Y, "5V in", 11, weight="bold", fill="#c75b39")
text(x5, LABEL_Y + 14, "(converter)", 10, fill="#c75b39")
xg = rx(8)
wire([(xg, RAIL["-"]), (xg, LABEL_Y + 52)], C["gnd"], 3)
text(xg + 6, LABEL_Y + 66, "shared ground in (power side)", 10, "start", "bold")

text(BX, H - 30, "Gold squares are male header pins: each takes a female jumper to its module. "
     "Arcs are insulated wires on top of the board; they touch only their two holes.", 12, "start", fill="#444")

sys.stdout.write(finish())
