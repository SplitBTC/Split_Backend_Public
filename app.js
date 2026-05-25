require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');

const landingPageRoutes = require('./routes/landingPageRoutes');
const iOSEndPoints = require('./routes/iOSEndPoints');
const MessageEndPoints = require('./routes/MessageEndPoints');
const BitcoinEventRoutes = require('./routes/BitcoinEventRoutes');
const merchantRoutes = require('./routes/merchant');

function createApp() {
  const app = express();
  const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';

  app.use(cors({
    origin: corsOrigin,
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type'],
  }));

  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.js')) {
        res.set('Content-Type', 'application/javascript');
      }
    },
  }));

  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(express.json());

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(landingPageRoutes);
  app.use(iOSEndPoints);
  app.use(MessageEndPoints);
  app.use(BitcoinEventRoutes);
  app.use(merchantRoutes);

  return app;
}

module.exports = {
  createApp,
};
