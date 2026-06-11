require('dotenv').config();
const express = require('express');
const router = express.Router();
const Prospect = require('../models/Prospect')
const bcrypt = require('bcrypt');
const Admin = require('../models/Admin');

const DEFAULT_PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.example.android&pcampaignid=web_share';

function renderHomePage(res) {
  res.render('Home', {
    APP_STORE_URL: process.env.APP_STORE_URL,
    PLAY_STORE_URL: process.env.PLAY_STORE_URL || DEFAULT_PLAY_STORE_URL,
  });
}

function renderAndroidApkPage(res) {
  res.render('AndroidApk', {
    ANDROID_APK_URL: process.env.ANDROID_APK_URL,
    ANDROID_APK_SHA256: process.env.ANDROID_APK_SHA256,
    ANDROID_APK_VERSION: process.env.ANDROID_APK_VERSION,
    PLAY_STORE_URL: process.env.PLAY_STORE_URL || DEFAULT_PLAY_STORE_URL,
  });
}

router.get('/', (req, res) => {
  renderHomePage(res);
});

router.get('/Home', (req, res) => {
  renderHomePage(res);
});

router.get('/download', (req, res) => {
  res.redirect('/Home');
});

router.get('/test', (req, res) => {
  res.redirect('/Home');
});

router.get('/android-apk', (req, res) => {
  renderAndroidApkPage(res);
});

router.get(['/promos', '/split-promos'], (req, res) => {
  res.render('SplitPromos');
});

router.post('/prospects', async (req, res) => {
    try {
      const { email, businessName, name, website, source, campaignGoal } = req.body || {};

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

      const prospect = await Prospect.create({
        email,
        businessName,
        name,
        source,
        campaignGoal,
      });

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
