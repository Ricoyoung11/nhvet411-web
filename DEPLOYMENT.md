# NHVet411 — Simple Go-Live Guide (GitHub + Supabase + NHVet411.org)

This guide takes your repository (**`Ricoyoung11/nhvet411-web`**, branch **`clean-baseline`**) live on **`NHVet411.org`** with your Gemini API key secured server-side inside Supabase.

---

## Step 1: Create Your Supabase Project & Database
1. Sign in to [supabase.com](https://supabase.com/) and create a new project (region: **US East**).
2. Open **SQL Editor**, paste the contents of `supabase/migrations/001_initial_schema.sql`, and click **Run**.
3. Next, open a new **SQL Editor** query, paste `supabase/migrations/002_moderation_and_rls.sql`, and click **Run**.
   - Verify the output table at the bottom shows **`rls_enabled = true`** for all 6 tables (`audit_logs`, `amplifier_docs`, `moderators`, `organizations`, `pending_submissions`, `staff_contacts`).
4. Go to **Project Settings → API** and copy:
   - **Project URL** (`https://<PROJECT_REF>.supabase.co`)
   - **anon public key**
   - **service_role secret key** (only for seeding locally — never put this in the website)

---

## Step 2: Seed Your 147 Verified Organizations
On your computer, clone the repo and run the seeder once:

```bash
git clone https://github.com/Ricoyoung11/nhvet411-web.git
cd nhvet411-web
cp .env.example .env
# Edit .env and paste SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
npm install
npm run seed
```

---

## Step 3: Deploy the Secure Gemini Edge Function (Keeps Your API Key Private)
Install or run the Supabase CLI (`npx supabase`) inside `nhvet411-web`:

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF

# Store your Gemini API key & allowed web origins as server-side Supabase secrets
# (Include your *.pages.dev preview URL while testing before NHVet411.org DNS is live)
npx supabase secrets set GEMINI_API_KEY=YOUR_REAL_GEMINI_API_KEY
npx supabase secrets set ALLOWED_ORIGINS="https://nhvet411.org,https://www.nhvet411.org,https://nhvet411-web.pages.dev"

# Deploy the public search & flyer proxy function
npx supabase functions deploy gemini-search-proxy --no-verify-jwt
```

Your live proxy URL will be:
`https://YOUR_PROJECT_REF.supabase.co/functions/v1/gemini-search-proxy`

---

## Step 4: Publish the Site on Cloudflare Pages (Free Tier, Unlimited Bandwidth)
1. Go to **Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git**.
2. Select **`Ricoyoung11/nhvet411-web`** and branch **`clean-baseline`**.
3. Build settings:
   - **Framework preset:** `None`
   - **Build command:** `node build_website.js`
   - **Build output directory:** `/`
4. Under **Environment variables (Production)**, add:
   - `NHVET411_GEMINI_PROXY_URL` = `https://YOUR_PROJECT_REF.supabase.co/functions/v1/gemini-search-proxy`
   - `NHVET411_SUPABASE_ANON_KEY` = `YOUR_SUPABASE_ANON_KEY`
   *(Do **NOT** put `GEMINI_API_KEY` or `SUPABASE_SERVICE_ROLE_KEY` in Cloudflare! `build_website.js` automatically derives your `SUPABASE_URL` from `NHVET411_GEMINI_PROXY_URL`.)*
5. Click **Save and Deploy**.

*(Alternative: Vercel — import `Ricoyoung11/nhvet411-web`, Build Command `node build_website.js`, Output Directory `.`, add the same two public environment variables, and click **Deploy**.)*

---

## Step 5: Connect `NHVet411.org`
1. Buy/register **`nhvet411.org`** (Cloudflare Registrar, Porkbun, or Namecheap).
2. In Cloudflare Pages → **Custom Domains**, add **`nhvet411.org`** and **`www.nhvet411.org`**.
3. Follow the one-click DNS setup; free HTTPS/SSL activates automatically in a few minutes.

---

## Step 6: Configure Strong Passwords & Add Moderators (Zero Codebase Access)

Moderators **never** need GitHub, Cloudflare, or Supabase Dashboard access. They sign in directly on **`https://nhvet411.org`** via **🔐 Moderator Login**.

### A. One-Time Supabase Auth Settings (Strong Passwords + Reset Redirects)
1. In Supabase → **Authentication → URL Configuration**:
   - **Site URL:** `https://nhvet411.org`
   - **Redirect URLs:** Add `https://nhvet411.org/**` and `https://www.nhvet411.org/**`
2. In Supabase → **Authentication → Providers → Email** (or **Authentication → Settings → Password Settings**):
   - **Minimum password length:** `12`
   - **Password requirements:** Require **lowercase, uppercase, digits, and symbols**.
   - *(Optional extra hardening: disable public self-signup under **Authentication → Providers → Email → Allow new users to sign up** so only accounts you explicitly invite/create can exist.)*

### B. Add Yourself or a New Moderator (~30 seconds)
1. In Supabase → **Authentication → Users**, click **Add user → Create new user** (or **Invite user**), enter their email and a strong initial password, and copy their **User UUID**.
2. In Supabase → **SQL Editor**, add them to the allowlist:
```sql
insert into public.moderators (user_id, email, display_name, role)
values ('PASTE-USER-UUID-HERE', 'mod@example.com', 'Moderator Full Name', 'moderator')
on conflict (user_id) do update
set display_name = excluded.display_name, role = excluded.role;
```
*(Use `'admin'` for yourself and `'moderator'` for VSO moderators.)*

### C. Password Resets (If a Moderator Forgets Their Password)
- **Self-Service (Primary):** On `https://nhvet411.org`, the moderator clicks **🔐 Moderator Login → Forgot password?**, enters their email, opens the recovery email, and sets a new 12+ character strong password directly on the site.
- **Owner Backup:** In Supabase → **Authentication → Users**, click the moderator's row → **Send password recovery** (or delete/ban the user if needed).

### D. Remove / Revoke a Moderator Immediately
Run in Supabase → **SQL Editor**:
```sql
delete from public.moderators where email = 'former-mod@example.com';
```
Their approval & live-edit permissions stop immediately at the database RLS layer.

