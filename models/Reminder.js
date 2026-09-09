const mongoose = require('mongoose');

const reminderSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Reminder title is required'],
      trim: true,
      maxlength: [200, 'Reminder title cannot exceed 200 characters'],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [2000, 'Reminder description cannot exceed 2000 characters'],
      default: '',
    },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
    },
    reminderTime: {
      type: Date,
      required: [true, 'Reminder date and time is required'],
    },
    repeat: {
      type: String,
      enum: ['never', 'daily', 'weekly', 'monthly'],
      default: 'never',
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'snoozed'],
      default: 'pending',
    },
    snoozedUntil: {
      type: Date,
      default: null,
    },
    snoozeCount: {
      type: Number,
      default: 0,
    },
    isNotified: {
      type: Boolean,
      default: false,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    deleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
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
    sourceMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      default: null,
    },
    todoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Todo',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for fast querying, filtering, and authorization checks
reminderSchema.index({ organization: 1, userId: 1, status: 1, deleted: 1 });
reminderSchema.index({ reminderTime: 1, status: 1, isNotified: 1 });
reminderSchema.index({ userId: 1, reminderTime: 1 });

// Text index for keyword search on title and description
reminderSchema.index({ title: 'text', description: 'text' });

const Reminder = mongoose.model('Reminder', reminderSchema);

module.exports = Reminder;
