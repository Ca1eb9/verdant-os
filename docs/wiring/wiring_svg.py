"""Drawing helpers shared by the wiring diagram scripts (plain Python, no packages).

Each script draws into `out`; `late` is drawn on top of everything (labels
over wires). `finish()` joins them into the SVG text.
"""

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


def finish():
    return "\n".join(out + late + ["</svg>"])


def draw_standing_resistor(x0, x1, y, bands, label):
    """A resistor standing on end between two neighbouring holes (seen from above):
    the body over the first hole, the bent-back lead into the second."""
    add(f'<path d="M {x0},{y} C {x0},{y - 16} {x1},{y - 16} {x1},{y}" fill="none" stroke="#888" stroke-width="2"/>')
    add(f'<circle cx="{x0}" cy="{y}" r="9" fill="#e8d3a6" stroke="#8a6d3b"/>')
    for i, c in enumerate(bands):
        add(f'<circle cx="{x0}" cy="{y}" r="{8 - i * 2}" fill="none" stroke="{c}" stroke-width="1.6"/>')
    add(f'<circle cx="{x1}" cy="{y}" r="3" fill="#888"/>')
    if label:
        add(f'<rect x="{(x0 + x1) / 2 - 22}" y="{y + 12}" width="44" height="15" rx="4" fill="#174a2d"/>')
        text((x0 + x1) / 2, y + 23, label, 10, weight="bold", fill="#fff")


class PermaProtoHalf:
    """Adafruit Perma-Proto half-sized board, top view: 30 rows of two 5-hole
    strips (a-e, f-j) and two rails along each long edge, laid out like a
    breadboard. `rx(row)` and `hole[letter]` give hole positions."""

    PITCH = 22
    ROWS = 30

    def __init__(self, bx, by):
        self.bx, self.by = bx, by
        self.rail_top = {"+": by + 28, "-": by + 50}
        self.hole = {"j": by + 92, "i": by + 114, "h": by + 136, "g": by + 158, "f": by + 180,
                     "e": by + 228, "d": by + 250, "c": by + 272, "b": by + 294, "a": by + 316}
        self.rail = {"+": by + 358, "-": by + 380}
        self.width = self.ROWS * self.PITCH + 110
        self.height = self.rail["-"] + 30 - by

    def rx(self, r):
        return self.bx + 55 + (r - 1) * self.PITCH

    def draw(self):
        bx, by, rx, hole = self.bx, self.by, self.rx, self.hole
        add(f'<rect x="{bx}" y="{by}" width="{self.width}" height="{self.height}" rx="10" fill="#1f5e3a" '
            f'stroke="#174a2d" stroke-width="2"/>')
        for mx in (bx + 22, bx + self.width - 22):
            add(f'<circle cx="{mx}" cy="{(hole["f"] + hole["e"]) / 2}" r="9" fill="#fff" stroke="#c9c2b2" stroke-width="2"/>')
        for rails in (self.rail_top, self.rail):
            for s, y in rails.items():
                col = "#ff6b6b" if s == "+" else "#7fa8ff"
                ly = y - 11 if s == "+" else y + 11
                add(f'<line x1="{rx(1) - 10}" y1="{ly}" x2="{rx(self.ROWS) + 10}" y2="{ly}" stroke="{col}" stroke-width="1.5"/>')
                text(rx(1) - 22, y + 5, s if s == "+" else "−", 15, weight="bold", fill=col)
                for r in range(1, self.ROWS + 1):
                    add(f'<circle cx="{rx(r)}" cy="{y}" r="4" fill="#d8c27a"/>')
        for letter, y in hole.items():
            text(rx(1) - 22, y + 4, letter, 10, fill="#bfe3cc")
            for r in range(1, self.ROWS + 1):
                add(f'<circle cx="{rx(r)}" cy="{y}" r="4" fill="#d8c27a"/>')
        for r in range(1, self.ROWS + 1):
            text(rx(r), hole["j"] - 14, str(r), 9, fill="#bfe3cc", weight="bold" if r % 5 == 0 else "normal")
