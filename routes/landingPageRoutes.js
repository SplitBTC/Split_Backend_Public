require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const router = express.Router();
const Prospect = require('../models/Prospect')
const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const Admin = require('../models/Admin');
const Coupon = require('../models/Coupon');
const RewardSpendPayment = require("../models/RewardSpendPayment");
const PlatformAnalytics = require("../models/PlatformAnalytics");
const PlatformWallet = require("../models/PlatformWallet");
const s3Client = require('../integrations/r2');
const googleMapsAddressValidation = require('../services/googleMapsAddressValidation');
const {
  LumaEventImportError,
  importLumaEventFromUrl,
} = require('../services/lumaEventImporter');

const DEFAULT_DONATION_LIGHTNING_ADDRESS = 'donate@split-loyalty.com';
const DEFAULT_PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.splitloyalty.android&pcampaignid=web_share';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POSTAL_CODE_REGEX = /^\d{5}(?:-\d{4})?$/;
const COUPON_LOGO_MAX_BYTES = 5 * 1024 * 1024;
const EVENT_IMPORT_COOKIE_NAME = 'splitEventImportSession';
const EVENT_IMPORT_SESSION_MS = 45 * 60 * 1000;
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
const couponLogoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: COUPON_LOGO_MAX_BYTES,
    files: 1,
  },
});
const FOSS_PROJECTS = [
  {
    slug: 'split-ios',
    name: 'Split_iOS',
    title: 'The Split Rewards iOS wallet, published for transparency.',
    status: 'Open source',
    repoUrl: 'https://github.com/TeeVee06/Split_iOS',
    liveUrl: '/UserLanding',
    liveLabel: 'Visit Split',
    description:
      'The iOS client for Split, including self-custodial wallet flows, Lightning address management, messaging, rewards, and merchant discovery.',
    highlights: [
      'Uses public-safe backend configuration defaults in the open-source iOS snapshot.',
      'Includes the current messaging privacy and trust documentation.',
    ],
    focusTitle: 'Wallet UX, messaging, and Bitcoin spending.',
    focusText:
      'The current iOS release is focused on making Bitcoin spending easier: self-custodial wallet flows, payment coordination, messaging, and merchant-facing reward loops.',
  },
  {
    slug: 'split-nodejs',
    name: 'Split_NodeJS',
    title: 'The Split backend, published for transparency.',
    status: 'Open source',
    repoUrl: 'https://github.com/TeeVee06/Split_NodeJS',
    liveUrl: '/UserLanding',
    liveLabel: 'Visit Split',
    description:
      'The Node/Express backend that powers wallet-authenticated sessions, Lightning address flows, messaging, rewards, and app infrastructure.',
    highlights: [
      'Published for inspection and review.',
    ],
    focusTitle: 'Messaging trust, relay cleanup, and app infrastructure.',
    focusText:
      'The backend currently emphasizes trustworthy message handling, scheduled attachment cleanup, wallet-authenticated flows, and the infrastructure that supports Bitcoin spending in the app.',
  },
  {
    slug: 'split-bitcoin-tax-prep',
    name: 'split_bitcoin_tax_prep',
    title: 'Bitcoin tax prep for spenders, built in public.',
    status: 'Open source',
    repoUrl: 'https://github.com/TeeVee06/split_bitcoin_tax_prep',
    description:
      'A standalone Bitcoin tax prep workflow that parses supported CSV and PDF documents, helps users review owned wallets and outgoing sends, and generates a draft tax packet with supporting files.',
    highlights: [
      'No LLM is used for document extraction or tax calculations.',
      'The hosted Split backend no longer serves this workflow.',
      'Current parser coverage lives in the dedicated project repo.',
    ],
    focusTitle: 'Parser coverage, review flow, and trustworthy draft output.',
    focusText:
      'Bitcoin tax prep now lives in its own repository so this backend can stay focused on the Split app API and hosted Split pages.',
  },
];

async function buildDonationCard(platformWallet) {
  const lightningAddress = String(
    platformWallet?.lightningAddress || DEFAULT_DONATION_LIGHTNING_ADDRESS
  )
    .trim()
    .toLowerCase();

  return {
    lightningAddress,
    paymentUri: `lightning:${lightningAddress}`,
    qrCodeDataUrl: await QRCode.toDataURL(`lightning:${lightningAddress}`, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
    }),
  };
}

function emptyCouponFormValues() {
  return {
    businessName: '',
    contactEmail: '',
    dealDescription: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    postalCode: '',
  };
}

function normalizeCouponFormValues(body = {}) {
  return {
    businessName: String(body.businessName || '').trim(),
    contactEmail: String(body.contactEmail || '').trim().toLowerCase(),
    dealDescription: String(body.dealDescription || '').trim(),
    addressLine1: String(body.addressLine1 || '').trim(),
    addressLine2: String(body.addressLine2 || '').trim(),
    city: String(body.city || '').trim(),
    state: String(body.state || '').trim().toUpperCase(),
    postalCode: String(body.postalCode || '').trim(),
  };
}

function validateCouponFormValues(values) {
  const fieldErrors = {};

  if (!values.businessName) {
    fieldErrors.businessName = 'Business name is required.';
  } else if (values.businessName.length > 160) {
    fieldErrors.businessName = 'Business name is too long.';
  }

  if (!values.contactEmail) {
    fieldErrors.contactEmail = 'Contact email is required.';
  } else if (values.contactEmail.length > 320 || !EMAIL_REGEX.test(values.contactEmail)) {
    fieldErrors.contactEmail = 'Enter a valid contact email.';
  }

  if (!values.dealDescription) {
    fieldErrors.dealDescription = 'Coupon description is required.';
  } else if (values.dealDescription.length > 2000) {
    fieldErrors.dealDescription = 'Coupon description is too long.';
  }

  if (!values.addressLine1) {
    fieldErrors.addressLine1 = 'Address line 1 is required.';
  }

  if (values.addressLine2.length > 120) {
    fieldErrors.addressLine2 = 'Address line 2 is too long.';
  }

  if (!values.city) {
    fieldErrors.city = 'City is required.';
  } else if (values.city.length > 80) {
    fieldErrors.city = 'City is too long.';
  }

  if (!values.state) {
    fieldErrors.state = 'State is required.';
  } else if (!US_STATE_CODES.has(values.state)) {
    fieldErrors.state = 'Select a valid US state.';
  }

  if (!values.postalCode) {
    fieldErrors.postalCode = 'ZIP code is required.';
  } else if (!POSTAL_CODE_REGEX.test(values.postalCode)) {
    fieldErrors.postalCode = 'Enter a valid ZIP code.';
  }

  return fieldErrors;
}

function formatCouponUploadError(error) {
  if (!error) {
    return 'Unable to read the uploaded logo.';
  }

  if (error.code === 'LIMIT_FILE_SIZE') {
    return 'Logo must be 5 MB or smaller.';
  }

  if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
    return 'Upload exactly one logo image.';
  }

  return 'Unable to read the uploaded logo.';
}

async function uploadCouponLogo(file) {
  const objectKey = `merchant-coupons/logos/${crypto.randomUUID()}.png`;

  const processedBuffer = await sharp(file.buffer)
    .rotate()
    .resize(640, 640, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 0 },
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();

  await s3Client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: objectKey,
    Body: processedBuffer,
    ContentType: 'image/png',
    ACL: 'public-read',
  }));

  return {
    businessLogoUrl: `https://cdn.split-loyalty.com/${objectKey}`,
    businessLogoObjectKey: objectKey,
  };
}

async function deleteCouponLogo(objectKey) {
  if (!objectKey) {
    return;
  }

  try {
    await s3Client.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: objectKey,
    }));
  } catch (error) {
    console.warn('Failed to delete merchant coupon logo:', error.message);
  }
}

function renderCreateMerchantCouponPage(req, res, options = {}) {
  const values = {
    ...emptyCouponFormValues(),
    ...(options.values || {}),
  };

  return res.render('CreateMerchantCoupon', {
    values,
    fieldErrors: options.fieldErrors || {},
    formError: options.formError || null,
    submitted: options.submitted ?? String(req.query.submitted || '').trim() === '1',
    states: US_STATE_OPTIONS,
  });
}

function getEventImportPassword() {
  return String(process.env.EVENT_PW || '').trim();
}

function isSecureRequest(req) {
  return req.secure || req.get('x-forwarded-proto') === 'https';
}

function safeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signEventImportExpiry(expiresAt) {
  return crypto
    .createHmac('sha256', getEventImportPassword())
    .update(String(expiresAt))
    .digest('hex');
}

function createEventImportSessionToken() {
  const expiresAt = Date.now() + EVENT_IMPORT_SESSION_MS;
  return {
    expiresAt,
    token: `${expiresAt}.${signEventImportExpiry(expiresAt)}`,
  };
}

function verifyEventImportSessionToken(token) {
  if (!getEventImportPassword()) {
    return { valid: false, expiresAt: null };
  }

  const [expiresAtValue, signature] = String(token || '').split('.');
  const expiresAt = Number(expiresAtValue);

  if (!Number.isFinite(expiresAt) || !signature || expiresAt <= Date.now()) {
    return { valid: false, expiresAt: null };
  }

  const expectedSignature = signEventImportExpiry(expiresAt);
  return {
    valid: safeStringEqual(signature, expectedSignature),
    expiresAt,
  };
}

function setEventImportSessionCookie(req, res) {
  const { token } = createEventImportSessionToken();

  res.cookie(EVENT_IMPORT_COOKIE_NAME, token, {
    httpOnly: true,
    maxAge: EVENT_IMPORT_SESSION_MS,
    path: '/createEvent',
    sameSite: 'lax',
    secure: isSecureRequest(req),
  });
}

function clearEventImportSessionCookie(res) {
  res.clearCookie(EVENT_IMPORT_COOKIE_NAME, {
    path: '/createEvent',
  });
}

function getEventImportAuthState(req) {
  const configured = Boolean(getEventImportPassword());
  const session = verifyEventImportSessionToken(req.cookies?.[EVENT_IMPORT_COOKIE_NAME]);
  const remainingMinutes = session.valid
    ? Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 60000))
    : null;

  return {
    configured,
    isAuthenticated: configured && session.valid,
    remainingMinutes,
  };
}

function emptyCreateEventValues() {
  return {
    eventUrl: '',
  };
}

function renderCreateEventPage(req, res, options = {}) {
  const authState = getEventImportAuthState(req);
  const values = {
    ...emptyCreateEventValues(),
    ...(options.values || {}),
  };

  if (authState.configured && !authState.isAuthenticated && req.cookies?.[EVENT_IMPORT_COOKIE_NAME]) {
    clearEventImportSessionCookie(res);
  }

  return res.render('CreateEvent', {
    ...authState,
    values,
    authError: options.authError || null,
    formError: options.formError || null,
    importedEvent: options.importedEvent || null,
    created: options.created ?? null,
  });
}

function renderHomePage(res) {
  res.render('Home', {
    APP_STORE_URL: process.env.APP_STORE_URL,
    PLAY_STORE_URL: process.env.PLAY_STORE_URL || DEFAULT_PLAY_STORE_URL,
  });
}

router.get('/', (req, res) => {
  renderHomePage(res);
});

router.get('/Home', (req, res) => {
  renderHomePage(res);
});

router.get('/test', (req, res) => {
  res.redirect('/Home');
});

router.get('/UserLanding', async (req, res) => {
  try {
    // Current monthKey in UTC (YYYY-MM), aligned with reward ledger writes.
    const monthKey = new Date().toISOString().slice(0, 7);

    // Monthly totals from reward-eligible payment ledger rows.
    const [monthlyAgg] = await RewardSpendPayment.aggregate([
      { $match: { monthKey } },
      {
        $group: {
          _id: null,
          totalMerchantSpendCents: { $sum: "$usdAmountCents" },
          totalTransactions: { $sum: 1 },
        },
      },
    ]);

    // Lifetime totals + satsRewarded (single analytics doc)
    const platformAnalytics = await PlatformAnalytics.findOne({ _id: "platform" }).lean();

    // Current monthly reward pot source = platform wallet balance
    // (Assuming there's only one doc; if you use a fixed _id, swap findOne({ _id: "platform" }))
    const platformWallet = await PlatformWallet.findOne({}).lean();

    const stats = {
      monthKey,

      // Monthly reward-eligible payment ledger rows
      totalMerchantSpendMonthUsdCents: monthlyAgg?.totalMerchantSpendCents || 0,
      totalTransactionsMonth: monthlyAgg?.totalTransactions || 0,

      // Lifetime (PlatformAnalytics)
      lifetimeMerchantSpendUsdCents: platformAnalytics?.merchantVolume?.usdCents || 0,
      lifetimeTransactions: platformAnalytics?.merchantTransactions || 0,

      // Rewards
      currentMonthlyRewardPotSats: platformWallet?.balanceSats || 0,
      satsRewardedAllTime: platformAnalytics?.satsRewarded || 0,
    };
    const donationCard = await buildDonationCard(platformWallet);

    res.render('UserLanding', {
      APP_STORE_URL: process.env.APP_STORE_URL,
      PLAY_STORE_URL: process.env.PLAY_STORE_URL || DEFAULT_PLAY_STORE_URL,
      stats,
      donationCard,
    });
  } catch (err) {
    console.error('Error loading UserLanding:', err);
    const donationCard = await buildDonationCard(null);
    res.render('UserLanding', {
      APP_STORE_URL: process.env.APP_STORE_URL,
      PLAY_STORE_URL: process.env.PLAY_STORE_URL || DEFAULT_PLAY_STORE_URL,
      stats: {
        monthKey: null,
        totalMerchantSpendMonthUsdCents: 0,
        totalTransactionsMonth: 0,
        lifetimeMerchantSpendUsdCents: 0,
        lifetimeTransactions: 0,
        currentMonthlyRewardPotSats: 0,
        satsRewardedAllTime: 0,
      },
      spotlightPost: null,
      donationCard,
    });
  }
	});

router.get('/foss-projects', (req, res) => {
  res.render('FossProjects', {
    projects: FOSS_PROJECTS,
  });
});

router.get('/bitcoin-events', (_req, res) => {
  res.render('BitcoinEvents');
});

router.get('/create_merchant_coupon', (req, res) => {
  return renderCreateMerchantCouponPage(req, res);
});

router.get('/createEvent', (req, res) => {
  return renderCreateEventPage(req, res);
});

router.post('/createEvent/login', (req, res) => {
  if (!getEventImportPassword()) {
    return renderCreateEventPage(req, res.status(503), {
      authError: 'Event import password is not configured.',
    });
  }

  const submittedPassword = String(req.body?.eventPassword || '').trim();

  if (!safeStringEqual(submittedPassword, getEventImportPassword())) {
    return renderCreateEventPage(req, res.status(401), {
      authError: 'Invalid password.',
    });
  }

  setEventImportSessionCookie(req, res);
  return res.redirect('/createEvent');
});

router.post('/createEvent/logout', (req, res) => {
  clearEventImportSessionCookie(res);
  return res.redirect('/createEvent');
});

router.post('/createEvent', async (req, res) => {
  const authState = getEventImportAuthState(req);
  const eventUrl = String(req.body?.eventUrl || req.body?.eventURL || req.body?.url || '').trim();

  if (!authState.isAuthenticated) {
    return renderCreateEventPage(req, res.status(401), {
      authError: 'Enter the event import password to continue.',
      values: { eventUrl },
    });
  }

  if (!eventUrl) {
    return renderCreateEventPage(req, res.status(400), {
      formError: 'Enter a Luma event URL.',
      values: { eventUrl },
    });
  }

  try {
    const { created, event } = await importLumaEventFromUrl(eventUrl);

    return renderCreateEventPage(req, res, {
      created,
      importedEvent: event,
      values: emptyCreateEventValues(),
    });
  } catch (error) {
    if (error instanceof LumaEventImportError) {
      return renderCreateEventPage(req, res.status(error.status), {
        formError: error.message,
        values: { eventUrl },
      });
    }

    console.error('Error importing Bitcoin event from CreateEvent page:', error);
    return renderCreateEventPage(req, res.status(500), {
      formError: 'Could not import that event right now.',
      values: { eventUrl },
    });
  }
});

router.post('/create_merchant_coupon', (req, res) => {
  couponLogoUpload.single('businessLogo')(req, res, async (uploadError) => {
    const values = normalizeCouponFormValues(req.body || {});
    const fieldErrors = validateCouponFormValues(values);

    if (req.body?.website && String(req.body.website).trim() !== '') {
      return res.status(200).send('Submission received');
    }

    if (uploadError) {
      fieldErrors.businessLogo = formatCouponUploadError(uploadError);
      return renderCreateMerchantCouponPage(req, res.status(400), {
        values,
        fieldErrors,
        submitted: false,
      });
    }

    const file = req.file;
    if (!file) {
      fieldErrors.businessLogo = 'A business logo image is required.';
    } else if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      fieldErrors.businessLogo = 'Logo must be an image file.';
    }

    if (Object.keys(fieldErrors).length) {
      return renderCreateMerchantCouponPage(req, res.status(400), {
        values,
        fieldErrors,
        submitted: false,
      });
    }

    let normalizedAddress;
    try {
      normalizedAddress = await googleMapsAddressValidation.validateUsBusinessAddress({
        line1: values.addressLine1,
        line2: values.addressLine2,
        city: values.city,
        state: values.state,
        postalCode: values.postalCode,
      });
    } catch (error) {
      if (error instanceof googleMapsAddressValidation.AddressValidationError) {
        return renderCreateMerchantCouponPage(req, res.status(400), {
          values,
          formError: error.message,
          submitted: false,
        });
      }

      console.error('Error validating merchant coupon address:', error);
      return renderCreateMerchantCouponPage(req, res.status(500), {
        values,
        formError: 'We could not validate that address right now. Please try again shortly.',
        submitted: false,
      });
    }

    let uploadedLogo = null;
    try {
      uploadedLogo = await uploadCouponLogo(file);

      await Coupon.create({
        businessName: values.businessName,
        businessLogoUrl: uploadedLogo.businessLogoUrl,
        businessLogoObjectKey: uploadedLogo.businessLogoObjectKey,
        contactEmail: values.contactEmail,
        dealDescription: values.dealDescription,
        status: 'pending',
        appliesToAllLocations: true,
        primaryBusinessAddress: normalizedAddress,
      });

      return res.redirect('/create_merchant_coupon?submitted=1');
    } catch (error) {
      console.error('Error saving merchant coupon submission:', error);

      if (uploadedLogo?.businessLogoObjectKey) {
        await deleteCouponLogo(uploadedLogo.businessLogoObjectKey);
      }

      return renderCreateMerchantCouponPage(req, res.status(500), {
        values,
        formError: 'We could not save your coupon right now. Please try again shortly.',
        submitted: false,
      });
    }
  });
});

router.post('/prospects', async (req, res) => {
    try {
      const { email, businessName, name, website } = req.body || {};

          if (req.method !== 'POST') return res.sendStatus(405);
          if (!email || !businessName || !name) return res.sendStatus(400);

          // optional honeypot (you already have website field in the form)
          if (website) return res.sendStatus(204);


      // Honeypot check
      if (website && website.trim() !== "") {
        console.log("Bot submission detected, ignoring.");
        return res.status(200).send('Submission received');
        // Send 200 so bots think it worked and don't try again aggressively
      }

      if (!email || !businessName || !name) {
        return res.status(400).send('All fields are required');
      }

      const prospect = await Prospect.create({ email, businessName, name });

      console.log("A Business has requested a demo");
      console.log("Prospect data:", prospect);

      res.redirect('/Prospect-submitted');
    } catch (err) {
      console.error(err);
      res.status(500).send('Server error');
    }
  });

  router.get('/Prospect-submitted', (req, res) => {
    res.render('Prospect-submitted');
  });

router.get('/Contact-us', (req, res) => {
    res.render('Contact-us');
})

  router.get('/User-agreement', (req, res) => {
    res.render('User-agreement');
  });

  router.get('/Privacy-policy', (req, res) => {
    res.render('Privacy-policy');
  });

  router.get('/user-feedback', (req, res) => {
    res.render('user-feedback');
  });

  router.post('/user-feedback', async (req, res) => {
  try {
    // Ignore bot spam honeypot
    if (req.body.website && req.body.website.trim() !== '') {
      return res.status(200).send('ok');
    }

    // Create new feedback document
    const feedback = new Feedback({
      q1: req.body.q1 || '',
      q2: req.body.q2 || '',
      q3: req.body.q3 || '',
      q4: req.body.q4 || '',
      q5: req.body.q5 || '',
    });

    await feedback.save();
    res.status(200).send('Feedback submitted. Thank you!');
  } catch (error) {
    console.error('Error saving feedback:', error);
    res.status(500).send('Error saving feedback.');
  }
})

router.get('/Admin-login', (req, res) => {
  res.render('Admin-login');
});

router.post('/Admin-login', async (req, res) => {
  try {
    const { username, password } = req.body;

    // Find admin by username
    const admin = await Admin.findOne({ username });
    if (!admin) {
      return res.status(401).send('Invalid username');
    }

    // Compare provided password with stored hash
    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return res.status(401).send('Invalid password');
    }

    // Successful login → redirect to /Admin
    res.cookie('adminAuth', 'true', { httpOnly: true });
    res.redirect('/Admin');
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).send('Internal server error');
  }
});

router.get('/Admin', (req, res) => {
  if (req.cookies.adminAuth !== 'true') return res.redirect('/Admin-login');
  res.render('Admin');
});

module.exports = router;
