#!/usr/bin/env python3
"""Turn the control-head drawings (graphics/head-*-inkscape.svg, edited in
Inkscape) into the web app's head data, one module per head
(web/app/heads/<head>.js) plus web/app/heads/index.js.

    python3 tools/build_heads.py           # rewrite the files
    python3 tools/build_heads.py --check   # exit 1 if any is stale

The drawings name things with Inkscape labels (inkscape:label), not ids:
layers ("Buttons", "Buttons_NP", "LEDs_NP", "Outlines", ...; "_NP" = not
programmable) and shapes ("btn-ind1", "btn-7", "btn-star", "LED-xmit",
"outline-display", ...). Only geometry is taken (the app has its own colours):
rects, circles and text, with the layers' translate() baked in. Anything else,
a duplicate label, an unlabelled button or a btn-* name that isn't a
motreader button stops the build.
"""
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "graphics")
OUT = os.path.join(ROOT, "web", "app", "heads")
SVG = "{http://www.w3.org/2000/svg}"
INK = "{http://www.inkscape.org/namespaces/inkscape}"

# drawing file (head-<key>-...) -> RSS's control head type
HEADS = {"a4": "Rotary", "a5": "Standard", "a7": "Enhanced", "a9": "S9000e"}
# btn-<x> -> motreader's button name (buttons.csv)
NAMED = {"star": "*", "hash": "#", "mode-dn": "Mode Dn", "mode-up": "Mode Up",
         "vol-dn": "Vol Dn", "vol-up": "Vol Up", "zone-up": "Zone Up", "home": "Home"}
BUTTON_LAYERS = ("Buttons",)


class DrawingError(Exception):
    pass


def num(v) -> float:
    return round(float(v), 2)


def translate(el, where):
    """(dx, dy) of an element's transform (only translate() is supported)."""
    t = el.get("transform")
    if not t:
        return 0.0, 0.0
    m = re.fullmatch(r"\s*translate\(\s*([-\d.e]+)[\s,]*([-\d.e]+)?\s*\)\s*", t)
    if not m:
        raise DrawingError(f"{where}: transform {t!r} (only translate() is supported)")
    return float(m.group(1)), float(m.group(2) or 0)


def button_of(label: str):
    """'btn-ind1' -> 'Ind 1', 'btn-7' -> '7', 'btn-star' -> '*'; None if not a motreader button."""
    x = label[4:]
    if re.fullmatch(r"ind[1-6]", x):
        return f"Ind {x[3]}"
    if re.fullmatch(r"\d", x):
        return x
    return NAMED.get(x)


def font_size(el):
    m = re.search(r"font-size:\s*([\d.]+)px", el.get("style", ""))
    return num(m.group(1)) if m else 4.94


def shape(el, dx, dy, layer, where):
    tag = el.tag.replace(SVG, "")
    label = el.get(INK + "label")
    ex, ey = translate(el, where)
    dx, dy = dx + ex, dy + ey
    s = {"label": label} if label else {}
    if tag == "rect":
        s.update(kind="rect", x=num(float(el.get("x", 0)) + dx), y=num(float(el.get("y", 0)) + dy),
                 w=num(el.get("width")), h=num(el.get("height")),
                 rx=num(el.get("rx") or el.get("ry") or 0), ry=num(el.get("ry") or el.get("rx") or 0))
    elif tag == "circle":
        s.update(kind="circle", cx=num(float(el.get("cx")) + dx), cy=num(float(el.get("cy")) + dy), r=num(el.get("r")))
    elif tag == "ellipse":
        s.update(kind="ellipse", cx=num(float(el.get("cx")) + dx), cy=num(float(el.get("cy")) + dy),
                 rx=num(el.get("rx")), ry=num(el.get("ry")))
    elif tag == "text":
        spans = [t for t in el.iter(SVG + "tspan")] or [el]
        first = spans[0]
        text = "".join(t.text or "" for t in spans).strip()
        s.update(kind="text", text=text, x=num(float(first.get("x", el.get("x", 0))) + dx),
                 y=num(float(first.get("y", el.get("y", 0))) + dy), size=font_size(el))
    else:
        raise DrawingError(f"{where}: <{tag}> isn't supported (use rects, circles, ellipses and text)")
    if label and label.startswith("btn-") and layer in BUTTON_LAYERS + ("Buttons_NP",):
        b = button_of(label)
        if b is None and layer in BUTTON_LAYERS:
            raise DrawingError(f"{where}: {label!r} isn't a motreader button "
                               "(btn-ind1..6, btn-0..9, btn-star, btn-hash, btn-mode-dn, ...)")
        if b is not None:
            s["button"] = b
    if layer in BUTTON_LAYERS and tag != "text" and "button" not in s:
        raise DrawingError(f"{where}: an unlabelled shape in the {layer} layer (label it btn-...)")
    return s


def read_head(path):
    """{viewBox, layers: {name: [shape...]}} of one drawing."""
    name = os.path.basename(path)
    root = ET.parse(path).getroot()
    vb = [num(v) for v in root.get("viewBox", "").replace(",", " ").split()]
    if len(vb) != 4:
        raise DrawingError(f"{name}: no viewBox")
    layers = {}
    seen = set()
    for g in root.findall(SVG + "g"):
        if g.get(INK + "groupmode") != "layer":
            continue
        lname = g.get(INK + "label") or g.get("id")
        dx, dy = translate(g, f"{name} layer {lname}")
        shapes = []
        for el in g:
            tag = el.tag.replace(SVG, "")
            if tag == "g":
                raise DrawingError(f"{name} layer {lname}: a group inside a layer (ungroup it)")
            s = shape(el, dx, dy, lname, f"{name} layer {lname} {el.get(INK + 'label') or el.get('id')}")
            lab = s.get("label")
            if lab:
                if lab in seen:
                    raise DrawingError(f"{name}: label {lab!r} used twice")
                seen.add(lab)
            shapes.append(s)
        if lname in layers:
            raise DrawingError(f"{name}: two layers named {lname!r}")
        layers[lname] = shapes
    return {"viewBox": vb, "layers": layers}


def render_head(key, src, head):
    j = lambda x: json.dumps(x, separators=(", ", ": "))  # noqa: E731
    lines = [
        "// @ts-check",
        f"// GENERATED by tools/build_heads.py from graphics/{src}; do not edit by hand.",
        f"/** The {HEADS[key]} control head ({key.upper()}): see heads/index.js. */",
        "",
        "/** @type {import(\"./index.js\").HeadDrawing} */",
        "export default {",
        f"    head: {j(HEADS[key])},",
        f"    viewBox: {j(head['viewBox'])},",
        "    layers: {",
    ]
    for lname, shapes in head["layers"].items():
        if not shapes:
            lines.append(f"        {j(lname)}: [],")
            continue
        lines.append(f"        {j(lname)}: [")
        lines += [f"            {j(s)}," for s in shapes]
        lines.append("        ],")
    lines += ["    },", "};", ""]
    return "\n".join(lines)


def render_index(keys):
    lines = [
        "// @ts-check",
        "// GENERATED by tools/build_heads.py; do not edit by hand.",
        "/**",
        " * The control-head drawings, by RSS's control head type. Layers (Inkscape",
        " * layer names; \"_NP\" = not programmable) hold shapes in drawing",
        " * coordinates; a shape in Buttons / Buttons_NP may name the motreader",
        " * button it is (`button`).",
        " *",
        " * @typedef {{ label?: string, button?: string, kind: \"rect\" | \"circle\" | \"ellipse\" | \"text\",",
        " *   x?: number, y?: number, w?: number, h?: number, rx?: number, ry?: number,",
        " *   cx?: number, cy?: number, r?: number, text?: string, size?: number }} HeadShape",
        " * @typedef {{ head: string, viewBox: number[], layers: Record<string, HeadShape[]> }} HeadDrawing",
        " */",
    ]
    names = []
    for key, mod in keys:
        var = key.upper()
        lines.insert(len(lines), f"import {var} from \"./{mod}.js\";")
        names.append((HEADS[key], var))
    lines += [
        "",
        "/** RSS head type -> drawing. @type {Readonly<Record<string, HeadDrawing>>} */",
        "export const HEAD_DRAWINGS = { " + ", ".join(f"{h}: {v}" for h, v in names) + " };",
        "",
    ]
    return "\n".join(lines)


def build():
    """{output path: text}"""
    out = {}
    keys = []
    for f in sorted(os.listdir(SRC)):
        m = re.fullmatch(r"head-(a\d)-(.+?)(?:-inkscape)?\.svg", f)
        if not m:
            continue
        key = m.group(1)
        if key not in HEADS:
            raise DrawingError(f"{f}: unknown head {key} (known: {', '.join(HEADS)})")
        mod = f"{key}-{m.group(2)}"
        out[os.path.join(OUT, mod + ".js")] = render_head(key, f, read_head(os.path.join(SRC, f)))
        keys.append((key, mod))
    out[os.path.join(OUT, "index.js")] = render_index(keys)
    return out


def main():
    try:
        files = build()
    except DrawingError as e:
        sys.exit(f"build_heads: {e}")
    if "--check" in sys.argv:
        stale = [p for p, t in files.items() if not os.path.exists(p) or open(p).read() != t]
        if stale:
            sys.exit("stale (run tools/build_heads.py): " + ", ".join(os.path.relpath(p, ROOT) for p in stale))
        return
    os.makedirs(OUT, exist_ok=True)
    for p, t in files.items():
        with open(p, "w") as fh:
            fh.write(t)
        print(f"wrote {os.path.relpath(p, ROOT)}")


if __name__ == "__main__":
    main()
