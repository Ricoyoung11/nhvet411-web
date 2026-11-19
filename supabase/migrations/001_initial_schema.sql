-- ============================================================================
-- NHVet411 — Initial Supabase Schema, RLS Policies, Storage & Moderator RPC
-- Run in the Supabase SQL Editor (or via `supabase db push`).
-- Note: Shared emails across multiple VSOs are explicitly permitted.
-- ============================================================================

create extension if not exists pgcrypto;

-- 1. Moderators allowlist
create table if not exists public.moderators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  display_name text,
  role text not null default 'moderator' check (role in ('moderator', 'admin')),
  created_at timestamptz not null default now()
);

create or replace function public.is_moderator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.moderators where user_id = auth.uid()
  );
$$;

-- 2. Verified Veteran Service Organizations
create table if not exists public.organizations (
  id text primary key,
  name text not null,
  categories text[] not null default '{}',
  description text not null default '',
  address text not null default '',
  city text not null default 'Statewide',
  zip text not null default '',
  county text not null default 'All Counties',
  region_id text not null default 'statewide',
  secondary_region_id text,
  is_statewide boolean not null default false,
  phone text not null default '',
  email text not null default '',
  website text not null default '',
  branches text[] not null default array['all'],
  verified_vso boolean not null default true,
  last_verified date not null default current_date,
  source_url text not null default '',
  amplifier_doc text,
  status text not null default 'approved' check (status in ('approved', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_orgs_status on public.organizations(status);
create index if not exists idx_orgs_region on public.organizations(region_id);
create index if not exists idx_orgs_county on public.organizations(county);
create index if not exists idx_orgs_categories on public.organizations using gin(categories);
create index if not exists idx_orgs_branches on public.organizations using gin(branches);

-- 3. Staff / POC Contacts (no unique constraint on email — shared emails across VSOs allowed)
create table if not exists public.staff_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.organizations(id) on delete cascade,
  name text not null default '',
  role text not null default '',
  email text not null default '',
  phone text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_staff_org on public.staff_contacts(organization_id);

-- 4. Amplifier Flyers / PDFs
create table if not exists public.amplifier_docs (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.organizations(id) on delete cascade,
  title text not null default 'Resource Flyer',
  storage_path text not null,
  public_url text,
  mime_type text,
  created_at timestamptz not null default now()
);

create index if not exists idx_amp_org on public.amplifier_docs(organization_id);

-- 5. Pending Public Submissions Queue
create table if not exists public.pending_submissions (
  id uuid primary key default gen_random_uuid(),
  submission_type text not null default 'new' check (submission_type in ('new', 'update')),
  target_org_id text references public.organizations(id) on delete set null,
  payload jsonb not null,
  submitter_name text not null default 'Community Contributor',
  submitter_email text not null default '',
  review_status text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_pending_status on public.pending_submissions(review_status, created_at desc);

-- 6. Audit Logs
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_org_id text,
  submission_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- Row Level Security (RLS)
-- ============================================================================
alter table public.moderators enable row level security;
alter table public.organizations enable row level security;
alter table public.staff_contacts enable row level security;
alter table public.amplifier_docs enable row level security;
alter table public.pending_submissions enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists "Public can read approved organizations" on public.organizations;
create policy "Public can read approved organizations"
  on public.organizations for select
  using (status = 'approved' or public.is_moderator());

drop policy if exists "Moderators manage organizations" on public.organizations;
create policy "Moderators manage organizations"
  on public.organizations for all
  using (public.is_moderator())
  with check (public.is_moderator());

drop policy if exists "Public can read staff contacts of approved orgs" on public.staff_contacts;
create policy "Public can read staff contacts of approved orgs"
  on public.staff_contacts for select
  using (
    exists (
      select 1 from public.organizations o
      where o.id = staff_contacts.organization_id and (o.status = 'approved' or public.is_moderator())
    )
  );

drop policy if exists "Moderators manage staff contacts" on public.staff_contacts;
create policy "Moderators manage staff contacts"
  on public.staff_contacts for all
  using (public.is_moderator())
  with check (public.is_moderator());

drop policy if exists "Public can read amplifier docs" on public.amplifier_docs;
create policy "Public can read amplifier docs"
  on public.amplifier_docs for select
  using (
    exists (
      select 1 from public.organizations o
      where o.id = amplifier_docs.organization_id and (o.status = 'approved' or public.is_moderator())
    )
  );

drop policy if exists "Moderators manage amplifier docs" on public.amplifier_docs;
create policy "Moderators manage amplifier docs"
  on public.amplifier_docs for all
  using (public.is_moderator())
  with check (public.is_moderator());

drop policy if exists "Public can insert pending submissions" on public.pending_submissions;
create policy "Public can insert pending submissions"
  on public.pending_submissions for insert
  with check (review_status = 'pending');

drop policy if exists "Moderators manage pending submissions" on public.pending_submissions;
create policy "Moderators manage pending submissions"
  on public.pending_submissions for all
  using (public.is_moderator())
  with check (public.is_moderator());

drop policy if exists "Moderators can read moderators" on public.moderators;
create policy "Moderators can read moderators"
  on public.moderators for select
  using (public.is_moderator());

drop policy if exists "Moderators can read audit logs" on public.audit_logs;
create policy "Moderators can read audit logs"
  on public.audit_logs for select
  using (public.is_moderator());

-- ============================================================================
-- Storage Bucket for Uploaded Flyers (`vso-flyers`)
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'vso-flyers',
  'vso-flyers',
  true,
  10485760,
  array['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
)
on conflict (id) do nothing;

drop policy if exists "Public can read vso-flyers" on storage.objects;
create policy "Public can read vso-flyers"
  on storage.objects for select
  using (bucket_id = 'vso-flyers');

drop policy if exists "Public can upload flyers to submissions folder" on storage.objects;
create policy "Public can upload flyers to submissions folder"
  on storage.objects for insert
  with check (bucket_id = 'vso-flyers' and name like 'submissions/%');

drop policy if exists "Moderators can delete vso-flyers" on storage.objects;
create policy "Moderators can delete vso-flyers"
  on storage.objects for delete
  using (bucket_id = 'vso-flyers' and public.is_moderator());
