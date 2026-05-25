const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BITCOIN_EVENT_DESCRIPTION_MAX_LENGTH,
  LumaEventImportError,
  importLumaEventFromUrl,
  normalizeLumaEventUrl,
  parseLumaEventHtml,
} = require('../services/lumaEventImporter');

function buildLumaEventHtml({ nextData, jsonLd, canonicalUrl = 'https://luma.com/sample123' }) {
  return [
    '<!DOCTYPE html><html><head>',
    `<link rel="canonical" href="${canonicalUrl}">`,
    '<script type="application/ld+json">',
    JSON.stringify(jsonLd),
    '</script>',
    '</head><body>',
    '<script id="__NEXT_DATA__" type="application/json">',
    JSON.stringify(nextData),
    '</script>',
    '</body></html>',
  ].join('');
}

test('normalizeLumaEventUrl accepts lu.ma and strips query parameters', () => {
  assert.equal(
    normalizeLumaEventUrl('https://lu.ma/sample123?tk=abc'),
    'https://luma.com/sample123'
  );
});

test('parseLumaEventHtml maps Luma page data into BitcoinEvent fields', () => {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: 'Fallback Event Name',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: 'PubKey',
      address: {
        '@type': 'PostalAddress',
        addressCountry: { '@type': 'Country', name: 'United States' },
        addressLocality: 'New York',
        addressRegion: 'New York',
        streetAddress: 'PubKey',
      },
      geo: {
        '@type': 'GeoCoordinates',
        latitude: 40.7322184,
        longitude: -74.0000245,
      },
    },
  };
  const nextData = {
    props: {
      pageProps: {
        initialData: {
          data: {
            event: {
              api_id: 'evt-sample123',
              cover_url: 'https://images.lumacdn.com/event-covers/sample.png',
              start_at: '2026-05-01T22:00:00.000Z',
              end_at: '2026-05-02T00:00:00.000Z',
              timezone: 'America/New_York',
              location_type: 'offline',
              name: 'Bitcoin Meetup at PubKey',
              url: 'sample123',
              geo_address_info: {
                city: 'New York',
                region: 'New York',
                country_code: 'US',
                address: 'PubKey',
                full_address: 'PubKey, 85 Washington Pl, New York, NY 10011, USA',
              },
              coordinate: {
                latitude: 40.7322184,
                longitude: -74.0000245,
              },
            },
            hosts: [
              { name: 'PubKey', username: 'pubkey' },
              { name: 'BitDevs NYC', username: 'bitdevsnyc' },
            ],
            description_mirror: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Come talk Bitcoin.' }],
                },
              ],
            },
          },
        },
      },
    },
  };

  const parsed = parseLumaEventHtml(
    buildLumaEventHtml({ nextData, jsonLd }),
    'https://lu.ma/sample123?tk=abc'
  );

  assert.equal(parsed.source, 'luma');
  assert.equal(parsed.sourceUrl, 'https://luma.com/sample123');
  assert.equal(parsed.externalEventId, 'evt-sample123');
  assert.equal(parsed.title, 'Bitcoin Meetup at PubKey');
  assert.equal(parsed.description, 'Come talk Bitcoin.');
  assert.equal(parsed.coverImageUrl, 'https://images.lumacdn.com/event-covers/sample.png');
  assert.equal(parsed.hostName, 'PubKey & BitDevs NYC');
  assert.equal(parsed.startsAt.toISOString(), '2026-05-01T22:00:00.000Z');
  assert.equal(parsed.endsAt.toISOString(), '2026-05-02T00:00:00.000Z');
  assert.equal(parsed.timezone, 'America/New_York');
  assert.equal(parsed.venueName, 'PubKey');
  assert.equal(parsed.address, 'PubKey, 85 Washington Pl, New York, NY 10011, USA');
  assert.equal(parsed.city, 'New York');
  assert.equal(parsed.region, 'NY');
  assert.equal(parsed.postalCode, '10011');
  assert.equal(parsed.country, 'US');
  assert.equal(parsed.latitude, 40.7322184);
  assert.equal(parsed.longitude, -74.0000245);
});

test('parseLumaEventHtml accepts obfuscated US Luma city/state locations', () => {
  const html = buildLumaEventHtml({
    canonicalUrl: 'https://luma.com/f4etuisu',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Event',
      name: 'Bitcoin 2026 Unofficial Mixer',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
      location: {
        '@type': 'Place',
        name: 'Las Vegas, Nevada',
        address: 'Register to See Address',
        geo: {
          '@type': 'GeoCoordinates',
          latitude: 36.11,
          longitude: -115.175,
        },
        latitude: 36.11,
        longitude: -115.175,
      },
      image: ['https://images.lumacdn.com/event-covers/vegas.png'],
      description: 'An unofficial gathering during Bitcoin Conference 2026.',
      startDate: '2026-04-27T18:00:00.000-07:00',
      endDate: '2026-04-27T21:00:00.000-07:00',
      organizer: [
        { '@type': 'Organization', name: 'Christopher Carew' },
        { '@type': 'Organization', name: 'Keren Camou' },
      ],
    },
    nextData: {
      props: {
        pageProps: {
          initialData: {
            data: {
              event: {
                api_id: 'evt-NtQ3iLrcZvzTNc1',
                cover_url: 'https://images.lumacdn.com/event-covers/vegas.png',
                end_at: '2026-04-28T04:00:00.000Z',
                location_type: 'offline',
                name: 'Bitcoin 2026 Unofficial Mixer',
                start_at: '2026-04-28T01:00:00.000Z',
                timezone: 'America/Los_Angeles',
                geo_address_info: {
                  mode: 'obfuscated',
                  city: 'Las Vegas',
                  city_state: 'Las Vegas, Nevada',
                },
                coordinate: {
                  latitude: 36.11,
                  longitude: -115.175,
                },
              },
              hosts: [
                { name: 'Christopher Carew' },
                { name: 'Keren Camou' },
              ],
            },
          },
        },
      },
    },
  });

  const parsed = parseLumaEventHtml(html, 'https://luma.com/f4etuisu');

  assert.equal(parsed.sourceUrl, 'https://luma.com/f4etuisu');
  assert.equal(parsed.externalEventId, 'evt-NtQ3iLrcZvzTNc1');
  assert.equal(parsed.title, 'Bitcoin 2026 Unofficial Mixer');
  assert.equal(parsed.venueName, 'Las Vegas, Nevada');
  assert.equal(parsed.address, '');
  assert.equal(parsed.city, 'Las Vegas');
  assert.equal(parsed.region, 'NV');
  assert.equal(parsed.country, 'US');
  assert.equal(parsed.latitude, 36.11);
  assert.equal(parsed.longitude, -115.175);
});

test('parseLumaEventHtml truncates long Luma descriptions before save', () => {
  const longDescription = 'A'.repeat(BITCOIN_EVENT_DESCRIPTION_MAX_LENGTH + 200);
  const html = buildLumaEventHtml({
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Event',
      name: 'Long Bitcoin Meetup',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
      location: {
        '@type': 'Place',
        name: 'PubKey',
        address: {
          '@type': 'PostalAddress',
          addressCountry: { '@type': 'Country', name: 'United States' },
          addressLocality: 'New York',
          addressRegion: 'NY',
          streetAddress: 'PubKey',
        },
        geo: {
          '@type': 'GeoCoordinates',
          latitude: 40.7322184,
          longitude: -74.0000245,
        },
      },
    },
    nextData: {
      props: {
        pageProps: {
          initialData: {
            data: {
              event: {
                api_id: 'evt-long-description',
                start_at: '2026-05-01T22:00:00.000Z',
                location_type: 'offline',
                name: 'Long Bitcoin Meetup',
                geo_address_info: {
                  city: 'New York',
                  region: 'NY',
                  country_code: 'US',
                  address: 'PubKey',
                  full_address: 'PubKey, 85 Washington Pl, New York, NY 10011, USA',
                },
                coordinate: {
                  latitude: 40.7322184,
                  longitude: -74.0000245,
                },
              },
              hosts: [{ name: 'PubKey' }],
              description_mirror: {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: longDescription }],
                  },
                ],
              },
            },
          },
        },
      },
    },
  });

  const parsed = parseLumaEventHtml(html, 'https://luma.com/long-description');

  assert.equal(parsed.description.length, BITCOIN_EVENT_DESCRIPTION_MAX_LENGTH);
  assert.match(parsed.description, /\.\.\.$/);
});

test('parseLumaEventHtml rejects non-US Luma events', () => {
  const html = buildLumaEventHtml({
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Event',
      name: 'London Bitcoin Meetup',
      startDate: '2026-05-01T19:00:00.000Z',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
      location: {
        '@type': 'Place',
        name: 'Venue',
        address: {
          '@type': 'PostalAddress',
          addressCountry: { '@type': 'Country', name: 'United Kingdom' },
          addressLocality: 'London',
          addressRegion: 'England',
          streetAddress: 'Venue',
        },
        geo: {
          '@type': 'GeoCoordinates',
          latitude: 51.5,
          longitude: -0.12,
        },
      },
    },
    nextData: {
      props: {
        pageProps: {
          initialData: {
            data: {
              event: {
                api_id: 'evt-london',
                start_at: '2026-05-01T19:00:00.000Z',
                location_type: 'offline',
                name: 'London Bitcoin Meetup',
                geo_address_info: {
                  city: 'London',
                  region: 'England',
                  country_code: 'GB',
                  address: 'Venue',
                  full_address: 'Venue, London, UK',
                },
                coordinate: {
                  latitude: 51.5,
                  longitude: -0.12,
                },
              },
              hosts: [{ name: 'Host' }],
            },
          },
        },
      },
    },
  });

  assert.throws(
    () => parseLumaEventHtml(html, 'https://luma.com/london123'),
    (error) => error instanceof LumaEventImportError
      && error.code === 'unsupported_event_location'
  );
});

test('parseLumaEventHtml rejects Luma pages without event data', () => {
  const html = [
    '<!DOCTYPE html><html><head></head><body>',
    '<script id="__NEXT_DATA__" type="application/json">',
    JSON.stringify({
      props: {
        pageProps: {
          initialData: {
            kind: 'calendar',
            data: {},
          },
        },
      },
    }),
    '</script>',
    '</body></html>',
  ].join('');

  assert.throws(
    () => parseLumaEventHtml(html, 'https://luma.com/pubkey'),
    (error) => error instanceof LumaEventImportError
      && error.code === 'luma_event_not_found'
  );
});

test('importLumaEventFromUrl includes upstream Luma failure details', async () => {
  await assert.rejects(
    () => importLumaEventFromUrl('https://luma.com/rate-limited', {
      httpClient: {
        async get() {
          const error = new Error('Request failed with status code 429');
          error.code = 'ERR_BAD_REQUEST';
          error.response = {
            status: 429,
            statusText: 'Too Many Requests',
            headers: {
              'retry-after': '60',
              'content-type': 'text/html',
            },
            data: '<html><body>rate limit hit</body></html>',
          };
          throw error;
        },
      },
    }),
    (error) => {
      assert.ok(error instanceof LumaEventImportError);
      assert.equal(error.code, 'luma_fetch_failed');
      assert.equal(error.status, 502);
      assert.deepEqual(error.details, {
        upstreamStatus: 429,
        upstreamStatusText: 'Too Many Requests',
        axiosCode: 'ERR_BAD_REQUEST',
        retryAfter: '60',
        contentType: 'text/html',
        responseBodySnippet: '<html><body>rate limit hit</body></html>',
      });
      return true;
    }
  );
});
