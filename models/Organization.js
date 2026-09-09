const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Organization name is required'],
      trim: true,
    },
    slug: {
      type: String,
      unique: true,
      trim: true,
      lowercase: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    logo: {
      type: String,
      default: '',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    settings: {
      requireJoinApproval: { type: Boolean, default: true },
      allowPublicChannels: { type: Boolean, default: true },
      allowPrivateChannels: { type: Boolean, default: true },
      allowUserChannelCreation: { type: Boolean, default: true },
      allowMemberInvites: { type: Boolean, default: true },
      allowMemberChannelDeletion: { type: Boolean, default: false },
    },
    // Top-level organization status
    status: {
      type: String,
      enum: ['pending', 'active', 'rejected', 'suspended', 'expired'],
      default: 'pending',
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    rejectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    rejectedAt: {
      type: Date,
      default: null,
    },
    rejectionReason: {
      type: String,
      default: null,
      trim: true,
    },
    // SaaS subscription details (managed by Super Admin)
    subscription: {
      plan: {
        type: String,
        enum: ['free', 'professional', 'enterprise'],
        default: 'free',
      },
      status: {
        type: String,
        enum: ['pending', 'active', 'rejected', 'suspended', 'expired'],
        default: 'pending',
      },
      startedAt: { type: Date, default: null },
      expiresAt: { type: Date, default: null },
    },
    // Feature entitlements (toggled by Super Admin per organization)
    features: {
      chat: { type: Boolean, default: true },
      channels: { type: Boolean, default: true },
      todos: { type: Boolean, default: true },
    },
  },
  {
    timestamps: true,
    toObject: { virtuals: true },
    toJSON: { virtuals: true },
  }
);

// Virtual getter for plan
organizationSchema.virtual('plan').get(function () {
  return this.subscription?.plan || 'free';
});

// Auto-generate slug from name if not provided
organizationSchema.pre('save', function () {
  if (!this.slug && this.name) {
    this.slug = this.name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '') + '-' + Math.random().toString(36).substring(2, 7);
  }
});

organizationSchema.index({ name: 'text' });

const Organization = mongoose.model('Organization', organizationSchema);

module.exports = Organization;
