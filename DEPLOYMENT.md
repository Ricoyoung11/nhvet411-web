# NHVet411 — Simple Go-Live Guide (GitHub + Supabase + NHVet411.org)

This guide takes your repository (**`Ricoyoung11/nhvet411-web`**, branch **`clean-baseline`**) live on **`NHVet411.org`** with your Gemini API key secured server-side inside Supabase.

---

## Step 1: Create Your Supabase Project & Database
1. Sign in to [supabase.com](https://supabase.com/) and create a new project (region: **US East**).
2. Open **SQL Editor**, paste the contents of `supabase/migrations/001_initial_schema.sql`, and click **Run**.
3. Go to **Project Settings → API** and copy:
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
   *(Do **NOT** put `GEMINI_API_KEY` or `SUPABASE_SERVICE_ROLE_KEY` in Cloudflare!)*
5. Click **Save and Deploy**.

*(Alternative: Vercel — import `Ricoyoung11/nhvet411-web`, Build Command `node build_website.js`, Output Directory `.`, add the same two public environment variables, and click **Deploy**.)*

---

## Step 5: Connect `NHVet411.org`
1. Buy/register **`nhvet411.org`** (Cloudflare Registrar, Porkbun, or Namecheap).
2. In Cloudflare Pages → **Custom Domains**, add **`nhvet411.org`** and **`www.nhvet411.org`**.
3. Follow the one-click DNS setup; free HTTPS/SSL activates automatically in a few minutes.

---

## Step 6: Add Yourself as Moderator (Optional — For Review Queue)
1. In Supabase → **Authentication → Users**, create your admin account and copy your **User UUID**.
2. In Supabase → **SQL Editor**, run:
```sql
insert into public.moderators (user_id, email, display_name, role)
values ('PASTE-USER-UUID-HERE', 'your-email@example.com', 'Richard Young', 'admin');
```
