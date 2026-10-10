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
