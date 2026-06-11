require('dotenv').config();
const http = require('http');
const ngrok = require('@ngrok/ngrok');
const mongoose = require('mongoose');

const { createApp } = require('./app');
const { startMessagingRelayCleanup } = require('./messaging/messagingRelayCleanup');

const port = Number(process.env.PORT || 3000);

async function startServer() {
  const app = createApp();
  const server = http.createServer(app);
  const mongoUri = process.env.NODE_ENV === 'dev'
    ? process.env.mongo_DB
    : process.env.prod_mongo_DB;

  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');
  startMessagingRelayCleanup();

  if (process.env.NODE_ENV === 'dev' && process.env.Ngrok_On === 'true') {
    try {
      const details = await ngrok.connect({
        addr: port,
        authtoken: process.env.NGROK_AUTHTOKEN,
      });

      console.log('Ngrok Details:', details);
      console.log('Ingress established at:', details.url());
    } catch (error) {
      console.error('Error establishing ngrok connection:', error);
    }
  }

  await new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`Server is running on port ${port}`);
      resolve();
    });
  });

  return { app, server };
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Server startup failed:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  startServer,
};
