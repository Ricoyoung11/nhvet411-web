import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const INDEX_HTML_PATH = path.join(ROOT, 'index.html');
const DATA_JSON_PATH = path.join(ROOT, 'nh_organizations_data.json');

/**
 * Loads the REAL generated inline <script> from index.html into an isolated VM
 * with a lightweight DOM shim so every test exercises the exact browser code.
 */
function createAppHarness({ fetchMock = null } = {}) {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1])
    .filter(s => s.trim().length > 0);
  assert.equal(scriptMatches.length, 1, 'Expected exactly 1 inline script in index.html');
  const scriptSrc = scriptMatches[0];

  const elements = new Map();
  const selectorBuckets = {
    '.cat-pill': [],
    '.region-pill': [],
    '.region-photo-card': [],
    '.branch-btn': [],
    '.active': [],
    '[data-region="all"]': [],
    '[data-cat="all"]': [],
    '[data-branch="all"]': []
  };

  function makeEl(id, extra = {}) {
    const classes = new Set(extra.classes || []);
    const el = {
      id,
      value: extra.value ?? '',
      checked: extra.checked ?? false,
      textContent: '',
      innerHTML: '',
      style: {},
      dataset: { ...(extra.dataset || {}) },
      options: [],
      appendChild(child) {
        this.options.push(child);
        return child;
      },
      focus() {},
      reset() {},
      getAttribute(k) { return (this.attrs && this.attrs[k]) || ''; },
      setAttribute(k, v) { this.attrs = this.attrs || {}; this.attrs[k] = String(v); },
      scrollIntoView() {},
      classList: {
        add(c) { classes.add(c); },
        remove(c) { classes.delete(c); },
        toggle(c, force) {
          if (force === undefined) {
            if (classes.has(c)) classes.delete(c); else classes.add(c);
          } else if (force) {
            classes.add(c);
          } else {
            classes.delete(c);
          }
        },
        contains(c) { return classes.has(c); }
      }
    };
    if (id) elements.set(id, el);
    return el;
  }

  // Core DOM IDs read/written by initFilters, renderDirectory, runAiAssistantFromInput, resetAllFilters & moderation UI
  makeEl('search-input', { value: '' });
  makeEl('county-select', { value: 'all' });
  makeEl('include-statewide-toggle', { checked: true });
  makeEl('ai-navigator-response', { classes: ['hidden'] });
  makeEl('ai-navigator-text');
  makeEl('results-count');
  makeEl('cards-grid');
  makeEl('regional-spotlight-banner');
  makeEl('active-filter-summary');
  makeEl('region-pills');
  makeEl('category-pills');
  makeEl('region-photo-cards');
  makeEl('amp-org-select');
  makeEl('branch-active-label');
  makeEl('directory-section');
  makeEl('total-count-badge');
  makeEl('nav-total-count');
  makeEl('nav-all-vsos-count');
  makeEl('stat-total-vsos');
  makeEl('stat-total-counties');
  makeEl('stat-total-regions');
  makeEl('stat-total-categories');
  makeEl('stat-total-contacts');
  makeEl('footer-total-vsos');
  makeEl('footer-total-contacts');
  makeEl('footer-total-counties');
  makeEl('api-status-btn-text');
  makeEl('search-submit-btn');
  makeEl('search-submit-icon');
  makeEl('search-submit-label');
  makeEl('ai-navigator-icon');
  makeEl('ai-navigator-title');
  makeEl('detailed-filter-panel');
  makeEl('toggle-detailed-filters-btn');
  makeEl('toggle-detailed-filters-label');
  makeEl('toggle-detailed-filters-chevron');
  makeEl('hero-actions-wrap');
  makeEl('update-available-btn', { classes: ['hidden'] });
  makeEl('whats-new-modal', { classes: ['hidden'] });
  makeEl('whats-new-body');
  makeEl('whats-new-current-version');
  makeEl('review-queue-count');
  makeEl('mod-login-btn');
  makeEl('mod-review-btn', { classes: ['hidden'] });
  makeEl('mod-bell-dot', { classes: ['hidden'] });
  makeEl('mod-account-btn', { classes: ['hidden'] });
  makeEl('mod-account-label');
  makeEl('workflow-switch-bar', { classes: ['hidden'] });
  makeEl('submitter-info-row');
  makeEl('review-queue-modal', { classes: ['hidden'] });
  makeEl('review-queue-notice', { classes: ['hidden'] });
  makeEl('review-queue-body');
  makeEl('rq-new-badge', { classes: ['hidden'] });
  makeEl('mod-auth-modal', { classes: ['hidden'] });
  makeEl('apikey-modal', { classes: ['hidden'] });
  makeEl('submit-modal', { classes: ['hidden'] });
  makeEl('amplifier-modal', { classes: ['hidden'] });
  makeEl('legal-modal', { classes: ['hidden'] });
  makeEl('legal-panel-terms');
  makeEl('legal-panel-privacy', { classes: ['hidden'] });
  makeEl('legal-panel-dmca', { classes: ['hidden'] });
  makeEl('sub-license-checkbox', { checked: false });
  makeEl('sub-license-error', { classes: ['hidden'] });
  makeEl('sub-success', { classes: ['hidden'] });
  makeEl('ai-parse-banner', { classes: ['hidden'] });
  makeEl('parsed-contacts-list');

  const store = new Map();
  const localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); }
  };
  const sStore = new Map();
  const sessionStorage = {
    getItem(k) { return sStore.has(k) ? sStore.get(k) : null; },
    setItem(k, v) { sStore.set(k, String(v)); },
    removeItem(k) { sStore.delete(k); },
    clear() { sStore.clear(); }
  };

  const domListeners = {};
  const document = {
    hidden: false,
    body: makeEl('body'),
    getElementById(id) {
      if (!elements.has(id)) makeEl(id);
      return elements.get(id);
    },
    createElement(tag) {
      return makeEl('', { tag });
    },
    querySelectorAll(sel) {
      return selectorBuckets[sel] || [];
    },
    querySelector(sel) {
      const list = selectorBuckets[sel] || [];
      return list[0] || null;
    },
    addEventListener(evt, fn) {
      domListeners[evt] = domListeners[evt] || [];
      domListeners[evt].push(fn);
    }
  };

  const activeIntervals = new Set();
  const historyCalls = [];
  const sandbox = {
    console,
    document,
    window: {
      isSecureContext: false,
      addEventListener() {},
      location: { href: 'https://nhvet411.org/', origin: 'https://nhvet411.org', pathname: '/', search: '', hash: '' },
      history: {
        replaceState(stateObj, title, url) {
          historyCalls.push(url);
          sandbox.window.location.hash = '';
          sandbox.window.location.search = '';
        }
      }
    },
    navigator: {},
    localStorage,
    sessionStorage,
    fetch: fetchMock || (async () => { throw new Error('Network disabled in offline test'); }),
    setTimeout,
    clearTimeout,
    setInterval(fn, ms) {
      const id = { fn, ms };
      activeIntervals.add(id);
      return id;
    },
    clearInterval(id) {
      activeIntervals.delete(id);
    },
    encodeURIComponent,
    decodeURIComponent,
    URL,
    URLSearchParams,
    Blob: class {},
    FileReader: class {}
  };
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(scriptSrc, ctx);

  // Build simulated pill elements from LOOKUP_DATA so pill active-state toggles are also tested
  const cats = [{ id: 'all' }, ...vm.runInContext('LOOKUP_DATA.taxonomy_categories', ctx)];
  cats.forEach(c => {
    const btn = makeEl('', { dataset: { cat: c.id }, classes: c.id === 'all' ? ['active'] : [] });
    selectorBuckets['.cat-pill'].push(btn);
    if (c.id === 'all') selectorBuckets['[data-cat="all"]'].push(btn);
  });
  const regs = [{ id: 'all' }, ...vm.runInContext('LOOKUP_DATA.regions', ctx)];
  regs.forEach(r => {
    const btn = makeEl('', { dataset: { region: r.id }, classes: r.id === 'all' ? ['active'] : [] });
    selectorBuckets['.region-pill'].push(btn);
    if (r.id === 'all') selectorBuckets['[data-region="all"]'].push(btn);
  });

  // Expose helper to read rendered card order & HTML from #cards-grid
  function getRenderedCards() {
    const gridHtml = document.getElementById('cards-grid').innerHTML;
    const articles = [...gridHtml.matchAll(/<article id="vso-card-([^"]+)"[\s\S]*?<\/article>/g)];
    return articles.map(m => {
      const full = m[0];
      const h2Match = full.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
      const pMatch = full.match(/<p class="text-xs text-slate-700 mt-2[^>]*>([\s\S]*?)<\/p>/);
      const marks = [...full.matchAll(/<mark class="search-hl">([\s\S]*?)<\/mark>/g)].map(x => x[1]);
      const catHlCount = (full.match(/cat-tag-hl/g) || []).length;
      const pCount = (full.match(/<p\b/g) || []).length;
      return {
        id: m[1],
        html: full,
        titleHtml: h2Match ? h2Match[1] : '',
        descHtml: pMatch ? pMatch[1] : '',
        marks,
        catHlCount,
        pCount
      };
    });
  }

  // Trigger initial render
  vm.runInContext('renderDirectory()', ctx);

  return { ctx, document, domListeners, localStorage, sessionStorage, historyCalls, getRenderedCards, html };
}

test('1. Baseline data integrity: 147 orgs, RYoung28 removed, shared emails preserved, SWAM/Angers excluded', () => {
  const orgs = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf8'));
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  assert.equal(orgs.length, 147);
  assert.equal(/ryoung28/i.test(html), false, 'RYoung28 must not exist anywhere in index.html');
  const wwp = orgs.find(o => o.id === 'vso-111');
  assert.ok(wwp, 'Wounded Warrior Project (vso-111) must exist');
  assert.equal(wwp.staff_contacts.some(s => /richard young|ryoung28/i.test(s.name + ' ' + s.email)), false);
  assert.equal(orgs.some(o => /swim with a mission|swam/i.test(o.name)), false);
  assert.equal(orgs.some(o => /angers/i.test(o.name)), false);
});

test('2. Real-World Request #1: Dependent VA survivor benefits (with "dependant" typo) returns multi-category VSOs with inline <mark> highlights and zero added card clutter', async () => {
  const { ctx, document, getRenderedCards } = createAppHarness();
  const query = 'Anyone that knows how to get a dependant VA survivor benefits';

  // First test live typing before hitting Enter (Fix #3)
  ctx.onLiveSearchInput(query);
  const liveCards = getRenderedCards();
  assert.ok(liveCards.length >= 10, `Live typing should return >=10 VSOs, got ${liveCards.length}`);

  // Now run Ask AI Navigator (Fix #1 + #5 + inline highlights)
  document.getElementById('search-input').value = query;
  await ctx.runAiAssistantFromInput();
  const cards = getRenderedCards();
  const ids = cards.map(c => c.id);

  assert.ok(ids.includes('vso-084'), 'Must include Survivor Outreach Services (SOS)');
  assert.ok(ids.includes('vso-030'), 'Must include DMAVS');
  assert.ok(ids.includes('vso-031'), 'Must include DAV NH');
  assert.ok(ids.includes('vso-068'), 'Must include NH VFW State Headquarters');
  assert.ok(ids.includes('vso-033'), 'Must include Easterseals NH & Veterans Count');
  assert.ok(ids.includes('vso-002'), 'Must include 603 Legal Aid');
  assert.equal(ids.includes('vso-049'), false, 'Must NOT include Honor Flight New England');
  assert.equal(ids.includes('vso-056'), false, 'Must NOT include Less Leg More Heart');

  // Verify inline visual WHY highlighting inside existing descriptions & zero extra <p> lines
  const sos = cards.find(c => c.id === 'vso-084');
  assert.equal(sos.pCount, 1, 'Card must still have ONLY the single existing description <p> element');
  assert.ok(sos.marks.some(m => /survivor/i.test(m)), 'SOS title should highlight Survivor');
  assert.ok(sos.marks.some(m => /families|fallen/i.test(m)), `SOS description should highlight Families/Fallen, got: ${sos.marks.join(', ')}`);
  assert.ok(sos.catHlCount >= 1, 'Matched existing category tag should receive .cat-tag-hl');

  const dmavs = cards.find(c => c.id === 'vso-030');
  assert.ok(dmavs.descHtml.includes('<mark class="search-hl">State Veteran Benefits</mark>'), `DMAVS should highlight State Veteran Benefits, got: ${dmavs.descHtml}`);

  // Verify Share-with-a-Buddy payload never contains raw <mark> HTML
  const sharePayload = vm.runInContext('buildBuddyShareData(ORGANIZATIONS.find(o => o.id === "vso-084"))', ctx);
  assert.equal(sharePayload.bodyText.includes('<mark'), false, 'Buddy share text must never contain HTML mark tags');
});

test('3. Real-World Request #2: Student education benefits ranks campus/GI Bill orgs at top and highlights existing text inline', async () => {
  const { ctx, document, getRenderedCards } = createAppHarness();
  const query = 'got an email how to help a student get education benefits';

  document.getElementById('search-input').value = query;
  await ctx.runAiAssistantFromInput();
  const cards = getRenderedCards();
  const ids = cards.map(c => c.id);

  assert.ok(ids.slice(0, 3).includes('vso-076'), `Plymouth State Military Services should be in top 3, got top 5: ${ids.slice(0, 5)}`);
  assert.ok(ids.slice(0, 3).includes('vso-083'), `SVA Plymouth State should be in top 3, got top 5: ${ids.slice(0, 5)}`);
  assert.ok(ids.includes('vso-001'), 'Must include 51 Vets Incorporated');
  assert.ok(ids.includes('vso-030'), 'Must include DMAVS');
  assert.ok(ids.includes('vso-031'), 'Must include DAV NH');
  assert.equal(ids.includes('vso-063'), false, 'Must NOT clutter student GI Bill search with Nashua Community Music School');
  assert.equal(ids.includes('vso-007'), false, 'Must NOT clutter student GI Bill search with AWARE animal welfare');

  const psu = cards.find(c => c.id === 'vso-076');
  assert.ok(psu.descHtml.includes('<mark class="search-hl">Education Benefits</mark>'), `PSU description should highlight Education Benefits, got: ${psu.descHtml}`);
  assert.ok(psu.descHtml.includes('<mark class="search-hl">GI Bill</mark>'), `PSU description should highlight GI Bill, got: ${psu.descHtml}`);
});

test('4. Live Edited Description & Uploaded Brochure Updates are IMMEDIATELY searchable and highlighted inline', async () => {
  const { ctx, document, getRenderedCards } = createAppHarness();

  // Simulate a VSO editing their description or uploading a new brochure adding comprehensive service details
  vm.runInContext(`
    const coalition = ORGANIZATIONS.find(o => o.id === 'vso-022');
    coalition.description = 'Peer Veteran Coalition in Plymouth providing Chapter 35 dependent VA survivor benefits guidance and GI Bill scholarship workshops.';
    const harbor = ORGANIZATIONS.find(o => o.id === 'vso-041');
    harbor.description += ' Now offering free HVAC furnace winterization grants for NH veterans.';
  `, ctx);

  // Test 4a: Updated description immediately surfaces in survivor benefits search + highlights new terms
  document.getElementById('search-input').value = 'dependent VA survivor benefits';
  await ctx.runAiAssistantFromInput();
  let cards = getRenderedCards();
  const coalitionCard = cards.find(c => c.id === 'vso-022');
  assert.ok(coalitionCard, 'Org with newly updated description must immediately match survivor benefits search');
  assert.ok(coalitionCard.marks.some(m => /dependent/i.test(m)), 'Must highlight newly added term "dependent"');
  assert.ok(coalitionCard.marks.some(m => /survivor/i.test(m)), 'Must highlight newly added term "survivor"');

  // Test 4b: Unscripted unique brochure phrase ("HVAC furnace winterization") immediately matches & highlights
  document.getElementById('search-input').value = 'need help with HVAC furnace repair for a veteran';
  await ctx.runAiAssistantFromInput();
  cards = getRenderedCards();
  assert.ok(cards.some(c => c.id === 'vso-041'), 'Org with newly uploaded brochure text must match unscripted query');
  const harborCard = cards.find(c => c.id === 'vso-041');
  assert.ok(harborCard.marks.some(m => /hvac/i.test(m)), 'Must highlight HVAC inside updated description');
  assert.ok(harborCard.marks.some(m => /furnace/i.test(m)), 'Must highlight furnace inside updated description');
});

test('5. Long multi-sentence typing + typo tolerance ("morgage") + Plymouth locality ranking', async () => {
  const { ctx, document, getRenderedCards } = createAppHarness();
  const longQuery = 'I live in Plymouth and I am behind on my morgage and need help filing a VA claim for my family';

  // Live typing (before hitting Enter) must never collapse to 0
  ctx.onLiveSearchInput(longQuery);
  let cards = getRenderedCards();
  assert.ok(cards.length >= 10, `Live typing long sentence should return >=10 results, got ${cards.length}`);

  // Press Enter / Ask AI Navigator
  document.getElementById('search-input').value = longQuery;
  await ctx.runAiAssistantFromInput();
  cards = getRenderedCards();
  const state = vm.runInContext('state', ctx);

  assert.equal(state.selectedRegion, 'white-mountains', 'Should detect Plymouth -> white-mountains region');
  assert.equal(state.matchedTown, 'Plymouth');
  assert.ok(state.matchedCategories.includes('financial-legal'), 'Typo "morgage" must trigger financial-legal');
  assert.ok(state.matchedCategories.includes('benefits-advocacy'), '"VA claim" must trigger benefits-advocacy');
  assert.ok(state.matchedCategories.includes('family-youth'), '"family" must trigger family-youth');
  assert.ok(cards.length >= 5, `Should return local Plymouth + statewide matches, got ${cards.length}`);
  assert.ok(cards.slice(0, 4).some(c => ['vso-067', 'vso-038', 'vso-076', 'vso-083'].includes(c.id)), 'Plymouth local orgs should rank at the top');

  // Verify typo normalization helpers directly
  assert.equal(ctx.normalizeSearchQuery('dependant surviver benifits for ptds and morgage ch 35'), 'dependent survivor benefits for ptsd and mortgage chapter 35');
});

test('6. NH town-name collision guard & pure geography lookup (Plymouth / 03264 / Lyme disease / bow hunting)', async () => {
  const { ctx, document, getRenderedCards } = createAppHarness();

  // Ambiguous English words must NOT set a town filter
  for (const phrase of ['Lyme disease medical clinic', 'bow hunting trip for veterans', 'financial freedom workshops', 'need a bath remodel ramp']) {
    const geo = ctx.detectSafeGeography(phrase);
    assert.equal(geo.city, '', `Phrase "${phrase}" must NOT falsely match NH town (got "${geo.city}")`);
    assert.equal(geo.regionId, 'all', `Phrase "${phrase}" must keep regionId="all"`);
  }

  // Explicit geographic phrasing around ambiguous town MUST still match
  const explicitLyme = ctx.detectSafeGeography('need help in Lyme, NH');
  assert.equal(explicitLyme.city, 'Lyme');
  assert.equal(explicitLyme.regionId, 'dartmouth-lake-sunapee');

  // Standalone Plymouth must act as pure geo lookup (NOT narrow to just Plymouth State org name!)
  document.getElementById('search-input').value = 'Plymouth';
  await ctx.runAiAssistantFromInput();
  let cards = getRenderedCards();
  assert.ok(cards.length >= 25, `Pure town search "Plymouth" should return regional + statewide VSOs, got ${cards.length}`);
  assert.ok(cards.slice(0, 6).every(c => ['vso-022', 'vso-038', 'vso-067', 'vso-076', 'vso-083', 'vso-127'].includes(c.id)), 'Top 6 cards for "Plymouth" should be all 6 Plymouth-based VSOs');

  // ZIP code 03264 must also work as pure geo lookup
  document.getElementById('search-input').value = '03264';
  await ctx.runAiAssistantFromInput();
  cards = getRenderedCards();
  assert.ok(cards.length >= 25, `ZIP "03264" should return regional + statewide VSOs, got ${cards.length}`);

  // Long sentence containing English word "aware" must NOT falsely trigger nameHit for AWARE
  document.getElementById('search-input').value = 'I am aware of a veteran who needs emergency mortgage help';
  await ctx.runAiAssistantFromInput();
  cards = getRenderedCards();
  assert.ok(cards.length >= 5, `Sentence containing "aware" must not collapse to AWARE org alone, got ${cards.length}`);
  assert.ok(cards.some(c => c.id === 'vso-033' || c.id === 'vso-110'), 'Should return financial-aid VSOs');
});

test('7. Gemini API model chain uses gemini-3.5-flash-lite -> gemini-4-hydrogen, grounds strictly to valid IDs, and falls back gracefully', async () => {
  const calledUrls = [];
  const fetchMock = async (url, opts) => {
    calledUrls.push(url);
    if (url.includes('gemini-3.5-flash-lite')) {
      return { ok: false, status: 503 }; // force fallback to gemini-4-hydrogen
    }
    const body = JSON.parse(opts.body);
    assert.ok(body.contents[0].parts[0].text.includes('Do NOT do open-web search'), 'Prompt must enforce closed-catalog grounding');
    assert.ok(body.contents[0].parts[0].text.includes('vso-030'), 'Prompt must embed live ORGANIZATIONS JSON');
    return {
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                categories: ['benefits-advocacy', 'family-youth'],
                org_ids: ['vso-084', 'vso-030', 'vso-999-hallucinated'],
                highlight_terms: ['State Veteran Benefits', 'Families'],
                summary: 'Matched survivor & claims orgs'
              })
            }]
          }
        }]
      })
    };
  };

  const { ctx, document, localStorage, getRenderedCards } = createAppHarness({ fetchMock });
  localStorage.setItem('nhvet411_gemini_key', 'AIzaFakeTestKey123');
  document.getElementById('search-input').value = 'dependent VA survivor benefits';
  await ctx.runAiAssistantFromInput();

  assert.equal(calledUrls.length, 2, 'Should try gemini-3.5-flash-lite first, then fallback to gemini-4-hydrogen');
  assert.ok(calledUrls[0].includes('/models/gemini-3.5-flash-lite:generateContent'), `Unexpected 1st model URL: ${calledUrls[0]}`);
  assert.ok(calledUrls[1].includes('/models/gemini-4-hydrogen:generateContent'), `Unexpected 2nd model URL: ${calledUrls[1]}`);
  const state = vm.runInContext('state', ctx);
  assert.equal(state.matchedOrgIds.includes('vso-999-hallucinated'), false, 'Hallucinated org IDs must be stripped');
  assert.ok(document.getElementById('ai-navigator-text').innerHTML.includes('Grounded via gemini-4-hydrogen'));
  assert.ok(getRenderedCards().some(c => c.id === 'vso-084'));
});

test('8. Shared POC emails return EVERY organization sharing that email (including org.email & staff_contacts)', async () => {
  const { ctx, document, getRenderedCards } = createAppHarness();

  // Official POC email shared across 2 orgs (Camp Resilience & Lakes Region Veterans Coalition)
  document.getElementById('search-input').value = 'kwebber@camp-resilience.org';
  await ctx.runAiAssistantFromInput();
  let ids = getRenderedCards().map(c => c.id);
  assert.deepEqual(ids.sort(), ['vso-016', 'vso-055']);
  assert.ok(getRenderedCards().some(c => c.html.includes('href="mailto:kwebber@camp-resilience.org?subject=')), 'mailto href must stay intact');
  assert.ok(getRenderedCards().some(c => c.html.includes('<mark class="search-hl">kwebber@camp-resilience.org</mark>')), 'Email text should highlight inline');

  // Shared across 3 orgs
  document.getElementById('search-input').value = 'amckenna@eastersealsnh.org';
  await ctx.runAiAssistantFromInput();
  ids = getRenderedCards().map(c => c.id);
  assert.deepEqual(ids.sort(), ['vso-019', 'vso-033', 'vso-034']);

  // Primary org.email shared across 2 DMAVS orgs
  document.getElementById('search-input').value = 'info@dmavs.nh.gov';
  await ctx.runAiAssistantFromInput();
  ids = getRenderedCards().map(c => c.id);
  assert.deepEqual(ids.sort(), ['vso-019', 'vso-030']);
});

test('9. Highlighter safety: word boundaries, HTML entity integrity (&amp;), and XSS escaping', async () => {
  const { ctx, document } = createAppHarness();

  // "VA" must NOT break words like "Advocacy" or "Available"
  const vaTest = ctx.highlightText('VA Claims Assistance, Available Advocacy for Veterans', ['VA']);
  assert.equal(vaTest, '<mark class="search-hl">VA</mark> Claims Assistance, Available Advocacy for Veterans');

  // Searching "amp" or "lt" must NEVER corrupt "&amp;" or "&lt;" entities
  const ampTest = ctx.highlightText('Education & Training <Camp> amp support', ['amp', 'lt']);
  assert.equal(ampTest.includes('&<mark'), false, `Entity was corrupted: ${ampTest}`);
  assert.equal(ampTest, 'Education &amp; Training &lt;Camp&gt; <mark class="search-hl">amp</mark> support');

  // XSS injection via search bar must be escaped in #ai-navigator-text and cards
  const xss = '<img src=x onerror=alert(1)> survivor benefits';
  document.getElementById('search-input').value = xss;
  await ctx.runAiAssistantFromInput();
  const navHtml = document.getElementById('ai-navigator-text').innerHTML;
  assert.equal(navHtml.includes('<img'), false, 'Raw <img must never be rendered in #ai-navigator-text');
  assert.ok(navHtml.includes('&lt;img'), 'XSS payload must be HTML-escaped');
});

test('10. Filter interoperability: manual selectCategory narrows matched categories, switches cleanly to unrelated categories, and resetAllFilters restores 147-org baseline', async () => {
  const { ctx, document, getRenderedCards } = createAppHarness();

  document.getElementById('search-input').value = 'dependent VA survivor benefits';
  await ctx.runAiAssistantFromInput();
  const initialCount = getRenderedCards().length;
  assert.ok(initialCount >= 10 && initialCount < 147);

  // Clicking a MATCHED category narrows the search seamlessly while preserving highlights
  ctx.selectCategory('family-youth');
  const narrowedCards = getRenderedCards();
  assert.equal(narrowedCards.length, 5, 'Narrowing into matched family-youth category should show all 5 family-youth orgs');
  assert.ok(narrowedCards.some(c => c.id === 'vso-084' && c.marks.length > 0), 'Highlights should stay active when narrowing matched category');

  // Clicking an UNRELATED category cleanly clears the old long sentence search instead of returning 0
  ctx.selectCategory('service-animals-equine');
  const state = vm.runInContext('state', ctx);
  assert.equal(state.selectedCategory, 'service-animals-equine');
  assert.equal(state.matchedCategories.length, 0);
  assert.equal(state.matchedOrgIds, null);
  assert.equal(state.searchQuery, '');
  const animalCards = getRenderedCards();
  assert.ok(animalCards.length >= 8, `Switching to unrelated service-animals-equine pill must show its orgs instead of 0, got ${animalCards.length}`);

  // Resetting restores all 147 orgs with zero highlights
  ctx.resetAllFilters();
  const cards = getRenderedCards();
  assert.equal(cards.length, 147, 'resetAllFilters must restore all 147 orgs');
  assert.equal(cards.some(c => c.marks.length > 0 || c.catHlCount > 0), false, 'No highlight marks may remain after reset');
});

test('11. Approved Item #1: 6 Concord/Manchester statewide HQ orgs are flagged is_statewide:true and surface on regional searches (Plymouth & Berlin) while keeping physical HQ addresses intact', async () => {
  const orgs = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf8'));
  const expectedStatewideHqs = ['vso-002', 'vso-030', 'vso-031', 'vso-033', 'vso-068', 'vso-084'];
  for (const id of expectedStatewideHqs) {
    const o = orgs.find(item => item.id === id);
    assert.ok(o, `Missing org ${id}`);
    assert.equal(o.is_statewide, true, `${id} (${o.name}) must have is_statewide: true`);
    assert.ok(['Concord', 'Manchester'].includes(o.city), `${id} must retain its physical HQ city (${o.city})`);
    assert.ok(o.address && o.address.length > 3, `${id} must retain its physical street address for Google Maps`);
  }

  const { ctx, document, getRenderedCards } = createAppHarness();

  // Plymouth mortgage + VA claim + family must now surface DMAVS, DAV NH, Easterseals/Veterans Count, VFW State HQ, 603 Legal Aid
  document.getElementById('search-input').value = 'I live in Plymouth and I am behind on my morgage and need help filing a VA claim for my family';
  await ctx.runAiAssistantFromInput();
  let cards = getRenderedCards();
  let ids = cards.map(c => c.id);
  for (const id of ['vso-030', 'vso-031', 'vso-033', 'vso-068', 'vso-002']) {
    assert.ok(ids.includes(id), `Plymouth multi-need search should now include statewide HQ ${id}`);
  }
  // Plymouth local orgs must still outrank Concord/Manchester statewide orgs
  assert.ok(['vso-038', 'vso-067', 'vso-076', 'vso-083'].includes(ids[0]), `Top result for Plymouth search should be Plymouth-local, got ${ids[0]}`);
  // Physical Concord/Manchester address must still appear in the card's Google Maps Location row
  const dmavsCard = cards.find(c => c.id === 'vso-030');
  assert.ok(dmavsCard.html.includes('4 Pembroke Road, Concord'), 'DMAVS card must keep Concord street address link');

  // Berlin (Coos County / Great North Woods) survivor search includes SOS & DMAVS when + Include Statewide is ON, excludes when OFF
  document.getElementById('search-input').value = 'Berlin survivor benefits';
  await ctx.runAiAssistantFromInput();
  ids = getRenderedCards().map(c => c.id);
  assert.ok(ids.includes('vso-084'), 'Berlin survivor search should include Survivor Outreach Services (SOS)');
  assert.ok(ids.includes('vso-030'), 'Berlin survivor search should include DMAVS');

  document.getElementById('include-statewide-toggle').checked = false;
  ctx.renderDirectory();
  ids = getRenderedCards().map(c => c.id);
  assert.equal(ids.includes('vso-084'), false, 'Unchecking + Include Statewide must hide Concord-based statewide orgs on Berlin filter');
});

test('12. Approved Item #2: Flyer/brochure upload parser uses updated Gemini models (gemini-3.5-flash-lite -> gemini-3.8-flash -> gemini-4-hydrogen) with zero retired 2.5/2.0/1.5 strings', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const builderSrc = fs.readFileSync(path.join(ROOT, 'build_website.js'), 'utf8');

  assert.equal(/gemini-(2\.5|2\.0|1\.5)-flash/i.test(html), false, 'index.html must not contain retired Gemini 2.5/2.0/1.5 model strings');
  assert.equal(/gemini-(2\.5|2\.0|1\.5)-flash/i.test(builderSrc), false, 'build_website.js must not contain retired Gemini 2.5/2.0/1.5 model strings');
  assert.ok(html.includes("['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-4-hydrogen']"), 'Flyer parser must use updated 3.5-flash-lite -> 3.8-flash -> 4-hydrogen chain');
  assert.equal(builderSrc.includes('process.env.GEMINI_API_KEY'), false, 'build_website.js must NEVER read or bake secret GEMINI_API_KEY into index.html');
});

test('13. Approved Item #3: Supabase Edge Function gemini-search-proxy handles public keyless search & flyer parsing, strips hallucinations, enforces CORS/limits, and integrates cleanly with index.html', async () => {
  const { handleRequest, resetRateLimitBuckets } = await import('../supabase/functions/gemini-search-proxy/index.ts');
  resetRateLimitBuckets();

  // 13a. End-to-end client (index.html with ZERO localStorage key!) -> Real Edge Function -> Mock Gemini API
  const upstreamCalls = [];
  const mockGeminiFetch = async (url, opts) => {
    upstreamCalls.push(url);
    assert.ok(url.includes('key=SERVER_SECRET_KEY_ONLY'), 'Server-side GEMINI_API_KEY must be injected by Edge Function');
    if (url.includes('gemini-3.5-flash-lite')) {
      return new Response(JSON.stringify({ error: 'busy' }), { status: 503 });
    }
    const reqBody = JSON.parse(opts.body);
    assert.ok(reqBody.contents[0].parts[0].text.includes('Do NOT do open-web search'));
    return new Response(
      JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                categories: ['benefits-advocacy', 'family-youth'],
                org_ids: ['vso-084', 'vso-030', 'vso-999-hallucinated'],
                highlight_terms: ['State Veteran Benefits', 'Families'],
                summary: 'Grounded proxy response'
              })
            }]
          }
        }]
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const proxyUrl = 'https://example-ref.supabase.co/functions/v1/gemini-search-proxy';
  const clientFetchBridge = async (url, opts) => {
    assert.equal(url, proxyUrl, 'Browser must call Supabase Edge Function URL, NOT generativelanguage.googleapis.com directly');
    const req = new Request(url, {
      method: opts.method,
      headers: { ...(opts.headers || {}), origin: 'https://nhvet411.org', 'x-forwarded-for': '203.0.113.10' },
      body: opts.body
    });
    return handleRequest(req, {
      geminiApiKey: 'SERVER_SECRET_KEY_ONLY',
      allowedOrigins: 'https://nhvet411.org,https://www.nhvet411.org',
      fetchImpl: mockGeminiFetch
    });
  };

  const { ctx, document, localStorage, getRenderedCards } = createAppHarness({ fetchMock: clientFetchBridge });
  assert.equal(localStorage.getItem('nhvet411_gemini_key'), null, 'Public visitor has NO browser API key');
  ctx.window.NHVET411_GEMINI_PROXY_URL = proxyUrl;

  document.getElementById('search-input').value = 'dependent VA survivor benefits';
  await ctx.runAiAssistantFromInput();

  assert.equal(upstreamCalls.length, 2, 'Edge Function should fall back gemini-3.5-flash-lite -> gemini-4-hydrogen');
  assert.ok(upstreamCalls[0].includes('/models/gemini-3.5-flash-lite:generateContent'));
  assert.ok(upstreamCalls[1].includes('/models/gemini-4-hydrogen:generateContent'));
  const state = vm.runInContext('state', ctx);
  assert.equal(state.matchedOrgIds.includes('vso-999-hallucinated'), false, 'Edge Function must strip hallucinated IDs');
  assert.ok(document.getElementById('ai-navigator-text').innerHTML.includes('Grounded via gemini-4-hydrogen'));
  assert.ok(getRenderedCards().some(c => c.id === 'vso-084'));

  // 13b. Flyer mode inside Edge Function falls back 3.5-flash-lite -> 3.8-flash -> 4-hydrogen
  const flyerCalls = [];
  const flyerRes = await handleRequest(
    new Request(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'https://nhvet411.org', 'x-forwarded-for': '203.0.113.11' },
      body: JSON.stringify({ mode: 'flyer', mimeType: 'image/png', base64Data: 'iVBORw0KGgo=' })
    }),
    {
      geminiApiKey: 'SERVER_SECRET_KEY_ONLY',
      allowedOrigins: 'https://nhvet411.org',
      fetchImpl: async (url) => {
        flyerCalls.push(url);
        if (url.includes('gemini-3.5-flash-lite') || url.includes('gemini-3.8-flash')) {
          return new Response('unavailable', { status: 503 });
        }
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ name: 'Test VSO', phone: '603-555-0199', contacts: [] }) }] } }]
        }), { status: 200 });
      }
    }
  );
  assert.equal(flyerRes.status, 200);
  const flyerJson = await flyerRes.json();
  assert.equal(flyerJson.ok, true);
  assert.equal(flyerJson.model, 'gemini-4-hydrogen');
  assert.equal(flyerJson.data.name, 'Test VSO');
  assert.equal(flyerCalls.length, 3, 'Flyer proxy must try all 3 models: 3.5-flash-lite -> 3.8-flash -> 4-hydrogen');

  // 13c. Security & validation checks: OPTIONS CORS, disallowed origin 403, missing secret 500, oversized query 400
  const optRes = await handleRequest(new Request(proxyUrl, { method: 'OPTIONS', headers: { origin: 'https://nhvet411.org' } }), {
    geminiApiKey: 'K', allowedOrigins: 'https://nhvet411.org'
  });
  assert.equal(optRes.status, 204);
  assert.equal(optRes.headers.get('Access-Control-Allow-Origin'), 'https://nhvet411.org');

  const badOriginRes = await handleRequest(
    new Request(proxyUrl, { method: 'POST', headers: { origin: 'https://evil.example', 'x-forwarded-for': '203.0.113.12' }, body: '{}' }),
    { geminiApiKey: 'K', allowedOrigins: 'https://nhvet411.org' }
  );
  assert.equal(badOriginRes.status, 403);

  const missingKeyRes = await handleRequest(
    new Request(proxyUrl, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.13' }, body: JSON.stringify({ mode: 'search', query: 'va claim', catalog: [{ id: 'vso-030' }] }) }),
    { geminiApiKey: '' }
  );
  assert.equal(missingKeyRes.status, 500);

  const bigQueryRes = await handleRequest(
    new Request(proxyUrl, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.14' }, body: JSON.stringify({ mode: 'search', query: 'a'.repeat(2000), catalog: [{ id: 'vso-030' }] }) }),
    { geminiApiKey: 'K' }
  );
  assert.equal(bigQueryRes.status, 400);
});

test('14. Public visitor security lockout & Supabase pending_submissions routing (with flyer upload)', async () => {
  const calls = [];
  const fetchMock = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    if (url.includes('/storage/v1/object/vso-flyers/submissions/')) {
      return { ok: true, status: 200, json: async () => ({ Key: 'vso-flyers/submissions/test.png' }) };
    }
    if (url.includes('/rest/v1/pending_submissions')) {
      return { ok: true, status: 201, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const { ctx, document } = createAppHarness({ fetchMock });
  ctx.window.NHVET411_GEMINI_PROXY_URL = 'https://demo-proj.supabase.co/functions/v1/gemini-search-proxy';
  ctx.window.NHVET411_SUPABASE_ANON_KEY = 'anon-key-123';
  assert.equal(ctx.getSupabaseUrl(), 'https://demo-proj.supabase.co', 'Should auto-derive SUPABASE_URL from proxy URL');

  ctx.updateModeratorUi();
  assert.equal(document.getElementById('mod-login-btn').classList.contains('hidden'), false);
  assert.equal(document.getElementById('mod-review-btn').classList.contains('hidden'), true);
  assert.equal(document.getElementById('workflow-switch-bar').classList.contains('hidden'), true);

  // Attempting to force live workflow or open review queue while logged out must fail safely
  ctx.setSubmissionWorkflow('live');
  assert.equal(vm.runInContext('state.submissionWorkflow', ctx), 'queue', 'Logged-out visitor cannot enable live edit');
  ctx.toggleReviewQueueModal(true);
  assert.equal(document.getElementById('review-queue-modal').classList.contains('hidden'), true, 'Review modal stays closed for public');
  assert.equal(document.getElementById('mod-auth-modal').classList.contains('hidden'), false, 'Redirects public user to Moderator Login modal');

  // Public edit + flyer upload requires license checkbox, then routes to Storage + pending_submissions with Prefer: return=minimal
  ctx.openEditModalForOrg('vso-030');
  document.getElementById('sub-phone').value = '(603) 555-9999';
  document.getElementById('sub-submitter-name').value = 'VSO Officer Pat';
  document.getElementById('sub-submitter-email').value = 'pat@vso.org';
  vm.runInContext('state.uploadedFileObj = { name: "new-card.png", type: "image/png", size: 2048 }; state.uploadedFileName = "new-card.png";', ctx);

  // Unchecked license box must block submission with zero network calls
  assert.equal(document.getElementById('sub-license-checkbox').checked, false);
  assert.equal(await ctx.handleVsoSubmit({ preventDefault() {} }), false);
  assert.equal(calls.length, 0, 'Must NOT upload flyer or POST submission before license checkbox is checked');

  // Checking license box enables submission and attaches license_accepted + license_accepted_at
  document.getElementById('sub-license-checkbox').checked = true;
  await ctx.handleVsoSubmit({ preventDefault() {} });

  const storageCall = calls.find(c => c.url.includes('/storage/v1/object/vso-flyers/submissions/'));
  const pendingCall = calls.find(c => c.url.includes('/rest/v1/pending_submissions'));
  assert.ok(storageCall, 'Public flyer must upload to vso-flyers/submissions/ bucket');
  assert.ok(pendingCall, 'Public edit must POST to pending_submissions');
  assert.equal(pendingCall.headers['Prefer'], 'return=minimal', 'Public insert must use Prefer: return=minimal so anon RLS does not fail on RETURNING');
  const submitted = JSON.parse(pendingCall.body);
  assert.equal(submitted.review_status, 'pending');
  assert.equal(submitted.target_org_id, 'vso-030');
  assert.equal(submitted.submitter_name, 'VSO Officer Pat');
  assert.equal(submitted.submitter_email, 'pat@vso.org');
  assert.equal(submitted.payload.license_accepted, true, 'Submission payload must record license_accepted: true');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(submitted.payload.license_accepted_at), 'Submission payload must record ISO license_accepted_at');
  assert.ok(submitted.payload.flyerMeta.url.includes('/storage/v1/object/public/vso-flyers/submissions/'));

  // Live directory must remain untouched before moderator approval
  const dmavsPhone = vm.runInContext('ORGANIZATIONS.find(o => o.id === "vso-030").phone', ctx);
  assert.notEqual(dmavsPhone, '(603) 555-9999', 'Public edit must NOT mutate live ORGANIZATIONS directly');
});

test('15. Moderator login allowlist check, strong password enforcement, and password recovery flow', async () => {
  const calls = [];
  const fetchMock = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    if (url.includes('/auth/v1/token?grant_type=password')) {
      const b = JSON.parse(opts.body);
      if (b.email === 'random@example.com') {
        return { ok: true, status: 200, json: async () => ({ access_token: 'non-mod-tok', refresh_token: 'r0', expires_in: 3600, user: { id: 'u-nonmod', email: b.email } }) };
      }
      return { ok: true, status: 200, json: async () => ({ access_token: 'mod-tok-1', refresh_token: 'r1', expires_in: 3600, user: { id: 'u-mod1', email: b.email } }) };
    }
    if (url.includes('/rest/v1/moderators?user_id=eq.u-nonmod')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (url.includes('/rest/v1/moderators?user_id=eq.u-mod1')) {
      return { ok: true, status: 200, json: async () => [{ user_id: 'u-mod1', email: 'mod1@nhvet411.org', display_name: 'Jane Mod', role: 'moderator' }] };
    }
    if (url.includes('/rest/v1/pending_submissions?select=id')) {
      return { ok: true, status: 200, json: async () => [{ id: 'sub-1' }, { id: 'sub-2' }] };
    }
    if (url.includes('/auth/v1/recover') || url.includes('/auth/v1/user') || url.includes('/auth/v1/logout')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => [] };
  };

  const { ctx, document, historyCalls } = createAppHarness({ fetchMock });
  ctx.window.NHVET411_SUPABASE_URL = 'https://demo-proj.supabase.co';
  ctx.window.NHVET411_SUPABASE_ANON_KEY = 'anon-key-123';

  // Strong password criteria checks (12+ chars, upper, lower, digit, symbol)
  assert.equal(ctx.validateStrongPassword('Short1!').valid, false);
  assert.equal(ctx.validateStrongPassword('alllowercase123!').valid, false);
  assert.equal(ctx.validateStrongPassword('ALLUPPERCASE123!').valid, false);
  assert.equal(ctx.validateStrongPassword('NoDigitsHere!!').valid, false);
  assert.equal(ctx.validateStrongPassword('NoSymbolsHere123').valid, false);
  assert.equal(ctx.validateStrongPassword('GraniteState#2026!').valid, true);

  // Non-moderator user rejected & logged out
  document.getElementById('mod-login-email').value = 'random@example.com';
  document.getElementById('mod-login-password').value = 'GraniteState#2026!';
  const nonModOk = await ctx.handleModeratorLoginSubmit({ preventDefault() {} });
  assert.equal(nonModOk, false);
  assert.equal(ctx.isModeratorLoggedIn(), false);
  assert.ok(calls.some(c => c.url.includes('/auth/v1/logout')));

  // Allowlisted moderator signs in & unlocks review bell + live edit switch
  document.getElementById('mod-login-email').value = 'mod1@nhvet411.org';
  document.getElementById('mod-login-password').value = 'GraniteState#2026!';
  const modOk = await ctx.handleModeratorLoginSubmit({ preventDefault() {} });
  assert.equal(modOk, true);
  assert.equal(ctx.isModeratorLoggedIn(), true);
  assert.equal(document.getElementById('mod-login-btn').classList.contains('hidden'), true);
  assert.equal(document.getElementById('mod-review-btn').classList.contains('hidden'), false);
  assert.equal(document.getElementById('workflow-switch-bar').classList.contains('hidden'), false);
  assert.equal(vm.runInContext('state.submissionWorkflow', ctx), 'live');

  // Forgot password triggers Supabase recover endpoint with redirect_to
  document.getElementById('mod-forgot-email').value = 'mod1@nhvet411.org';
  assert.equal(await ctx.handleForgotPasswordSubmit({ preventDefault() {} }), true);
  assert.ok(calls.some(c => c.url.includes('/auth/v1/recover?redirect_to=')));

  // Recovery URL hash opens strong-password reset view and strips token from URL bar
  ctx.window.location.hash = '#access_token=recovery-secret-jwt&type=recovery';
  const detected = await ctx.checkUrlForPasswordRecovery();
  assert.equal(detected, true);
  assert.equal(historyCalls.length >= 1, true, 'Sensitive recovery token must be stripped via history.replaceState');
  assert.equal(vm.runInContext('state.modAuthMode', ctx), 'recovery');

  // Weak password rejected on recovery submit; strong matching password succeeds
  document.getElementById('mod-recovery-pw-new').value = 'weakpass';
  document.getElementById('mod-recovery-pw-confirm').value = 'weakpass';
  assert.equal(await ctx.handleSetNewPasswordSubmit({ preventDefault() {} }, true), false);

  document.getElementById('mod-recovery-pw-new').value = 'NHVetStrong#2026!';
  document.getElementById('mod-recovery-pw-confirm').value = 'NHVetStrong#2026!';
  assert.equal(await ctx.handleSetNewPasswordSubmit({ preventDefault() {} }, true), true);
  assert.ok(calls.some(c => c.url.includes('/auth/v1/user') && c.method === 'PUT'));
});

test('16. Bell icon red-dot notification never pops up over ongoing approvals', async () => {
  let pendingIds = [{ id: 'sub-1' }];
  const fetchMock = async (url) => {
    if (url.includes('/rest/v1/pending_submissions?select=id')) {
      return { ok: true, status: 200, json: async () => pendingIds };
    }
    return { ok: true, status: 200, json: async () => [] };
  };

  const { ctx, document } = createAppHarness({ fetchMock });
  ctx.window.NHVET411_SUPABASE_URL = 'https://demo-proj.supabase.co';
  ctx.window.NHVET411_SUPABASE_ANON_KEY = 'anon-key-123';
  vm.runInContext('state.modSession = { access_token: "t1", expires_at: Math.floor(Date.now()/1000) + 3600, user: { id: "u1" } }; state.modProfile = { user_id: "u1", email: "m@org.org", display_name: "Mod A", role: "moderator" };', ctx);
  ctx.updateModeratorUi();

  // Background poll finds 1 item -> red dot lights up, review modal stays CLOSED (no interrupting pop-up!)
  await ctx.pollModeratorPendingCount(true);
  assert.equal(document.getElementById('review-queue-count').textContent, 1);
  assert.equal(document.getElementById('mod-bell-dot').classList.contains('hidden'), false, 'Red dot must show on bell icon');
  assert.equal(document.getElementById('review-queue-modal').classList.contains('hidden'), true, 'Must NOT pop up over page automatically');

  // While moderator IS actively reviewing item #1 inside open modal, 2 new submissions arrive
  document.getElementById('review-queue-modal').classList.remove('hidden');
  vm.runInContext('state.modPendingItems = [{ id: "sub-1", payload: { name: "Org 1" } }]; state.modPendingIndex = 0; state.modRejectOpenForId = "sub-1";', ctx);
  pendingIds = [{ id: 'sub-1' }, { id: 'sub-2' }, { id: 'sub-3' }];
  await ctx.pollModeratorPendingCount(true);

  assert.equal(vm.runInContext('state.modPendingIndex', ctx), 0, 'Active item index must not be disturbed');
  assert.equal(vm.runInContext('state.modRejectOpenForId', ctx), 'sub-1', 'Open rejection comment box must not be wiped');
  assert.equal(document.getElementById('rq-new-badge').classList.contains('hidden'), false, 'Subtle +N new refresh pill should appear');
  assert.equal(document.getElementById('rq-new-badge').textContent, '+2 new');
});

test('17. Clean Review modal: side-by-side image/PDF flyer preview, XSS/apostrophe safety, Prev/Next & History toggle', () => {
  const { ctx, document } = createAppHarness();
  vm.runInContext('state.modSession = { access_token: "t1", expires_at: 9999999999, user: { id: "u1" } }; state.modProfile = { user_id: "u1", email: "m@org.org", display_name: "Mod A", role: "moderator" };', ctx);

  vm.runInContext(`
    state.modPendingItems = [
      {
        id: 'sub-img',
        target_org_id: 'vso-030',
        submitter_name: "O'Brien <script>alert(1)</script>",
        submitter_email: 'obrien@vso.org',
        created_at: '2026-11-20T18:00:00Z',
        payload: {
          uploadMode: 'edit',
          targetOrgId: 'vso-030',
          targetOrgName: "Veteran's <img src=x onerror=alert(1)> Center",
          phone: '(603) 555-1212',
          flyerMeta: { url: 'https://demo-proj.supabase.co/storage/v1/object/public/vso-flyers/submissions/card.png', fileName: "O'Brien Card.png", mimeType: 'image/png' },
          incomingContacts: [{ name: 'Pat New', email: 'pat@dmavs.nh.gov' }]
        }
      },
      {
        id: 'sub-pdf',
        target_org_id: null,
        submitter_name: 'PDF Submitter',
        submitter_email: '',
        created_at: '2026-11-20T18:05:00Z',
        payload: {
          uploadMode: 'new',
          name: 'Granite Vets PDF Org',
          city: 'Concord',
          flyerMeta: { url: 'https://demo-proj.supabase.co/storage/v1/object/public/vso-flyers/submissions/flyer.pdf', fileName: 'flyer.pdf', mimeType: 'application/pdf' },
          incomingContacts: []
        }
      },
      {
        id: 'sub-text',
        target_org_id: 'vso-031',
        submitter_name: 'Text Only Editor',
        submitter_email: 'editor@dav.org',
        created_at: '2026-11-20T18:10:00Z',
        payload: { uploadMode: 'edit', targetOrgId: 'vso-031', targetOrgName: 'DAV NH', description: 'Updated claims hours Mon-Fri 8-4.' }
      }
    ];
    state.modHistoryItems = [
      { id: 'hist-1', review_status: 'rejected', reviewed_by_name: 'Jane Mod', reviewed_at: '2026-11-20T17:00:00Z', submitter_name: 'Sam', submitter_email: 'sam@vso.org', rejection_reason: 'Phone number disconnected; please reconfirm.', payload: { name: 'Sample VSO' } }
    ];
    state.modPendingIndex = 0;
  `, ctx);

  // Item 1: Image flyer renders side-by-side split + escapes XSS & uses safe data-flyer-* attributes
  ctx.renderReviewQueueModal();
  let html1 = document.getElementById('review-queue-body').innerHTML;
  assert.ok(html1.includes('review-split-grid'), 'Image submission must render side-by-side layout');
  assert.ok(html1.includes('class="review-flyer-img"'), 'Image flyer must render inside <img> preview');
  assert.ok(html1.includes('onclick="openFlyerLightboxFromEl(this)"'), 'Flyer button must use safe data-attribute handler');
  assert.equal(html1.includes('<script>alert(1)'), false, 'XSS in submitter_name must be escaped');
  assert.equal(html1.includes('<img src=x'), false, 'XSS in org name must be escaped');
  assert.ok(html1.includes('Submission 1 of 3'));

  // Navigate to Item 2: PDF flyer renders side-by-side <iframe>
  ctx.navigatePendingSubmission(1);
  let html2 = document.getElementById('review-queue-body').innerHTML;
  assert.ok(html2.includes('Submission 2 of 3'));
  assert.ok(html2.includes('class="review-flyer-pdf"'), 'PDF flyer must render inside <iframe> preview');

  // Toggle to History & back to Pending -> preserves modPendingIndex === 1
  ctx.setReviewQueueTab('history');
  const histHtml = document.getElementById('review-queue-body').innerHTML;
  assert.ok(histHtml.includes('Phone number disconnected; please reconfirm.'));
  assert.ok(histHtml.includes('mailto:sam@vso.org'));
  ctx.setReviewQueueTab('pending');
  assert.equal(vm.runInContext('state.modPendingIndex', ctx), 1, 'Returning from History must preserve exact Pending position');

  // Navigate to Item 3 (no flyer): full-width clean layout (no review-split-grid)
  ctx.navigatePendingSubmission(1);
  let html3 = document.getElementById('review-queue-body').innerHTML;
  assert.ok(html3.includes('Submission 3 of 3'));
  assert.equal(html3.includes('review-split-grid'), false, 'Text-only edit must use full modal width without empty flyer column');

  // Lightbox rejects javascript: URLs
  assert.equal(ctx.sanitizeSafeMediaUrl('javascript:alert(1)'), '');
  assert.equal(ctx.sanitizeSafeMediaUrl('data:text/html;base64,PHNjcmlwdD4='), '');
});

test('18. Rejection requires customer-service comment, persists to RPC, advances queue & creates mailto link', async () => {
  const rpcCalls = [];
  const fetchMock = async (url, opts = {}) => {
    if (url.includes('/rest/v1/rpc/reject_pending_submission')) {
      rpcCalls.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, conflict: false, reviewed_by_name: 'Jane Mod', rejection_reason: JSON.parse(opts.body).p_rejection_reason }) };
    }
    return { ok: true, status: 200, json: async () => [] };
  };

  const { ctx, document } = createAppHarness({ fetchMock });
  ctx.window.NHVET411_SUPABASE_URL = 'https://demo-proj.supabase.co';
  ctx.window.NHVET411_SUPABASE_ANON_KEY = 'anon-key-123';
  vm.runInContext(`
    state.modSession = { access_token: 't1', expires_at: Math.floor(Date.now()/1000) + 3600, user: { id: 'u1' } };
    state.modProfile = { user_id: 'u1', email: 'mod@nhvet411.org', display_name: 'Jane Mod', role: 'moderator' };
    state.modPendingItems = [
      { id: 'sub-r1', submitter_name: 'Alex VSO', submitter_email: 'alex@vso.org', payload: { name: 'Granite Vets', uploadMode: 'new' } },
      { id: 'sub-r2', submitter_name: 'Next Person', submitter_email: '', payload: { name: 'Second Org', uploadMode: 'new' } }
    ];
    state.modPendingIndex = 0;
  `, ctx);

  ctx.toggleRejectBoxForItem('sub-r1');
  // Blank / too-short comment must be blocked with zero RPC call
  document.getElementById('rq-reject-reason-input').value = '  ';
  assert.equal(await ctx.confirmRejectQueueItem('sub-r1'), false);
  assert.equal(rpcCalls.length, 0, 'Must not call reject RPC without a comment');
  assert.equal(document.getElementById('rq-reject-error').classList.contains('hidden'), false);

  // Real courteous comment succeeds, advances queue to sub-r2, and offers mailto link
  document.getElementById('rq-reject-reason-input').value = 'Please include your 603 phone number so veterans can reach your office directly.';
  assert.equal(await ctx.confirmRejectQueueItem('sub-r1'), true);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].p_submission_id, 'sub-r1');
  assert.equal(rpcCalls[0].p_rejection_reason, 'Please include your 603 phone number so veterans can reach your office directly.');
  assert.equal(vm.runInContext('state.modPendingItems.length', ctx), 1, 'Auto-removed rejected item');
  assert.equal(vm.runInContext('state.modPendingItems[0].id', ctx), 'sub-r2', 'Auto-advanced to next pending item');
  const noticeHtml = document.getElementById('review-queue-notice').innerHTML;
  assert.ok(noticeHtml.includes('mailto:alex@vso.org'), 'Notice must include 1-click Email Submitter Feedback mailto link');
  assert.ok(noticeHtml.includes(encodeURIComponent('Please include your 603 phone number')), 'mailto body must prefill the rejection reason');
});

test('19. Concurrent multi-moderator race protection, Concord statewide HQ preservation & contact turnover removal', async () => {
  const fetchMock = async (url, opts = {}) => {
    if (url.includes('/rest/v1/organizations?id=eq.vso-030')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (url.includes('/rest/v1/rpc/approve_pending_submission')) {
      const body = JSON.parse(opts.body);
      if (body.p_submission_id === 'sub-race') {
        // Simulate Moderator A beating Moderator B by 50ms under Postgres FOR UPDATE lock
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: false, conflict: true, code: 'ALREADY_REVIEWED', review_status: 'approved', reviewed_by_name: 'Rich Admin' })
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, conflict: false, org_id: body.p_resolved_org.id, reviewed_by_name: 'Mod B' }) };
    }
    return { ok: true, status: 200, json: async () => [] };
  };

  const { ctx, document } = createAppHarness({ fetchMock });
  ctx.window.NHVET411_SUPABASE_URL = 'https://demo-proj.supabase.co';
  ctx.window.NHVET411_SUPABASE_ANON_KEY = 'anon-key-123';
  vm.runInContext(`
    state.modSession = { access_token: 't2', expires_at: Math.floor(Date.now()/1000) + 3600, user: { id: 'u2' } };
    state.modProfile = { user_id: 'u2', email: 'modb@nhvet411.org', display_name: 'Mod B', role: 'moderator' };
    state.modPendingItems = [
      { id: 'sub-race', target_org_id: 'vso-030', payload: { uploadMode: 'edit', targetOrgId: 'vso-030', name: 'DMAVS', city: 'Concord', zip: '03301', phone: '(603) 000-0000' } },
      { id: 'sub-next', target_org_id: 'vso-030', payload: { uploadMode: 'edit', targetOrgId: 'vso-030', name: 'NH Department of Military Affairs and Veterans Services (DMAVS)', city: 'Concord', zip: '03301', replaceContacts: true, incomingContacts: [{ name: 'New Officer', email: 'new@dmavs.nh.gov' }] } }
    ];
    state.modPendingIndex = 0;
  `, ctx);

  // Moderator B tries approving sub-race -> graceful conflict notice, no clobber, advances to sub-next
  await ctx.approveQueueItem('sub-race');
  assert.ok(document.getElementById('review-queue-notice').innerHTML.includes('Already approved by Rich Admin'));
  assert.equal(vm.runInContext('state.modPendingItems.length', ctx), 1);
  assert.equal(vm.runInContext('state.modPendingItems[0].id', ctx), 'sub-next');
  assert.notEqual(vm.runInContext('ORGANIZATIONS.find(o => o.id === "vso-030").phone', ctx), '(603) 000-0000');

  // Approving sub-next on Concord statewide HQ (vso-030) MUST preserve is_statewide:true AND replace departed contacts cleanly
  await ctx.approveQueueItem('sub-next');
  const dmavs = vm.runInContext('ORGANIZATIONS.find(o => o.id === "vso-030")', ctx);
  assert.equal(dmavs.is_statewide, true, 'Editing Concord statewide HQ must NOT wipe is_statewide flag');
  assert.equal(dmavs.city, 'Concord');
  assert.equal(dmavs.staff_contacts.length, 1);
  assert.equal(dmavs.staff_contacts[0].name, 'New Officer');

  // Also verify UI contact removal clears #sub-staff so removed contacts are never resurrected
  ctx.openEditModalForOrg('vso-030');
  assert.equal(document.getElementById('sub-staff').value, 'New Officer');
  ctx.removeParsedContactRow(0);
  assert.equal(document.getElementById('sub-staff').value, '', 'Removing last contact row must clear #sub-staff');
});

test('20. Moderator direct live edit RPC & 260-org single-query scale stress test', async () => {
  const baselineOrgs = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf8'));
  const scaledRows = baselineOrgs.map(o => ({ ...o, status: 'approved', staff_contacts: o.staff_contacts || [], amplifier_docs: [] }));
  for (let i = 1; i <= 113; i++) {
    scaledRows.push({
      id: `vso-extra-${i}`,
      name: `Granite Veteran Support Hub #${i}`,
      categories: ['housing-homelessness', 'benefits-advocacy'],
      description: `Regional New Hampshire veteran outreach hub #${i} offering VA claims assistance and emergency rent relief.`,
      address: `${100 + i} Main Street`,
      city: i % 2 === 0 ? 'Manchester' : 'Plymouth',
      zip: i % 2 === 0 ? '03101' : '03264',
      county: i % 2 === 0 ? 'Hillsborough' : 'Grafton',
      region_id: i % 2 === 0 ? 'merrimack-valley' : 'white-mountains',
      is_statewide: false,
      phone: '(603) 555-0100',
      email: `hub${i}@nhvets.org`,
      website: 'https://nhvet411.org',
      branches: ['all'],
      verified_vso: true,
      status: 'approved',
      staff_contacts: [{ name: `Advocate #${i}`, role: 'VSO', email: `adv${i}@nhvets.org`, phone: '' }],
      amplifier_docs: []
    });
  }

  let liveSaveCalled = false;
  let orgQueryCount = 0;
  const fetchMock = async (url, opts = {}) => {
    if (url.includes('/rest/v1/organizations?select=*')) {
      orgQueryCount += 1;
      return { ok: true, status: 200, json: async () => scaledRows };
    }
    if (url.includes('/rest/v1/organizations?id=eq.')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (url.includes('/rest/v1/rpc/moderator_save_organization')) {
      liveSaveCalled = true;
      const body = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ ok: true, org_id: body.p_org.id, saved_by: 'Rich Admin' }) };
    }
    return { ok: true, status: 200, json: async () => [] };
  };

  const { ctx, document, getRenderedCards } = createAppHarness({ fetchMock });
  ctx.window.NHVET411_SUPABASE_URL = 'https://demo-proj.supabase.co';
  ctx.window.NHVET411_SUPABASE_ANON_KEY = 'anon-key-123';

  // Stress test 260 orgs loading in 1 single relational query + fast rendering & searching
  const t0 = performance.now();
  const synced = await ctx.syncLiveDirectoryFromSupabase();
  const syncMs = performance.now() - t0;
  assert.equal(synced, true);
  assert.equal(orgQueryCount, 1, '260 orgs must load in ONE single relational query');
  assert.equal(vm.runInContext('ORGANIZATIONS.length', ctx), 260);
  assert.equal(document.getElementById('total-count-badge').textContent, 260);
  assert.equal(document.getElementById('nav-all-vsos-count').textContent, 260);
  assert.equal(document.getElementById('footer-total-vsos').textContent, 260);
  assert.equal(document.getElementById('stat-total-vsos').textContent, 260);
  assert.equal(document.getElementById('footer-total-contacts').textContent, document.getElementById('stat-total-contacts').textContent);
  assert.ok(syncMs < 400, `260-org sync + render should stay fast (<400ms), took ${syncMs.toFixed(1)}ms`);

  const tSearch = performance.now();
  ctx.onLiveSearchInput('Plymouth VA claims emergency rent relief');
  const searchMs = performance.now() - tSearch;
  const searchCards = getRenderedCards();
  assert.ok(searchCards.length >= 20, `Expected strong matches across 260 orgs, got ${searchCards.length}`);
  assert.ok(searchMs < 150, `Live search over 260 orgs must stay snappy (<150ms), took ${searchMs.toFixed(1)}ms`);

  // Signed-in moderator direct live edit calls moderator_save_organization RPC and updates directory immediately
  vm.runInContext(`
    state.modSession = { access_token: 'admin-tok', expires_at: Math.floor(Date.now()/1000) + 3600, user: { id: 'u-admin' } };
    state.modProfile = { user_id: 'u-admin', email: 'rich@nhvet411.org', display_name: 'Rich Admin', role: 'admin' };
    state.submissionWorkflow = 'live';
  `, ctx);
  ctx.updateModeratorUi();
  ctx.openEditModalForOrg('vso-extra-1');
  document.getElementById('sub-desc').value = 'Live moderator edit verified for stress testing.';
  document.getElementById('sub-license-checkbox').checked = true;
  await ctx.handleVsoSubmit({ preventDefault() {} });
  assert.equal(liveSaveCalled, true, 'Moderator live edit must invoke moderator_save_organization RPC');
});

test('21. Migration 002 RLS & concurrency SQL audit + build_website.js env var derivation check', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/002_moderation_and_rls.sql'), 'utf8');
  for (const tbl of ['moderators', 'organizations', 'staff_contacts', 'amplifier_docs', 'pending_submissions', 'audit_logs']) {
    assert.ok(sql.includes(`alter table public.${tbl} enable row level security;`), `Missing RLS enforcement for ${tbl}`);
  }
  assert.ok(sql.includes('add column if not exists rejection_reason text'), 'Must add rejection_reason column');
  assert.ok(sql.includes('for update;'), 'Must use FOR UPDATE row locking for concurrent moderator safety');
  assert.ok(sql.includes('if not public.is_moderator() then'), 'Must enforce is_moderator() server-side in RPCs');
  assert.ok(sql.includes('revoke all on function public.approve_pending_submission'), 'Must revoke anon/public execute on approve RPC');
  assert.ok(sql.includes('revoke all on function public.reject_pending_submission'), 'Must revoke anon/public execute on reject RPC');
  assert.ok(sql.includes('revoke all on function public.moderator_save_organization'), 'Must revoke anon/public execute on live save RPC');
  assert.ok(sql.includes('length(v_clean_reason) < 3'), 'Server-side RPC must enforce non-empty rejection reason');

  const builderSrc = fs.readFileSync(path.join(ROOT, 'build_website.js'), 'utf8');
  assert.equal(builderSrc.includes('SUPABASE_SERVICE_ROLE_KEY'), false, 'build_website.js must NEVER touch SUPABASE_SERVICE_ROLE_KEY');
  assert.equal(builderSrc.includes('process.env.GEMINI_API_KEY'), false, 'build_website.js must NEVER touch GEMINI_API_KEY');
});

test('22. Pre-Launch Hygiene #1: Personal email privacy scrub (opt-in only) + leaked email removal + official org free-domain preservation', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const orgs = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf8'));

  // Leaked extraction artifact and all 22 unconfirmed individual personal emails must NOT exist in public JSON or index.html
  const forbiddenEmails = [
    'aashishbalani27@gmail.com',
    'iwont4gt@gmail.com',
    'sheser@comcast.net',
    'elimcquade@gmail.com',
    'marge.hart188@gmail.com',
    'tmahoney.eip@gmail.com',
    'nonaalexander1@gmail.com',
    'blazrss@yahoo.com',
    'mkbfd43@gmail.com',
    'tombyron38@gmail.com',
    'me_guide@hotmail.com',
    '1sgpeirce@gmail.com',
    'joshuaskinner88@gmail.com',
    'margolapointe33@gmail.com',
    'luckytwobealive@comcast.net',
    'balloontraveler@yahoo.com',
    'sophie.defrancesco@gmail.com',
    'sgmjim@gmail.com',
    'vogelmanlarry@yahoo.com',
    'dc9guy@comcast.net',
    'pjl64@comcast.net',
    'nancygarnhart@gmail.com',
    'michelleverdi@me.com'
  ];
  for (const em of forbiddenEmails) {
    assert.equal(html.toLowerCase().includes(em), false, `Suppressed personal email "${em}" must NOT appear anywhere in index.html`);
    assert.equal(JSON.stringify(orgs).toLowerCase().includes(em), false, `Suppressed personal email "${em}" must NOT appear in nh_organizations_data.json`);
  }

  // Named contacts whose personal emails were suppressed MUST still retain their names on the cards
  const vso005 = orgs.find(o => o.id === 'vso-005');
  assert.ok(vso005.staff_contacts.some(c => c.name.includes('Linda Lambert') && c.email === ''), 'Linda Lambert name must remain while personal email is stripped');
  const vso076 = orgs.find(o => o.id === 'vso-076');
  assert.equal(vso076.email, 'jenelson@plymouth.edu', 'vso-076 primary email should fall back to official .edu address');
  assert.ok(vso076.staff_contacts.some(c => c.name.includes('Jim Goss') && c.email === ''), 'Jim Goss name must remain while personal gmail is stripped');

  // Official VSO role/chapter inboxes on free providers MUST remain active and opted-in
  for (const officialFree of ['nhvfwstateheadquarters@gmail.com', 'heropupsinc@yahoo.com', 'thehonorbear@gmail.com', 'vetsreststop@gmail.com', 'womenofgwot@gmail.com']) {
    assert.ok(html.toLowerCase().includes(officialFree), `Official org inbox "${officialFree}" must remain visible in index.html`);
  }

  // Runtime defense-in-depth: injecting an unconfirmed @gmail.com contact hides email in HTML & share text until public_opt_in: true
  const { ctx, getRenderedCards } = createAppHarness();
  vm.runInContext(`
    const target = ORGANIZATIONS.find(o => o.id === 'vso-005');
    target.email = 'unopted_volunteer@gmail.com';
    target.public_opt_in = false;
    target.staff_contacts = [{ name: 'Linda Lambert', email: 'unopted_volunteer@gmail.com', public_opt_in: false }];
    renderDirectory();
  `, ctx);
  let card005 = getRenderedCards().find(c => c.id === 'vso-005');
  assert.equal(card005.html.includes('unopted_volunteer@gmail.com'), false, 'Unopted personal email must be hidden in card HTML');
  let share005 = vm.runInContext('buildBuddyShareData(ORGANIZATIONS.find(o => o.id === "vso-005"))', ctx);
  assert.equal(share005.bodyText.includes('unopted_volunteer@gmail.com'), false, 'Unopted personal email must be hidden in Buddy Share body');

  vm.runInContext(`
    const target2 = ORGANIZATIONS.find(o => o.id === 'vso-005');
    target2.public_opt_in = true;
    target2.staff_contacts[0].public_opt_in = true;
    renderDirectory();
  `, ctx);
  card005 = getRenderedCards().find(c => c.id === 'vso-005');
  assert.ok(card005.html.includes('unopted_volunteer@gmail.com'), 'Explicit public_opt_in: true must allow personal-domain email to render');
});

test('23. Pre-Launch Hygiene #2: Third-party flyer media_authorized gate & required unchecked upload license checkbox', async () => {
  const { ctx, document, getRenderedCards } = createAppHarness();

  // Confirmed baseline flyers (walkwithtiger.pdf & The Honor Bear project.pdf) have media_authorized: true and render
  let cards = getRenderedCards();
  const tigerCard = cards.find(c => c.id === 'vso-105');
  const bearCard = cards.find(c => c.id === 'the-honor-bear-project-laconia');
  assert.ok(tigerCard.html.includes('openAmplifierModal'), 'Authorized walkwithtiger.pdf must render View Official Amplifier button');
  assert.ok(bearCard.html.includes('openAmplifierModal'), 'Authorized Honor Bear PDF must render View Official Amplifier button');

  // Unconfirmed third-party flyer (media_authorized: false) must NOT render button or open lightbox
  vm.runInContext(`
    const unauthOrg = ORGANIZATIONS.find(o => o.id === 'vso-001');
    unauthOrg.amplifier_doc = 'unconfirmed_third_party.pdf';
    unauthOrg.media_authorized = false;
    renderDirectory();
  `, ctx);
  cards = getRenderedCards();
  const org001Card = cards.find(c => c.id === 'vso-001');
  assert.equal(org001Card.html.includes('openAmplifierModal'), false, 'media_authorized: false must suppress flyer button on public card');
  ctx.openAmplifierModal('vso-001');
  assert.equal(document.getElementById('amplifier-modal').classList.contains('hidden'), true, 'openAmplifierModal must refuse unauthorized flyer');

  // Opening submit modal resets #sub-license-checkbox to unchecked, and submitting unchecked is blocked
  ctx.openEditModalForOrg('vso-030');
  assert.equal(document.getElementById('sub-license-checkbox').checked, false, 'License checkbox must default to unchecked when modal opens');
  const blockedRes = await ctx.handleVsoSubmit({ preventDefault() {} });
  assert.equal(blockedRes, false, 'Unchecked license checkbox must block form submission');
  assert.equal(document.getElementById('sub-license-error').classList.contains('hidden'), false, 'Validation error message must display');
});

test('24. Pre-Launch Hygiene #3: Card badge scoped to data freshness (✓ Checked YYYY-MM) with non-endorsement tooltip', () => {
  const { getRenderedCards, html } = createAppHarness();
  assert.equal(html.includes('>✓ Verified VSO<'), false, 'Legacy "✓ Verified VSO" badge text must be replaced');
  const cards = getRenderedCards();
  const dmavs = cards.find(c => c.id === 'vso-030');
  assert.ok(dmavs.html.includes('✓ Checked 2026-11'), 'Card must display ✓ Checked YYYY-MM from last_verified');
  assert.ok(dmavs.html.includes('Contact details checked active as of 2026-11. Informational listing only; not VA accreditation or an endorsement.'), 'Card badge must include non-endorsement & non-VA-accreditation tooltip');
});

test('25. Pre-Launch Hygiene #4 & #5: Footer legal links, accessible legal modal, Escape-key close across all 6 modals, and WCAG AA form labels', () => {
  const { ctx, document, domListeners, html } = createAppHarness();
  ctx.initMobileExperience();

  // Footer contains Terms & Disclaimer, Privacy Policy, and DMCA / Removal Request links
  assert.ok(html.includes('id="footer-terms-link"') && html.includes('Terms &amp; Disclaimer'));
  assert.ok(html.includes('id="footer-privacy-link"') && html.includes('Privacy Policy'));
  assert.ok(html.includes('id="footer-dmca-link"') && html.includes('DMCA / Removal Request'));

  // Legal modal sections switch cleanly and contain confirmed entity/email + crisis line + accurate Gemini proxy disclosure
  ctx.openLegalModal('privacy');
  assert.equal(document.getElementById('legal-modal').classList.contains('hidden'), false);
  assert.equal(document.getElementById('legal-panel-privacy').classList.contains('hidden'), false);
  assert.equal(document.getElementById('legal-panel-terms').classList.contains('hidden'), true);
  assert.ok(html.includes('NHVet411 (Independent New Hampshire Veteran Resource Project)'));
  assert.ok(html.includes('admin@nhvet411.org'));
  assert.ok(html.includes('988 (then Press 1)'));
  assert.ok(html.includes('Google Gemini'));
  assert.ok(html.includes('17 U.S.C. § 512'));

  // Escape key closes every interactive modal
  for (const modalId of ['whats-new-modal', 'legal-modal', 'amplifier-modal', 'apikey-modal', 'submit-modal', 'mod-auth-modal', 'review-queue-modal']) {
    document.getElementById(modalId).classList.remove('hidden');
    for (const fn of (domListeners.keydown || [])) {
      fn({ key: 'Escape' });
    }
    assert.equal(document.getElementById(modalId).classList.contains('hidden'), true, `Escape key must close #${modalId}`);
  }

  // All 7 modals must declare role="dialog" and aria-modal="true"
  for (const modalId of ['apikey-modal', 'submit-modal', 'review-queue-modal', 'mod-auth-modal', 'amplifier-modal', 'legal-modal', 'whats-new-modal']) {
    const tagMatch = html.match(new RegExp(`<div id="${modalId}"[^>]*>`));
    assert.ok(tagMatch, `Missing modal #${modalId}`);
    assert.ok(tagMatch[0].includes('role="dialog"') && tagMatch[0].includes('aria-modal="true"'), `#${modalId} must have role="dialog" and aria-modal="true"`);
  }

  // Every form input/select/textarea in index.html must have an associated <label for="id"> or aria-label
  const controlTags = [...html.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)];
  assert.ok(controlTags.length >= 20, `Expected >=20 form controls, found ${controlTags.length}`);
  for (const [, tag, attrs] of controlTags) {
    const idMatch = attrs.match(/\bid="([^"]+)"/i);
    const hasAriaLabel = /\baria-label="[^"]+"/i.test(attrs);
    const hasLabelFor = idMatch ? new RegExp(`<label[^>]*\\bfor="${idMatch[1]}"`, 'i').test(html) : false;
    const isWrappedInLabel = idMatch && idMatch[1] === 'include-statewide-toggle';
    assert.ok(hasAriaLabel || hasLabelFor || isWrappedInLabel, `Form control <${tag}> (${idMatch ? idMatch[1] : attrs}) is missing <label for> or aria-label`);
  }
});

test('26. Site UX Polish Batch (#1-#9): 1A favicon, 211NH Help pill, desktop Admin dropdown + footer AI key, Detailed Filter toggle, 4 U.S.C. §7i vertical-stripe NH flag loader, live named contact count, version-bump update notice & What\'s New modal, and concise search placeholder', async () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const faviconSvg = fs.readFileSync(path.join(ROOT, 'favicon.svg'), 'utf8');
  const versionJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
  const whatsNewJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'whats_new.json'), 'utf8'));

  // #1: Option 1A stacked VET / 411 charcoal favicon exists and is linked in <head>
  assert.ok(faviconSvg.includes('>VET</text>') && faviconSvg.includes('>411</text>'), 'favicon.svg must render Option 1A VET / 411');
  assert.ok(html.includes('rel="icon" type="image/svg+xml" href="data:image/svg+xml'), 'index.html must include inline SVG favicon');

  // #2: 211NH Help label in top banner and footer
  assert.ok(html.includes('Dial 211</strong>: 211NH Help'), 'Top crisis banner must show Dial 211: 211NH Help');
  assert.ok(html.includes('<strong>211NH Help:</strong>'), 'Footer must show 211NH Help');

  // #3: AI Key pill moved to footer; Moderator Login tucked inside hero-admin-dropdown-wrap
  const heroStart = html.indexOf('<header id="resource-search"');
  const heroEnd = html.indexOf('</header>', heroStart);
  const heroHtml = html.slice(heroStart, heroEnd);
  const footerStart = html.indexOf('<footer');
  const footerHtml = html.slice(footerStart);
  assert.equal(heroHtml.includes('api-status-btn-text'), false, 'AI Key pill must no longer sit in the hero');
  assert.ok(footerHtml.includes('id="footer-ai-key-btn"') && footerHtml.includes('id="api-status-btn-text"'), 'AI Key pill must live in the footer');
  assert.ok(heroHtml.includes('id="hero-admin-dropdown-wrap"') && heroHtml.includes('id="mod-login-btn"'), 'Moderator Login must live inside Admin dropdown');

  // #4 & #6: Redundant VIEW ALL pill removed; Detailed Filter toggle removed from 7 Regions and placed directly above #detailed-filter-panel
  assert.equal(html.includes('btn-view-all-count'), false, 'Redundant green VIEW ALL pill must be removed');
  const regionsStart = html.indexOf('id="nh-regions-showcase"');
  const regionsEnd = html.indexOf('</section>', regionsStart);
  assert.equal(html.slice(regionsStart, regionsEnd).includes('toggleMobileFilters'), false, 'Toggle button must be removed from 7 Regions showcase');
  assert.ok(html.includes('id="toggle-detailed-filters-btn"') && html.includes('Hide Detailed Filters'), 'State-aware Detailed Filters toggle must sit above #detailed-filter-panel');

  // #9: Concise question-first search placeholder
  assert.ok(html.includes('placeholder="Ask any question, or enter a ZIP code or NH town..."'), 'Search placeholder must lead with Ask any question...');

  // #8: version.json synced to whats_new.json
  assert.equal(versionJson.version, whatsNewJson.currentVersion, 'version.json must match whats_new.json currentVersion');

  // Runtime checks for #3, #5, #6, #7, #8
  let pendingVersion = versionJson.version;
  let resolveSlowAi;
  const slowAiPromise = new Promise(r => { resolveSlowAi = r; });

  const fetchMock = async (url) => {
    if (url.includes('version.json')) {
      return { ok: true, status: 200, json: async () => ({ version: pendingVersion }) };
    }
    if (url.includes('gemini-search-proxy')) {
      await slowAiPromise;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, model: 'gemini-3.5-flash-lite', data: { categories: ['benefits-advocacy'], org_ids: ['vso-030'], highlight_terms: ['VA'] } })
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const { ctx, document } = createAppHarness({ fetchMock });
  ctx.window.NHVET411_GEMINI_PROXY_URL = 'https://demo.supabase.co/functions/v1/gemini-search-proxy';

  // #6 runtime: toggleMobileFilters toggles panel visibility and updates button label/chevron/aria-expanded
  assert.equal(document.getElementById('detailed-filter-panel').classList.contains('hidden'), false);
  ctx.toggleMobileFilters();
  assert.equal(document.getElementById('detailed-filter-panel').classList.contains('hidden'), true);
  assert.equal(document.getElementById('toggle-detailed-filters-label').textContent, 'Show Detailed Filters');
  assert.equal(document.getElementById('toggle-detailed-filters-btn').getAttribute('aria-expanded'), 'false');
  ctx.toggleMobileFilters();
  assert.equal(document.getElementById('detailed-filter-panel').classList.contains('hidden'), false);
  assert.equal(document.getElementById('toggle-detailed-filters-label').textContent, 'Hide Detailed Filters');
  assert.equal(document.getElementById('toggle-detailed-filters-btn').getAttribute('aria-expanded'), 'true');

  // #5 runtime: plain-text AI search shows regulation vertical-stripe NH flag loader while awaiting proxy and clears cleanly on finish
  document.getElementById('search-input').value = 'How do I file a VA disability claim in Concord?';
  const searchRun = ctx.runAiAssistantFromInput();
  assert.equal(document.getElementById('search-submit-btn').disabled, true, 'Search button must disable while AI search is in flight');
  assert.equal(document.getElementById('search-submit-label').textContent, 'Searching...');
  const loaderHtml = document.getElementById('ai-navigator-icon').innerHTML;
  assert.ok(loaderHtml.includes('nh-flag-loader-fill'), 'Animated NH flag loader must appear during AI search');
  assert.ok(loaderHtml.includes('fill="#0A3161"') && loaderHtml.includes('width="62" height="86"'), 'Blue union with stars must sit in upper-left per 4 U.S.C. § 7(i)');
  assert.equal((loaderHtml.match(/height="187"/g) || []).length, 13, 'Flag must render 13 regulation vertical stripes');
  resolveSlowAi();
  await searchRun;
  assert.equal(document.getElementById('search-submit-btn').disabled, false, 'Search button must re-enable after AI search finishes');
  assert.equal(document.getElementById('search-submit-label').textContent, 'Search / Ask AI');

  // #7 runtime: adding a named VSO contact dynamically increments BOTH banner and footer contact counts
  ctx.updateStateDirectoryStats();
  const beforeBannerContacts = Number(document.getElementById('stat-total-contacts').textContent);
  const beforeFooterContacts = Number(document.getElementById('footer-total-contacts').textContent);
  assert.equal(beforeBannerContacts, 215);
  assert.equal(beforeFooterContacts, 215);
  ctx.applySubmissionPayloadLive({
    uploadMode: 'add-contact',
    targetOrgId: 'vso-030',
    incomingContacts: [{ name: 'Alex Rivera (Outreach Specialist)', email: 'arivera@dmavs.nh.gov', phone: '(603) 555-0199', public_opt_in: true }],
    license_accepted: true
  });
  assert.equal(Number(document.getElementById('stat-total-contacts').textContent), 216, 'Banner VSO contacts count must increment dynamically');
  assert.equal(Number(document.getElementById('footer-total-contacts').textContent), 216, 'Footer VSO contacts count must increment dynamically');

  // #8 runtime: Update Available stays hidden on same version, appears ONLY on version bump, and What's New modal renders cleanly
  const sameRes = await ctx.checkForSiteUpdate(true);
  assert.equal(sameRes, false);
  assert.equal(document.getElementById('update-available-btn').classList.contains('hidden'), true, 'Update badge must remain hidden when versions match');

  pendingVersion = '1.2.0';
  const bumpRes = await ctx.checkForSiteUpdate(true);
  assert.equal(bumpRes, true);
  assert.equal(document.getElementById('update-available-btn').classList.contains('hidden'), false, 'Update badge must appear when version bumps');

  ctx.openWhatsNewModal();
  assert.equal(document.getElementById('whats-new-modal').classList.contains('hidden'), false);
  assert.ok(document.getElementById('whats-new-body').innerHTML.includes('v1.2.0'), 'What\'s New modal should display refresh banner for detected new version');
  assert.ok(document.getElementById('whats-new-body').innerHTML.includes(whatsNewJson.releases[0].title.replace(/&/g, '&amp;')), 'What\'s New modal should render current release title safely escaped');
  ctx.closeWhatsNewModal();
  assert.equal(document.getElementById('whats-new-modal').classList.contains('hidden'), true);
});



