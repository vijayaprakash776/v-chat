const mongoose = require('mongoose');

const organizationSettingsSchema = new mongoose.Schema(
  {
    allowPublicChannels: {
      type: Boolean,
      default: true,
    },
    allowPrivateChannels: {
      type: Boolean,
      default: true,
    },
    allowUserChannelCreation: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Helper static method to get or initialize default settings singleton
organizationSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({
      allowPublicChannels: true,
      allowPrivateChannels: true,
      allowUserChannelCreation: true,
    });
  }
  return settings;
};

const OrganizationSettings = mongoose.model('OrganizationSettings', organizationSettingsSchema);

module.exports = OrganizationSettings;
