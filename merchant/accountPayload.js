function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeAddress(address) {
  const source = address && typeof address === 'object' ? address : {};
  const lat = Number(source.lat);
  const lng = Number(source.lng);

  return {
    formattedAddress: normalizeString(source.formattedAddress),
    googlePlaceId: normalizeString(source.googlePlaceId),
    street: normalizeString(source.street),
    city: normalizeString(source.city),
    state: normalizeString(source.state),
    postalCode: normalizeString(source.postalCode),
    lat,
    lng,
  };
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateAccountPayload(payload, { partial = false } = {}) {
  const errors = [];
  const normalized = {};

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'email')) {
    normalized.email = normalizeEmail(payload.email);
    if (!normalized.email) {
      errors.push('email is required');
    } else if (!validateEmail(normalized.email)) {
      errors.push('email format is invalid');
    }
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'businessName')) {
    normalized.businessName = normalizeString(payload.businessName);
    if (!normalized.businessName) {
      errors.push('businessName is required');
    } else if (normalized.businessName.length > 120) {
      errors.push('businessName is too long');
    }
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'phone')) {
    normalized.phone = normalizeString(payload.phone);
    if (!normalized.phone) {
      errors.push('phone is required');
    } else if (normalized.phone.length < 7 || normalized.phone.length > 32) {
      errors.push('phone format is invalid');
    }
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'address')) {
    normalized.address = normalizeAddress(payload.address);
    if (!normalized.address.formattedAddress) errors.push('address.formattedAddress is required');
    if (!normalized.address.googlePlaceId) errors.push('address.googlePlaceId is required');
    if (!normalized.address.street) errors.push('address.street is required');
    if (!normalized.address.city) errors.push('address.city is required');
    if (!normalized.address.state) errors.push('address.state is required');
    if (!normalized.address.postalCode) errors.push('address.postalCode is required');
    if (!Number.isFinite(normalized.address.lat) || normalized.address.lat < -90 || normalized.address.lat > 90) {
      errors.push('address.lat is invalid');
    }
    if (!Number.isFinite(normalized.address.lng) || normalized.address.lng < -180 || normalized.address.lng > 180) {
      errors.push('address.lng is invalid');
    }
  }

  return { errors, normalized };
}

function serializeMerchant(merchant) {
  return {
    merchantId: String(merchant._id),
    businessName: merchant.businessName,
    email: merchant.email,
    phone: merchant.phone,
    address: {
      formattedAddress: merchant.address?.formattedAddress,
      googlePlaceId: merchant.address?.googlePlaceId,
      street: merchant.address?.street,
      city: merchant.address?.city,
      state: merchant.address?.state,
      postalCode: merchant.address?.postalCode,
      lat: merchant.address?.lat,
      lng: merchant.address?.lng,
    },
    sparkWalletPubkey: merchant.sparkWalletPubkey,
    createdAt: merchant.createdAt,
    updatedAt: merchant.updatedAt,
  };
}

module.exports = {
  validateAccountPayload,
  serializeMerchant,
};
