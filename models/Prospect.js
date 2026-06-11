const mongoose = require('mongoose');

const prospectSchema = new mongoose.Schema({

  businessName: { type: String, required: true, },
  email: { type: String, required: true, },
  name: { type: String, required: true, },
  source: { type: String },
  campaignGoal: { type: String },

});

const Prospect = mongoose.model('Prospect', prospectSchema);

module.exports = Prospect;
