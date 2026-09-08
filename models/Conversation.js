const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
      },
    ],
    lastMessage: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      default: null,
    },
    lastMessageAt: {
      type: Date,
      default: Date.now,
    },
    memberSettings: [
      {
        _id: false,
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
          required: true,
        },
        muted: {
          type: Boolean,
          default: false,
        },
        manualUnread: {
          type: Boolean,
          default: false,
        },
        lastReadAt: {
          type: Date,
          default: null,
        },
        lastReadMessageId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Message',
          default: null,
        },
      },
    ],
  },
  {
    timestamps: true, // Automatically manages createdAt and updatedAt
  }
);

// Index for fast participant pair lookups and conversation sorting
conversationSchema.index({ organization: 1, participants: 1 });
conversationSchema.index({ organization: 1, lastMessageAt: -1 });
conversationSchema.index({ 'memberSettings.userId': 1 });

const Conversation = mongoose.model('Conversation', conversationSchema);

module.exports = Conversation;
