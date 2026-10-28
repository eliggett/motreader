# Control-head drawings

One Inkscape drawing per head: `head-a4-rotary`, `head-a5-basic`,
`head-a7-enhanced`, `head-a9-s9000e` (`-inkscape.svg`). Edit them in Inkscape,
then regenerate the web app's copies:

    python3 tools/build_heads.py

That writes `web/app/heads/<head>.js` (one file per head, plain data, so
diffs stay readable). `npm test` fails if they are stale.

What the generator reads (colours and styles are ignored; the app has its own):

- **Layers** by their Inkscape name: `Buttons` (programmable keys), `Buttons_NP`,
  `LEDs`, `LEDs_NP`, `Knobs`, `Misc`, `Text`, `Outlines` (areas; a label with
  "display" in it is drawn darkest), `OverallOutline` (the panel),
  `TotalOutline` (not drawn). `_NP` = not programmable.
- **Shapes** by their Inkscape label (Object Properties → Label): in `Buttons`,
  `btn-ind1`..`btn-ind6`, `btn-0`..`btn-9`, `btn-star`, `btn-hash`,
  `btn-mode-dn`, `btn-mode-up`, `btn-vol-dn`, `btn-vol-up`, `btn-zone-up`,
  `btn-home`. LEDs with `xmit` / `busy` in the label are drawn red / amber,
  others green.
- Rects, circles, ellipses and text only; a layer may be translated, but no
  groups inside layers. The generator stops with a message on anything else, a
  duplicate label, or a `btn-` name that isn't a button.
