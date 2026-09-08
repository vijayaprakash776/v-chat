const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Channel = require('../models/Channel');
const Conversation = require('../models/Conversation');
const Membership = require('../models/Membership');

/**
 * Parse @mentions from text content and resolve against MongoDB Users
 * Matches @Name, @FirstName, or @all / @everyone
 * @param {string} content
 * @param {Array} scopeUsers - Array of users or user IDs in current chat/channel scope
 * @returns {Promise<{ users: Array, isAll: boolean }>} Matched users and whether @all was present
 */
const parseMentions = async (content, scopeUsers = []) => {
  if (!content || typeof content !== 'string' || !content.includes('@')) {
    return { users: [], isAll: false };
  }

  // Detect @all or @everyone robustly (standalone, with punctuation/brackets/formatting, but not inside emails)
  const isAll =
    /(?:^|[\s.,;:!?()\[\]{}'"*~_`])@(all|everyone)(?=[\s.,;:!?()\[\]{}'"*~_`]|$)/i.test(content) ||
    content.trim().toLowerCase() === '@all';

  try {
    // If no scope users provided, do not fall back to all users in the database (isolation requirement)
    if (!scopeUsers || scopeUsers.length === 0) {
      return { users: [], isAll };
    }

    // Resolve scopeUsers to populated User documents if they are raw IDs or missing name
    let resolvedUsers = scopeUsers;
    const firstItem = scopeUsers[0];
    const needsResolving = !firstItem || typeof firstItem !== 'object' || !firstItem.name;

    if (needsResolving) {
      const userIds = scopeUsers.map((u) => (u?._id || u?.id || u).toString());
      resolvedUsers = await User.find({ _id: { $in: userIds } }).select('_id name email avatar');
    }

    if (isAll) {
      return { users: resolvedUsers, isAll: true };
    }

    const matchedUsers = [];
    for (const user of resolvedUsers) {
      if (!user.name) continue;

      // Check full name with word boundary e.g. @Dinesh J
      const escapedFullName = user.name.trim().replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
      const fullNameRegex = new RegExp(`(?:^|[\\s.,;:!?()[\\]{}'"*~_\`])@${escapedFullName}\\b`, 'i');

      // Check first name e.g. @Dinesh
      const firstName = user.name.trim().split(' ')[0];
      const escapedFirstName = firstName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
      const firstNameRegex = new RegExp(`(?:^|[\\s.,;:!?()[\\]{}'"*~_\`])@${escapedFirstName}\\b`, 'i');

      if (fullNameRegex.test(content) || firstNameRegex.test(content)) {
        if (!matchedUsers.some((u) => (u._id || u).toString() === (user._id || user).toString())) {
          matchedUsers.push(user);
        }
      }
    }

    return { users: matchedUsers, isAll: false };
  } catch (err) {
    console.error('Error parsing mentions:', err.message);
    return { users: [], isAll: false };
  }
};

/**
 * Create and emit notification for a direct or group message (with @all and mention detection)
 */
const notifyDirectMessage = async ({
  sender,
  receiverId,
  conversationId,
  messageId,
  content = '',
  attachments = [],
  io,
}) => {
  try {
    const senderId = (sender._id || sender.id || sender).toString();
    const senderName = sender.name || 'A teammate';

    let preview = content ? content.trim() : '';
    if (!preview && attachments && attachments.length > 0) {
      const first = attachments[0];
      const isImg = first.fileType?.startsWith('image/');
      preview = isImg ? `Shared an image: ${first.fileName}` : `Shared a file: ${first.fileName}`;
    }
    const truncated = preview.length > 50 ? `${preview.slice(0, 47)}...` : preview;

    // Retrieve conversation fresh from the database to guarantee correct members
    const conversation = await Conversation.findById(conversationId)
      .select('participants organization memberSettings');

    if (!conversation) return [];

    let participantIds = (conversation.participants || []).map((p) => (p._id || p).toString());
    if (participantIds.length === 0 && receiverId) {
      participantIds.push(receiverId.toString());
    }

    // Exclude the sender
    let recipientIds = participantIds.filter((id) => id !== senderId);
    if (recipientIds.length === 0) return [];

    // Verify recipients belong to active organization
    if (conversation.organization) {
      const validMemberships = await Membership.find({
        organization: conversation.organization,
        user: { $in: recipientIds },
        status: 'active',
      }).select('user');
      const validSet = new Set(validMemberships.map((m) => m.user.toString()));
      recipientIds = recipientIds.filter((id) => validSet.has(id));
    }

    if (recipientIds.length === 0) return [];

    // Resolve recipient users for mention detection
    const recipientUsers = await User.find({ _id: { $in: recipientIds } }).select('_id name email avatar settings');
    const { users: mentionedUsers, isAll } = await parseMentions(content, recipientUsers);
    const mentionedUserIds = new Set(
      mentionedUsers.map((u) => (u._id || u.id || u).toString())
    );

    const notifications = [];

    for (const recipientId of recipientIds) {
      const isMentioned = isAll || mentionedUserIds.has(recipientId);

      const recipientUser = recipientUsers.find((u) => u._id.toString() === recipientId)
        || await User.findById(recipientId).select('settings');

      if (isMentioned && recipientUser?.settings?.notifications?.mentions === false) {
        continue;
      }
      if (!isMentioned && recipientUser?.settings?.notifications?.messages === false) {
        continue;
      }

      const recipientSettings = conversation?.memberSettings?.find(
        (setting) => setting?.userId?.toString() === recipientId
      );
      if (recipientSettings?.muted && !isMentioned) continue;

      const notifType = isMentioned ? 'mention' : 'message';
      let notificationContent = '';
      if (isAll) {
        notificationContent = `${senderName} mentioned @all: "${truncated}"`;
      } else if (isMentioned) {
        notificationContent = `${senderName} mentioned you: "${truncated}"`;
      } else {
        notificationContent = `${senderName}: "${truncated}"`;
      }

      const notification = await Notification.create({
        recipient: recipientId,
        organization: conversation?.organization || null,
        sender: senderId,
        type: notifType,
        content: notificationContent,
        conversationId,
        messageId,
        isRead: false,
      });

      const populated = await Notification.findById(notification._id)
        .populate('sender', 'name email avatar')
        .populate('conversationId');

      if (io) {
        io.to(`user:${recipientId}`).emit('notification:new', {
          notification: populated,
        });

        const unreadCount = await Notification.countDocuments({
          recipient: recipientId,
          isRead: false,
          ...(conversation?.organization ? { organization: conversation.organization } : {}),
        });
        io.to(`user:${recipientId}`).emit('notification:unread_count', {
          unreadCount,
        });
      }

      notifications.push(populated);
    }

    return notifications;
  } catch (err) {
    console.error('Error creating DM notification:', err.message);
    return [];
  }
};

/**
 * Create and emit notifications for a channel message (with mention and @all detection)
 */
const notifyChannelMessage = async ({
  sender,
  channel,
  channelId: explicitChannelId,
  messageId,
  content = '',
  attachments = [],
  io,
}) => {
  try {
    const senderId = (sender._id || sender.id || sender).toString();
    const senderName = sender.name || 'A teammate';
    const channelId = explicitChannelId || (channel?._id || channel?.id || channel)?.toString();

    if (!channelId) return [];

    // Query channel fresh from the database to guarantee accurate members & settings
    const channelDoc = await Channel.findById(channelId)
      .select('name isPrivate organization members memberSettings');

    if (!channelDoc) return [];

    const channelName = channelDoc.name || 'channel';
    let memberIds = (channelDoc.members || []).map((m) => (m._id || m).toString());

    // Exclude sender
    let recipientIds = memberIds.filter((id) => id !== senderId);
    if (recipientIds.length === 0) return [];

    // Organization boundary: ensure recipients belong to channel's active organization
    if (channelDoc.organization) {
      const validMemberships = await Membership.find({
        organization: channelDoc.organization,
        user: { $in: recipientIds },
        status: 'active',
      }).select('user');
      const validSet = new Set(validMemberships.map((m) => m.user.toString()));
      recipientIds = recipientIds.filter((id) => validSet.has(id));
    }

    if (recipientIds.length === 0) return [];

    // Fetch user info for mention parsing and settings
    const recipientUsers = await User.find({ _id: { $in: recipientIds } }).select('_id name email avatar settings');
    const { users: mentionedUsers, isAll } = await parseMentions(content, recipientUsers);
    const mentionedUserIds = new Set(
      mentionedUsers.map((u) => (u._id || u.id || u).toString())
    );

    const notifications = [];

    for (const memberId of recipientIds) {
      const isMentioned = isAll || mentionedUserIds.has(memberId);

      const recipientUser = recipientUsers.find((u) => u._id.toString() === memberId)
        || await User.findById(memberId).select('settings');

      if (isMentioned && recipientUser?.settings?.notifications?.mentions === false) {
        continue;
      }
      if (!isMentioned && recipientUser?.settings?.notifications?.messages === false) {
        continue;
      }

      const memberSettings = channelDoc.memberSettings?.find(
        (setting) => setting?.userId?.toString() === memberId
      );
      if (memberSettings?.muted && !isMentioned) continue;

      const notifType = isMentioned ? 'mention' : 'channel_activity';

      let notifContent = '';
      if (isAll) {
        notifContent = `${senderName} mentioned @all in #${channelName}`;
      } else if (isMentioned) {
        notifContent = `${senderName} mentioned you in #${channelName}`;
      } else if (content && content.trim()) {
        notifContent = `New message in #${channelName} from ${senderName}`;
      } else if (attachments && attachments.length > 0) {
        notifContent = `${senderName} shared an attachment in #${channelName}`;
      } else {
        notifContent = `New activity in #${channelName} from ${senderName}`;
      }

      const notification = await Notification.create({
        recipient: memberId,
        organization: channelDoc.organization || null,
        sender: senderId,
        type: notifType,
        content: notifContent,
        channelId: channelDoc._id,
        messageId,
        isRead: false,
      });

      const populated = await Notification.findById(notification._id)
        .populate('sender', 'name email avatar')
        .populate('channelId', 'name isPrivate');

      if (io) {
        io.to(`user:${memberId}`).emit('notification:new', {
          notification: populated,
        });

        const unreadCount = await Notification.countDocuments({
          recipient: memberId,
          isRead: false,
          ...(channelDoc.organization ? { organization: channelDoc.organization } : {}),
        });
        io.to(`user:${memberId}`).emit('notification:unread_count', {
          unreadCount,
        });
      }

      notifications.push(populated);
    }

    return notifications;
  } catch (err) {
    console.error('Error creating channel notification:', err.message);
    return [];
  }
};

/**
 * Create and emit notification when a Todo is assigned to a teammate
 */
const notifyTodoAssigned = async ({ creator, assigneeId, todo, io }) => {
  try {
    const creatorId = (creator._id || creator.id || creator).toString();
    const recipientId = (assigneeId._id || assigneeId.id || assigneeId).toString();

    // Never notify self
    if (creatorId === recipientId) return null;

    const creatorName = creator.name || 'A teammate';
    const todoTitle = todo.title ? todo.title.trim() : 'a new task';
    const truncatedTitle = todoTitle.length > 45 ? `${todoTitle.slice(0, 42)}...` : todoTitle;
    const notificationContent = `${creatorName} assigned you a To-Do: "${truncatedTitle}"`;

    const notification = await Notification.create({
      recipient: recipientId,
      organization: todo.organization || null,
      sender: creatorId,
      type: 'todo_assigned',
      content: notificationContent,
      conversationId: todo.conversationId || null,
      channelId: todo.channelId || null,
      todoId: todo._id,
      isRead: false,
    });

    const populated = await Notification.findById(notification._id)
      .populate('sender', 'name email avatar')
      .populate('conversationId')
      .populate('channelId', 'name isPrivate')
      .populate('todoId');

    if (io) {
      io.to(`user:${recipientId}`).emit('notification:new', {
        notification: populated,
      });
    }

    return populated;
  } catch (err) {
    console.error('Error creating Todo notification:', err.message);
    return null;
  }
};

module.exports = {
  parseMentions,
  notifyDirectMessage,
  notifyChannelMessage,
  notifyTodoAssigned,
};
