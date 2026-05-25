const axios = require('axios');

const BitcoinEvent = require('../models/BitcoinEvent');

const LUMA_FETCH_TIMEOUT_MS = 10000;
const LUMA_ERROR_BODY_SNIPPET_LENGTH = 500;
const BITCOIN_EVENT_DESCRIPTION_MAX_LENGTH =
  BitcoinEvent.schema.path('description').options.maxlength;
const TRUNCATED_DESCRIPTION_SUFFIX = '...';
const POSTAL_CODE_REGEX = /\b\d{5}(?:-\d{4})?\b/;

const US_STATE_OPTIONS = Object.freeze([
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
  { code: 'DC', name: 'District of Columbia' },
]);

const US_STATE_CODES = new Set(US_STATE_OPTIONS.map((state) => state.code));
const US_REGION_TO_CODE = new Map(
  US_STATE_OPTIONS.flatMap((state) => [
    [state.code.toLowerCase(), state.code],
    [state.name.toLowerCase(), state.code],
  ])
);
const US_STATE_CODE_REGEX = new RegExp(`\\b(${Array.from(US_STATE_CODES).join('|')})\\b`, 'i');
const US_COORDINATE_BOUNDS = Object.freeze([
  {
    minLatitude: 24.396308,
    maxLatitude: 49.384358,
    minLongitude: -124.848974,
    maxLongitude: -66.885444,
  },
  {
    minLatitude: 18.910361,
    maxLatitude: 22.235,
    minLongitude: -160.2471,
    maxLongitude: -154.8066,
  },
  {
    minLatitude: 51.214183,
    maxLatitude: 71.365162,
    minLongitude: -179.148909,
    maxLongitude: -129.9795,
  },
]);

class LumaEventImportError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'LumaEventImportError';
    this.code = options.code || 'luma_import_failed';
    this.status = options.status || 422;
    this.details = options.details || null;
  }
}

function buildLumaFetchErrorDetails(error) {
  const response = error?.response;
  const responseHeaders = response?.headers || {};
  let responseBodySnippet = null;

  if (response?.data) {
    const body = typeof response.data === 'string'
      ? response.data
      : JSON.stringify(response.data);
    responseBodySnippet = body.slice(0, LUMA_ERROR_BODY_SNIPPET_LENGTH);
  }

  return {
    upstreamStatus: response?.status || null,
    upstreamStatusText: response?.statusText || null,
    axiosCode: error?.code || null,
    retryAfter: responseHeaders['retry-after'] || null,
    contentType: responseHeaders['content-type'] || null,
    responseBodySnippet,
  };
}

function normalizeTrimmed(value) {
  return String(value || '').trim();
}

function truncateText(value, maxLength) {
  const normalized = normalizeTrimmed(value);

  if (normalized.length <= maxLength) {
    return normalized;
  }

  if (maxLength <= TRUNCATED_DESCRIPTION_SUFFIX.length) {
    return normalized.slice(0, maxLength);
  }

  return `${normalized
    .slice(0, maxLength - TRUNCATED_DESCRIPTION_SUFFIX.length)
    .trimEnd()}${TRUNCATED_DESCRIPTION_SUFFIX}`;
}

function normalizeLumaEventUrl(value) {
  const rawValue = normalizeTrimmed(value);
  if (!rawValue) {
    throw new LumaEventImportError('eventUrl is required.', {
      code: 'invalid_luma_url',
      status: 400,
    });
  }

  const urlInput = /^https?:\/\//i.test(rawValue)
    ? rawValue
    : `https://${rawValue.replace(/^\/+/, '')}`;

  let parsedUrl;
  try {
    parsedUrl = new URL(urlInput);
  } catch (_error) {
    throw new LumaEventImportError('Enter a valid Luma event URL.', {
      code: 'invalid_luma_url',
      status: 400,
    });
  }

  const hostname = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
  if (hostname !== 'luma.com' && hostname !== 'lu.ma') {
    throw new LumaEventImportError('Enter a valid Luma event URL.', {
      code: 'invalid_luma_url',
      status: 400,
    });
  }

  const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
  if (pathSegments.length !== 1 || !/^[a-z0-9][a-z0-9_-]*$/i.test(pathSegments[0])) {
    throw new LumaEventImportError('Enter a valid Luma event URL.', {
      code: 'invalid_luma_url',
      status: 400,
    });
  }

  return `https://luma.com/${pathSegments[0]}`;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function extractNextData(html) {
  const match = String(html || '').match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i
  );

  return match ? parseJson(match[1]) : null;
}

function extractJsonLd(html) {
  const matches = String(html || '').matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
  );

  for (const match of matches) {
    const parsed = parseJson(match[1]);
    if (parsed?.['@type'] === 'Event') {
      return parsed;
    }
  }

  return null;
}

function extractCanonicalUrl(html, fallbackUrl) {
  const canonicalMatch = String(html || '').match(
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i
  ) || String(html || '').match(
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i
  );

  if (!canonicalMatch) {
    return fallbackUrl;
  }

  try {
    return normalizeLumaEventUrl(canonicalMatch[1]);
  } catch (_error) {
    return fallbackUrl;
  }
}

function extractLumaEventId(html) {
  const match = String(html || '').match(/luma:\/\/event\/(evt-[a-z0-9]+)/i);
  return match ? match[1] : '';
}

function normalizeCountryCode(value) {
  const normalized = normalizeTrimmed(value).toUpperCase();

  if (
    normalized === 'US'
    || normalized === 'USA'
    || normalized === 'UNITED STATES'
    || normalized === 'UNITED STATES OF AMERICA'
  ) {
    return 'US';
  }

  return normalized;
}

function normalizeUsRegion(value) {
  const normalized = normalizeTrimmed(value);
  if (!normalized) {
    return '';
  }

  const upper = normalized.toUpperCase();
  if (US_STATE_CODES.has(upper)) {
    return upper;
  }

  return US_REGION_TO_CODE.get(normalized.toLowerCase()) || '';
}

function normalizeUsRegionFromLocationPart(value) {
  const directRegion = normalizeUsRegion(value);
  if (directRegion) {
    return directRegion;
  }

  const withoutPostalOrCountry = normalizeTrimmed(value)
    .replace(POSTAL_CODE_REGEX, '')
    .replace(/\b(?:US|USA|United States(?: of America)?)\b/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cleanedRegion = normalizeUsRegion(withoutPostalOrCountry);
  if (cleanedRegion) {
    return cleanedRegion;
  }

  const stateCodeMatch = withoutPostalOrCountry.toUpperCase().match(US_STATE_CODE_REGEX);
  return stateCodeMatch ? stateCodeMatch[1].toUpperCase() : '';
}

function inferUsRegionFromLocationText(...values) {
  for (const value of values) {
    const normalized = normalizeTrimmed(value);
    if (!normalized) {
      continue;
    }

    const directRegion = normalizeUsRegion(normalized);
    if (directRegion) {
      return directRegion;
    }

    const parts = normalized.split(',').map((part) => part.trim()).filter(Boolean);
    const candidates = parts.length > 1 ? parts.slice(1) : parts;
    for (const candidate of candidates) {
      const region = normalizeUsRegionFromLocationPart(candidate);
      if (region) {
        return region;
      }
    }
  }

  return '';
}

function inferCityFromLocationText(...values) {
  for (const value of values) {
    const parts = normalizeTrimmed(value).split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length > 1) {
      return parts[0];
    }
  }

  return '';
}

function coordinatesAreInUnitedStates(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return false;
  }

  return US_COORDINATE_BOUNDS.some((bounds) => (
    latitude >= bounds.minLatitude
    && latitude <= bounds.maxLatitude
    && longitude >= bounds.minLongitude
    && longitude <= bounds.maxLongitude
  ));
}

function getJsonLdAddress(jsonLd) {
  const address = jsonLd?.location?.address;
  return address && typeof address === 'object' && !Array.isArray(address) ? address : {};
}

function getJsonLdCountry(address) {
  const country = address?.addressCountry;
  return typeof country === 'string' ? country : country?.name;
}

function resolveCountryCode(explicitCountry, { region, latitude, longitude }) {
  const country = normalizeCountryCode(explicitCountry);
  if (country) {
    return country;
  }

  return region && coordinatesAreInUnitedStates(latitude, longitude) ? 'US' : '';
}

function parseFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePostalCode(value) {
  const match = normalizeTrimmed(value).match(POSTAL_CODE_REGEX);
  return match ? match[0] : '';
}

function collectDescriptionText(node, output) {
  if (!node) {
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((entry) => collectDescriptionText(entry, output));
    return;
  }

  if (node.type === 'text' && typeof node.text === 'string') {
    output.push(node.text);
  }

  if (node.type === 'hard_break') {
    output.push('\n');
  }

  if (Array.isArray(node.content)) {
    collectDescriptionText(node.content, output);
  }

  if (node.type === 'paragraph') {
    output.push('\n\n');
  }
}

function extractDescriptionFromMirror(descriptionMirror) {
  const output = [];
  collectDescriptionText(descriptionMirror, output);

  return output
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getJsonLdOrganizerName(jsonLd) {
  const organizer = jsonLd?.organizer;
  const organizers = Array.isArray(organizer) ? organizer : [organizer];

  return organizers
    .map((entry) => normalizeTrimmed(entry?.name))
    .filter(Boolean)
    .join(' & ');
}

function mapNextDataToEventFields(nextData, jsonLd, sourceUrl, html) {
  const data = nextData?.props?.pageProps?.initialData?.data || {};
  const event = data.event || {};
  const geoAddressInfo = event.geo_address_info || {};
  const coordinate = event.coordinate || {};
  const jsonLdLocation = jsonLd?.location || {};
  const jsonLdAddress = getJsonLdAddress(jsonLd);
  const hosts = Array.isArray(data.hosts) ? data.hosts : [];
  const hostName = hosts
    .map((host) => normalizeTrimmed(host?.name))
    .filter(Boolean)
    .join(' & ');
  const latitude = parseFiniteNumber(coordinate.latitude || jsonLdLocation.geo?.latitude);
  const longitude = parseFiniteNumber(coordinate.longitude || jsonLdLocation.geo?.longitude);
  const city = normalizeTrimmed(geoAddressInfo.city || jsonLdAddress.addressLocality)
    || inferCityFromLocationText(geoAddressInfo.city_state, jsonLdLocation.name);
  const region = normalizeUsRegion(geoAddressInfo.region || jsonLdAddress.addressRegion)
    || inferUsRegionFromLocationText(geoAddressInfo.city_state, jsonLdLocation.name);
  const country = resolveCountryCode(
    geoAddressInfo.country_code || geoAddressInfo.country || getJsonLdCountry(jsonLdAddress),
    { region, latitude, longitude }
  );

  return {
    source: 'luma',
    sourceUrl,
    externalEventId: normalizeTrimmed(event.api_id || extractLumaEventId(html)),
    title: normalizeTrimmed(event.name || jsonLd?.name),
    description: extractDescriptionFromMirror(data.description_mirror)
      || normalizeTrimmed(jsonLd?.description),
    coverImageUrl: normalizeTrimmed(event.cover_url || jsonLd?.image?.[0]),
    hostName: hostName || getJsonLdOrganizerName(jsonLd),
    startsAt: event.start_at || jsonLd?.startDate || null,
    endsAt: event.end_at || jsonLd?.endDate || null,
    timezone: normalizeTrimmed(event.timezone),
    venueName: normalizeTrimmed(geoAddressInfo.address || jsonLdLocation.name),
    address: normalizeTrimmed(geoAddressInfo.full_address || geoAddressInfo.short_address),
    city,
    region,
    postalCode: parsePostalCode(geoAddressInfo.full_address || geoAddressInfo.short_address),
    country,
    latitude,
    longitude,
    locationType: normalizeTrimmed(event.location_type),
  };
}

function hasNextEventData(nextData) {
  return Boolean(nextData?.props?.pageProps?.initialData?.data?.event);
}

function mapJsonLdToEventFields(jsonLd, sourceUrl, html) {
  const location = jsonLd?.location || {};
  const address = getJsonLdAddress(jsonLd);
  const latitude = parseFiniteNumber(location.geo?.latitude || location.latitude);
  const longitude = parseFiniteNumber(location.geo?.longitude || location.longitude);
  const city = normalizeTrimmed(address.addressLocality)
    || inferCityFromLocationText(location.name);
  const region = normalizeUsRegion(address.addressRegion)
    || inferUsRegionFromLocationText(location.name);
  const country = resolveCountryCode(getJsonLdCountry(address), {
    region,
    latitude,
    longitude,
  });

  return {
    source: 'luma',
    sourceUrl,
    externalEventId: extractLumaEventId(html),
    title: normalizeTrimmed(jsonLd?.name),
    description: normalizeTrimmed(jsonLd?.description),
    coverImageUrl: normalizeTrimmed(jsonLd?.image?.[0]),
    hostName: getJsonLdOrganizerName(jsonLd),
    startsAt: jsonLd?.startDate || null,
    endsAt: jsonLd?.endDate || null,
    timezone: '',
    venueName: normalizeTrimmed(location.name),
    address: normalizeTrimmed(address.streetAddress),
    city,
    region,
    postalCode: parsePostalCode(address.streetAddress),
    country,
    latitude,
    longitude,
    locationType: jsonLd?.eventAttendanceMode === 'https://schema.org/OfflineEventAttendanceMode'
      ? 'offline'
      : '',
  };
}

function validateImportedFields(fields) {
  if (fields.locationType && fields.locationType !== 'offline') {
    throw new LumaEventImportError('Only in-person Luma events are supported.', {
      code: 'unsupported_event_location',
      status: 422,
    });
  }

  if (fields.country !== 'US') {
    throw new LumaEventImportError('Only US Luma events are supported.', {
      code: 'unsupported_event_location',
      status: 422,
    });
  }

  const startsAt = fields.startsAt ? new Date(fields.startsAt) : null;
  const endsAt = fields.endsAt ? new Date(fields.endsAt) : null;
  const missingFields = [];

  if (!fields.externalEventId) missingFields.push('externalEventId');
  if (!fields.title) missingFields.push('title');
  if (!startsAt || Number.isNaN(startsAt.getTime())) missingFields.push('startsAt');
  if (!fields.city) missingFields.push('city');
  if (!fields.region) missingFields.push('region');
  if (!Number.isFinite(fields.latitude)) missingFields.push('latitude');
  if (!Number.isFinite(fields.longitude)) missingFields.push('longitude');

  if (missingFields.length > 0) {
    throw new LumaEventImportError('Luma event is missing required data.', {
      code: 'missing_required_event_data',
      status: 422,
      details: { missingFields },
    });
  }

  return {
    source: fields.source,
    sourceUrl: fields.sourceUrl,
    externalEventId: fields.externalEventId,
    title: fields.title,
    description: truncateText(fields.description, BITCOIN_EVENT_DESCRIPTION_MAX_LENGTH),
    coverImageUrl: fields.coverImageUrl,
    hostName: fields.hostName,
    startsAt,
    endsAt: endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt : null,
    timezone: fields.timezone,
    venueName: fields.venueName,
    address: fields.address,
    city: fields.city,
    region: fields.region,
    postalCode: fields.postalCode,
    country: fields.country,
    latitude: fields.latitude,
    longitude: fields.longitude,
  };
}

function parseLumaEventHtml(html, requestedUrl) {
  const fallbackUrl = normalizeLumaEventUrl(requestedUrl);
  const sourceUrl = extractCanonicalUrl(html, fallbackUrl);
  const nextData = extractNextData(html);
  const jsonLd = extractJsonLd(html);
  const hasNextEvent = hasNextEventData(nextData);

  if (!hasNextEvent && !jsonLd) {
    throw new LumaEventImportError('Could not find Luma event data on that page.', {
      code: 'luma_event_not_found',
      status: 404,
    });
  }

  const fields = hasNextEvent
    ? mapNextDataToEventFields(nextData, jsonLd, sourceUrl, html)
    : mapJsonLdToEventFields(jsonLd, sourceUrl, html);

  return validateImportedFields(fields);
}

async function fetchLumaEventHtml(eventUrl, options = {}) {
  const httpClient = options.httpClient || axios;

  try {
    const response = await httpClient.get(eventUrl, {
      timeout: LUMA_FETCH_TIMEOUT_MS,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'SplitBitcoinEventsImporter/1.0',
      },
    });

    return response?.data;
  } catch (error) {
    const details = buildLumaFetchErrorDetails(error);

    if (error?.response?.status === 404) {
      throw new LumaEventImportError('Luma event was not found.', {
        code: 'luma_event_not_found',
        status: 404,
        details,
      });
    }

    throw new LumaEventImportError('Could not fetch Luma event data.', {
      code: 'luma_fetch_failed',
      status: 502,
      details,
    });
  }
}

async function saveBitcoinEvent(eventFields) {
  const existingEvent = await BitcoinEvent.findOne({
    $or: [
      { source: eventFields.source, externalEventId: eventFields.externalEventId },
      { sourceUrl: eventFields.sourceUrl },
    ],
  });

  if (existingEvent) {
    Object.assign(existingEvent, eventFields);
    const event = await existingEvent.save();
    return { created: false, event };
  }

  const event = await BitcoinEvent.create(eventFields);
  return { created: true, event };
}

async function importLumaEventFromUrl(rawEventUrl, options = {}) {
  const eventUrl = normalizeLumaEventUrl(rawEventUrl);
  const html = await fetchLumaEventHtml(eventUrl, options);
  const eventFields = parseLumaEventHtml(html, eventUrl);

  return saveBitcoinEvent(eventFields);
}

module.exports = {
  LumaEventImportError,
  BITCOIN_EVENT_DESCRIPTION_MAX_LENGTH,
  importLumaEventFromUrl,
  normalizeLumaEventUrl,
  parseLumaEventHtml,
};
