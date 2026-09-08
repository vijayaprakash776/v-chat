const mongoose = require('mongoose');

const membershipSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User reference is required for membership'],
    },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: [true, 'Organization reference is required for membership'],
    },
    role: {
      type: String,
      enum: ['owner', 'admin', 'member'],
      default: 'member',
    },
    permissions: [
      {
        type: String,
        trim: true,
      },
    ],
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
  },
  {
    timestamps: true,
  }
);

// A user can have at most one membership record per organization
membershipSchema.index({ user: 1, organization: 1 }, { unique: true });
membershipSchema.index({ organization: 1, role: 1 });
membershipSchema.index({ user: 1, status: 1 });

const Membership = mongoose.model('Membership', membershipSchema);

module.exports = Membership;
