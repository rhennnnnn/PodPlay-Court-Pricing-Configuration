# PodPlay Court Pricing Configuration

A standalone, client-facing web tool that lets a PodPlay client configure their own court pricing, then export it as a readable PDF to share with their PodPlay Customer Success contact for setup.

It is a pure static site — no backend, no build step, no dependencies.

## Pricing models

One app with a segmented switch between three models:

- **Court+ (Per Court)** — one court price shared across the whole group.
- **Spot+ (Per Spot)** — the court price is split per person; each player pays their own spot.
- **Hybrid (Mixed)** — non-members pay the full court price; members pay per person.

Each model supports time bands (Off Peak / Peak / Reduced), a default member discount, custom memberships with per-band discounts, court lock fees, lesson discounts, and an optional day pass.

## Run it

It's three files. Open `index.html` in a browser, or serve the folder:

```bash
python -m http.server 8091
```

Then visit `http://localhost:8091/`.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Markup and layout |
| `styles.css` | PodPlay-branded theme (light + dark) |
| `app.js` | State, pricing math, autosave, and PDF export |

Work autosaves to the browser's `localStorage`. The primary action, **Save as PDF**, opens a printable summary the client shares with PodPlay to have the pricing applied to their courts.
