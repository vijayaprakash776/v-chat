const mongoose = require('mongoose');

// Define the blueprint for User documents
const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
  },
  avatar: {
    type: String,
    default: '',
  },
  bio: {
    type: String,
    default: '',
    trim: true,
  },
  title: {
    type: String,
    default: '',
    trim: true,
  },
  phone: {
    type: String,
    default: '',
    trim: true,
  },
  role: {
    type: String,
    enum: ['user', 'admin', 'super_admin'],
    default: 'user',
  },
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active',
  },
  currentOrganization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    default: null,
  },
  lastSeenAt: {
    type: Date,
    default: null,
  },
  pinnedChats: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
    },
  ],
  pinnedChannels: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Channel',
    },
  ],
  settings: {
    notifications: {
      type: new mongoose.Schema(
        {
          messages: { type: Boolean, default: true },
          mentions: { type: Boolean, default: true },
          sound: { type: Boolean, default: true },
          desktop: { type: Boolean, default: true },
          mentionsOnly: { type: Boolean, default: false },
          emailAlerts: { type: Boolean, default: false },
        },
        { _id: false, strict: false }
      ),
      default: () => ({}),
    },
    appearance: {
      type: new mongoose.Schema(
        {
          theme: { type: String, default: 'light' },
          compactMode: { type: Boolean, default: false },
          fontSize: { type: String, default: 'medium' },
        },
        { _id: false, strict: false }
      ),
      default: () => ({}),
    },
    privacy: {
      type: new mongoose.Schema(
        {
          onlineStatus: { type: mongoose.Schema.Types.Mixed, default: 'everyone' },
          lastSeen: { type: mongoose.Schema.Types.Mixed, default: true },
          readReceipts: { type: mongoose.Schema.Types.Mixed, default: true },
        },
        { _id: false, strict: false }
      ),
      default: () => ({}),
    },
    chat: {
      type: new mongoose.Schema(
        {
          enterToSend: { type: Boolean, default: true },
          sendOnEnter: { type: Boolean, default: true },
          mediaAutoDownload: { type: Boolean, default: true },
          emojiReactions: { type: Boolean, default: true },
        },
        { _id: false, strict: false }
      ),
      default: () => ({}),
    },
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Indexes for rapid role lookup and directory sorting
userSchema.index({ role: 1 });
userSchema.index({ status: 1 });
userSchema.index({ createdAt: -1 });

// Compile and export the User model (maps to 'users' collection)
const User = mongoose.model('User', userSchema);

module.exports = User;
