const axios = require('axios');

const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const POSTAL_CODE_REGEX = /^\d{5}(?:-\d{4})?$/;

class AddressValidationError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AddressValidationError';
    this.code = options.code || 'invalid_address';
  }
}

function normalizeTrimmed(value) {
  return String(value || '').trim();
}

function normalizeState(value) {
  return normalizeTrimmed(value).toUpperCase();
}

function normalizePostalCode(value) {
  const digits = normalizeTrimmed(value).replace(/[^\d]/g, '');

  if (digits.length === 9) {
    return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  }

  if (digits.length === 5) {
    return digits;
  }

  return normalizeTrimmed(value);
}

function buildAddressQuery({ line1, line2, city, state, postalCode }) {
  return [
    normalizeTrimmed(line1),
    normalizeTrimmed(line2),
    `${normalizeTrimmed(city)}, ${normalizeState(state)} ${normalizePostalCode(postalCode)}`,
    'US',
  ]
    .filter(Boolean)
    .join(', ');
}

function findAddressComponent(components, type) {
  return (Array.isArray(components) ? components : []).find((component) => (
    Array.isArray(component?.types) && component.types.includes(type)
  )) || null;
}

function formatPostalCode(postalCodeComponent, postalSuffixComponent) {
  const postalCode = normalizeTrimmed(postalCodeComponent?.long_name || postalCodeComponent?.short_name);
  const postalSuffix = normalizeTrimmed(postalSuffixComponent?.long_name || postalSuffixComponent?.short_name);

  if (!postalCode) {
    return '';
  }

  return postalSuffix ? `${postalCode}-${postalSuffix}` : postalCode;
}

function postalCodesMatch(inputPostalCode, resolvedPostalCode) {
  const normalizedInput = normalizePostalCode(inputPostalCode);
  const normalizedResolved = normalizePostalCode(resolvedPostalCode);

  if (!normalizedInput || !normalizedResolved) {
    return false;
  }

  const [inputFive] = normalizedInput.split('-');
  const [resolvedFive] = normalizedResolved.split('-');

  if (normalizedInput.length > 5) {
    return normalizedInput === normalizedResolved;
  }

  return inputFive === resolvedFive;
}

function isSupportedResultType(result) {
  const types = new Set(Array.isArray(result?.types) ? result.types : []);

  return (
    types.has('street_address')
    || types.has('premise')
    || types.has('subpremise')
    || types.has('establishment')
  );
}

function isPostalCodeResultType(result) {
  const types = new Set(Array.isArray(result?.types) ? result.types : []);

  return types.has('postal_code');
}

function parseGeocodeResult(result, { submittedLine2 = '' } = {}) {
  const components = Array.isArray(result?.address_components) ? result.address_components : [];
  const streetNumber = normalizeTrimmed(findAddressComponent(components, 'street_number')?.long_name);
  const route = normalizeTrimmed(findAddressComponent(components, 'route')?.long_name);
  const city = normalizeTrimmed(
    findAddressComponent(components, 'locality')?.long_name
    || findAddressComponent(components, 'postal_town')?.long_name
    || findAddressComponent(components, 'sublocality')?.long_name
  );
  const state = normalizeState(findAddressComponent(components, 'administrative_area_level_1')?.short_name);
  const countryCode = normalizeTrimmed(findAddressComponent(components, 'country')?.short_name).toUpperCase();
  const postalCode = formatPostalCode(
    findAddressComponent(components, 'postal_code'),
    findAddressComponent(components, 'postal_code_suffix')
  );
  const latitude = Number(result?.geometry?.location?.lat);
  const longitude = Number(result?.geometry?.location?.lng);
  const placeId = normalizeTrimmed(result?.place_id);
  const formattedAddress = normalizeTrimmed(result?.formatted_address);

  if (
    !streetNumber
    || !route
    || !city
    || !state
    || !postalCode
    || !countryCode
    || !placeId
    || !formattedAddress
    || !Number.isFinite(latitude)
    || !Number.isFinite(longitude)
  ) {
    throw new AddressValidationError(
      'We could not confirm that address. Please enter a complete US street address.'
    );
  }

  return {
    formattedAddress,
    line1: `${streetNumber} ${route}`.trim(),
    line2: normalizeTrimmed(submittedLine2),
    city,
    state,
    postalCode: normalizePostalCode(postalCode),
    countryCode,
    placeId,
    latitude,
    longitude,
    geoPoint: {
      type: 'Point',
      coordinates: [longitude, latitude],
    },
  };
}

async function validateUsBusinessAddress(address, options = {}) {
  const line1 = normalizeTrimmed(address?.line1);
  const line2 = normalizeTrimmed(address?.line2);
  const city = normalizeTrimmed(address?.city);
  const state = normalizeState(address?.state);
  const postalCode = normalizePostalCode(address?.postalCode);

  if (!line1 || !city || !state || !postalCode) {
    throw new AddressValidationError('Enter a complete US business address.');
  }

  const apiKey = normalizeTrimmed(process.env.GOOGLE_MAPS_API_KEY);
  if (!apiKey) {
    throw new Error('Missing GOOGLE_MAPS_API_KEY');
  }

  const httpClient = options.httpClient || axios;
  const params = new URLSearchParams({
    address: buildAddressQuery({ line1, line2, city, state, postalCode }),
    components: 'country:US',
    key: apiKey,
  });

  let response;
  try {
    response = await httpClient.get(`${GOOGLE_GEOCODE_URL}?${params.toString()}`);
  } catch (error) {
    throw new Error(`Google geocoding request failed: ${error.message}`);
  }

  const data = response?.data || {};

  if (data.status !== 'OK' || !Array.isArray(data.results) || !data.results.length) {
    if (data.status === 'ZERO_RESULTS') {
      throw new AddressValidationError(
        'We could not find that address. Please enter a valid US business address.'
      );
    }

    throw new Error(`Google geocoding returned status ${data.status || 'UNKNOWN'}`);
  }

  const preferredResult = data.results.find((result) => (
    !result?.partial_match && isSupportedResultType(result)
  ));
  const result = preferredResult || data.results[0];

  if (!result || result.partial_match || !isSupportedResultType(result)) {
    throw new AddressValidationError(
      'We could not confirm that address. Please enter a complete US street address.'
    );
  }

  const normalizedAddress = parseGeocodeResult(result, { submittedLine2: line2 });

  if (normalizedAddress.countryCode !== 'US') {
    throw new AddressValidationError('Use a US business address for this coupon.');
  }

  if (normalizedAddress.state !== state) {
    throw new AddressValidationError('That address did not match the selected state.');
  }

  if (!postalCodesMatch(postalCode, normalizedAddress.postalCode)) {
    throw new AddressValidationError('That address did not match the ZIP code entered.');
  }

  return normalizedAddress;
}

function parsePostalCodeGeocodeResult(result) {
  const components = Array.isArray(result?.address_components) ? result.address_components : [];
  const city = normalizeTrimmed(
    findAddressComponent(components, 'locality')?.long_name
    || findAddressComponent(components, 'postal_town')?.long_name
    || findAddressComponent(components, 'sublocality')?.long_name
  );
  const state = normalizeState(findAddressComponent(components, 'administrative_area_level_1')?.short_name);
  const countryCode = normalizeTrimmed(findAddressComponent(components, 'country')?.short_name).toUpperCase();
  const postalCode = formatPostalCode(
    findAddressComponent(components, 'postal_code'),
    findAddressComponent(components, 'postal_code_suffix')
  );
  const latitude = Number(result?.geometry?.location?.lat);
  const longitude = Number(result?.geometry?.location?.lng);
  const formattedAddress = normalizeTrimmed(result?.formatted_address);

  if (
    !postalCode
    || !countryCode
    || !formattedAddress
    || !Number.isFinite(latitude)
    || !Number.isFinite(longitude)
  ) {
    throw new AddressValidationError('We could not resolve that ZIP code.', {
      code: 'invalid_postal_code',
    });
  }

  return {
    formattedAddress,
    postalCode: normalizePostalCode(postalCode),
    city,
    state,
    countryCode,
    latitude,
    longitude,
    geoPoint: {
      type: 'Point',
      coordinates: [longitude, latitude],
    },
  };
}

async function resolveUsPostalCodeSearchOrigin(postalCodeInput, options = {}) {
  const postalCode = normalizePostalCode(postalCodeInput);

  if (!POSTAL_CODE_REGEX.test(postalCode)) {
    throw new AddressValidationError('Enter a valid US ZIP code.', {
      code: 'invalid_postal_code',
    });
  }

  const apiKey = normalizeTrimmed(process.env.GOOGLE_MAPS_API_KEY);
  if (!apiKey) {
    throw new Error('Missing GOOGLE_MAPS_API_KEY');
  }

  const httpClient = options.httpClient || axios;
  const params = new URLSearchParams({
    address: postalCode,
    components: 'country:US',
    key: apiKey,
  });

  let response;
  try {
    response = await httpClient.get(`${GOOGLE_GEOCODE_URL}?${params.toString()}`);
  } catch (error) {
    throw new Error(`Google geocoding request failed: ${error.message}`);
  }

  const data = response?.data || {};

  if (data.status !== 'OK' || !Array.isArray(data.results) || !data.results.length) {
    if (data.status === 'ZERO_RESULTS') {
      throw new AddressValidationError('We could not find that ZIP code.', {
        code: 'invalid_postal_code',
      });
    }

    throw new Error(`Google geocoding returned status ${data.status || 'UNKNOWN'}`);
  }

  const preferredResult = data.results.find((result) => (
    !result?.partial_match && isPostalCodeResultType(result)
  ));
  const result = preferredResult || data.results[0];

  if (!result || result.partial_match) {
    throw new AddressValidationError('We could not resolve that ZIP code.', {
      code: 'invalid_postal_code',
    });
  }

  const resolvedOrigin = parsePostalCodeGeocodeResult(result);

  if (resolvedOrigin.countryCode !== 'US') {
    throw new AddressValidationError('Use a US ZIP code for coupon discovery.', {
      code: 'invalid_postal_code',
    });
  }

  if (!postalCodesMatch(postalCode, resolvedOrigin.postalCode)) {
    throw new AddressValidationError('That ZIP code could not be confirmed.', {
      code: 'invalid_postal_code',
    });
  }

  return resolvedOrigin;
}

module.exports = {
  AddressValidationError,
  resolveUsPostalCodeSearchOrigin,
  validateUsBusinessAddress,
};
