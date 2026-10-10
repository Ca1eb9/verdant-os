#!/usr/bin/env python3
"""Draws robot-power.svg: the robot's 12 V side (battery, fuse, switch, buck
converter, motor driver, charging pads) and the two voltage dividers.

    python3 draw_robot_power.py > robot-power.svg

Plain Python, no packages. Wires to the ESP32 end in a labelled flag
("GPIO 4") rather than running across the drawing. Keep robot.md's tables in
step with it.
"""
import sys

from wiring_svg import add, finish, text, wire

C = {"batt": "#c2185b", "pad": "#ef6c00", "5v": "#d62728", "gnd": "#222222", "sig": "#1f77b4",
     "motor": "#6d4c41"}
BUS_Y = 150
W, H = 1240, 740


def box(x, y, w, h, title, lines=(), fill="#f4f1ea", stroke="#c9c2b2"):
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    text(x + w / 2, y + 22, title, 13, weight="bold")
    for i, line in enumerate(lines):
        text(x + w / 2, y + 42 + i * 16, line, 11, fill="#555")


def pin(x, y, label, inside="start"):
    """A connection point on a box edge, named inside the box."""
    add(f'<circle cx="{x}" cy="{y}" r="3.5" fill="#fff" stroke="#222" stroke-width="1.5"/>')
    text(x + (8 if inside == "start" else -8), y + 4, label, 11, inside, "bold")


def dot(x, y, color):
    add(f'<circle cx="{x}" cy="{y}" r="4.5" fill="{color}"/>')


def flag(x, y, label, color, side="right"):
    """Where a wire continues to the ESP32: a labelled tag instead of a long wire."""
    w = len(label) * 7 + 18
    x0 = x if side == "right" else x - w
    tip = x0 + w + 8 if side == "right" else x0 - 8
    edge = x0 + w if side == "right" else x0
    add(f'<path d="M {x0},{y - 10} L {x0 + w},{y - 10} L {x0 + w + (8 if side == "right" else 0)},{y} '
        f'L {x0 + w},{y + 10} L {x0},{y + 10} L {x0 - (0 if side == "right" else 8)},{y} Z" '
        f'fill="#fff" stroke="{color}" stroke-width="1.5"/>')
    text(x0 + w / 2, y + 4, label, 11, weight="bold", fill=color)
    return tip, edge


def v_resistor(x, y1, y2, label):
    mid = (y1 + y2) / 2
    add(f'<line x1="{x}" y1="{y1}" x2="{x}" y2="{y2}" stroke="#888" stroke-width="2"/>')
    add(f'<rect x="{x - 7}" y="{mid - 20}" width="14" height="40" rx="5" fill="#e8d3a6" stroke="#8a6d3b"/>')
    text(x - 13, mid + 4, label, 11, "end", "bold", "#5a4320")


def v_capacitor(x, y1, y2, label):
    mid = (y1 + y2) / 2
    add(f'<line x1="{x}" y1="{y1}" x2="{x}" y2="{mid - 4}" stroke="#888" stroke-width="2"/>')
    add(f'<line x1="{x}" y1="{mid + 4}" x2="{x}" y2="{y2}" stroke="#888" stroke-width="2"/>')
    for dy in (-4, 4):
        add(f'<line x1="{x - 10}" y1="{mid + dy}" x2="{x + 10}" y2="{mid + dy}" stroke="#444" stroke-width="2.5"/>')
    text(x + 15, mid + 4, label, 11, "start", "bold", "#444")


def ground(x, y):
    """Ground symbol: every one of these is the same shared ground."""
    add(f'<line x1="{x}" y1="{y}" x2="{x}" y2="{y + 8}" stroke="{C["gnd"]}" stroke-width="3"/>')
    for i, half in enumerate((11, 7, 3)):
        add(f'<line x1="{x - half}" y1="{y + 8 + i * 4}" x2="{x + half}" y2="{y + 8 + i * 4}" '
            f'stroke="{C["gnd"]}" stroke-width="2"/>')


def divider(x, top, gpio):
    """100k down from `top` to the tap, then 22k and 0.1 uF side by side to ground."""
    tap = top + 100
    bottom = tap + 90
    v_resistor(x, top, tap, "100 kΩ")
    v_resistor(x, tap, bottom, "22 kΩ")
    wire([(x, tap), (x + 60, tap)], "#888", 2)
    v_capacitor(x + 60, tap, bottom, "0.1 µF")
    text(x + 75, (tap + bottom) / 2 + 18, "(optional)", 10, "start", fill="#777")
    wire([(x, bottom), (x + 60, bottom)], "#888", 2)
    ground(x + 30, bottom)
    dot(x, tap, C["sig"])
    wire([(x + 60, tap), (x + 110, tap)], C["sig"], 3)
    flag(x + 110, tap, f"to {gpio}", C["sig"])


add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
add(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')
text(40, 38, "Robot: power and charging (12 V side)", 22, "start", "bold")
text(40, 62, "Wire this with real wire, not on the breadboard. A tag like  to GPIO 4  continues on the ESP32;", 13,
     "start", fill="#444")
text(40, 80, "every ground symbol is the same shared ground (battery −). A dot joins wires; wires that only cross don't.",
     13, "start", fill="#444")

# ---- battery, fuse, switch, switched bus
box(40, 110, 170, 110, "Battery pack", ["3S Li-ion, BMS inside", "9.6–12.6 V", "red +, black −"])
pin(210, BUS_Y, "+", "end")
add(f'<circle cx="125" cy="220" r="3.5" fill="#fff" stroke="#222" stroke-width="1.5"/>')
text(125, 212, "−", 13, weight="bold")
ground(125, 220)
NODE_X = 340
wire([(210, BUS_Y), (250, BUS_Y)], C["batt"], 4)
add(f'<rect x="250" y="{BUS_Y - 9}" width="50" height="18" rx="9" fill="#fff" stroke="#444" stroke-width="1.5"/>')
add(f'<path d="M 256,{BUS_Y} C 266,{BUS_Y - 10} 284,{BUS_Y + 10} 294,{BUS_Y}" fill="none" stroke="#444" stroke-width="1.5"/>')
text(275, BUS_Y - 16, "3 A fuse", 11, weight="bold")
wire([(300, BUS_Y), (390, BUS_Y)], C["batt"], 4)
dot(NODE_X, BUS_Y, C["batt"])
add(f'<circle cx="394" cy="{BUS_Y}" r="4" fill="#fff" stroke="#444" stroke-width="1.5"/>')
add(f'<line x1="397" y1="{BUS_Y - 2}" x2="438" y2="{BUS_Y - 20}" stroke="#444" stroke-width="2.5"/>')
add(f'<circle cx="442" cy="{BUS_Y}" r="4" fill="#fff" stroke="#444" stroke-width="1.5"/>')
text(418, BUS_Y + 24, "power switch", 11, weight="bold")
BUS_END = 1000
wire([(446, BUS_Y), (BUS_END, BUS_Y)], C["batt"], 4)
text(780, BUS_Y - 12, "BATT+ (switched)", 12, weight="bold", fill=C["batt"])

# ---- buck converter
UX, UY = 580, 200
box(UX, UY, 190, 100, "UBEC buck converter", ["5 V, 3 A (Adafruit 1385)"])
pin(UX, UY + 55, "IN+")
pin(UX, UY + 82, "IN−")
pin(UX + 190, UY + 55, "5V", "end")
pin(UX + 190, UY + 82, "GND", "end")
dot(550, BUS_Y, C["batt"])
wire([(550, BUS_Y), (550, UY + 55), (UX, UY + 55)], C["batt"], 3)
wire([(UX, UY + 82), (565, UY + 82)], C["gnd"], 3)
ground(565, UY + 82)
wire([(UX + 190, UY + 55), (800, UY + 55)], C["5v"], 3)
flag(800, UY + 55, "to ESP32 5V", C["5v"])
wire([(UX + 190, UY + 82), (790, UY + 82)], C["gnd"], 3)
ground(790, UY + 82)

# ---- motor driver and motor
MX, MY = 580, 360
box(MX, MY, 190, 130, "DRV8871 motor driver", ["current limited to ~2 A"])
pin(MX, MY + 60, "VM")
pin(MX, MY + 100, "GND")
pin(MX + 190, MY + 55, "IN1", "end")
pin(MX + 190, MY + 80, "IN2", "end")
pin(MX + 190, MY + 110, "OUT1/OUT2", "end")
dot(520, BUS_Y, C["batt"])
wire([(520, BUS_Y), (520, MY + 60), (MX, MY + 60)], C["batt"], 3)
wire([(MX, MY + 100), (560, MY + 100)], C["gnd"], 3)
ground(560, MY + 100)
for y, gpio in ((MY + 55, "GPIO 5"), (MY + 80, "GPIO 6")):
    wire([(MX + 190, y), (800, y)], C["sig"], 3)
    flag(800, y, f"to {gpio}", C["sig"])
box(820, 530, 150, 100, "Motor", ["Pololu 4845, 12 V", "red to OUT1", "black to OUT2"], fill="#efe6e1",
    stroke=C["motor"])
wire([(MX + 190, MY + 110), (790, MY + 110), (790, 570), (820, 570)], C["motor"], 3)
text(895, 650, "its 4 encoder wires: insulate", 10, fill="#777")
text(895, 663, "and leave unconnected", 10, fill="#777")

# ---- battery voltage divider (after the switch, so it doesn't drain a switched-off robot)
dot(BUS_END, BUS_Y, C["batt"])
wire([(BUS_END, BUS_Y), (BUS_END, 220)], C["batt"], 3)
divider(BUS_END, 220, "GPIO 4")
text(BUS_END - 14, 200, "battery voltage", 11, "end", "bold", C["sig"])

# ---- ESP32: what arrives where
EX, EY = 1000, 560
box(EX, EY, 210, 150, "ESP32-S3 DevKitC-1", ["5V: from the converter", "GND: shared ground", "GPIO 5, 6: motor IN1, IN2",
                                             "GPIO 4: battery voltage", "GPIO 1: charge contact", "sensors: breadboard diagram"],
    fill="#e3f1f3", stroke="#0f7c8c")

# ---- charging: pads, diode, charge contact sense
box(40, 420, 170, 130, "Copper tape pads", ["touch the dock's pogo pins", "charger: 12.6 V, 2 A",
                                                "(docking only)"],
    fill="#fdf0e2", stroke=C["pad"])
PAD_P, PAD_N = (210, 500), (210, 528)
pin(PAD_P[0], PAD_P[1], "pad +", "end")
pin(PAD_N[0], PAD_N[1], "pad −", "end")
wire([(PAD_N[0], PAD_N[1]), (240, PAD_N[1])], C["gnd"], 3)
ground(240, PAD_N[1])
DY = 330    # the diode: anode toward the pad, cathode (band) toward the battery side
wire([(PAD_P[0], PAD_P[1]), (NODE_X, PAD_P[1]), (NODE_X, DY + 18)], C["pad"], 3)
add(f'<path d="M {NODE_X - 12},{DY + 16} L {NODE_X + 12},{DY + 16} L {NODE_X},{DY - 4} Z" fill="#444"/>')
add(f'<line x1="{NODE_X - 12}" y1="{DY - 6}" x2="{NODE_X + 12}" y2="{DY - 6}" stroke="#444" stroke-width="3"/>')
text(NODE_X - 18, DY + 2, "Schottky diode", 11, "end", "bold")
text(NODE_X - 18, DY + 17, "1N5822, band up", 10, "end", fill="#555")
wire([(NODE_X, DY - 6), (NODE_X, BUS_Y)], C["batt"], 3)
text(NODE_X + 8, BUS_Y + 40, "joins before the switch:", 10, "start", fill="#555")
text(NODE_X + 8, BUS_Y + 53, "charges even when off", 10, "start", fill="#555")
SENSE_X = 400
dot(NODE_X, PAD_P[1], C["pad"])
wire([(NODE_X, PAD_P[1]), (SENSE_X, PAD_P[1])], C["pad"], 3)
divider(SENSE_X, PAD_P[1], "GPIO 1")
text(SENSE_X + 14, PAD_P[1] - 10, "charge contact", 11, "start", "bold", C["sig"])

sys.stdout.write(finish())
