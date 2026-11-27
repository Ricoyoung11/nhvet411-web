# NHVet411 Strict Baseline & Targeted-Change Rules

These are permanent project rules for **NHVet411** (`NHVetWiki`). Every AI assistant and contributor must follow them on every task.

---

## 1. Preserve the Existing Baseline (Zero Unrequested Changes)
- **Start strictly from the existing original files** (`build_website.js`, `index.html`, and the JSON data files). Never rewrite the application from scratch.
- **Do NOT change** fonts, typography, background images, colors, CSS classes, page layout, or existing working functions unless explicitly instructed.
- Only edit the **exact capability or bug** requested. Leave all unrelated code and UI untouched.

## 2. Anti-Bloat & Recommendations Policy
- The website is already information-dense. **Do NOT add unrequested UI panels, extra cards, banners, or features.**
- When identifying opportunities to improve UX, security, or helpfulness outside the explicit request, **do not implement them automatically**. Instead, list them separately under **"Optional Recommendations"** (1–2 sentences each + why it helps) and wait for explicit approval.

## 3. Mandatory Two-Pass Review on Every Change
Before finishing any edit, perform **two full passes**:
- **Pass 1 — Targeted Implementation:** Make only the requested change cleanly and minimally.
- **Pass 2 — Adversarial Verification & Ripple-Effect Check:** Re-read and test the change a second time specifically checking for:
  1. **Bugs & Regressions:** Did this break any existing filter, modal, submission, merge, PDF/flyer viewer, or mobile layout?
  2. **Edge Cases:** Typos, empty fields, shared POC emails across VSOs, NH town-name collisions, special characters/XSS, large files, and offline/no-API-key fallbacks.
  3. **UX & Clutter:** Does it fit naturally into the existing UI without crowding the screen or adding jargon?
  4. **Side-Effect Audit:** Verify every function/section touched and confirm nothing outside scope was altered.

## 4. Required Reporting Format
After every change, report concisely:
1. **Exact files & functions modified** (explicitly confirming fonts, background, and layout were untouched).
2. **Pass 2 Review findings** (edge cases & ripple effects checked and fixed).
3. **Optional Recommendations** (unimplemented ideas for approval).

## 5. What's New & Version-Bump Approval Gate
- User-facing release notes live in `whats_new.json` (which drives both the footer **What's New** modal and `version.json` update checks).
- **Mandatory Owner Approval:** Never bump `currentVersion` or publish new/edited `whats_new.json` text until the site owner has explicitly reviewed and approved the exact wording.
- Keep **What's New** entries at a **30,000ft plain-English level** for everyday veterans and families—no internal technical details, moderation mechanics, or overly descriptive jargon.

