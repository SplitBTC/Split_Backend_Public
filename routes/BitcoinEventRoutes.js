const express = require('express');

const BitcoinEvent = require('../models/BitcoinEvent');
const googleMapsAddressValidation = require('../services/googleMapsAddressValidation');
const {
  LumaEventImportError,
  importLumaEventFromUrl,
} = require('../services/lumaEventImporter');

const router = express.Router();

const BITCOIN_EVENTS_RADIUS_MILES = 25;

function requireAdminAuth(req, res, next) {
  if (req.cookies?.adminAuth === 'true') {
    return next();
  }

  return res.status(401).json({
    error: 'admin_auth_required',
    message: 'Admin authentication is required.',
  });
}

function parseCoordinate(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePostalCode(value) {
  const digits = String(value || '').trim().replace(/[^\d]/g, '');

  if (digits.length === 9) {
    return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  }

  if (digits.length === 5) {
    return digits;
  }

  return String(value || '').trim();
}

function toRadians(value) {
  return value * (Math.PI / 180);
}

function calculateDistanceMiles(origin, event) {
  const eventLatitude = Number(event?.latitude);
  const eventLongitude = Number(event?.longitude);

  if (
    !origin
    || !Number.isFinite(eventLatitude)
    || !Number.isFinite(eventLongitude)
  ) {
    return null;
  }

  const earthRadiusMiles = 3958.7613;
  const latitudeDelta = toRadians(eventLatitude - origin.latitude);
  const longitudeDelta = toRadians(eventLongitude - origin.longitude);
  const originLatitude = toRadians(origin.latitude);
  const destinationLatitude = toRadians(eventLatitude);

  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(originLatitude)
      * Math.cos(destinationLatitude)
      * Math.sin(longitudeDelta / 2) ** 2;

  const centralAngle = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  return Math.round((earthRadiusMiles * centralAngle) * 100) / 100;
}

function buildFutureBitcoinEventsQuery(now = new Date()) {
  return {
    country: 'US',
    $or: [
      { endsAt: { $gt: now } },
      {
        endsAt: null,
        startsAt: { $gt: now },
      },
    ],
  };
}

async function resolveSearchOrigin(req) {
  const latitude = parseCoordinate(req.query.latitude ?? req.query.lat);
  const longitude = parseCoordinate(req.query.longitude ?? req.query.lng);
  const postalCode = normalizePostalCode(req.query.postalCode ?? req.query.zip);

  if (latitude !== null || longitude !== null) {
    if (latitude === null || longitude === null) {
      return {
        error: {
          status: 400,
          body: { error: 'latitude and longitude must be provided together' },
        },
      };
    }

    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return {
        error: {
          status: 400,
          body: { error: 'latitude or longitude is out of range' },
        },
      };
    }

    return {
      searchOrigin: {
        source: 'device',
        latitude,
        longitude,
        postalCode: null,
        formattedAddress: null,
      },
    };
  }

  if (!postalCode) {
    return { searchOrigin: null };
  }

  try {
    const resolvedOrigin = await googleMapsAddressValidation.resolveUsPostalCodeSearchOrigin(postalCode);
    return {
      searchOrigin: {
        source: 'postalCode',
        latitude: resolvedOrigin.latitude,
        longitude: resolvedOrigin.longitude,
        postalCode: resolvedOrigin.postalCode,
        formattedAddress: resolvedOrigin.formattedAddress,
      },
    };
  } catch (error) {
    if (error instanceof googleMapsAddressValidation.AddressValidationError) {
      return {
        error: {
          status: 400,
          body: { error: error.message },
        },
      };
    }

    console.error('Error resolving Bitcoin events ZIP code search origin:', error);
    return {
      error: {
        status: 500,
        body: { error: 'Unable to resolve ZIP code right now' },
      },
    };
  }
}

function serializeBitcoinEvent(event, options = {}) {
  const distanceMiles = options.distanceMiles ?? null;

  return {
    id: String(event?._id || ''),
    source: event.source,
    sourceUrl: event.sourceUrl,
    externalEventId: event.externalEventId,
    title: event.title,
    description: event.description,
    coverImageUrl: event.coverImageUrl,
    hostName: event.hostName,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timezone: event.timezone,
    venueName: event.venueName,
    address: event.address,
    city: event.city,
    region: event.region,
    postalCode: event.postalCode,
    country: event.country,
    latitude: event.latitude,
    longitude: event.longitude,
    distanceMiles,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

router.get('/v1/bitcoin-events', async (req, res) => {
  try {
    const { searchOrigin, error } = await resolveSearchOrigin(req);
    if (error) {
      return res.status(error.status).json(error.body);
    }

    const events = await BitcoinEvent.find(buildFutureBitcoinEventsQuery())
      .sort({ startsAt: 1, _id: 1 })
      .lean();
    const nearbyEvents = [];
    const moreEvents = [];

    events.forEach((event) => {
      const distanceMiles = calculateDistanceMiles(searchOrigin, event);
      const serializedEvent = serializeBitcoinEvent(event, { distanceMiles });

      if (
        searchOrigin
        && distanceMiles !== null
        && distanceMiles <= BITCOIN_EVENTS_RADIUS_MILES
      ) {
        nearbyEvents.push(serializedEvent);
        return;
      }

      moreEvents.push(serializedEvent);
    });

    return res.status(200).json({
      nearbyEvents,
      moreEvents,
      searchOrigin,
      radiusMiles: BITCOIN_EVENTS_RADIUS_MILES,
    });
  } catch (error) {
    console.error('Error fetching Bitcoin events:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/addBitcoinEvent', requireAdminAuth, async (req, res) => {
  const eventUrl = req.body?.eventUrl || req.body?.eventURL || req.body?.url;

  try {
    const { created, event } = await importLumaEventFromUrl(eventUrl);

    return res.status(created ? 201 : 200).json({
      created,
      event: serializeBitcoinEvent(event),
    });
  } catch (error) {
    if (error instanceof LumaEventImportError) {
      return res.status(error.status).json({
        error: error.code,
        message: error.message,
        details: error.details,
      });
    }

    console.error('Bitcoin event import error:', error);
    return res.status(500).json({
      error: 'bitcoin_event_import_failed',
      message: 'Could not import Bitcoin event.',
    });
  }
});

module.exports = router;
