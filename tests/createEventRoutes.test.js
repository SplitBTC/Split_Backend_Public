const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');

const express = require('express');
const cookieParser = require('cookie-parser');

const landingPageRoutes = require('../routes/landingPageRoutes');

function createLandingApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(landingPageRoutes);
  return app;
}

async function withServer(run) {
  const app = createLandingApp();
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a valid address');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run({ baseUrl });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

async function maybeWithServer(t, run) {
  try {
    await withServer(run);
  } catch (error) {
    if (error && error.code === 'EPERM') {
      t.skip('Local socket binding is not permitted in this environment.');
      return;
    }

    throw error;
  }
}

async function withEventPassword(password, run) {
  const originalPassword = process.env.EVENT_PW;
  process.env.EVENT_PW = password;

  try {
    await run();
  } finally {
    if (originalPassword === undefined) {
      delete process.env.EVENT_PW;
    } else {
      process.env.EVENT_PW = originalPassword;
    }
  }
}

test('GET /createEvent renders password form without a valid session', async (t) => {
  await withEventPassword('correct-password', async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/createEvent`);
      const body = await response.text();

      assert.equal(response.status, 200);
      assert.match(body, /Enter password\./);
      assert.match(body, /action="\/createEvent\/login"/);
      assert.doesNotMatch(body, /Luma event URL/);
    });
  });
});

test('POST /createEvent/login rejects an invalid password', async (t) => {
  await withEventPassword('correct-password', async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/createEvent/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ eventPassword: 'wrong-password' }),
      });
      const body = await response.text();

      assert.equal(response.status, 401);
      assert.match(body, /Invalid password\./);
    });
  });
});

test('POST /createEvent/login creates a 45 minute event import session', async (t) => {
  await withEventPassword('correct-password', async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const loginResponse = await fetch(`${baseUrl}/createEvent/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ eventPassword: 'correct-password' }),
        redirect: 'manual',
      });
      const setCookie = loginResponse.headers.get('set-cookie') || '';
      const sessionCookie = setCookie.split(';')[0];

      assert.equal(loginResponse.status, 302);
      assert.equal(loginResponse.headers.get('location'), '/createEvent');
      assert.match(setCookie, /splitEventImportSession=/);
      assert.match(setCookie, /Max-Age=2700/);
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Lax/);

      const unlockedResponse = await fetch(`${baseUrl}/createEvent`, {
        headers: { Cookie: sessionCookie },
      });
      const unlockedBody = await unlockedResponse.text();

      assert.equal(unlockedResponse.status, 200);
      assert.match(unlockedBody, /Import Luma event\./);
      assert.match(unlockedBody, /Luma event URL/);
    });
  });
});

test('POST /createEvent requires an active event import session', async (t) => {
  await withEventPassword('correct-password', async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/createEvent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ eventUrl: 'https://lu.ma/sample123' }),
      });
      const body = await response.text();

      assert.equal(response.status, 401);
      assert.match(body, /Enter the event import password to continue\./);
      assert.match(body, /Enter password\./);
    });
  });
});
