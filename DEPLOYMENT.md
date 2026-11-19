# NHVet411 — Deployment Guide (GitHub + Supabase + NHVet411.org)

This guide takes your clean baseline repository (`Ricoyoung11/nhvet411`) live on **`NHVet411.org`**.

---

## Step 1: Set Up Supabase

1. Sign in to [supabase.com](https://supabase.com/) and create a project (region: **US East**).
2. Open **SQL Editor**, paste the contents of `supabase/migrations/001_initial_schema.sql`, and click **Run**.
   - Creates `organizations`, `staff_contacts` (shared emails across VSOs permitted), `amplifier_docs`, `pending_submissions`, `moderators`, `audit_logs`, Row Level Security (RLS), and the `vso-flyers` Storage bucket.
3. In **Project Settings → API**, copy your **Project URL**, **anon key**, and **service_role key**.

---

## Step 2: Seed the Clean 147-Org Baseline into Supabase

In your local clone of `Ricoyoung11/nhvet411`:

```bash
cp .env.example .env
# Fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY inside .env
npm install
npm run seed
```

This idempotently loads all 147 verified baseline organizations (with `ryoung28` removed from `vso-111`, shared emails intact, and SWAM/Angers clear for upload testing).

---

## Step 3: Add Moderators in Supabase

1. In Supabase → **Authentication → Users**, add accounts for yourself and any trusted NHVet411 moderators.
2. Register each moderator's User UUID in the SQL Editor:

```sql
insert into public.moderators (user_id, email, display_name, role)
values ('PASTE-USER-UUID-HERE', 'your-email@example.com', 'Richard Young', 'admin');
```

---

## Step 4: Host the Static Site (Cloudflare Pages or Vercel)

Because `index.html` and the PDF flyers live cleanly in the repository root:

### Option A: Cloudflare Pages (Recommended — Free Tier, Unlimited Bandwidth)
1. Go to **Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git**.
2. Select **`Ricoyoung11/nhvet411`**.
3. Build settings:
   - **Framework preset:** `None`
   - **Build command:** `node build_website.js` *(or leave empty to serve the committed `index.html` directly)*
   - **Build output directory:** `/`
4. Click **Save and Deploy**.

### Option B: Vercel
1. Import `Ricoyoung11/nhvet411` on [vercel.com](https://vercel.com/).
2. Framework preset: **Other**, output directory: `.` (root).
3. Click **Deploy**.

---

## Step 5: Connect `NHVet411.org`

1. Register `nhvet411.org` (Cloudflare Registrar, Porkbun, or Namecheap).
2. In Cloudflare Pages (or Vercel) → **Custom Domains**, add `nhvet411.org` and `www.nhvet411.org`.
3. Follow the DNS CNAME/ALIAS instructions; HTTPS/SSL activates automatically.
