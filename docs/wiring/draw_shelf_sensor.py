#!/usr/bin/env python3
"""Draws shelf-sensor-breadboard.svg, the shelf sensor node's breadboard wiring.

    python3 draw_shelf_sensor.py > shelf-sensor-breadboard.svg

Plain Python, no packages. Edit the row numbers and pins here rather than the
SVG, then keep shelf-sensor.md's tables in step.
"""
import sys

P = 20                      # hole pitch (0.1")
BX = 60                     # breadboard left edge
ROWS = 34                   # rows drawn (board continues to 63)
def rx(r): return BX + 30 + (r - 1) * P

# breadboard y positions
BOARD_TOP, BOARD_BOT = 300, 660
NUM_TOP, NUM_BOT = 313, 650
RAIL_T = {"+": 330, "-": 350}           # top rails (unused)
HOLE = {"j": 380, "i": 400, "h": 420, "g": 440, "f": 460,
        "e": 500, "d": 520, "c": 540, "b": 560, "a": 580}
RAIL = {"+": 610, "-": 630}             # bottom rails (used)

# Arduino, drawn rotated 180 degrees: power/analog header on top, USB on the right
UX, UY, UW, UH = 45, 800, 540, 250
TOP_PIN_Y = UY + 16
BOT_PIN_Y = UY + UH - 16
top_pins = ["A5", "A4", "A3", "A2", "A1", "A0", None, "VIN", "GND", "GND", "5V", "3V3", "RESET", "IOREF", ""]
bot_pins = ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", None, "D8", "D9", "D10", "D11", "D12", "D13", "GND", "AREF", "SDA", "SCL"]
pin_x = {}
x = UX + 60
for n in top_pins:
    if n is None: x += 10; continue
    if n: pin_x.setdefault(("top", n), x)
    x += P
x = UX + 100
for n in bot_pins:
    if n is None: x += 12; continue
    pin_x.setdefault(("bot", n), x)
    x += P

C = {"5v": "#d62728", "gnd": "#222222", "d2": "#ff7f0e", "d3": "#e6b800", "d4": "#2ca02c",
     "a0": "#1f77b4", "sda": "#9467bd", "scl": "#8c564b"}

out, late = [], []
def add(s, layer=None): (late if layer == "late" else out).append(s)

def wire(points, color, w=4):
    d = "M " + " L ".join(f"{x},{y}" for x, y in points)
    add(f'<path d="{d}" fill="none" stroke="#fff" stroke-width="{w+2}" stroke-linejoin="round" stroke-linecap="round"/>')
    add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{w}" stroke-linejoin="round" stroke-linecap="round"/>')
    for (px, py) in (points[0], points[-1]):
        add(f'<circle cx="{px}" cy="{py}" r="3.2" fill="{color}" stroke="#fff" stroke-width="1"/>')

def text(x, y, s, size=12, anchor="middle", weight="normal", fill="#222", rot=None, layer=None):
    t = f' transform="rotate({rot} {x} {y})"' if rot is not None else ""
    add(f'<text x="{x}" y="{y}" font-family="Helvetica, Arial, sans-serif" font-size="{size}" text-anchor="{anchor}" '
        f'font-weight="{weight}" fill="{fill}"{t}>{s}</text>', layer)

def resistor(x1, x2, y, bands, label):
    add(f'<line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" stroke="#888" stroke-width="2"/>')
    bx, bw = (x1 + x2) / 2 - 22, 44
    add(f'<rect x="{bx}" y="{y-7}" width="{bw}" height="14" rx="6" fill="#e8d3a6" stroke="#8a6d3b"/>')
    for i, c in enumerate(bands):
        add(f'<rect x="{bx + 7 + i*8 + (6 if i == 3 else 0)}" y="{y-7}" width="4" height="14" fill="{c}"/>')
    for px in (x1, x2):
        add(f'<circle cx="{px}" cy="{y}" r="3" fill="#888"/>')
    lw = len(label) * 6.4
    add(f'<rect x="{(x1+x2)/2 - lw/2}" y="{y-27}" width="{lw}" height="15" rx="3" fill="#fff" opacity="0.92"/>', "late")
    text((x1 + x2) / 2, y - 15, label, 11, weight="bold", fill="#5a4320", layer="late")

W, H = 1240, 1130
add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
add(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')
text(40, 38, "Shelf sensor node: breadboard wiring (Arduino Uno R3)", 22, "start", "bold")
text(40, 62, "Full-size breadboard, rows 1–30. In each numbered row, holes a–e are connected to each other "
     "(and f–j to each other). Bottom rails: + is 5V, − is GND.", 13, "start", fill="#444")

# ---- breadboard
right = rx(ROWS) + 20
add(f'<rect x="{BX}" y="{BOARD_TOP}" width="{right-BX}" height="{BOARD_BOT-BOARD_TOP}" rx="8" fill="#f4f1ea" stroke="#c9c2b2"/>')
add(f'<rect x="{right-10}" y="{BOARD_TOP-2}" width="14" height="{BOARD_BOT-BOARD_TOP+4}" fill="#fff"/>')
add(f'<path d="M {right-10},{BOARD_TOP} ' + " ".join(f"L {right-10 + (5 if i%2 else 0)},{BOARD_TOP + i*15}" for i in range(1, 25)) +
    f'" fill="none" stroke="#c9c2b2" stroke-width="1.5"/>')
text(right + 12, (BOARD_TOP + BOARD_BOT) / 2, "board continues to row 63 (not used)", 11, fill="#888", rot=90)
add(f'<rect x="{BX+20}" y="{(HOLE["f"]+HOLE["e"])/2-6}" width="{right-BX-34}" height="12" fill="#e4dfd3"/>')
def rails(rs):
    for sign, y in rs.items():
        col = "#d62728" if sign == "+" else "#1f4fbf"
        ly = y - 10 if sign == "+" else y + 10   # red line above +, blue below -
        add(f'<line x1="{BX+24}" y1="{ly}" x2="{right-14}" y2="{ly}" stroke="{col}" stroke-width="1.5"/>')
        text(BX + 12, y + 5, sign, 15, weight="bold", fill=col)
        for r in range(1, ROWS + 1):
            add(f'<rect x="{rx(r)-3}" y="{y-3}" width="6" height="6" fill="#55524a"/>')
rails(RAIL_T)
rails(RAIL)
for letter, y in HOLE.items():
    text(BX + 12, y + 4, letter, 10, fill="#888")
    for r in range(1, ROWS + 1):
        add(f'<rect x="{rx(r)-3}" y="{y-3}" width="6" height="6" fill="#55524a"/>')
for r in range(1, ROWS + 1):
    for y in (NUM_TOP, NUM_BOT):
        text(rx(r), y, str(r), 9, fill="#7a7466", weight="bold" if r % 5 == 0 else "normal")

# ---- Arduino Uno (rotated)
add(f'<rect x="{UX}" y="{UY}" width="{UW}" height="{UH}" rx="10" fill="#0f7c8c" stroke="#095863" stroke-width="2"/>')
add(f'<rect x="{UX+UW-30}" y="{UY+40}" width="52" height="64" rx="3" fill="#c0c0c0" stroke="#888"/>')
text(UX + UW + 2, UY + 76, "USB", 12, weight="bold", fill="#333", rot=90)
add(f'<rect x="{UX+UW-20}" y="{UY+150}" width="40" height="46" rx="3" fill="#333"/>')
text(UX + UW / 2 - 10, UY + UH / 2 + 2, "Arduino Uno R3", 22, weight="bold", fill="#fff")
text(UX + UW / 2 - 10, UY + UH / 2 + 24, "drawn with its USB socket on the right", 12, fill="#d8f0f3")
for (side, name), px in pin_x.items():
    y = TOP_PIN_Y if side == "top" else BOT_PIN_Y
    add(f'<rect x="{px-6}" y="{y-6}" width="12" height="12" fill="#222"/>')
    add(f'<circle cx="{px}" cy="{y}" r="2.5" fill="#bbb"/>')
    if side == "top":
        text(px + 4, y + 12, name, 10, "end", fill="#fff", rot=-90)
    else:
        text(px + 4, y - 12, name, 10, "start", fill="#fff", rot=-90)

def uno(side, name): return (pin_x[(side, name)], TOP_PIN_Y if side == "top" else BOT_PIN_Y)

# ---- modules plugged into the board: body over rows f-j, legs into hole e
def legs(rows):
    for r in rows:
        add(f'<line x1="{rx(r)}" y1="{HOLE["f"]+4}" x2="{rx(r)}" y2="{HOLE["e"]}" stroke="#b8952e" stroke-width="3"/>')
        add(f'<circle cx="{rx(r)}" cy="{HOLE["e"]}" r="3.5" fill="#d9b44a" stroke="#8a6d1e"/>')

# DHT11 module: rows 2-4 (S, +, -)
legs([2, 3, 4])
add(f'<rect x="{rx(2)-22}" y="{HOLE["j"]-12}" width="{2*P+44}" height="{HOLE["f"]-HOLE["j"]+18}" rx="4" fill="#1b1b1b"/>')
add(f'<rect x="{rx(2)-12}" y="{HOLE["j"]-4}" width="{2*P+24}" height="58" rx="3" fill="#4aa8e0"/>')
for i in range(3):
    for j in range(3):
        add(f'<rect x="{rx(2)-4+j*16}" y="{HOLE["j"]+4+i*16}" width="8" height="8" fill="#2a6f99"/>')
for r, n in zip([2, 3, 4], ["S", "+", "−"]):
    text(rx(r), HOLE["f"] + 2, n, 12, weight="bold", fill="#fff")
text(rx(3), BOARD_TOP - 8, "DHT11 module", 12, weight="bold")

# BH1750 (GY-302): rows 7-11 (VCC, GND, SCL, SDA, ADDR)
legs(range(7, 12))
add(f'<rect x="{rx(7)-14}" y="{HOLE["j"]-12}" width="{4*P+28}" height="{HOLE["f"]-HOLE["j"]+18}" rx="4" fill="#1f4fbf"/>')
add(f'<rect x="{rx(9)-10}" y="{HOLE["j"]-2}" width="20" height="14" fill="#111"/>')
for r, n in zip(range(7, 12), ["VCC", "GND", "SCL", "SDA", "ADDR"]):
    text(rx(r) + 4, HOLE["f"] + 4, n, 10, "start", "bold", "#fff", rot=-90)
text(rx(9), BOARD_TOP - 8, "BH1750 (GY-302)", 12, weight="bold")

# ---- sensors on cables, above the board
def cable(rows_colors, top_y, x_join):
    for i, (r, col) in enumerate(rows_colors):
        xo = x_join + (i - 1) * 5
        wire([(xo, top_y), (xo, top_y + 30), (rx(r), BOARD_TOP - 20), (rx(r), HOLE["e"])], col, 3)

# DS18B20 probe: red 13, yellow 17, black 18
cx = rx(15)
add(f'<rect x="{cx-9}" y="125" width="18" height="70" rx="8" fill="#b9bec4" stroke="#7d848c"/>')
add(f'<rect x="{cx-5}" y="195" width="10" height="20" fill="#222"/>')
text(cx, 100, "DS18B20 probe", 12, weight="bold")
text(cx, 115, "(goes in the reservoir)", 10, fill="#666")
cable([(13, C["5v"]), (17, C["d3"]), (18, C["gnd"])], 215, cx)

# Level sensor: XKC-Y25-V + DFRobot adapter, red 21, green 22, black 26
lx = rx(23)
add(f'<circle cx="{lx-38}" cy="160" r="24" fill="#f5f5f5" stroke="#999"/>')
add(f'<circle cx="{lx-30}" cy="150" r="3" fill="#e02020"/>')
text(lx - 38, 198, "XKC-Y25-V", 9, fill="#666")
add(f'<path d="M {lx-14},160 L {lx+6},160" stroke="#222" stroke-width="4"/>')
add(f'<rect x="{lx+6}" y="137" width="44" height="44" rx="4" fill="#1b1b1b"/>')
text(lx + 6, 100, "Level sensor", 12, weight="bold")
text(lx + 6, 115, "(sensor + DFRobot adapter)", 10, fill="#666")
cable([(21, C["5v"]), (22, C["d4"]), (26, C["gnd"])], 181, lx + 28)

# pH board: red 28, blue 29, black 30
px_ = rx(31)
add(f'<rect x="{px_-30}" y="140" width="60" height="54" rx="4" fill="#1b1b1b"/>')
add(f'<rect x="{px_-8}" y="122" width="16" height="22" fill="#ddd" stroke="#999"/>')
add(f'<rect x="{px_+14}" y="150" width="9" height="9" fill="#2a5bd7"/>')
text(px_ - 6, 182, "pH V1.1", 9, fill="#ddd")
text(px_, 100, "pH board", 12, weight="bold")
text(px_, 115, "(probe on the BNC)", 10, fill="#666")
cable([(28, C["5v"]), (29, C["a0"]), (30, C["gnd"])], 194, px_)

# ---- resistors (leads in hole c)
resistor(rx(13), rx(17), HOLE["c"], ["#e6b800", "#7f3fbf", "#d62728", "#c9a227"], "4.7 kΩ pull-up")
resistor(rx(22), rx(26), HOLE["c"], ["#7a4a1e", "#111", "#ff7f0e", "#c9a227"], "10 kΩ pull-down")

# ---- jumpers, hole a -> rail
for r in (3, 7, 13, 21, 28):
    wire([(rx(r), HOLE["a"]), (rx(r), RAIL["+"])], C["5v"], 3)
for r in (4, 8, 18, 26, 30):
    wire([(rx(r), HOLE["a"]), (rx(r), RAIL["-"])], C["gnd"], 3)

# ---- Uno power to the rails
x5, y5 = uno("top", "5V")
wire([(x5, y5), (x5, 745), (rx(11), 745), (rx(11), RAIL["+"])], C["5v"])
xg, yg = uno("top", "GND")
wire([(xg, yg), (xg, 735), (rx(12), 735), (rx(12), RAIL["-"])], C["gnd"])

# ---- signals to the top header
xa5, _ = uno("top", "A5")
wire([(rx(9), HOLE["a"]), (rx(9), 690), (xa5, 690), (xa5, TOP_PIN_Y)], C["scl"])
xa4, _ = uno("top", "A4")
wire([(rx(10), HOLE["a"]), (rx(10), 700), (xa4, 700), (xa4, TOP_PIN_Y)], C["sda"])
xa0, _ = uno("top", "A0")
wire([(rx(29), HOLE["a"]), (rx(29), 760), (xa0, 760), (xa0, TOP_PIN_Y)], C["a0"])

# ---- signals around the left edge to the digital header
for r, name, col, lane, xl, yb in ((2, "D2", C["d2"], 680, 28, 1080), (17, "D3", C["d3"], 710, 19, 1090),
                                    (22, "D4", C["d4"], 720, 10, 1100)):
    xd, yd = uno("bot", name)
    wire([(rx(r), HOLE["a"]), (rx(r), lane), (xl, lane), (xl, yb), (xd, yb), (xd, BOT_PIN_Y)], col)

# ---- legend
LX, LY = 830, 110
text(LX, LY, "Wires to the Uno", 15, "start", "bold")
rows = [
    ("5V", C["5v"], "+ rail"),
    ("GND", C["gnd"], "− rail"),
    ("D2", C["d2"], "row 2: DHT11 S"),
    ("D3", C["d3"], "row 17: DS18B20 yellow"),
    ("D4", C["d4"], "row 22: level sensor green"),
    ("A0", C["a0"], "row 29: pH board blue"),
    ("A4", C["sda"], "row 10: BH1750 SDA"),
    ("A5", C["scl"], "row 9: BH1750 SCL"),
]
for i, (pin, col, desc) in enumerate(rows):
    y = LY + 28 + i * 22
    add(f'<rect x="{LX}" y="{y-9}" width="26" height="6" rx="3" fill="{col}"/>')
    text(LX + 34, y - 2, pin, 12, "start", "bold")
    text(LX + 74, y - 2, desc, 12, "start")
y = LY + 28 + len(rows) * 22 + 18
text(LX, y, "Resistors", 15, "start", "bold")
notes = [
    ("4.7 kΩ: row 13 to row 17 (hole c)", "bold"),
    ("yellow, violet, red, gold", None),
    ("10 kΩ: row 22 to row 26 (hole c)", "bold"),
    ("brown, black, orange, gold", None),
    ("", None),
    ("Power rows", "bold"),
    ("Red jumper from hole a to the + rail:", None),
    ("rows 3, 7, 13, 21, 28.", None),
    ("Black jumper from hole a to the − rail:", None),
    ("rows 4, 8, 18, 26, 30.", None),
    ("", None),
    ("Leave BH1750 ADDR (row 11) unconnected.", None),
    ("Power the level sensor from 5V only:", None),
    ("its signal is as high as its supply,", None),
    ("and 12–24V would destroy pin D4.", None),
    ("", None),
    ("Unplug the USB cable before changing wiring.", "bold"),
]
for i, (n, wgt) in enumerate(notes):
    text(LX, y + 22 + i * 18, n, 12, "start", wgt or "normal")
out.extend(late)
out.append('</svg>')
sys.stdout.write("\n".join(out))
