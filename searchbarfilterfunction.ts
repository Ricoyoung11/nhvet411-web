import lookupData from './nh_lookup_schema.json';

export interface Organization {
  id: string;
  name: string;
  categories: string[]; // Array of taxonomy_category IDs (e.g., ["veterans-posts-community", "benefits-advocacy"])
  zip: string;
  city: string;
  county: string;
  region_id: string;
  is_statewide?: boolean;
}

export function filterOrganizations(
  organizations: Organization[],
  options: {
    searchQuery?: string;     // Can be ZIP ("03285"), City ("Thornton"), or Org Name
    selectedRegion?: string;  // e.g., "white-mountains"
    selectedCounty?: string;  // e.g., "Grafton"
    selectedCategory?: string;// e.g., "housing-shelter"
    includeStatewide?: boolean;
  }
) {
  const query = options.searchQuery?.trim().toLowerCase() || '';

  // 1. Check if the user typed a 5-digit NH ZIP code or exact NH City name
  const matchedZipEntry = lookupData.zip_lookup.find(
    (item) => item.zip === query || item.city.toLowerCase() === query
  );

  // If the user searched a specific town/ZIP (e.g. "03285"), we automatically know its Region and County!
  const targetRegion = options.selectedRegion || matchedZipEntry?.region_id;
  const targetCounty = options.selectedCounty || matchedZipEntry?.county;

  return organizations.filter((org) => {
    // A. Filter by 11 Taxonomy Categories
    if (options.selectedCategory && options.selectedCategory !== 'all') {
      if (!org.categories.includes(options.selectedCategory)) return false;
    }

    // B. Always allow Statewide organizations if includeStatewide is enabled
    if (options.includeStatewide && (org.is_statewide || org.region_id === 'statewide')) {
      return true;
    }

    // C. Filter by Region (matches primary or secondary gateway region)
    if (targetRegion && targetRegion !== 'statewide') {
      const orgZipMeta = lookupData.zip_lookup.find((z) => z.zip === org.zip);
      const matchesRegion =
        org.region_id === targetRegion ||
        orgZipMeta?.secondary_region_id === targetRegion;
      if (!matchesRegion) return false;
    }

    // D. Filter by County (if explicitly selected)
    if (options.selectedCounty && org.county.toLowerCase() !== targetCounty?.toLowerCase()) {
      return false;
    }

    // E. Text Search Fallback (if user typed an Organization Name or Keyword instead of a ZIP/City)
    if (query && !matchedZipEntry) {
      const matchesText =
        org.name.toLowerCase().includes(query) ||
        org.city.toLowerCase().includes(query) ||
        org.zip.includes(query);
      if (!matchesText) return false;
    }

    return true;
  });
}