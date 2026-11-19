# NHVet411 — Clean Baseline Repository

New Hampshire's Verified Veteran & VSO Resource Directory (`NHVet411.org`).

> **Permanent Change-Control Rules:** See **[NHVET411_RULES.md](./NHVET411_RULES.md)** before making any edits. All changes must be targeted, preserve existing fonts/background/layout unless explicitly requested, and pass a two-pass review.

---

## Baseline Status

- **Exact Original Frontend Preserved:** `build_website.js` and the generated `index.html` retain your original design, fonts, frosted mural background, colors, layout, and functions untouched.
- **Clean 147-Org Dataset (`nh_organizations_data.json`):**
  - Removed `Richard Young` (`ryoung28@gmail.com`) from **Wounded Warrior Project (`vso-111`)**.
  - Preserved shared emails across multiple VSOs.
  - Kept **SWAM** and **Angers Peace** out of the 147-org baseline for post-reset upload testing.
  - Included the two referenced baseline flyers (`walkwithtiger.pdf` and `The Honor Bear project.pdf`).

---

## View Locally in Chrome

Because `index.html` is a self-contained static page built by `build_website.js`, you can open it **directly in Chrome**:

1. Clone this repository (or click **Code → Download ZIP** on GitHub).
2. Double-click **`index.html`** to open it in Chrome.

To rebuild `index.html` after editing `build_website.js` or `nh_organizations_data.json`:

```bash
node build_website.js          # Rebuilds index.html from nh_organizations_data.json
node build_website.js --reset  # Rebuilds clean 147-org baseline from nh_vet_services_master.json
```

---

## Ready to Deploy

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the step-by-step guide to connecting **Supabase**, seeding the 147-org database, and launching on **`NHVet411.org`** via Cloudflare Pages or Vercel.
