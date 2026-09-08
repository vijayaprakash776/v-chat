const mongoose = require('mongoose');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const Channel = require('../models/Channel');
const User = require('../models/User');

// Helper to escape regex special characters
const escapeRegex = (string) => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * Get IDs of all conversations and channels the user has permission to view in their active organization
 */
const getUserAccessibleScope = async (userId, orgId) => {
  if (!orgId) return { allowedConvIds: [], allowedChannelIds: [] };

  // 1. Accessible DM conversations in current org (where user is a participant)
  const userConversations = await Conversation.find({
    organization: orgId,
    participants: userId,
  }).select('_id');
  const allowedConvIds = userConversations.map((c) => c._id);

  // 2. Accessible channels in current org (public channels OR private channels where user is member/creator)
  const accessibleChannels = await Channel.find({
    organization: orgId,
    $or: [
      { isPrivate: false },
      { members: userId },
      { createdBy: userId },
    ],
  }).select('_id');
  const allowedChannelIds = accessibleChannels.map((ch) => ch._id);

  return { allowedConvIds, allowedChannelIds };
};

// @desc    Unified global search across messages, attachments, channels, and users in active org
// @route   GET /api/search
// @access  Private
const searchAll = async (req, res) => {
  try {
    const userId = req.user.id;
    const orgId = req.user.currentOrganizationId;
    const query = req.query.q ? req.query.q.trim() : '';
    const type = req.query.type || 'all'; // 'all' | 'messages' | 'files' | 'channels' | 'users'
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    if (!query || !orgId) {
      return res.status(200).json({
        success: true,
        query: '',
        results: {
          messages: [],
          files: [],
          channels: [],
          users: [],
        },
        totalCount: 0,
      });
    }

    const cleanQuery = query.replace(/^#+/, '').trim();
    const searchPattern = cleanQuery || query;
    const safeRegex = new RegExp(escapeRegex(searchPattern), 'i');
    const { allowedConvIds, allowedChannelIds } = await getUserAccessibleScope(userId, orgId);

    const results = {
      messages: [],
      files: [],
      channels: [],
      users: [],
    };

    // 1. Search Messages & Attachments (if type is 'all', 'messages', or 'files')
    if (['all', 'messages', 'files'].includes(type)) {
      const scopeFilter = {
        organization: orgId,
        $or: [
          { conversationId: { $in: allowedConvIds } },
          { channelId: { $in: allowedChannelIds } },
        ],
      };

      let messageContentFilter = {};
      if (type === 'messages') {
        messageContentFilter = { content: safeRegex };
      } else if (type === 'files') {
        messageContentFilter = {
          $or: [
            { 'attachments.fileName': safeRegex },
            { messageType: { $in: ['image', 'video', 'file'] } },
          ],
        };
      } else {
        // 'all'
        messageContentFilter = {
          $or: [
            { content: safeRegex },
            { 'attachments.fileName': safeRegex },
          ],
        };
      }

      const matchQuery = {
        ...scopeFilter,
        ...messageContentFilter,
        deleted: { $ne: true },
      };

      const matchedMessages = await Message.find(matchQuery)
        .populate('sender', 'name email avatar')
        .populate('receiver', 'name email avatar')
        .populate('channelId', 'name isPrivate')
        .populate('conversationId', 'participants')
        .populate({
          path: 'replyTo',
          populate: { path: 'sender', select: 'name email avatar' },
        })
        .populate({
          path: 'forwardedFrom',
          populate: { path: 'sender', select: 'name email avatar' },
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);

      // Segregate into text messages vs file attachments
      matchedMessages.forEach((msg) => {
        const hasMatchingFile = msg.attachments?.some((a) =>
          safeRegex.test(a.fileName)
        );

        if (hasMatchingFile || (type === 'files' && msg.attachments?.length > 0)) {
          results.files.push(msg);
        } else {
          results.messages.push(msg);
        }
      });
    }

    // 2. Search Channels (if type is 'all' or 'channels')
    if (['all', 'channels'].includes(type)) {
      const channelQuery = {
        organization: orgId,
        _id: { $in: allowedChannelIds },
        $or: [
          { name: safeRegex },
          { description: safeRegex },
        ],
      };

      results.channels = await Channel.find(channelQuery)
        .select('name description isPrivate members createdBy lastMessageAt')
        .limit(10);
    }

    // 3. Search Users in active organization (if type is 'all' or 'users')
    if (['all', 'users'].includes(type)) {
      const Membership = require('../models/Membership');
      const memberships = await Membership.find({
        organization: orgId,
        status: 'active',
      }).select('user');
      const orgUserIds = memberships.map((m) => m.user);

      results.users = await User.find({
        _id: { $in: orgUserIds },
        $or: [
          { name: safeRegex },
          { email: safeRegex },
        ],
      })
        .select('name email avatar')
        .limit(10);
    }

    const totalCount =
      results.messages.length +
      results.files.length +
      results.channels.length +
      results.users.length;

    return res.status(200).json({
      success: true,
      query,
      results,
      totalCount,
      page,
      limit,
    });
  } catch (error) {
    console.error('Search All Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error performing search',
    });
  }
};

// @desc    Search messages with advanced filters and pagination
// @route   GET /api/search/messages
// @access  Private
const searchMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const query = req.query.q ? req.query.q.trim() : '';
    const messageType = req.query.messageType; // 'text' | 'image' | 'file'
    const channelId = req.query.channelId;
    const conversationId = req.query.conversationId;
    const senderId = req.query.senderId;
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;
    const orgId = req.user.currentOrganizationId;
    const { allowedConvIds, allowedChannelIds } = await getUserAccessibleScope(userId, orgId);

    const conditions = [];

    // Context filter or full accessible scope
    if (channelId) {
      if (!allowedChannelIds.some((id) => id.toString() === channelId.toString())) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to search this channel',
        });
      }
      conditions.push({ channelId });
    } else if (conversationId) {
      if (!allowedConvIds.some((id) => id.toString() === conversationId.toString())) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to search this conversation',
        });
      }
      conditions.push({ conversationId });
    } else {
      conditions.push({
        $or: [
          { conversationId: { $in: allowedConvIds } },
          { channelId: { $in: allowedChannelIds } },
        ],
      });
    }

    // Text search query
    if (query) {
      const safeRegex = new RegExp(escapeRegex(query), 'i');
      conditions.push({
        $or: [
          { content: safeRegex },
          { 'attachments.fileName': safeRegex },
        ],
      });
    }

    // Message type filter
    if (messageType && ['text', 'image', 'video', 'file'].includes(messageType)) {
      conditions.push({ messageType });
    }

    // Sender filter
    if (senderId && mongoose.Types.ObjectId.isValid(senderId)) {
      conditions.push({ sender: senderId });
    }

    // Date range filter
    if (startDate || endDate) {
      const dateFilter = {};
      if (startDate) dateFilter.$gte = new Date(startDate);
      if (endDate) dateFilter.$lte = new Date(endDate);
      conditions.push({ createdAt: dateFilter });
    }

    // Filter out soft-deleted messages
    conditions.push({ deleted: { $ne: true } });

    const finalQuery = conditions.length > 0 ? { $and: conditions } : {};

    const [messages, totalCount] = await Promise.all([
      Message.find(finalQuery)
        .populate('sender', 'name email avatar')
        .populate('receiver', 'name email avatar')
        .populate('channelId', 'name isPrivate')
        .populate({
          path: 'replyTo',
          populate: { path: 'sender', select: 'name email avatar' },
        })
        .populate({
          path: 'forwardedFrom',
          populate: { path: 'sender', select: 'name email avatar' },
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Message.countDocuments(finalQuery),
    ]);

    return res.status(200).json({
      success: true,
      query,
      count: messages.length,
      totalCount,
      page,
      totalPages: Math.ceil(totalCount / limit) || 1,
      messages,
    });
  } catch (error) {
    console.error('Search Messages Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error searching messages',
    });
  }
};

module.exports = {
  searchAll,
  searchMessages,
};
