-- ============================================================================
-- NHVet411 — Migration 002: Enforce RLS, Rejection Reasons & Concurrency-Safe
-- Moderator Approval / Rejection / Live-Edit RPCs
--
-- Safe to run multiple times (idempotent) in the Supabase SQL Editor.
-- At the end, prints an RLS status confirmation table for all 6 tables.
-- ============================================================================

-- 1. Add customer-service rejection comment & reviewer display name columns
alter table public.pending_submissions
  add column if not exists rejection_reason text;

alter table public.pending_submissions
  add column if not exists reviewed_by_name text;

create index if not exists idx_pending_reviewed_at
  on public.pending_submissions (reviewed_at desc)
  where review_status in ('approved', 'rejected');

-- 2. Explicitly enforce Row Level Security (RLS) across all 6 tables
alter table public.moderators enable row level security;
alter table public.organizations enable row level security;
alter table public.staff_contacts enable row level security;
alter table public.amplifier_docs enable row level security;
alter table public.pending_submissions enable row level security;
alter table public.audit_logs enable row level security;

-- 3. Ensure required table privileges (RLS policies still govern all row access)
grant usage on schema public to anon, authenticated;
grant select on public.organizations, public.staff_contacts, public.amplifier_docs to anon, authenticated;
grant insert on public.pending_submissions to anon, authenticated;
grant select, update, delete on public.pending_submissions to authenticated;
grant select on public.moderators, public.audit_logs to authenticated;
grant insert on public.audit_logs to authenticated;
grant insert, update, delete on public.organizations, public.staff_contacts, public.amplifier_docs to authenticated;

-- 4. Add missing moderator INSERT policy on audit_logs & storage upload policy
drop policy if exists "Moderators can insert audit logs" on public.audit_logs;
create policy "Moderators can insert audit logs"
  on public.audit_logs for insert
  with check (public.is_moderator());

drop policy if exists "Moderators can upload vso-flyers" on storage.objects;
create policy "Moderators can upload vso-flyers"
  on storage.objects for insert
  with check (bucket_id = 'vso-flyers' and public.is_moderator());

-- ============================================================================
-- 5. Internal Helper: Upsert Verified Organization + Contacts + Flyers
--    Called only from moderator-verified SECURITY DEFINER RPCs below.
-- ============================================================================
create or replace function public._nhvet411_upsert_organization(
  p_org jsonb,
  p_staff_contacts jsonb default '[]'::jsonb,
  p_amplifier_docs jsonb default '[]'::jsonb,
  p_replace_contacts boolean default false
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id text;
  v_org_name text;
  v_categories text[];
  v_branches text[];
  v_contact jsonb;
  v_cname text;
  v_crole text;
  v_cemail text;
  v_cphone text;
  v_norm_name text;
  v_existing_contact_id uuid;
  v_doc jsonb;
  v_doc_url text;
  v_doc_path text;
  v_doc_title text;
  v_doc_mime text;
  v_primary_amp text;
begin
  if not public.is_moderator() then
    raise exception 'Unauthorized: Moderator access required' using errcode = '42501';
  end if;

  v_org_id := btrim(coalesce(p_org->>'id', ''));
  v_org_name := btrim(coalesce(p_org->>'name', ''));

  if v_org_id = '' or v_org_name = '' then
    raise exception 'Organization id and name are required' using errcode = '22023';
  end if;

  -- Lock existing organization row (if present) so concurrent approvals serialize safely
  perform 1 from public.organizations where id = v_org_id for update;

  select coalesce(array_agg(elem), array[]::text[])
    into v_categories
  from jsonb_array_elements_text(
    case when jsonb_typeof(p_org->'categories') = 'array' then p_org->'categories' else '[]'::jsonb end
  ) as elem
  where btrim(elem) <> '';

  if array_length(v_categories, 1) is null then
    v_categories := array['veterans-posts-community']::text[];
  end if;

  select coalesce(array_agg(elem), array[]::text[])
    into v_branches
  from jsonb_array_elements_text(
    case when jsonb_typeof(p_org->'branches') = 'array' then p_org->'branches' else '["all"]'::jsonb end
  ) as elem
  where btrim(elem) <> '';

  if array_length(v_branches, 1) is null then
    v_branches := array['all']::text[];
  end if;

  v_primary_amp := nullif(btrim(coalesce(p_org->>'amplifier_doc', '')), '');

  insert into public.organizations (
    id,
    name,
    categories,
    description,
    address,
    city,
    zip,
    county,
    region_id,
    secondary_region_id,
    is_statewide,
    phone,
    email,
    website,
    branches,
    verified_vso,
    last_verified,
    source_url,
    amplifier_doc,
    status,
    updated_at
  )
  values (
    v_org_id,
    v_org_name,
    v_categories,
    coalesce(p_org->>'description', ''),
    coalesce(p_org->>'address', ''),
    coalesce(nullif(btrim(coalesce(p_org->>'city', '')), ''), 'Statewide'),
    coalesce(p_org->>'zip', ''),
    coalesce(nullif(btrim(coalesce(p_org->>'county', '')), ''), 'All Counties'),
    coalesce(nullif(btrim(coalesce(p_org->>'region_id', '')), ''), 'statewide'),
    nullif(btrim(coalesce(p_org->>'secondary_region_id', '')), ''),
    case when lower(btrim(coalesce(p_org->>'is_statewide', ''))) in ('true', 't', '1', 'yes') then true else false end,
    coalesce(p_org->>'phone', ''),
    coalesce(p_org->>'email', ''),
    coalesce(p_org->>'website', ''),
    v_branches,
    case when lower(btrim(coalesce(p_org->>'verified_vso', ''))) in ('false', 'f', '0', 'no') then false else true end,
    current_date,
    coalesce(nullif(p_org->>'source_url', ''), coalesce(p_org->>'website', '')),
    v_primary_amp,
    'approved',
    now()
  )
  on conflict (id) do update set
    name = excluded.name,
    categories = excluded.categories,
    description = excluded.description,
    address = excluded.address,
    city = excluded.city,
    zip = excluded.zip,
    county = excluded.county,
    region_id = excluded.region_id,
    secondary_region_id = excluded.secondary_region_id,
    is_statewide = excluded.is_statewide,
    phone = excluded.phone,
    email = excluded.email,
    website = excluded.website,
    branches = excluded.branches,
    verified_vso = excluded.verified_vso,
    last_verified = current_date,
    source_url = case when excluded.source_url <> '' then excluded.source_url else public.organizations.source_url end,
    amplifier_doc = coalesce(excluded.amplifier_doc, public.organizations.amplifier_doc),
    status = 'approved',
    updated_at = now();

  -- Staff contacts sync:
  --   * Full Edit mode (p_replace_contacts = true): replaces roster so departed VSO staff can be swapped out.
  --   * Merge / Add-Contact / Flyer mode (p_replace_contacts = false): non-destructive append/update so
  --     two moderators adding different contacts to the same VSO never overwrite each other.
  if jsonb_typeof(p_staff_contacts) = 'array' then
    if p_replace_contacts then
      delete from public.staff_contacts where organization_id = v_org_id;
      for v_contact in select value from jsonb_array_elements(p_staff_contacts)
      loop
        v_cname := btrim(coalesce(v_contact->>'name', ''));
        v_crole := btrim(coalesce(v_contact->>'role', ''));
        v_cemail := btrim(coalesce(v_contact->>'email', ''));
        v_cphone := btrim(coalesce(v_contact->>'phone', ''));
        if v_cname <> '' or v_cemail <> '' or v_cphone <> '' then
          insert into public.staff_contacts (organization_id, name, role, email, phone)
          values (
            v_org_id,
            case when v_cname <> '' then v_cname else v_org_name || ' Contact' end,
            v_crole,
            v_cemail,
            v_cphone
          );
        end if;
      end loop;
    else
      for v_contact in select value from jsonb_array_elements(p_staff_contacts)
      loop
        v_cname := btrim(coalesce(v_contact->>'name', ''));
        v_crole := btrim(coalesce(v_contact->>'role', ''));
        v_cemail := btrim(coalesce(v_contact->>'email', ''));
        v_cphone := btrim(coalesce(v_contact->>'phone', ''));
        if v_cname = '' and v_cemail = '' and v_cphone = '' then
          continue;
        end if;

        v_norm_name := lower(btrim(split_part(split_part(v_cname, '(', 1), '-', 1)));
        v_existing_contact_id := null;

        select sc.id
          into v_existing_contact_id
        from public.staff_contacts sc
        where sc.organization_id = v_org_id
          and (
            (v_norm_name <> '' and lower(btrim(split_part(split_part(sc.name, '(', 1), '-', 1))) = v_norm_name)
            or (v_cemail <> '' and lower(btrim(sc.email)) = lower(v_cemail) and v_norm_name = '')
          )
        limit 1;

        if v_existing_contact_id is not null then
          update public.staff_contacts
          set
            email = case when btrim(email) = '' and v_cemail <> '' then v_cemail else email end,
            phone = case when btrim(phone) = '' and v_cphone <> '' then v_cphone else phone end,
            role = case when btrim(role) = '' and v_crole <> '' then v_crole else role end,
            name = case when length(v_cname) > length(name) then v_cname else name end
          where id = v_existing_contact_id;
        else
          insert into public.staff_contacts (organization_id, name, role, email, phone)
          values (
            v_org_id,
            case when v_cname <> '' then v_cname else v_org_name || ' Contact' end,
            v_crole,
            v_cemail,
            v_cphone
          );
        end if;
      end loop;
    end if;
  end if;

  -- Amplifier flyer docs (non-destructive deduplicated append)
  if jsonb_typeof(p_amplifier_docs) = 'array' then
    for v_doc in select value from jsonb_array_elements(p_amplifier_docs)
    loop
      if jsonb_typeof(v_doc) = 'string' then
        v_doc_url := btrim(v_doc #>> '{}');
        v_doc_path := v_doc_url;
        v_doc_title := v_org_name || ' Resource Flyer';
        v_doc_mime := case when lower(v_doc_url) like '%.pdf%' then 'application/pdf' else 'image/png' end;
      else
        v_doc_url := btrim(coalesce(v_doc->>'public_url', v_doc->>'url', v_doc->>'storage_path', ''));
        v_doc_path := btrim(coalesce(v_doc->>'storage_path', v_doc_url));
        v_doc_title := coalesce(nullif(btrim(coalesce(v_doc->>'title', '')), ''), v_org_name || ' Resource Flyer');
        v_doc_mime := coalesce(nullif(btrim(coalesce(v_doc->>'mime_type', '')), ''), 'application/pdf');
      end if;

      if v_doc_url <> '' and length(v_doc_url) <= 250000 then
        if not exists (
          select 1 from public.amplifier_docs ad
          where ad.organization_id = v_org_id
            and (ad.public_url = v_doc_url or ad.storage_path = v_doc_path)
        ) then
          insert into public.amplifier_docs (organization_id, title, storage_path, public_url, mime_type)
          values (v_org_id, v_doc_title, v_doc_path, v_doc_url, v_doc_mime);
        end if;
      end if;
    end loop;
  end if;

  return v_org_id;
end;
$$;

revoke all on function public._nhvet411_upsert_organization(jsonb, jsonb, jsonb, boolean) from public, anon, authenticated;

-- ============================================================================
-- 6. Concurrency-Safe RPC: Approve Pending Submission (FOR UPDATE Row Lock)
-- ============================================================================
create or replace function public.approve_pending_submission(
  p_submission_id uuid,
  p_resolved_org jsonb,
  p_staff_contacts jsonb default '[]'::jsonb,
  p_amplifier_docs jsonb default '[]'::jsonb,
  p_replace_contacts boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub record;
  v_mod_name text;
  v_prev_reviewer text;
  v_org_id text;
begin
  if not public.is_moderator() then
    raise exception 'Unauthorized: Moderator access required' using errcode = '42501';
  end if;

  select coalesce(nullif(btrim(display_name), ''), email)
    into v_mod_name
  from public.moderators
  where user_id = auth.uid();
  v_mod_name := coalesce(v_mod_name, 'Moderator');

  -- Lock the submission row so two moderators clicking at the exact same second cannot double-approve
  select *
    into v_sub
  from public.pending_submissions
  where id = p_submission_id
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'conflict', true,
      'code', 'NOT_FOUND',
      'message', 'This submission was already removed.'
    );
  end if;

  if v_sub.review_status <> 'pending' then
    select coalesce(
      nullif(btrim(v_sub.reviewed_by_name), ''),
      (select coalesce(nullif(btrim(m.display_name), ''), m.email) from public.moderators m where m.user_id = v_sub.reviewed_by),
      'another moderator'
    ) into v_prev_reviewer;

    return jsonb_build_object(
      'ok', false,
      'conflict', true,
      'code', 'ALREADY_REVIEWED',
      'review_status', v_sub.review_status,
      'reviewed_by_name', v_prev_reviewer,
      'reviewed_at', v_sub.reviewed_at,
      'message', format('Already %s by %s.', v_sub.review_status, v_prev_reviewer)
    );
  end if;

  v_org_id := public._nhvet411_upsert_organization(
    p_resolved_org,
    p_staff_contacts,
    p_amplifier_docs,
    p_replace_contacts
  );

  update public.pending_submissions
  set
    review_status = 'approved',
    target_org_id = v_org_id,
    reviewed_by = auth.uid(),
    reviewed_by_name = v_mod_name,
    reviewed_at = now()
  where id = p_submission_id;

  insert into public.audit_logs (actor_id, action, target_org_id, submission_id, details)
  values (
    auth.uid(),
    'approve_submission',
    v_org_id,
    p_submission_id,
    jsonb_build_object(
      'moderator', v_mod_name,
      'submission_type', v_sub.submission_type,
      'submitter_name', v_sub.submitter_name,
      'submitter_email', v_sub.submitter_email
    )
  );

  return jsonb_build_object(
    'ok', true,
    'conflict', false,
    'org_id', v_org_id,
    'reviewed_by_name', v_mod_name
  );
end;
$$;

revoke all on function public.approve_pending_submission(uuid, jsonb, jsonb, jsonb, boolean) from public, anon;
grant execute on function public.approve_pending_submission(uuid, jsonb, jsonb, jsonb, boolean) to authenticated;

-- ============================================================================
-- 7. Concurrency-Safe RPC: Reject Pending Submission (Required Comment)
-- ============================================================================
create or replace function public.reject_pending_submission(
  p_submission_id uuid,
  p_rejection_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub record;
  v_mod_name text;
  v_prev_reviewer text;
  v_clean_reason text;
begin
  if not public.is_moderator() then
    raise exception 'Unauthorized: Moderator access required' using errcode = '42501';
  end if;

  v_clean_reason := btrim(coalesce(p_rejection_reason, ''));
  if length(v_clean_reason) < 3 then
    raise exception 'A rejection reason comment is required (minimum 3 characters).' using errcode = '22023';
  end if;

  select coalesce(nullif(btrim(display_name), ''), email)
    into v_mod_name
  from public.moderators
  where user_id = auth.uid();
  v_mod_name := coalesce(v_mod_name, 'Moderator');

  select *
    into v_sub
  from public.pending_submissions
  where id = p_submission_id
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'conflict', true,
      'code', 'NOT_FOUND',
      'message', 'This submission was already removed.'
    );
  end if;

  if v_sub.review_status <> 'pending' then
    select coalesce(
      nullif(btrim(v_sub.reviewed_by_name), ''),
      (select coalesce(nullif(btrim(m.display_name), ''), m.email) from public.moderators m where m.user_id = v_sub.reviewed_by),
      'another moderator'
    ) into v_prev_reviewer;

    return jsonb_build_object(
      'ok', false,
      'conflict', true,
      'code', 'ALREADY_REVIEWED',
      'review_status', v_sub.review_status,
      'reviewed_by_name', v_prev_reviewer,
      'reviewed_at', v_sub.reviewed_at,
      'message', format('Already %s by %s.', v_sub.review_status, v_prev_reviewer)
    );
  end if;

  update public.pending_submissions
  set
    review_status = 'rejected',
    rejection_reason = v_clean_reason,
    reviewed_by = auth.uid(),
    reviewed_by_name = v_mod_name,
    reviewed_at = now()
  where id = p_submission_id;

  insert into public.audit_logs (actor_id, action, target_org_id, submission_id, details)
  values (
    auth.uid(),
    'reject_submission',
    v_sub.target_org_id,
    p_submission_id,
    jsonb_build_object(
      'moderator', v_mod_name,
      'rejection_reason', v_clean_reason,
      'submitter_name', v_sub.submitter_name,
      'submitter_email', v_sub.submitter_email
    )
  );

  return jsonb_build_object(
    'ok', true,
    'conflict', false,
    'reviewed_by_name', v_mod_name,
    'rejection_reason', v_clean_reason,
    'submitter_email', v_sub.submitter_email,
    'submitter_name', v_sub.submitter_name
  );
end;
$$;

revoke all on function public.reject_pending_submission(uuid, text) from public, anon;
grant execute on function public.reject_pending_submission(uuid, text) to authenticated;

-- ============================================================================
-- 8. Moderator Direct Live Edit RPC (Instant Live Update for Signed-In Mods)
-- ============================================================================
create or replace function public.moderator_save_organization(
  p_org jsonb,
  p_staff_contacts jsonb default '[]'::jsonb,
  p_amplifier_docs jsonb default '[]'::jsonb,
  p_replace_contacts boolean default false,
  p_action text default 'moderator_live_edit'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mod_name text;
  v_org_id text;
begin
  if not public.is_moderator() then
    raise exception 'Unauthorized: Moderator access required' using errcode = '42501';
  end if;

  select coalesce(nullif(btrim(display_name), ''), email)
    into v_mod_name
  from public.moderators
  where user_id = auth.uid();
  v_mod_name := coalesce(v_mod_name, 'Moderator');

  v_org_id := public._nhvet411_upsert_organization(
    p_org,
    p_staff_contacts,
    p_amplifier_docs,
    p_replace_contacts
  );

  insert into public.audit_logs (actor_id, action, target_org_id, details)
  values (
    auth.uid(),
    coalesce(nullif(btrim(p_action), ''), 'moderator_live_edit'),
    v_org_id,
    jsonb_build_object(
      'moderator', v_mod_name,
      'org_name', coalesce(p_org->>'name', '')
    )
  );

  return jsonb_build_object(
    'ok', true,
    'org_id', v_org_id,
    'saved_by', v_mod_name
  );
end;
$$;

revoke all on function public.moderator_save_organization(jsonb, jsonb, jsonb, boolean, text) from public, anon;
grant execute on function public.moderator_save_organization(jsonb, jsonb, jsonb, boolean, text) to authenticated;

-- ============================================================================
-- 9. Verification Output: Confirm RLS is ON for all 6 public tables
-- ============================================================================
select
  schemaname,
  tablename,
  rowsecurity as rls_enabled
from pg_tables
where schemaname = 'public'
  and tablename in (
    'moderators',
    'organizations',
    'staff_contacts',
    'amplifier_docs',
    'pending_submissions',
    'audit_logs'
  )
order by tablename;
