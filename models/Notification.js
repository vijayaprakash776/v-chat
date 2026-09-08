const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Recipient ID is required'],
    },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    type: {
      type: String,
      enum: [
        'message',
        'mention',
        'channel_activity',
        'todo_assigned',
        'invitation_received',
        'invitation_accepted',
        'join_request',
        'join_request_approved',
        'join_request_rejected',
        'company_request',
        'company_approved',
        'company_rejected',
      ],
      required: true,
    },
    content: {
      type: String,
      required: [true, 'Notification content is required'],
      trim: true,
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
    messageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      default: null,
    },
    todoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Todo',
      default: null,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true, // Automatically manages createdAt and updatedAt
  }
);

// Compound indexes for fast unread queries and chronological retrieval
notificationSchema.index({ recipient: 1, organization: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, organization: 1, isRead: 1, createdAt: -1 });

const Notification = mongoose.model('Notification', notificationSchema);

module.exports = Notification;
