const mongoose = require('mongoose');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const Channel = require('../models/Channel');
const User = require('../models/User');
const PinnedMessage = require('../models/PinnedMessage');
const Notification = require('../models/Notification');
const {
  notifyDirectMessage,
  notifyChannelMessage,
} = require('../services/notificationService');

// @desc    Mark a message as read
// @route   PATCH /api/messages/:messageId/read
// @access  Private
const markMessageAsRead = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid messageId format',
      });
    }

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
      });
    }

    // Only the receiver can mark a message as read
    if (message.receiver && message.receiver.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Only the receiver can mark this message as read',
      });
    }

    message.isRead = true;
    await message.save();

    // Mark any corresponding notification for this user & message as read
    const matchedNotifs = await Notification.find({
      recipient: userId,
      messageId: message._id,
      isRead: false,
    }).select('_id');

    if (matchedNotifs.length > 0) {
      await Notification.updateMany(
        { _id: { $in: matchedNotifs.map((n) => n._id) } },
        { $set: { isRead: true } }
      );
    }

    // Real-Time Socket.IO event emission for read receipt & notification sync
    const io = req.app.get('io');
    if (io) {
      const rooms = [`conversation:${message.conversationId.toString()}`, `user:${message.sender.toString()}`];
      io.to(rooms).emit('message:read', {
        messageId: message._id,
        conversationId: message.conversationId,
        readBy: userId,
      });
    }

    return res.status(200).json({
      success: true,
      message,
    });
  } catch (error) {
    console.error('Mark Message Read Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error marking message as read',
    });
  }
};

// @desc    Mark multiple messages as read for the authenticated user
// @route   PATCH /api/messages/read
// @access  Private
const markMessagesAsRead = async (req, res) => {
  try {
    const { messageIds = [] } = req.body;
    const userId = req.user.id;
    const orgId = req.user.currentOrganizationId;

    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Array of messageIds is required' });
    }

    const validIds = messageIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid message IDs provided' });
    }

    const messages = await Message.find({ _id: { $in: validIds } });
    const accessible = messages.filter((m) => {
      const senderId = (m.sender?._id || m.sender?.id || m.sender)?.toString();
      if (senderId === userId) return false;
      return true;
    });

    if (accessible.length === 0) {
      return res.status(200).json({ success: true, messageIds: [], readAt: new Date().toISOString() });
    }

    const readAt = new Date();
    const accessibleIds = accessible.map((m) => m._id);

    await Message.updateMany(
      { _id: { $in: accessibleIds } },
      {
        $set: { isRead: true },
        $addToSet: { readBy: { userId, readAt } },
      }
    );

    const scopesConv = accessible.filter((m) => m.conversationId).map((m) => m.conversationId);
    const scopesChan = accessible.filter((m) => m.channelId).map((m) => m.channelId);

    const notifConditions = [{ messageId: { $in: accessibleIds } }];
    if (scopesConv.length > 0) {
      notifConditions.push({ conversationId: { $in: scopesConv } });
    }
    if (scopesChan.length > 0) {
      notifConditions.push({ channelId: { $in: scopesChan } });
    }

    const matchedNotifs = await Notification.find({
      recipient: userId,
      isRead: false,
      $or: notifConditions,
    }).select('_id');

    if (matchedNotifs.length > 0) {
      await Notification.updateMany(
        { _id: { $in: matchedNotifs.map((n) => n._id) } },
        { $set: { isRead: true } }
      );
    }

    const currentUnreadCount = await Notification.countDocuments({
      recipient: userId,
      isRead: false,
      ...(orgId ? { organization: orgId } : {}),
    });

    const readerUser = await User.findById(userId).select('settings');
    const sendReadReceipts = readerUser?.settings?.privacy?.readReceipts !== false;

    const io = req.app.get('io');
    if (io) {
      if (sendReadReceipts) {
        const byScope = new Map();
        accessible.forEach((message) => {
          const scope = message.conversationId || message.channelId;
          const key = `${message.conversationId ? 'conversation' : 'channel'}:${scope}`;
          if (!byScope.has(key)) byScope.set(key, { message, ids: [] });
          byScope.get(key).ids.push(message._id);
        });
        for (const { message, ids } of byScope.values()) {
          const room = message.conversationId ? `conversation:${message.conversationId}` : `channel:${message.channelId}`;
          io.to(room).emit('message:read', { conversationId: message.conversationId, channelId: message.channelId, messageIds: ids, userId, readAt });
          if (message.sender) {
            io.to(`user:${message.sender.toString()}`).emit('message:read', { conversationId: message.conversationId, channelId: message.channelId, messageIds: ids, userId, readAt });
          }
        }
      }

      // Sync unread notification count reduction in real-time
      matchedNotifs.forEach((n) => {
        io.to(`user:${userId}`).emit('notification:read', {
          notificationId: n._id,
        });
      });

      // Also directly emit the updated unread notification count
      io.to(`user:${userId}`).emit('notification:unread_count', {
        unreadCount: currentUnreadCount,
      });
    }
    return res.status(200).json({ success: true, messageIds: accessibleIds, readAt, unreadNotificationsCount: currentUnreadCount });
  } catch (error) {
    console.error('Mark Messages Read Error:', error.stack || error.message);
    return res.status(500).json({ success: false, message: 'Server error marking messages as read', error: error.message });
  }
};

const getMessageById = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;
    if (!mongoose.Types.ObjectId.isValid(messageId)) return res.status(400).json({ success: false, message: 'Invalid messageId format' });
    const message = await Message.findById(messageId)
      .populate('sender', 'name email avatar')
      .populate('receiver', 'name email avatar')
      .populate('conversationId')
      .populate('channelId', 'name isPrivate members')
      .populate({ path: 'replyTo', populate: { path: 'sender', select: 'name email avatar' } });
    if (!message) return res.status(404).json({ success: false, message: 'Message not found' });
    let allowed = false;
    if (message.conversationId) allowed = Boolean(await Conversation.exists({ _id: message.conversationId._id, participants: userId }));
    if (message.channelId) allowed = Boolean(await Channel.exists({ _id: message.channelId._id, members: userId }));
    if (!allowed) return res.status(403).json({ success: false, message: 'Not authorized to access this message' });
    return res.status(200).json({ success: true, message });
  } catch (error) {
    console.error('Get Message Error:', error.message);
    return res.status(500).json({ success: false, message: 'Server error fetching message' });
  }
};

// @desc    Edit a message
// @route   PATCH /api/messages/:messageId
// @access  Private
const editMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { content } = req.body;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid messageId format',
      });
    }

    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Message content cannot be empty',
      });
    }

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
      });
    }

    // Cannot edit deleted messages
    if (message.deleted) {
      return res.status(400).json({
        success: false,
        message: 'Cannot edit a deleted message',
      });
    }

    // Authorization: Only the original sender can edit
    if (message.sender.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: 'You can only edit your own messages',
      });
    }

    // Update message content and timestamps
    message.content = content.trim();
    message.edited = true;
    message.editedAt = new Date();
    await message.save();

    const populated = await Message.findById(messageId)
      .populate('sender', 'name email avatar')
      .populate('receiver', 'name email avatar')
      .populate({
        path: 'replyTo',
        populate: { path: 'sender', select: 'name email avatar' },
      });

    // Real-Time Socket.IO emission
    const io = req.app.get('io');
    if (io) {
      const payload = {
        messageId: message._id,
        conversationId: message.conversationId,
        channelId: message.channelId,
        content: message.content,
        edited: true,
        editedAt: message.editedAt,
        message: populated,
      };

      if (message.conversationId) {
        io.to(`conversation:${message.conversationId.toString()}`).emit('message:edited', payload);
        if (message.receiver) {
          io.to(`user:${message.receiver.toString()}`).emit('message:edited', payload);
        }
      } else if (message.channelId) {
        io.to(`channel:${message.channelId.toString()}`).emit('channel:message:edited', payload);
        io.to(`channel:${message.channelId.toString()}`).emit('message:edited', payload);
      }
    }

    return res.status(200).json({
      success: true,
      message: populated,
    });
  } catch (error) {
    console.error('Edit Message Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error editing message',
    });
  }
};

// @desc    Soft delete a message
// @route   DELETE /api/messages/:messageId
// @access  Private
const deleteMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid messageId format',
      });
    }

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
      });
    }

    // Authorization: Sender or Admin
    const isSender = message.sender.toString() === userId;
    const isAdmin = userRole === 'admin';

    if (!isSender && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to delete this message',
      });
    }

    // Apply soft deletion
    message.deleted = true;
    message.deletedAt = new Date();
    message.deletedBy = userId;
    message.content = 'This message was deleted';
    message.attachments = [];
    await message.save();
    await PinnedMessage.deleteOne({ messageId: message._id });

    const populated = await Message.findById(messageId)
      .populate('sender', 'name email avatar')
      .populate('receiver', 'name email avatar')
      .populate({
        path: 'replyTo',
        populate: { path: 'sender', select: 'name email avatar' },
      });

    // Real-Time Socket.IO emission
    const io = req.app.get('io');
    if (io) {
      const payload = {
        messageId: message._id,
        conversationId: message.conversationId,
        channelId: message.channelId,
        deleted: true,
        deletedAt: message.deletedAt,
        deletedBy: userId,
        message: populated,
      };

      if (message.conversationId) {
        io.to(`conversation:${message.conversationId.toString()}`).emit('message:deleted', payload);
        if (message.receiver) {
          io.to(`user:${message.receiver.toString()}`).emit('message:deleted', payload);
        }
      } else if (message.channelId) {
        io.to(`channel:${message.channelId.toString()}`).emit('channel:message:deleted', payload);
        io.to(`channel:${message.channelId.toString()}`).emit('message:deleted', payload);
      }
    }

    return res.status(200).json({
      success: true,
      messageId: message._id,
      message: populated,
    });
  } catch (error) {
    console.error('Delete Message Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error deleting message',
    });
  }
};

// @desc    Delete message for me only
// @route   POST /api/messages/:messageId/delete-for-me
// @access  Private
const deleteMessageForMe = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid messageId format',
      });
    }

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
      });
    }

    // Add userId to deletedFor array if not already present
    if (!message.deletedFor) {
      message.deletedFor = [];
    }
    const alreadyDeleted = message.deletedFor.some((id) => id.toString() === userId.toString());
    if (!alreadyDeleted) {
      message.deletedFor.push(userId);
      await message.save();
    }

    return res.status(200).json({
      success: true,
      messageId: message._id,
      deletedForMe: true,
    });
  } catch (error) {
    console.error('Delete Message For Me Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error deleting message for me',
    });
  }
};

// @desc    Forward a message to another conversation or channel
// @route   POST /api/messages/:messageId/forward
// @access  Private
const forwardMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { targetType, targetId } = req.body;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid messageId format',
      });
    }

    if (!targetType || !['conversation', 'channel'].includes(targetType)) {
      return res.status(400).json({
        success: false,
        message: 'targetType must be either "conversation" or "channel"',
      });
    }

    if (!targetId || !mongoose.Types.ObjectId.isValid(targetId)) {
      return res.status(400).json({
        success: false,
        message: 'Valid targetId is required',
      });
    }

    // 1. Fetch Source Message
    const sourceMessage = await Message.findById(messageId);
    if (!sourceMessage) {
      return res.status(404).json({
        success: false,
        message: 'Source message not found',
      });
    }

    if (sourceMessage.deleted) {
      return res.status(400).json({
        success: false,
        message: 'Cannot forward a deleted message',
      });
    }

    // 2. Authorize Source Message Access
    if (sourceMessage.conversationId) {
      const sourceConv = await Conversation.findById(sourceMessage.conversationId);
      if (!sourceConv || !sourceConv.participants.some((p) => p.toString() === userId)) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to access the source conversation',
        });
      }
    } else if (sourceMessage.channelId) {
      const sourceChan = await Channel.findById(sourceMessage.channelId);
      if (!sourceChan || !sourceChan.members.some((m) => m.toString() === userId)) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to access the source channel',
        });
      }
    }

    const io = req.app.get('io');
    let newMessageDoc = null;

    // 3. Create Forwarded Message at Target
    if (targetType === 'conversation') {
      const destConv = await Conversation.findById(targetId);
      if (!destConv) {
        return res.status(404).json({
          success: false,
          message: 'Destination conversation not found',
        });
      }

      const isParticipant = destConv.participants.some((p) => p.toString() === userId);
      if (!isParticipant) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to send messages to destination conversation',
        });
      }

      const receiverId = destConv.participants.find((p) => p.toString() !== userId) || userId;
      const isSelf = receiverId.toString() === userId.toString();

      if (destConv.organization && destConv.organization.toString() !== req.user.currentOrganizationId) {
        return res.status(403).json({
          success: false,
          message: 'Destination conversation belongs to another organization',
        });
      }

      newMessageDoc = await Message.create({
        organization: destConv.organization,
        conversationId: destConv._id,
        sender: userId,
        receiver: receiverId,
        content: sourceMessage.content || '',
        messageType: sourceMessage.messageType || 'text',
        attachments: sourceMessage.attachments || [],
        forwarded: true,
        forwardedFrom: sourceMessage._id,
        isRead: isSelf ? true : false,
      });

      destConv.lastMessage = newMessageDoc._id;
      destConv.lastMessageAt = newMessageDoc.createdAt;
      await destConv.save();

      const populated = await Message.findById(newMessageDoc._id)
        .populate('sender', 'name email avatar')
        .populate('receiver', 'name email avatar')
        .populate({
          path: 'forwardedFrom',
          populate: { path: 'sender', select: 'name email avatar' },
        });

      if (io) {
        const rooms = [`conversation:${destConv._id.toString()}`];
        for (const p of destConv.participants || []) {
          const pid = (p._id || p).toString();
          if (pid !== userId) {
            rooms.push(`user:${pid}`);
          }
        }
        io.to(rooms).emit('message:new', { message: populated });

        await notifyDirectMessage({
          sender: populated.sender,
          receiverId,
          conversationId: destConv._id,
          messageId: populated._id,
          content: populated.content,
          attachments: populated.attachments,
          io,
        });
      }

      return res.status(201).json({
        success: true,
        message: populated,
      });
    } else {
      // Channel Target
      const destChan = await Channel.findById(targetId);
      if (!destChan) {
        return res.status(404).json({
          success: false,
          message: 'Destination channel not found',
        });
      }

      const isMember = destChan.members.some((m) => m.toString() === userId);
      if (!isMember) {
        return res.status(403).json({
          success: false,
          message: 'You must be a member of the destination channel to forward messages to it',
        });
      }

      if (destChan.organization && destChan.organization.toString() !== req.user.currentOrganizationId) {
        return res.status(403).json({
          success: false,
          message: 'Destination channel belongs to another organization',
        });
      }

      newMessageDoc = await Message.create({
        organization: destChan.organization,
        channelId: destChan._id,
        sender: userId,
        content: sourceMessage.content || '',
        messageType: sourceMessage.messageType || 'text',
        attachments: sourceMessage.attachments || [],
        forwarded: true,
        forwardedFrom: sourceMessage._id,
        isRead: false,
      });

      destChan.lastMessage = newMessageDoc._id;
      destChan.lastMessageAt = newMessageDoc.createdAt;
      await destChan.save();

      const populated = await Message.findById(newMessageDoc._id)
        .populate('sender', 'name email avatar')
        .populate({
          path: 'forwardedFrom',
          populate: { path: 'sender', select: 'name email avatar' },
        });

      if (io) {
        io.to(`channel:${destChan._id.toString()}`).emit('channel:message:new', {
          message: populated,
        });

        await notifyChannelMessage({
          sender: populated.sender,
          channel: destChan,
          messageId: populated._id,
          content: populated.content,
          attachments: populated.attachments,
          io,
        });
      }

      return res.status(201).json({
        success: true,
        message: populated,
      });
    }
  } catch (error) {
    console.error('Forward Message Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error forwarding message',
    });
  }
};

// Allowed emoji validation: must be 1-10 chars, no HTML/script
const isValidEmoji = (emoji) => {
  if (!emoji || typeof emoji !== 'string') return false;
  const trimmed = emoji.trim();
  if (trimmed.length === 0 || trimmed.length > 10) return false;
  // Reject anything that looks like HTML or script
  if (/<|>|script|javascript/i.test(trimmed)) return false;
  return true;
};

// @desc    Add a reaction to a message
// @route   POST /api/messages/:messageId/reactions
// @access  Private
const addReaction = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid messageId format',
      });
    }

    if (!isValidEmoji(emoji)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or missing emoji',
      });
    }

    const trimmedEmoji = emoji.trim();

    // 1. Fetch message
    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
      });
    }

    // 2. Reject reactions on deleted messages
    if (message.deleted) {
      return res.status(400).json({
        success: false,
        message: 'Cannot react to a deleted message',
      });
    }

    // 3. Authorization: verify user can access this message
    if (message.conversationId) {
      const conversation = await Conversation.findById(message.conversationId);
      if (!conversation || !conversation.participants.some((p) => p.toString() === userId)) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to react to this message',
        });
      }
    } else if (message.channelId) {
      const channel = await Channel.findById(message.channelId);
      if (!channel || !channel.members.some((m) => m.toString() === userId)) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to react to this message',
        });
      }
    }

    // 4. Atomic update: add user to existing emoji entry, or create new entry
    const existingReaction = message.reactions.find((r) => r.emoji === trimmedEmoji);

    if (existingReaction) {
      // Add user to existing emoji (atomic, no duplicates)
      await Message.updateOne(
        { _id: messageId, 'reactions.emoji': trimmedEmoji },
        { $addToSet: { 'reactions.$.users': userId } }
      );
    } else {
      // Create new reaction entry
      await Message.updateOne(
        { _id: messageId },
        { $push: { reactions: { emoji: trimmedEmoji, users: [userId] } } }
      );
    }

    // 5. Fetch updated reactions with populated user names
    const updated = await Message.findById(messageId)
      .select('reactions conversationId channelId')
      .populate('reactions.users', 'name');

    // 6. Socket.IO real-time emission
    const io = req.app.get('io');
    if (io) {
      const payload = {
        messageId: message._id,
        conversationId: message.conversationId,
        channelId: message.channelId,
        reactions: updated.reactions,
      };

      if (message.conversationId) {
        io.to(`conversation:${message.conversationId.toString()}`).emit('message:reaction:updated', payload);
        // Also emit to user rooms for participants not currently in conversation room
        if (message.receiver) {
          io.to(`user:${message.receiver.toString()}`).emit('message:reaction:updated', payload);
        }
        if (message.sender) {
          io.to(`user:${message.sender.toString()}`).emit('message:reaction:updated', payload);
        }
      } else if (message.channelId) {
        io.to(`channel:${message.channelId.toString()}`).emit('message:reaction:updated', payload);
      }
    }

    return res.status(200).json({
      success: true,
      reactions: updated.reactions,
    });
  } catch (error) {
    console.error('Add Reaction Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error adding reaction',
    });
  }
};

// @desc    Remove a reaction from a message
// @route   DELETE /api/messages/:messageId/reactions/:emoji
// @access  Private
const removeReaction = async (req, res) => {
  try {
    const { messageId, emoji } = req.params;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid messageId format',
      });
    }

    const decodedEmoji = decodeURIComponent(emoji).trim();
    if (!isValidEmoji(decodedEmoji)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid emoji',
      });
    }

    // 1. Fetch message
    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
      });
    }

    // 2. Authorization: verify user can access this message
    if (message.conversationId) {
      const conversation = await Conversation.findById(message.conversationId);
      if (!conversation || !conversation.participants.some((p) => p.toString() === userId)) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to modify reactions on this message',
        });
      }
    } else if (message.channelId) {
      const channel = await Channel.findById(message.channelId);
      if (!channel || !channel.members.some((m) => m.toString() === userId)) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to modify reactions on this message',
        });
      }
    }

    // 3. Atomic update: remove user from the emoji's users array
    await Message.updateOne(
      { _id: messageId, 'reactions.emoji': decodedEmoji },
      { $pull: { 'reactions.$.users': userId } }
    );

    // 4. Clean up: remove reaction entry if users array is now empty
    await Message.updateOne(
      { _id: messageId },
      { $pull: { reactions: { emoji: decodedEmoji, users: { $size: 0 } } } }
    );

    // 5. Fetch updated reactions with populated user names
    const updated = await Message.findById(messageId)
      .select('reactions conversationId channelId')
      .populate('reactions.users', 'name');

    // 6. Socket.IO real-time emission
    const io = req.app.get('io');
    if (io) {
      const payload = {
        messageId: message._id,
        conversationId: message.conversationId,
        channelId: message.channelId,
        reactions: updated.reactions,
      };

      if (message.conversationId) {
        io.to(`conversation:${message.conversationId.toString()}`).emit('message:reaction:updated', payload);
        if (message.receiver) {
          io.to(`user:${message.receiver.toString()}`).emit('message:reaction:updated', payload);
        }
        if (message.sender) {
          io.to(`user:${message.sender.toString()}`).emit('message:reaction:updated', payload);
        }
      } else if (message.channelId) {
        io.to(`channel:${message.channelId.toString()}`).emit('message:reaction:updated', payload);
      }
    }

    return res.status(200).json({
      success: true,
      reactions: updated.reactions,
    });
  } catch (error) {
    console.error('Remove Reaction Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error removing reaction',
    });
  }
};

module.exports = {
  markMessageAsRead,
  markMessagesAsRead,
  getMessageById,
  editMessage,
  deleteMessage,
  deleteMessageForMe,
  forwardMessage,
  addReaction,
  removeReaction,
};
