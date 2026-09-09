const mongoose = require('mongoose');

const attachmentSchema = new mongoose.Schema(
  {
    fileUrl: {
      type: String,
      required: [true, 'File URL is required'],
    },
    fileName: {
      type: String,
      required: [true, 'File name is required'],
    },
    fileType: {
      type: String,
      required: [true, 'File MIME type is required'],
    },
    fileSize: {
      type: Number,
      required: [true, 'File size is required'],
    },
  },
  { _id: false }
);

const pollOptionSchema = new mongoose.Schema(
  {
    text: {
      type: String,
      required: true,
      trim: true,
    },
    votes: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
  },
  { _id: true }
);

const pollSchema = new mongoose.Schema(
  {
    question: {
      type: String,
      required: true,
      trim: true,
    },
    options: [pollOptionSchema],
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from creation
    },
    isClosed: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    // For Direct Messages
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      default: null,
    },
    // For Group Channel Messages
    channelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Channel',
      default: null,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Sender ID is required'],
    },
    // Direct messages have a receiver, channel messages do not
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    content: {
      type: String,
      default: '',
      trim: true,
    },
    messageType: {
      type: String,
      enum: ['text', 'image', 'video', 'file', 'poll', 'call'],
      default: 'text',
    },
    attachments: {
      type: [attachmentSchema],
      default: [],
    },
    poll: {
      type: pollSchema,
      default: null,
    },
    call: {
      type: new mongoose.Schema(
        {
          callType: {
            type: String,
            enum: ['audio', 'video'],
            default: 'audio',
          },
          status: {
            type: String,
            enum: ['ended', 'missed', 'declined', 'cancelled'],
            default: 'ended',
          },
          duration: {
            type: Number,
            default: 0,
          },
        },
        { _id: false }
      ),
      default: null,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    readBy: [
      {
        _id: false,
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
          required: true,
        },
        readAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    // Level 12: Advanced Message Action Fields
    edited: {
      type: Boolean,
      default: false,
    },
    editedAt: {
      type: Date,
      default: null,
    },
    pinned: {
      type: Boolean,
      default: false,
    },
    deleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    deletedFor: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    forwarded: {
      type: Boolean,
      default: false,
    },
    forwardedFrom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      default: null,
    },
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      default: null,
    },
    // Level 15: Message Reactions
    reactions: [
      {
        _id: false,
        emoji: {
          type: String,
          required: true,
        },
        users: [
          {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
          },
        ],
      },
    ],
  },
  {
    timestamps: true, // Automatically manages createdAt and updatedAt
  }
);

// Validation: Ensure message belongs to either a direct conversation or a group channel,
// and has either text content or at least one file attachment (unless deleted)
messageSchema.pre('validate', function () {
  if (!this.conversationId && !this.channelId) {
    this.invalidate(
      'conversationId',
      'A message must belong to either a direct conversation or a channel'
    );
  }

  // If message is soft-deleted, allow empty content
  if (this.deleted) {
    return;
  }

  const hasContent = this.content && this.content.trim().length > 0;
  const hasAttachments = this.attachments && this.attachments.length > 0;
  const hasPoll = Boolean(this.poll && this.poll.question);
  const hasCall = Boolean(this.call && this.call.callType) || this.messageType === 'call';

  if (!hasContent && !hasAttachments && !hasPoll && !hasCall) {
    this.invalidate(
      'content',
      'Message must contain text content, at least one attachment, a poll, or a call entry'
    );
  }
});

// Compound indexes for rapid chronological & paginated retrieval
messageSchema.index({ organization: 1, createdAt: -1 });
messageSchema.index({ conversationId: 1, createdAt: 1 });
messageSchema.index({ conversationId: 1, createdAt: -1 });
messageSchema.index({ channelId: 1, createdAt: 1 });
messageSchema.index({ channelId: 1, createdAt: -1 });
messageSchema.index({ replyTo: 1 });
messageSchema.index({ forwardedFrom: 1 });
messageSchema.index({ deleted: 1 });

// Text index for full-text search across message content and attachment filenames
messageSchema.index(
  {
    content: 'text',
    'attachments.fileName': 'text',
  },
  {
    weights: {
      content: 5,
      'attachments.fileName': 3,
    },
    name: 'message_text_search_index',
  }
);

const Message = mongoose.model('Message', messageSchema);

module.exports = Message;
