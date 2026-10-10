#!/usr/bin/env python3
"""Draws shelf-sensor-perfboard.svg: the shelf sensor node soldered onto an
Adafruit Perma-Proto half-sized board (top view, parts side).

    python3 draw_shelf_sensor_perfboard.py > shelf-sensor-perfboard.svg

Plain Python, no packages. Edit the rows here rather than the SVG, then keep
shelf-sensor.md's perfboard table in step.
"""
import sys

from wiring_svg import PermaProtoHalf, add, draw_standing_resistor, finish, text, wire

BX, BY = 70, 150            # board's top-left corner
PP = PermaProtoHalf(BX, BY)
rx, HOLE, RAIL, BW, BH = PP.rx, PP.hole, PP.rail, PP.width, PP.height   # bottom rails: + is 5V, - is GND

C = {"5v": "#d62728", "gnd": "#222222", "d2": "#ff7f0e", "d3": "#e6b800", "d4": "#2ca02c",
     "a0": "#1f77b4", "sda": "#9467bd", "scl": "#8c564b"}

W, H = 1240, 760
add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
add(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')
text(40, 38, "Shelf sensor node: perfboard layout (Adafruit Perma-Proto half-size)", 22, "start", "bold")
text(40, 62, "Top view, parts side. The board is wired like a breadboard: holes a–e of a row are one connection, "
     "f–j another, and each rail runs the whole length.", 13, "start", fill="#444")

# ---- board
PP.draw()

# ---- links: a short bare wire from hole a down to a rail, soldered on both ends
for r in (3, 7, 14, 19, 24):
    wire([(rx(r), HOLE["a"]), (rx(r), RAIL["+"])], C["5v"], 3)
for r in (4, 8, 16, 21, 26):
    wire([(rx(r), HOLE["a"]), (rx(r), RAIL["-"])], C["gnd"], 3)

# ---- resistors stand on end between two neighbouring rows, in hole c: one
# lead straight down, the other bent back along the body
def standing_resistor(r, bands, label):
    draw_standing_resistor(rx(r), rx(r + 1), HOLE["c"], bands, label)

standing_resistor(14, ["#e6b800", "#7f3fbf", "#d62728", "#c9a227"], "4.7 kΩ")
standing_resistor(20, ["#7a4a1e", "#111", "#ff7f0e", "#c9a227"], "10 kΩ")

# ---- parts soldered into hole e
def socket(rows, label, female=True):
    x0, x1 = rx(rows[0]) - 9, rx(rows[-1]) + 9
    add(f'<rect x="{x0}" y="{HOLE["e"] - 9}" width="{x1 - x0}" height="18" rx="2" fill="#111"/>')
    for r in rows:
        if female:
            add(f'<rect x="{rx(r) - 3}" y="{HOLE["e"] - 3}" width="6" height="6" fill="#444"/>')
        else:
            add(f'<rect x="{rx(r) - 3}" y="{HOLE["e"] - 3}" width="6" height="6" fill="#e2c35a"/>')
    part_label((x0 + x1) / 2, label)

# names go in the empty top half, above each part
def part_label(x, label):
    w = len(label) * 6.6 + 10
    add(f'<rect x="{x - w / 2}" y="{HOLE["h"] - 9}" width="{w}" height="18" rx="4" fill="#174a2d"/>')
    text(x, HOLE["h"] + 4, label, 11, weight="bold", fill="#fff")

def pin_names(rows, names):
    for r, n in zip(rows, names):
        text(rx(r) + 4, HOLE["e"] - 16, n, 9, "start", "bold", "#fff", rot=-90)

socket([2, 3, 4], "DHT11 socket")
pin_names([2, 3, 4], ["S", "+", "−"])
socket(range(7, 12), "BH1750 socket")
pin_names(range(7, 12), ["VCC", "GND", "SCL", "SDA", "ADDR"])

# DS18B20: screw terminal, 2.54 mm pitch
x0, x1 = rx(14) - 10, rx(16) + 10
add(f'<rect x="{x0}" y="{HOLE["e"] - 14}" width="{x1 - x0}" height="24" rx="2" fill="#2f8f4e" stroke="#1d5c32"/>')
for r in (14, 15, 16):
    add(f'<circle cx="{rx(r)}" cy="{HOLE["e"] - 2}" r="6" fill="#c9c9c9" stroke="#777"/>')
    add(f'<line x1="{rx(r) - 4}" y1="{HOLE["e"] - 2}" x2="{rx(r) + 4}" y2="{HOLE["e"] - 2}" stroke="#555" stroke-width="1.5"/>')
part_label(rx(15), "DS18B20 terminal")
pin_names([14, 15, 16], ["red", "yellow", "black"])

socket([19, 20, 21], "Level header", female=False)
pin_names([19, 20, 21], ["red", "green", "black"])
socket([24, 25, 26], "pH header", female=False)
pin_names([24, 25, 26], ["red", "blue", "black"])

# ---- wires to the Uno: a male header pin in hole a of each signal row (and
# on the rails for power), then a female-to-male jumper to the Uno
uno_pins = [(2, "D2", C["d2"]), (9, "A5", C["scl"]), (10, "A4", C["sda"]), (15, "D3", C["d3"]),
            (20, "D4", C["d4"]), (25, "A0", C["a0"])]
# labels alternate between two lines so neighbouring rows don't collide
LABEL_Y = BY + BH + 60
pins = [(r, HOLE["a"], name, col) for r, name, col in uno_pins] + \
       [(28, RAIL["+"], "5V", C["5v"]), (30, RAIL["-"], "GND", C["gnd"])]
for i, (r, y, name, col) in enumerate(pins):
    ly = LABEL_Y + (22 if i % 2 else 0)
    wire([(rx(r), y), (rx(r), ly - 16)], col, 3)
    add(f'<rect x="{rx(r) - 4}" y="{y - 4}" width="8" height="8" fill="#e2c35a" stroke="#8a6d1e"/>')
    text(rx(r), ly, f"Uno {name}", 12, weight="bold", fill=col)
text(BX, LABEL_Y + 60, "Gold squares are male header pins. Each takes a female-to-male jumper to that Uno pin; "
     "the jumpers leave the board and touch nothing else on it.", 12, "start", fill="#444")

# ---- legend
LX, LY = BX + BW + 40, 170
lines = [
    ("Parts side (top)", "bold"),
    ("DHT11, BH1750: female header sockets,", None),
    ("so the modules plug in.", None),
    ("DS18B20: 3-pin screw terminal,", None),
    ("2.54 mm pitch.", None),
    ("Level, pH: 3-pin male headers for", None),
    ("their cables' plugs.", None),
    ("", None),
    ("Resistors stand on end, hole c:", "bold"),
    ("4.7 kΩ: rows 14 (5V) and 15 (data)", None),
    ("10 kΩ: rows 20 (signal) and 21 (GND)", None),
    ("", None),
    ("Links (short wires), hole a to rail:", "bold"),
    ("+ rail: rows 3, 7, 14, 19, 24", None),
    ("− rail: rows 4, 8, 16, 21, 26", None),
    ("", None),
    ("Leave BH1750 ADDR (row 11) unconnected.", None),
    ("Top rails and rows 27–30 are unused.", None),
]
for i, (s, wgt) in enumerate(lines):
    text(LX, LY + i * 19, s, 12, "start", wgt or "normal")

sys.stdout.write(finish())
