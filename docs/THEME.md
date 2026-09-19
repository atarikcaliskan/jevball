# JevBall theme — "Matchday broadcast"

JevBall must NOT look like a generic white "glass card" dashboard. Its identity is a **TV football broadcast
crossed with a coach's tactics board**, seen at a night-match scoreboard's contrast level while the 3D
scene itself stays bright daylight.

## Tokens (CSS custom properties, defined once in `src/theme.css`, imported by both pages)

| Token | Value | Use |
|---|---|---|
| `--ink` | `#0a120e` | deepest background, panel base (green-black) |
| `--panel` | `#0f1b15e6` | translucent dark panel over the 3D scene (blur 14px) |
| `--panel-line` | `#ffffff1f` | 1px panel borders, chalk hairlines |
| `--turf` | `#14502c` | mid green surfaces, landing sections |
| `--turf-bright` | `#1f8a46` | highlights, progress |
| `--chalk` | `#f4f1e8` | primary text on dark, pitch-line motifs |
| `--chalk-dim` | `#a9b5ab` | secondary text |
| `--flood` | `#ffe14a` | THE accent: floodlight yellow — primary buttons, selected option, focus rings, live dots |
| `--home` | `#e82127` | Jev United |
| `--away` | `#3e6ae1` | System One FC |
| `--risk` | `#ff8a3c` | risky options |
| `--shot` | `#ff4d3d` | shots, goal flashes |

Type: **Barlow Condensed** 600/700 (uppercase, tight tracking) for display, scoreboard, buttons, labels;
**Barlow** 400/500 for body; **JetBrains Mono** 500 for data chips, probabilities, JSON. Load from Google Fonts.

Shape language: TV score-bug slabs — small radii (3–6 px), **skewed/parallelogram ends via `clip-path`** or
`transform: skewX(-12deg)` on scoreboard and primary buttons, team-colour bars on slab edges, thin chalk
hairlines, dashed tactics-board lines, pitch-marking motifs (centre circle, penalty arc, corner arcs,
mowing stripes as subtle repeating gradients), X/O tactics glyphs. No white glass cards, no big soft shadows,
no rounded pills. Motion: quick broadcast wipes (slide + clip reveal, 180–260 ms), score flip on goals,
respect `prefers-reduced-motion`.

On-pitch decision arrows (3D ribbons): tactics-board chalk — options translucent chalk white `#f4f1e8`,
risky `#ff8a3c`, shot `#ff4d3d`, **selected = floodlight yellow `#ffe14a`** with the travelling pulse.
DOM probability chips: dark ink slab, mono text, selected = yellow slab with ink text.

Brand: wordmark "JEVBALL" in Barlow Condensed 700 uppercase, with the mark `public/brand/jevball-mark.svg`
(may be redrawn to fit: ink square → a pitch-circle/ball motif with a yellow accent dot).
