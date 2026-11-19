/**
 * Idempotent NHVet411 Supabase Baseline Seeder
 * Matches `"seed": "node scripts/seed_supabase.js"` in package.json.
 *
 * Reads the clean 147-org baseline from ./nh_organizations_data.json and
 * upserts organizations, staff_contacts (allowing shared emails across VSOs),
 * and amplifier_docs into Supabase.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(__dirname, '../nh_organizations_data.json');

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false }
});

async function main() {
  const orgs = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  console.log(`📦 Seeding ${orgs.length} verified NHVet411 baseline organizations into ${supabaseUrl}...`);

  const orgRows = orgs.map((o) => ({
    id: o.id,
    name: o.name,
    categories: Array.isArray(o.categories) ? o.categories : [],
    description: o.description || '',
    address: o.address || '',
    city: o.city || 'Statewide',
    zip: o.zip || '',
    county: o.county || 'All Counties',
    region_id: o.region_id || 'statewide',
    secondary_region_id: o.secondary_region_id || null,
    is_statewide: Boolean(o.is_statewide),
    phone: o.phone || '',
    email: o.email || '',
    website: o.website || '',
    branches: Array.isArray(o.branches) && o.branches.length ? o.branches : ['all'],
    verified_vso: Boolean(o.verified_vso ?? true),
    last_verified: o.last_verified || new Date().toISOString().slice(0, 10),
    source_url: o.source_url || o.website || '',
    amplifier_doc: o.amplifier_doc || null,
    status: 'approved'
  }));

  for (let i = 0; i < orgRows.length; i += 50) {
    const chunk = orgRows.slice(i, i + 50);
    const { error } = await supabase.from('organizations').upsert(chunk, { onConflict: 'id' });
    if (error) throw new Error(`Failed upserting chunk ${i}: ${error.message}`);
  }
  console.log(`✅ Upserted ${orgRows.length} organizations.`);

  let contactCount = 0;
  for (const o of orgs) {
    const contacts = (o.staff_contacts || []).filter((c) => c.name || c.email || c.phone);
    const { error: delErr } = await supabase
      .from('staff_contacts')
      .delete()
      .eq('organization_id', o.id);
    if (delErr) throw new Error(`Failed clearing contacts for ${o.id}: ${delErr.message}`);

    if (contacts.length > 0) {
      const rows = contacts.map((c) => ({
        organization_id: o.id,
        name: c.name || '',
        role: c.role || '',
        email: c.email || '',
        phone: c.phone || ''
      }));
      const { error: insErr } = await supabase.from('staff_contacts').insert(rows);
      if (insErr) throw new Error(`Failed inserting contacts for ${o.id}: ${insErr.message}`);
      contactCount += rows.length;
    }

    if (o.amplifier_doc) {
      await supabase.from('amplifier_docs').delete().eq('organization_id', o.id);
      const { error: ampErr } = await supabase.from('amplifier_docs').insert({
        organization_id: o.id,
        title: `${o.name} Resource Flyer`,
        storage_path: o.amplifier_doc,
        public_url: o.amplifier_doc,
        mime_type: o.amplifier_doc.endsWith('.pdf') ? 'application/pdf' : 'image/png'
      });
      if (ampErr) throw new Error(ampErr.message);
    }
  }

  console.log(`✅ Synced ${contactCount} staff contacts & amplifier docs.`);
  console.log('🎉 NHVet411 Supabase baseline seed complete!');
}

main().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
