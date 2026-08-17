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

## Admin and client access

The site has two modes (soft-gated — this is static hosting with no real login, so treat it as convenience, not security):

- **Admin console** — the root URL (passcode-gated). Full access to all three models. The top nav holds the pricing-model switch, a **Config code** button (copy/apply, opens a dialog), and an admin-only **Share** button that opens the client-link dialog.
- **Client view** — a `?view=client` link (no passcode). Clients get the model switch and the **Config code** dialog (copy/apply), but not the **Share** button. Single-model links (`&model=…`) hide the switch and show a fixed model badge instead.

## Sharing a configuration

Configurations are shared as a copy-paste **configuration code** — `PPCC1-<COURT|SPOT|HYB>-…`. A code is **model-locked**: a Court+ code only loads into Court+, a Spot+ code only into Spot+, etc.

From the admin console's **Share** dialog you can also copy **client links**:

- `?view=client` — client can switch between all three models.
- `?view=client&model=court-plus` (or `spot-plus` / `hybrid`) — client is locked to that one model.

Work autosaves to the browser's `localStorage`, so it persists across refreshes and return visits on the same device. The **Save as PDF** button produces a printable summary — including the court group and the configuration code — for the client to send to their PodPlay contact.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Markup and layout |
| `styles.css` | PodPlay-branded theme (light + dark) |
| `app.js` | State, pricing math, autosave, and PDF export |

Work autosaves to the browser's `localStorage`. The primary action, **Save as PDF**, opens a printable summary the client shares with PodPlay to have the pricing applied to their courts.
