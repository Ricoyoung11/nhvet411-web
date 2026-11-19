import fs from 'fs';
import path from 'path';
import { GoogleGenAI, Type } from '@google/genai';

// Initialize Gemini (Make sure GEMINI_API_KEY is set in your environment)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 1. Load your Golden Lookup File from the Desktop folder
const LOOKUP_PATH = path.resolve('./nh_lookup_schema.json');
const OUTPUT_DB_PATH = path.resolve('./nh_organizations_data.json');

if (!fs.existsSync(LOOKUP_PATH)) {
  console.error('❌ Error: Could not find nh_lookup_schema.json in this folder.');
  process.exit(1);
}

const nhLookup = JSON.parse(fs.readFileSync(LOOKUP_PATH, 'utf-8'));

// Extract valid Category IDs directly from your lookup file so they ALWAYS match
const VALID_CATEGORY_IDS = nhLookup.taxonomy_categories.map((cat) => cat.id);

// 2. Define the Strict Gemini Structured Output Schema
// Notice it returns an ARRAY of organizations so a single PDF roster with 50 VSOs
// or a single flyer with 1 VSO both work seamlessly!
const extractionSchema = {
  type: Type.ARRAY,
  description: 'List of New Hampshire veteran organizations or services extracted from the document.',
  items: {
    type: Type.OBJECT,
    properties: {
      name: {
        type: Type.STRING,
        description: 'Official name of the organization, VSO post, or program.'
      },
      categories: {
        type: Type.ARRAY,
        description: 'Select 1 to 3 matching category IDs from the allowed taxonomy.',
        items: {
          type: Type.STRING,
          enum: VALID_CATEGORY_IDS
        }
      },
      description: {
        type: Type.STRING,
        description: 'Concise 1-2 sentence summary of the specific services provided to veterans.'
      },
      address: {
        type: Type.STRING,
        description: 'Street address or PO Box (exclude city, state, zip). Leave empty if not listed.'
      },
      city: {
        type: Type.STRING,
        description: 'New Hampshire city or town name (e.g., "Thornton", "Manchester", "Concord").'
      },
      zip: {
        type: Type.STRING,
        description: '5-digit ZIP code (e.g., "03285"). If 4-digit NH zip is found without leading zero, prepend "0".'
      },
      is_statewide: {
        type: Type.BOOLEAN,
        description: 'True if the organization serves the entire state of NH rather than just one local area.'
      },
      phone: {
        type: Type.STRING,
        description: 'Primary phone number formatted as (XXX) XXX-XXXX.'
      },
      email: {
        type: Type.STRING,
        description: 'Contact email address if available.'
      },
      website: {
        type: Type.STRING,
        description: 'Official website URL if listed on the document.'
      }
    },
    required: ['name', 'categories', 'description', 'city', 'zip', 'is_statewide']
  }
};

/**
 * Helper: Slugify organization name + city into a clean unique ID
 */
function createSlug(name, city) {
  const base = `${name}-${city || 'nh'}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return base;
}

/**
 * Helper: Match ZIP or City against nh_lookup_schema.json
 */
function resolveNHGeography(rawZip, rawCity, isStatewide) {
  // Normalize 5-digit NH zip (handles cases where Excel drops leading '0')
  let cleanZip = (rawZip || '').trim().replace(/[^0-9]/g, '');
  if (cleanZip.length === 4) cleanZip = '0' + cleanZip;
  if (cleanZip.length > 5) cleanZip = cleanZip.slice(0, 5);

  const cleanCity = (rawCity || '').trim().toLowerCase();

  // 1. Try exact ZIP match first
  let match = nhLookup.zip_lookup.find((item) => item.zip === cleanZip);

  // 2. Fallback: Try exact City name match if ZIP was missing on the flyer
  if (!match && cleanCity) {
    match = nhLookup.zip_lookup.find(
      (item) => item.city.toLowerCase() === cleanCity
    );
  }

  if (match) {
    return {
      city: match.city, // Uses canonical NH spelling
      zip: match.zip,
      county: match.county,
      region_id: match.region_id,
      ...(match.secondary_region_id ? { secondary_region_id: match.secondary_region_id } : {})
    };
  }

  // 3. Fallback for Statewide or Out-of-State National Hotlines with no local NH town
  return {
    city: rawCity || 'Statewide',
    zip: cleanZip || '00000',
    county: isStatewide ? 'All Counties' : 'Unknown',
    region_id: 'statewide'
  };
}

/**
 * Helper: Convert local file (PDF/PNG/JPG/TXT) into Gemini Part
 */
function fileToGenerativePart(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.txt': 'text/plain',
    '.csv': 'text/csv'
  };

  const mimeType = mimeTypes[ext] || 'application/octet-stream';
  const fileBuffer = fs.readFileSync(filePath);

  return {
    inlineData: {
      data: fileBuffer.toString('base64'),
      mimeType
    }
  };
}

/**
 * Main Extraction & Enrichment Function
 */
async function extractAndEnrich(filePath, sourceUrl) {
  console.log(`\n📄 Processing file: ${filePath}...`);

  const filePart = fileToGenerativePart(filePath);
  const todayISO = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const prompt = `
    You are a data extraction specialist for NHVetWiki, the New Hampshire Veteran Resource Directory.
    Extract all veteran service organizations, VSO posts, resources, or programs from the attached file.
    
    Rules:
    1. Map every organization to 1-3 of the 11 official taxonomy categories:
       ${nhLookup.taxonomy_categories.map(c => `- "${c.id}": ${c.description}`).join('\n       ')}
    2. Ensure New Hampshire ZIP codes retain their leading zero (e.g., "03285").
    3. Format phone numbers consistently as (XXX) XXX-XXXX.
    4. Never invent contact details; leave optional fields empty ("") if not present.
  `;

  // Call Gemini 2.5 Flash with Structured JSON Schema
  const response = await ai.models.generateContent({
    model: 'gemini-3.8-flash',
    contents: [filePart, prompt],
    config: {
      responseMimeType: 'application/json',
      responseSchema: extractionSchema,
      temperature: 0.1
    }
  });

  const rawExtractedList = JSON.parse(response.text);
  console.log(`✅ Gemini extracted ${rawExtractedList.length} organization(s). Enriching with NH Region/County lookup...`);

  // Enrich each extracted record with deterministic NH Geography & Verification Metadata
  const enrichedRecords = rawExtractedList.map((org) => {
    const geo = resolveNHGeography(org.zip, org.city, org.is_statewide);

    return {
      id: createSlug(org.name, geo.city),
      name: org.name,
      categories: org.categories,
      description: org.description,
      address: org.address || '',
      city: geo.city,
      zip: geo.zip,
      county: geo.county,
      region_id: geo.region_id,
      ...(geo.secondary_region_id ? { secondary_region_id: geo.secondary_region_id } : {}),
      is_statewide: Boolean(org.is_statewide || geo.region_id === 'statewide'),
      phone: org.phone || '',
      email: org.email || '',
      website: org.website || '',
      last_verified: todayISO,
      source_url: sourceUrl || org.website || `file://${path.basename(filePath)}`
    };
  });

  // Load existing database (if any) and merge/upsert by ID
  let existingDb = [];
  if (fs.existsSync(OUTPUT_DB_PATH)) {
    existingDb = JSON.parse(fs.readFileSync(OUTPUT_DB_PATH, 'utf-8'));
  }

  const dbMap = new Map(existingDb.map((item) => [item.id, item]));
  for (const record of enrichedRecords) {
    dbMap.set(record.id, record);
  }

  const updatedDb = Array.from(dbMap.values());
  fs.writeFileSync(OUTPUT_DB_PATH, JSON.stringify(updatedDb, null, 2), 'utf-8');

  console.log(`🎉 Saved! Database now contains ${updatedDb.length} total verified organizations in:`);
  console.log(`   👉 ${OUTPUT_DB_PATH}\n`);
  return enrichedRecords;
}

// --- CLI Runner ---
// Usage: node extract_and_enrich.js <path-to-file> [optional-source-url]
const [, , inputFilePath, inputSourceUrl] = process.argv;

if (!inputFilePath) {
  console.log(`
Usage:
  node extract_and_enrich.js <path-to-pdf-image-or-csv> [source-url]

Examples:
  node extract_and_enrich.js ./vso_roster_112.pdf "https://www.nh.gov/veterans"
  node extract_and_enrich.js ./flyer_photo.jpg "https://vfw4483.org"
  `);
  process.exit(0);
}

extractAndEnrich(inputFilePath, inputSourceUrl).catch((err) => {
  console.error('❌ Extraction failed:', err);
});