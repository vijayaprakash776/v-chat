const mongoose = require('mongoose');

const pinnedMessageSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
    },
    messageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      required: true,
      unique: true,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      default: null,
    },
    channelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Channel',
      default: null,
    },
    pinnedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    pinnedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

pinnedMessageSchema.index({ conversationId: 1, pinnedAt: -1 });
pinnedMessageSchema.index({ channelId: 1, pinnedAt: -1 });

module.exports = mongoose.model('PinnedMessage', pinnedMessageSchema);
