const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { notifyDirectMessage } = require('../services/notificationService');

// @desc    Create or get existing 1-to-1 conversation
// @route   POST /api/conversations
// @access  Private
const createOrGetConversation = async (req, res) => {
  try {
    const { receiverId } = req.body;
    const senderId = req.user.id;

    if (!receiverId) {
      return res.status(400).json({
        success: false,
        message: 'receiverId is required',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(receiverId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid receiverId format',
      });
    }

    // Allow self-conversations (Me / Notes to self)

    // Verify receiver exists in database
    const receiver = await User.findById(receiverId);
    if (!receiver) {
      return res.status(404).json({
        success: false,
        message: 'Recipient user not found',
      });
    }

    const orgId = req.user.currentOrganizationId;
    if (!orgId) {
      return res.status(400).json({
        success: false,
        message: 'No active organization set',
      });
    }

    // Verify receiver belongs to the same active organization
    const Membership = require('../models/Membership');
    const receiverMembership = await Membership.findOne({
      user: receiverId,
      organization: orgId,
      status: 'active',
    });

    if (!receiverMembership) {
      return res.status(403).json({
        success: false,
        message: 'Recipient is not a member of your active company',
      });
    }

    // Look for existing conversation between these participants in this organization
    const isSelf = receiverId.toString() === senderId.toString();

    if (isSelf) {
      // 1. Check for any existing self-conversations in this organization
      const existingSelfs = await Conversation.find({
        organization: orgId,
        $or: [
          { participants: [senderId] },
          { participants: [senderId, senderId] },
          { participants: { $all: [senderId], $size: 1 } },
        ],
      })
        .populate('participants', 'name email avatar')
        .populate({
          path: 'lastMessage',
          populate: { path: 'sender receiver', select: 'name email avatar' },
        })
        .sort({ lastMessageAt: -1, updatedAt: -1 });

      if (existingSelfs.length > 0) {
        const primary = existingSelfs[0];
        // Clean up any historical duplicate self-conversations
        if (existingSelfs.length > 1) {
          for (let i = 1; i < existingSelfs.length; i++) {
            const dup = existingSelfs[i];
            await Message.updateMany({ conversationId: dup._id }, { conversationId: primary._id });
            await Conversation.deleteOne({ _id: dup._id });
          }
        }
        return res.status(200).json({
          success: true,
          conversation: primary,
        });
      }

      // 2. Atomically find or create the single self-conversation
      const selfConv = await Conversation.findOneAndUpdate(
        {
          organization: orgId,
          participants: [senderId],
        },
        {
          $setOnInsert: {
            organization: orgId,
            participants: [senderId],
            lastMessageAt: new Date(),
          },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
      )
        .populate('participants', 'name email avatar')
        .populate({
          path: 'lastMessage',
          populate: { path: 'sender receiver', select: 'name email avatar' },
        });

      return res.status(200).json({
        success: true,
        conversation: selfConv,
      });
    }

    // Normal 1-on-1 conversation with another user
    const participantIds = [senderId, receiverId];
    let conversation = await Conversation.findOne({
      organization: orgId,
      participants: { $all: participantIds, $size: 2 },
    })
      .populate('participants', 'name email avatar')
      .populate({
        path: 'lastMessage',
        populate: { path: 'sender receiver', select: 'name email avatar' },
      });

    // If conversation already exists, return it (idempotent)
    if (conversation) {
      return res.status(200).json({
        success: true,
        conversation,
      });
    }

    // Check if organization plan is active before creating a new conversation
    const Organization = require('../models/Organization');
    const org = await Organization.findById(orgId).select('status subscription').lean();
    const orgStatus = org?.status || org?.subscription?.status || 'pending';
    const isExpired = orgStatus === 'expired' || Boolean(org?.subscription?.expiresAt && new Date() > new Date(org.subscription.expiresAt));
    if (isExpired) {
      return res.status(403).json({
        success: false,
        code: 'ORG_EXPIRED',
        companyStatus: 'expired',
        message: 'Your subscription plan has expired.',
      });
    }
    if (orgStatus === 'suspended') {
      return res.status(403).json({
        success: false,
        code: 'ORG_SUSPENDED',
        companyStatus: 'suspended',
        message: 'Your subscription has been Ended',
      });
    }

    // Otherwise create a new conversation for this organization
    conversation = await Conversation.create({
      organization: orgId,
      participants: participantIds,
      lastMessageAt: new Date(),
    });

    conversation = await Conversation.findById(conversation._id).populate(
      'participants',
      'name email avatar'
    );

    return res.status(201).json({
      success: true,
      conversation,
    });
  } catch (error) {
    console.error('Create Conversation Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error creating conversation',
    });
  }
};

// @desc    Get all conversations for authenticated user in current organization
// @route   GET /api/conversations
// @access  Private
const getUserConversations = async (req, res) => {
  try {
    const userId = req.user.id;
    const orgId = req.user.currentOrganizationId;

    if (!orgId) {
      return res.status(200).json({
        success: true,
        count: 0,
        conversations: [],
      });
    }

    const conversations = await Conversation.find({
      organization: orgId,
      participants: userId,
    })
      .populate('participants', 'name email avatar')
      .populate({
        path: 'lastMessage',
        populate: { path: 'sender receiver', select: 'name email avatar' },
      })
      .sort({ lastMessageAt: -1, updatedAt: -1 });

    // Deduplicate self-conversations and ensure exactly ONCE for current user
    const isSelfConv = (c) => {
      if (!c.participants || !Array.isArray(c.participants) || c.participants.length === 0) return false;
      return c.participants.every((p) => p && (p._id || p.id || p)?.toString() === userId.toString());
    };

    const selfConvs = conversations.filter(isSelfConv);
    const otherConvs = conversations.filter((c) => !isSelfConv(c));

    let primarySelfConv = null;
    if (selfConvs.length > 0) {
      primarySelfConv = selfConvs[0];
      // Clean up any duplicate self-conversations in DB if multiple exist
      if (selfConvs.length > 1) {
        for (let i = 1; i < selfConvs.length; i++) {
          const dup = selfConvs[i];
          await Message.updateMany({ conversationId: dup._id }, { conversationId: primarySelfConv._id });
          await Conversation.deleteOne({ _id: dup._id });
        }
      }
    } else {
      // Ensure self-conversation exists for every company user
      try {
        primarySelfConv = await Conversation.findOneAndUpdate(
          {
            organization: orgId,
            participants: [userId],
          },
          {
            $setOnInsert: {
              organization: orgId,
              participants: [userId],
              lastMessageAt: new Date(),
            },
          },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        )
          .populate('participants', 'name email avatar')
          .populate({
            path: 'lastMessage',
            populate: { path: 'sender receiver', select: 'name email avatar' },
          });
      } catch (selfErr) {
        console.warn('Could not auto-upsert self-conversation:', selfErr.message);
      }
    }

    // Deduplicate otherConvs by unique _id
    const seenOtherIds = new Set();
    const uniqueOtherConvs = otherConvs.filter((c) => {
      const id = (c._id || c.id)?.toString();
      if (!id || seenOtherIds.has(id)) return false;
      seenOtherIds.add(id);
      return true;
    });

    // Exactly one self-conversation at the top, followed by other conversations
    const sanitizedConversations = primarySelfConv
      ? [primarySelfConv, ...uniqueOtherConvs]
      : uniqueOtherConvs;

    return res.status(200).json({
      success: true,
      count: sanitizedConversations.length,
      conversations: sanitizedConversations,
    });
  } catch (error) {
    console.error('Get Conversations Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching conversations',
    });
  }
};

const updateConversationSetting = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;
    const { muted, manualUnread } = req.body;
    if (!mongoose.Types.ObjectId.isValid(conversationId)) return res.status(400).json({ success: false, message: 'Invalid conversationId format' });
    const conversation = await Conversation.findOne({ _id: conversationId, participants: userId });
    if (!conversation) return res.status(403).json({ success: false, message: 'Not authorized to update this conversation' });
    let setting = conversation.memberSettings.find((item) => item.userId.toString() === userId);
    if (!setting) {
      conversation.memberSettings.push({ userId });
      setting = conversation.memberSettings[conversation.memberSettings.length - 1];
    }
    if (typeof muted === 'boolean') setting.muted = muted;
    if (typeof manualUnread === 'boolean') setting.manualUnread = manualUnread;
    await conversation.save();
    return res.status(200).json({ success: true, settings: setting });
  } catch (error) {
    console.error('Update Conversation Setting Error:', error.message);
    return res.status(500).json({ success: false, message: 'Server error updating conversation settings' });
  }
};

const markConversationRead = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;
    if (!mongoose.Types.ObjectId.isValid(conversationId)) return res.status(400).json({ success: false, message: 'Invalid conversationId format' });
    const conversation = await Conversation.findOne({ _id: conversationId, participants: userId });
    if (!conversation) return res.status(403).json({ success: false, message: 'Not authorized to read this conversation' });
    const unread = await Message.find({ conversationId, receiver: userId, isRead: false }).select('_id');
    const readAt = new Date();
    if (unread.length) {
      const unreadIds = unread.map((message) => message._id);
      await Message.updateMany(
        { _id: { $in: unreadIds } },
        [
          {
            $set: {
              isRead: true,
              readBy: {
                $concatArrays: [
                  {
                    $filter: {
                      input: { $ifNull: ['$readBy', []] },
                      as: 'reader',
                      cond: { $ne: ['$$reader.userId', new mongoose.Types.ObjectId(userId)] },
                    },
                  },
                  [{ userId: new mongoose.Types.ObjectId(userId), readAt }],
                ],
              },
            },
          },
        ]
      );

      // Automatically mark notifications for this conversation & user as read
      const matchedNotifs = await Notification.find({
        recipient: userId,
        conversationId,
        isRead: false,
      }).select('_id');

      if (matchedNotifs.length > 0) {
        await Notification.updateMany(
          { _id: { $in: matchedNotifs.map((n) => n._id) } },
          { $set: { isRead: true } }
        );
      }

      const orgId = req.user.currentOrganizationId;
      const currentUnreadCount = await Notification.countDocuments({
        recipient: userId,
        isRead: false,
        ...(orgId ? { organization: orgId } : {}),
      });

      const io = req.app.get('io');
      if (io) {
        io.to(`conversation:${conversationId}`).emit('message:read', { conversationId, messageIds: unreadIds, userId, readAt });

        // Emit real-time notification read sync
        matchedNotifs.forEach((n) => {
          io.to(`user:${userId}`).emit('notification:read', {
            notificationId: n._id,
          });
        });

        io.to(`user:${userId}`).emit('notification:unread_count', {
          unreadCount: currentUnreadCount,
        });
      }
    }
    let setting = conversation.memberSettings.find((item) => item.userId.toString() === userId);
    if (!setting) {
      conversation.memberSettings.push({ userId });
      setting = conversation.memberSettings[conversation.memberSettings.length - 1];
    }
    setting.manualUnread = false;
    setting.lastReadAt = readAt;
    setting.lastReadMessageId = unread.length ? unread[unread.length - 1]._id : setting.lastReadMessageId;
    await conversation.save();
    return res.status(200).json({ success: true, messageIds: unread.map((message) => message._id), readAt });
  } catch (error) {
    console.error('Mark Conversation Read Error:', error.message);
    return res.status(500).json({ success: false, message: 'Server error marking conversation as read' });
  }
};

// @desc    Get messages for a conversation
// @route   GET /api/conversations/:conversationId/messages
// @access  Private
const getConversationMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid conversationId format',
      });
    }

    // Verify conversation exists
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found',
      });
    }

    // Authorization: User must be a participant in this conversation
    const isParticipant = conversation.participants.some(
      (p) => p.toString() === userId
    );

    if (!isParticipant) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access messages in this conversation',
      });
    }

    const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10) || 50, 100) : 0;
    const before = req.query.before; // ISO date string or timestamp

    const query = {
      conversationId,
      deletedFor: { $ne: userId },
    };
    if (before) {
      const beforeDate = new Date(before);
      if (!isNaN(beforeDate.getTime())) {
        query.createdAt = { $lt: beforeDate };
      }
    }

    const messagesQuery = Message.find(query)
      .populate('sender', 'name email avatar')
      .populate('receiver', 'name email avatar')
      .populate({
        path: 'replyTo',
        populate: { path: 'sender', select: 'name email avatar' },
      })
      .populate({
        path: 'forwardedFrom',
        populate: { path: 'sender', select: 'name email avatar' },
      });

    if (limit > 0) {
      const rawMessages = await messagesQuery.sort({ createdAt: -1 }).limit(limit);
      const messages = rawMessages.reverse();

      const oldestMessageDate = messages.length > 0 ? messages[0].createdAt : null;
      let hasMore = false;
      if (oldestMessageDate) {
        const olderCount = await Message.countDocuments({
          conversationId,
          createdAt: { $lt: oldestMessageDate },
        });
        hasMore = olderCount > 0;
      }

      return res.status(200).json({
        success: true,
        count: messages.length,
        hasMore,
        messages,
      });
    }

    const messages = await messagesQuery.sort({ createdAt: 1 });

    return res.status(200).json({
      success: true,
      count: messages.length,
      hasMore: false,
      messages,
    });
  } catch (error) {
    console.error('Get Messages Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching conversation messages',
    });
  }
};

// @desc    Send a message in a conversation (with optional file attachments)
// @route   POST /api/conversations/:id/messages
// @access  Private
const sendMessage = async (req, res) => {
  try {
    const conversationId = req.params.conversationId || req.params.id;
    let content = req.body.content ? req.body.content.trim() : '';
    const replyTo = req.body.replyTo || null;
    const senderId = req.user.id;

    // Parse uploaded files (if any)
    const attachments = (req.files || []).map((file) => ({
      fileUrl: `/uploads/${file.filename}`,
      fileName: file.originalname,
      fileType: file.mimetype,
      fileSize: file.size,
    }));

    if (!content && attachments.length === 0 && !req.body.poll) {
      return res.status(400).json({
        success: false,
        message: 'Message content, attachment, or poll is required',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid conversationId format',
      });
    }

    // Verify conversation exists
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found',
      });
    }

    // Authorization check
    const isParticipant = conversation.participants.some(
      (p) => p.toString() === senderId
    );

    if (!isParticipant) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to send messages to this conversation',
      });
    }

    // Determine messageType & Poll parsing
    let messageType = req.body.messageType || 'text';
    let poll = null;
    if (req.body.poll) {
      try {
        poll = typeof req.body.poll === 'string' ? JSON.parse(req.body.poll) : req.body.poll;
      } catch (e) {
        poll = null;
      }
    }

    if (poll && poll.question && Array.isArray(poll.options) && poll.options.length >= 2) {
      const cleanOptions = poll.options
        .map((opt) => (typeof opt === 'string' ? opt.trim() : opt?.text?.trim()))
        .filter(Boolean);

      if (cleanOptions.length >= 2) {
        messageType = 'poll';
        poll = {
          question: poll.question.trim(),
          options: cleanOptions.map((text) => ({ text, votes: [] })),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // Exactly 7 days from creation
          isClosed: false,
        };
        if (!content) {
          content = `📊 Poll: ${poll.question}`;
        }
      } else {
        poll = null;
      }
    } else {
      poll = null;
    }

    if (attachments.length > 0) {
      const allImages = attachments.every((att) => att.fileType.startsWith('image/'));
      const allVideos = attachments.every((att) => att.fileType.startsWith('video/'));
      if (allImages) {
        messageType = 'image';
      } else if (allVideos) {
        messageType = 'video';
      } else {
        messageType = 'file';
      }
    }

    // Find the receiver (the other participant or self for Me notes)
    const receiverId = conversation.participants.find(
      (p) => p.toString() !== senderId
    ) || senderId;

    // Create the message in MongoDB
    const newMessage = await Message.create({
      organization: conversation.organization,
      conversationId,
      sender: senderId,
      receiver: receiverId,
      content,
      messageType,
      attachments,
      poll,
      replyTo: replyTo && mongoose.Types.ObjectId.isValid(replyTo) ? replyTo : null,
      isRead: false,
    });

    // Update conversation metadata
    conversation.lastMessage = newMessage._id;
    conversation.lastMessageAt = newMessage.createdAt;
    await conversation.save();

    // Populate sender, receiver, and references
    const populatedMessage = await Message.findById(newMessage._id)
      .populate('sender', 'name email avatar')
      .populate('receiver', 'name email avatar')
      .populate({
        path: 'replyTo',
        populate: { path: 'sender', select: 'name email avatar' },
      })
      .populate({
        path: 'forwardedFrom',
        populate: { path: 'sender', select: 'name email avatar' },
      });

    // Real-Time Socket.IO event emission
    const io = req.app.get('io');
    if (io) {
      // Emit to conversation room AND all other participants' user rooms
      const convEmitter = io.to(`conversation:${conversationId}`);
      for (const p of conversation.participants || []) {
        const pid = (p._id || p).toString();
        if (pid !== senderId) {
          convEmitter.to(`user:${pid}`);
        }
      }
      convEmitter.emit('message:new', {
        message: populatedMessage,
      });

      // Create and dispatch real-time direct/group message notifications (with @all support)
      await notifyDirectMessage({
        sender: populatedMessage.sender,
        receiverId,
        conversationId,
        messageId: populatedMessage._id,
        content: populatedMessage.content,
        attachments: populatedMessage.attachments,
        io,
      });
    }

    return res.status(201).json({
      success: true,
      message: populatedMessage,
    });
  } catch (error) {
    console.error('Send Message Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error sending message',
    });
  }
};

module.exports = {
  createOrGetConversation,
  getUserConversations,
  updateConversationSetting,
  markConversationRead,
  getConversationMessages,
  sendMessage,
};
