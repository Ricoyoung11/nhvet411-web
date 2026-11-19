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

  // Core DOM IDs read/written by initFilters, renderDirectory, runAiAssistantFromInput, resetAllFilters
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
  makeEl('stat-total-vsos');
  makeEl('stat-total-counties');
  makeEl('stat-total-regions');
  makeEl('stat-total-categories');
  makeEl('stat-total-contacts');
  makeEl('api-status-btn-text');
  makeEl('review-queue-badge');
  makeEl('parsed-contacts-list');

  const store = new Map();
  const localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); }
  };

  const domListeners = {};
  const document = {
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

  const sandbox = {
    console,
    document,
    window: {
      isSecureContext: false,
      addEventListener() {},
      location: { href: 'http://localhost/' }
    },
    navigator: {},
    localStorage,
    fetch: fetchMock || (async () => { throw new Error('Network disabled in offline test'); }),
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    decodeURIComponent,
    URL,
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

  return { ctx, document, localStorage, getRenderedCards, html };
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

  // Shared across 2 orgs
  document.getElementById('search-input').value = 'sgmjim@gmail.com';
  await ctx.runAiAssistantFromInput();
  let ids = getRenderedCards().map(c => c.id);
  assert.deepEqual(ids.sort(), ['vso-076', 'vso-083']);
  assert.ok(getRenderedCards()[0].html.includes('href="mailto:sgmjim@gmail.com?subject='), 'mailto href must stay intact');
  assert.ok(getRenderedCards()[0].html.includes('<mark class="search-hl">sgmjim@gmail.com</mark>'), 'Email text should highlight inline');

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
