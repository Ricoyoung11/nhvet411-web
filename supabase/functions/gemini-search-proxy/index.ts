// NHVet411 Supabase Edge Function — Grounded Gemini Search & Flyer Proxy
// Keeps GEMINI_API_KEY strictly server-side inside Supabase Secrets.
// Deploy: supabase functions deploy gemini-search-proxy --no-verify-jwt

const SEARCH_MODELS = ['gemini-3.5-flash-lite', 'gemini-4-hydrogen'] as const;
const FLYER_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-4-hydrogen'] as const;

const MAX_QUERY_CHARS = 1500;
const MAX_CATALOG_ITEMS = 500;
const MAX_BASE64_BYTES = 10 * 1024 * 1024; // ~10 MB raw base64 ceiling
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 30;

const ipBuckets = new Map<string, { count: number; resetAt: number }>();

export interface ProxyEnv {
  geminiApiKey?: string;
  allowedOrigins?: string;
  fetchImpl?: typeof fetch;
}

function buildCorsHeaders(reqOrigin: string | null, allowedOriginsRaw: string): Record<string, string> {
  const allowList = allowedOriginsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let allowOrigin = '*';
  if (allowList.length > 0 && !allowList.includes('*')) {
    if (reqOrigin && allowList.includes(reqOrigin)) {
      allowOrigin = reqOrigin;
    } else {
      allowOrigin = allowList[0];
    }
  } else if (reqOrigin) {
    allowOrigin = reqOrigin;
  }

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
    'Vary': 'Origin',
    'Content-Type': 'application/json'
  };
}

function checkRateLimit(ip: string, now = Date.now()): boolean {
  if (ipBuckets.size > 5000) {
    for (const [k, v] of ipBuckets.entries()) {
      if (now > v.resetAt) ipBuckets.delete(k);
    }
  }
  const existing = ipBuckets.get(ip);
  if (!existing || now > existing.resetAt) {
    ipBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (existing.count >= RATE_MAX_REQUESTS) {
    return false;
  }
  existing.count += 1;
  return true;
}

export function resetRateLimitBuckets(): void {
  ipBuckets.clear();
}

export async function handleRequest(req: Request, env: ProxyEnv = {}): Promise<Response> {
  const reqOrigin = req.headers.get('origin');
  const allowedOriginsRaw = env.allowedOrigins ?? '';
  const corsHeaders = buildCorsHeaders(reqOrigin, allowedOriginsRaw);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), {
      status: 405,
      headers: corsHeaders
    });
  }

  // Enforce strict origin allowlist when ALLOWED_ORIGINS is configured
  const allowList = allowedOriginsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (allowList.length > 0 && !allowList.includes('*') && reqOrigin && !allowList.includes(reqOrigin)) {
    return new Response(JSON.stringify({ ok: false, error: 'Origin not allowed' }), {
      status: 403,
      headers: corsHeaders
    });
  }

  const clientIp = (req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || 'unknown')
    .split(',')[0]
    .trim();
  if (!checkRateLimit(clientIp)) {
    return new Response(JSON.stringify({ ok: false, error: 'Rate limit exceeded. Please wait a moment and try again.' }), {
      status: 429,
      headers: corsHeaders
    });
  }

  const apiKey = (env.geminiApiKey || '').trim();
  if (!apiKey) {
    return new Response(JSON.stringify({ ok: false, error: 'Server GEMINI_API_KEY secret is not configured' }), {
      status: 500,
      headers: corsHeaders
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON request body' }), {
      status: 400,
      headers: corsHeaders
    });
  }

  const mode = String(body.mode || 'search');
  const fetchFn = env.fetchImpl || fetch;

  if (mode === 'search') {
    const query = String(body.query || '').trim();
    const rawCatalog = Array.isArray(body.catalog) ? body.catalog : [];

    if (!query || query.length > MAX_QUERY_CHARS) {
      return new Response(JSON.stringify({ ok: false, error: 'Query must be between 1 and 1500 characters' }), {
        status: 400,
        headers: corsHeaders
      });
    }
    if (rawCatalog.length === 0 || rawCatalog.length > MAX_CATALOG_ITEMS) {
      return new Response(JSON.stringify({ ok: false, error: 'Valid organization catalog is required' }), {
        status: 400,
        headers: corsHeaders
      });
    }

    // Sanitize catalog entries & build server-side valid ID map to block hallucinations
    const validIdSet = new Set<string>();
    const compactCatalog = rawCatalog.map((item: Record<string, unknown>) => {
      const id = String(item?.id || '');
      if (id) validIdSet.add(id);
      return {
        id,
        name: String(item?.name || ''),
        categories: Array.isArray(item?.categories) ? item.categories : [],
        city: String(item?.city || ''),
        county: String(item?.county || ''),
        is_statewide: Boolean(item?.is_statewide),
        description: String(item?.description || '')
      };
    });

    const promptMsg =
      'You are the NHVet411 Veteran Resource Navigator for New Hampshire. ' +
      'STRICT RULE: Do NOT do open-web search; ONLY return valid organization IDs from the provided directory JSON. ' +
      `Analyze this request: "${query}". ` +
      'Return ALL organizations from the directory that can meaningfully help (across every relevant category), ' +
      'plus exact words/phrases that appear in their descriptions to highlight visually. ' +
      'Return ONLY valid JSON: {"categories": ["..."], "org_ids": ["..."], "highlight_terms": ["..."], "summary": "..."}. ' +
      'DIRECTORY: ' + JSON.stringify(compactCatalog);

    for (const model of SEARCH_MODELS) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      try {
        const res = await fetchFn(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptMsg }] }],
            generationConfig: { responseMimeType: 'application/json' }
          })
        });
        if (!res.ok) continue;

        const payload = await res.json();
        const txt = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const jsonMatch = String(txt).match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;

        const parsed = JSON.parse(jsonMatch[0]);
        const safeOrgIds = Array.isArray(parsed.org_ids)
          ? parsed.org_ids.map(String).filter((id: string) => validIdSet.has(id))
          : [];
        const safeCats = Array.isArray(parsed.categories)
          ? parsed.categories.map(String).filter((c: string) => c && c !== 'all')
          : [];
        const safeHighlights = Array.isArray(parsed.highlight_terms)
          ? parsed.highlight_terms.map(String).filter(Boolean).slice(0, 24)
          : [];

        return new Response(
          JSON.stringify({
            ok: true,
            model,
            data: {
              categories: safeCats,
              org_ids: safeOrgIds,
              highlight_terms: safeHighlights,
              summary: typeof parsed.summary === 'string' ? parsed.summary : ''
            }
          }),
          { status: 200, headers: corsHeaders }
        );
      } catch {
        continue;
      }
    }

    return new Response(JSON.stringify({ ok: false, error: 'All Gemini search models unavailable' }), {
      status: 502,
      headers: corsHeaders
    });
  }

  if (mode === 'flyer') {
    const mimeType = String(body.mimeType || 'image/png');
    const base64Data = String(body.base64Data || '');
    const extraSvgContext = String(body.extraSvgContext || '').slice(0, 20_000);

    if (!base64Data && !extraSvgContext) {
      return new Response(JSON.stringify({ ok: false, error: 'Flyer data is required' }), {
        status: 400,
        headers: corsHeaders
      });
    }
    if (base64Data.length > MAX_BASE64_BYTES) {
      return new Response(JSON.stringify({ ok: false, error: 'Flyer file exceeds maximum allowed size' }), {
        status: 413,
        headers: corsHeaders
      });
    }

    const promptMsg =
      'Extract veteran organization details and ALL listed staff/officer contacts from this flyer or business card. ' +
      'Return ONLY valid JSON with keys: "name", "address", "city", "zip", "phone", "email", "website", ' +
      '"description" (1-2 sentences summarizing mission/services), "contact_name", and ' +
      '"contacts": [{"name": "...", "role": "...", "email": "...", "phone": "..."}]. ' +
      'If a piece of data is missing, leave the string empty. Do not invent details.' +
      extraSvgContext;

    const parts: Array<Record<string, unknown>> = [];
    if (base64Data && !mimeType.includes('svg')) {
      parts.push({ inlineData: { mimeType, data: base64Data } });
    }
    parts.push({ text: promptMsg });

    for (const model of FLYER_MODELS) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      try {
        const res = await fetchFn(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { responseMimeType: 'application/json' }
          })
        });
        if (!res.ok) continue;

        const payload = await res.json();
        const txt = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const jsonMatch = String(txt).match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;

        const apiParsed = JSON.parse(jsonMatch[0]);
        return new Response(JSON.stringify({ ok: true, model, data: apiParsed }), {
          status: 200,
          headers: corsHeaders
        });
      } catch {
        continue;
      }
    }

    return new Response(JSON.stringify({ ok: false, error: 'All Gemini vision models unavailable' }), {
      status: 502,
      headers: corsHeaders
    });
  }

  return new Response(JSON.stringify({ ok: false, error: 'Unsupported mode' }), {
    status: 400,
    headers: corsHeaders
  });
}

// Start Deno HTTP server when executed on Supabase Edge Functions
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response> | Response): void;
} | undefined;

if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
  Deno.serve((req: Request) =>
    handleRequest(req, {
      geminiApiKey: Deno.env.get('GEMINI_API_KEY') || '',
      allowedOrigins: Deno.env.get('ALLOWED_ORIGINS') || ''
    })
  );
}
