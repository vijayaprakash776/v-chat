const mongoose = require('mongoose');
const Channel = require('../models/Channel');
const Message = require('../models/Message');
const User = require('../models/User');
const Membership = require('../models/Membership');
const Organization = require('../models/Organization');
const OrganizationSettings = require('../models/OrganizationSettings');
const { notifyChannelMessage } = require('../services/notificationService');
const { getPlanEntitlements, getMessageHistoryCutoffDate } = require('../config/plans');

// @desc    Create a new channel
// @route   POST /api/channels
// @access  Private
const createChannel = async (req, res) => {
  try {
    const { name, description = '', isPrivate = false, isAdminOnly = false, adminOnly = false } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role || 'user';
    const isPrivateBool = Boolean(isPrivate);
    const isAdminOnlyBool = Boolean(isAdminOnly || adminOnly);

    // Enforce Organization Settings for channel creation
    const orgSettings = await OrganizationSettings.getSettings();
    if (userRole !== 'admin') {
      if (!orgSettings.allowUserChannelCreation) {
        return res.status(403).json({
          success: false,
          message: 'Channel creation by non-admin users is currently disabled by organization policy.',
        });
      }
      if (isPrivateBool && !orgSettings.allowPrivateChannels) {
        return res.status(403).json({
          success: false,
          message: 'Private channel creation is disabled by organization policy.',
        });
      }
      if (!isPrivateBool && !orgSettings.allowPublicChannels) {
        return res.status(403).json({
          success: false,
          message: 'Public channel creation is disabled by organization policy.',
        });
      }
    }

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Channel name is required',
      });
    }

    // Clean name (strip leading # if user entered it)
    const cleanName = name.trim().replace(/^#+/, '');

    // Check if channel name is already taken in this organization
    const orgId = req.user.currentOrganizationId;

    // Enforce Plan Channel Limit (Max 10 channels for Free plan, unlimited for Professional)
    if (orgId) {
      const organization = await Organization.findById(orgId).select('subscription').lean();
      const planEntitlements = getPlanEntitlements(organization?.subscription?.plan);
      if (planEntitlements.maxChannels !== null) {
        const currentChannelCount = await Channel.countDocuments({ organization: orgId });
        if (currentChannelCount >= planEntitlements.maxChannels) {
          return res.status(403).json({
            success: false,
            message: `Free plan channel limit reached (${planEntitlements.maxChannels} channels maximum). Upgrade to Professional for unlimited channels.`,
            code: 'PLAN_LIMIT_REACHED',
          });
        }
      }
    }

    const existingChannel = await Channel.findOne({
      organization: orgId,
      name: { $regex: new RegExp(`^${cleanName}$`, 'i') },
    });

    if (existingChannel) {
      return res.status(409).json({
        success: false,
        message: `Channel '#${cleanName}' already exists in this workspace`,
      });
    }

    // Create channel with creator as the first member and first admin
    const newChannel = await Channel.create({
      organization: orgId,
      name: cleanName,
      description: description.trim(),
      createdBy: userId,
      members: [userId],
      admins: [userId],
      isAdminOnly: isAdminOnlyBool,
      isPrivate: isPrivateBool,
      isArchived: false,
      lastMessageAt: new Date(),
    });

    const populatedChannel = await Channel.findById(newChannel._id)
      .populate('members', 'name email avatar')
      .populate('admins', 'name email avatar')
      .populate('createdBy', 'name email avatar');

    // Real-Time Socket.IO emission
    const io = req.app.get('io');
    if (io) {
      if (newChannel.isPrivate) {
        // Only emit to creator's personal room for privacy
        io.to(`user:${userId}`).emit('channel:created', { channel: populatedChannel });
      } else {
        // Broadcast to company room only
        io.to(`company:${orgId}`).emit('channel:created', { channel: populatedChannel });
      }
    }

    return res.status(201).json({
      success: true,
      channel: populatedChannel,
    });
  } catch (error) {
    console.error('Create Channel Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error creating channel',
    });
  }
};

// @desc    Get all accessible channels for user in current organization
// @route   GET /api/channels
// @access  Private
const getChannels = async (req, res) => {
  try {
    const userId = req.user.id;
    const orgId = req.user.currentOrganizationId;

    if (!orgId) {
      return res.status(200).json({
        success: true,
        count: 0,
        channels: [],
      });
    }

    // Return all public channels OR private channels the user is a member of WITHIN current organization
    const channels = await Channel.find({
      organization: orgId,
      $or: [{ isPrivate: false }, { members: userId }],
    })
      .populate('members', 'name email avatar')
      .populate('admins', 'name email avatar')
      .populate('createdBy', 'name email avatar')
      .populate({
        path: 'lastMessage',
        populate: { path: 'sender', select: 'name email avatar' },
      })
      .sort({ lastMessageAt: -1, updatedAt: -1 });

    // Ensure only members with valid membership in this organization are shown in channel members
    const orgMemberships = await Membership.find({ organization: orgId }).select('user');
    const validMemberIds = new Set(orgMemberships.map((m) => m.user.toString()));

    const sanitizedChannels = channels.map((ch) => {
      const chObj = ch.toObject();
      chObj.members = (chObj.members || []).filter((m) => validMemberIds.has(m._id ? m._id.toString() : m.toString()));
      return chObj;
    });

    // Calculate persistent unread message count for each channel for requesting user
    const channelsWithUnread = await Promise.all(
      sanitizedChannels.map(async (ch) => {
        const unreadCount = await Message.countDocuments({
          channelId: ch._id,
          sender: { $ne: userId },
          'readBy.userId': { $ne: userId },
        });
        return { ...ch, unread: unreadCount };
      })
    );

    return res.status(200).json({
      success: true,
      count: channelsWithUnread.length,
      channels: channelsWithUnread,
    });
  } catch (error) {
    console.error('Get Channels Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching channels',
    });
  }
};

const updateChannelSetting = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { muted } = req.body;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid channel ID format' });
    if (typeof muted !== 'boolean') return res.status(400).json({ success: false, message: 'muted must be boolean' });
    const channel = await Channel.findOne({ _id: id, members: userId });
    if (!channel) return res.status(403).json({ success: false, message: 'Not authorized to update this channel' });
    let setting = channel.memberSettings.find((item) => item.userId.toString() === userId);
    if (!setting) {
      channel.memberSettings.push({ userId });
      setting = channel.memberSettings[channel.memberSettings.length - 1];
    }
    setting.muted = muted;
    await channel.save();
    return res.status(200).json({ success: true, settings: setting });
  } catch (error) {
    console.error('Update Channel Setting Error:', error.message);
    return res.status(500).json({ success: false, message: 'Server error updating channel settings' });
  }
};

// @desc    Get channel details by ID
// @route   GET /api/channels/:id
// @access  Private
const getChannel = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid channel ID format',
      });
    }

    const channel = await Channel.findById(id)
      .populate('members', 'name email avatar')
      .populate('admins', 'name email avatar')
      .populate('createdBy', 'name email avatar')
      .populate({
        path: 'lastMessage',
        populate: { path: 'sender', select: 'name email avatar' },
      });

    if (!channel) {
      return res.status(404).json({
        success: false,
        message: 'Channel not found',
      });
    }

    // Enforce Company Isolation
    if (channel.organization && channel.organization.toString() !== req.user.currentOrganizationId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Channel belongs to another workspace',
      });
    }

    // If private, verify user is a member
    if (channel.isPrivate) {
      const isMember = channel.members.some(
        (m) => (m._id || m).toString() === userId
      );
      if (!isMember) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to view this private channel',
        });
      }
    }

    // Ensure only members with valid membership in this organization are shown
    if (channel.organization) {
      const orgMemberships = await Membership.find({ organization: channel.organization }).select('user');
      const validMemberIds = new Set(orgMemberships.map((m) => m.user.toString()));
      channel.members = channel.members.filter((m) => validMemberIds.has((m._id || m).toString()));
    }

    return res.status(200).json({
      success: true,
      channel,
    });
  } catch (error) {
    console.error('Get Channel Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching channel',
    });
  }
};

// @desc    Join a channel
// @route   POST /api/channels/:id/join
// @access  Private
const joinChannel = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid channel ID format',
      });
    }

    const channel = await Channel.findById(id);
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: 'Channel not found',
      });
    }

    // Enforce Company Isolation
    if (channel.organization && channel.organization.toString() !== req.user.currentOrganizationId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Channel belongs to another workspace',
      });
    }

    // If private, only creator/members can add
    if (channel.isPrivate && channel.createdBy.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Cannot self-join private channel without invite',
      });
    }

    // Add user to members if not already a member
    const alreadyMember = channel.members.some((m) => m.toString() === userId);
    if (!alreadyMember) {
      channel.members.push(userId);
      await channel.save();
    }

    const populated = await Channel.findById(id)
      .populate('members', 'name email avatar')
      .populate('admins', 'name email avatar')
      .populate('createdBy', 'name email avatar')
      .populate({
        path: 'lastMessage',
        populate: { path: 'sender', select: 'name email avatar' },
      });

    const io = req.app.get('io');
    if (io) {
      io.to(`company:${channel.organization}`).emit('channel:updated', { channel: populated });
    }

    return res.status(200).json({
      success: true,
      channel: populated,
    });
  } catch (error) {
    console.error('Join Channel Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error joining channel',
    });
  }
};

// @desc    Add / invite members to a channel (restricted to creator or admin for private channels)
// @route   POST /api/channels/:id/members
// @access  Private
const addChannelMembers = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;
    const orgId = req.user.currentOrganizationId;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid channel ID format',
      });
    }

    const channel = await Channel.findById(id);
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: 'Channel not found',
      });
    }

    // Enforce Company Isolation
    if (channel.organization && channel.organization.toString() !== orgId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Channel belongs to another workspace',
      });
    }

    // Permission check for private channels: only creator or admin
    const isCreator = channel.createdBy?.toString() === userId;
    const isAdmin = userRole === 'admin';
    if (channel.isPrivate && !isCreator && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Only the channel creator or an organization admin can invite members to this private channel',
      });
    }

    // Parse userIds from body (can be array userIds or single userId)
    let { userIds } = req.body;
    if (!userIds && req.body.userId) {
      userIds = [req.body.userId];
    }

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide at least one user ID to add',
      });
    }

    // Filter valid ObjectIds
    const validIds = userIds.filter((uid) => mongoose.Types.ObjectId.isValid(uid));
    if (validIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid user IDs provided',
      });
    }

    // Verify all invitees belong to the same active organization
    const activeMemberships = await Membership.find({
      user: { $in: validIds },
      organization: channel.organization,
      status: 'active',
    }).select('user');

    const verifiedUserIds = activeMemberships.map((m) => m.user.toString());
    if (verifiedUserIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'None of the selected users are active members of this workspace',
      });
    }

    // Filter out users who are already channel members
    const existingMemberIds = channel.members.map((m) => m.toString());
    const toAdd = verifiedUserIds.filter((uid) => !existingMemberIds.includes(uid));

    if (toAdd.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'All selected users are already members of this channel',
      });
    }

    // Add new members
    channel.members.push(...toAdd);
    await channel.save();

    const populated = await Channel.findById(id)
      .populate('members', 'name email avatar')
      .populate('createdBy', 'name email avatar')
      .populate({
        path: 'lastMessage',
        populate: { path: 'sender', select: 'name email avatar' },
      });

    // Real-Time Socket.IO emission
    const io = req.app.get('io');
    if (io) {
      // 1. Notify channel room
      io.to(`channel:${id}`).emit('channel:updated', {
        channel: populated,
        addedUserIds: toAdd,
      });

      // 2. Notify company room
      io.to(`company:${channel.organization}`).emit('channel:updated', {
        channel: populated,
        addedUserIds: toAdd,
      });

      // 3. Notify newly added users in their personal user rooms so the private channel appears immediately
      toAdd.forEach((newUid) => {
        io.to(`user:${newUid}`).emit('channel:created', { channel: populated });
        io.to(`user:${newUid}`).emit('channel:updated', { channel: populated, addedUserIds: toAdd });
      });
    }

    return res.status(200).json({
      success: true,
      message: `Successfully added ${toAdd.length} member${toAdd.length > 1 ? 's' : ''} to #${channel.name}`,
      channel: populated,
      addedMembers: toAdd,
    });
  } catch (error) {
    console.error('Add Channel Members Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error adding channel members',
    });
  }
};

// @desc    Leave a channel
// @route   POST /api/channels/:id/leave
// @access  Private
const leaveChannel = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid channel ID format',
      });
    }

    const channel = await Channel.findById(id);
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: 'Channel not found',
      });
    }

    // Enforce Company Isolation
    if (channel.organization && channel.organization.toString() !== req.user.currentOrganizationId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Channel belongs to another workspace',
      });
    }

    // Remove user from members array
    channel.members = channel.members.filter((m) => m.toString() !== userId);
    await channel.save();

    const populated = await Channel.findById(id)
      .populate('members', 'name email avatar')
      .populate({
        path: 'lastMessage',
        populate: { path: 'sender', select: 'name email avatar' },
      });

    const io = req.app.get('io');
    if (io) {
      io.to(`company:${channel.organization}`).emit('channel:updated', { channel: populated, leftUserId: userId });
    }

    return res.status(200).json({
      success: true,
      message: `Left channel #${channel.name} successfully`,
      channelId: id,
    });
  } catch (error) {
    console.error('Leave Channel Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error leaving channel',
    });
  }
};

// @desc    Get channel message history
// @route   GET /api/channels/:id/messages
// @access  Private
const getChannelMessages = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid channel ID format',
      });
    }

    const channel = await Channel.findById(id);
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: 'Channel not found',
      });
    }

    // Enforce Company Isolation
    if (channel.organization && channel.organization.toString() !== req.user.currentOrganizationId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Channel belongs to another workspace',
      });
    }

    // Authorization: User must be a member to read channel messages
    const isMember = channel.members.some((m) => m.toString() === userId);
    if (!isMember) {
      return res.status(403).json({
        success: false,
        message: 'You must join this channel to view messages',
      });
    }

    const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10) || 50, 100) : 0;
    const before = req.query.before;

    // Apply plan message history cutoff if on FREE plan (100 days)
    const organization = channel.organization ? await Organization.findById(channel.organization).select('subscription').lean() : null;
    const cutoffDate = getMessageHistoryCutoffDate(organization?.subscription?.plan);

    const query = {
      channelId: id,
      deletedFor: { $ne: userId },
    };
    if (cutoffDate) {
      query.createdAt = { $gte: cutoffDate };
    }
    if (before) {
      const beforeDate = new Date(before);
      if (!isNaN(beforeDate.getTime())) {
        query.createdAt = query.createdAt ? { ...query.createdAt, $lt: beforeDate } : { $lt: beforeDate };
      }
    }

    const messagesQuery = Message.find(query)
      .populate('sender', 'name email avatar')
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
        const olderCountQuery = {
          channelId: id,
          createdAt: { $lt: oldestMessageDate },
        };
        if (cutoffDate) {
          olderCountQuery.createdAt.$gte = cutoffDate;
        }
        const olderCount = await Message.countDocuments(olderCountQuery);
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
    console.error('Get Channel Messages Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching channel messages',
    });
  }
};

// @desc    Send a message in a channel (with optional file attachments)
// @route   POST /api/channels/:id/messages
// @access  Private
const sendChannelMessage = async (req, res) => {
  try {
    const { id } = req.params;
    let content = req.body.content ? req.body.content.trim() : '';
    const replyTo = req.body.replyTo ? req.body.replyTo.toString().trim() : null;
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

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid channel ID format',
      });
    }

    const channel = await Channel.findById(id);
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: 'Channel not found',
      });
    }

    // Enforce Company Isolation
    if (channel.organization && channel.organization.toString() !== req.user.currentOrganizationId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Channel belongs to another workspace',
      });
    }

    if (channel.isArchived && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'This channel has been archived. New messages cannot be posted.',
      });
    }

    const senderIdStr = senderId.toString();

    // Authorization: User must be a member to send channel messages
    const isMember = (channel.members || []).some((m) => (m?._id || m?.id || m)?.toString() === senderIdStr);
    if (!isMember) {
      return res.status(403).json({
        success: false,
        message: 'You must join this channel to send messages',
      });
    }

    // Admin Only Channel Check: Only channel admins, creator, or org admins can post top-level announcements.
    // Non-admin members are permitted to reply to existing messages in the channel.
    if (channel.isAdminOnly) {
      const creatorIdStr = (channel.createdBy?._id || channel.createdBy?.id || channel.createdBy)?.toString();
      const isCreator = Boolean(creatorIdStr && creatorIdStr === senderIdStr);
      const isChannelAdmin = (channel.admins || []).some(
        (a) => (a?._id || a?.id || a)?.toString() === senderIdStr
      );
      const isOrgAdmin = ['admin', 'owner', 'super_admin'].includes(req.user.role) || ['admin', 'owner', 'super_admin'].includes(req.user.globalRole);

      if (!isCreator && !isChannelAdmin && !isOrgAdmin) {
        if (!replyTo) {
          return res.status(403).json({
            success: false,
            message: 'Only channel admins can send messages in this channel',
          });
        }

        if (!mongoose.Types.ObjectId.isValid(replyTo)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid reply message ID format',
          });
        }

        const parentMessage = await Message.findOne({
          _id: replyTo,
          channelId: id,
        });

        if (!parentMessage) {
          return res.status(400).json({
            success: false,
            message: 'Referenced message to reply to was not found in this channel',
          });
        }
      }
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

    // Create channel message in MongoDB
    const newMessage = await Message.create({
      organization: channel.organization,
      channelId: id,
      sender: senderId,
      content,
      messageType,
      attachments,
      poll,
      replyTo: replyTo && mongoose.Types.ObjectId.isValid(replyTo) ? replyTo : null,
      isRead: false,
    });

    // Update Channel lastMessage metadata
    channel.lastMessage = newMessage._id;
    channel.lastMessageAt = newMessage.createdAt;
    await channel.save();

    // Populate sender and references
    const populatedMessage = await Message.findById(newMessage._id)
      .populate('sender', 'name email avatar')
      .populate({
        path: 'replyTo',
        populate: { path: 'sender', select: 'name email avatar' },
      })
      .populate({
        path: 'forwardedFrom',
        populate: { path: 'sender', select: 'name email avatar' },
      });

    // Real-Time Socket.IO event emission to channel room
    const io = req.app.get('io');
    if (io) {
      io.to(`channel:${id}`).emit('channel:message:new', {
        message: populatedMessage,
      });

      // Dispatch channel activity & mention notifications to members
      await notifyChannelMessage({
        sender: populatedMessage.sender,
        channel,
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
    console.error('Send Channel Message Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error sending channel message',
    });
  }
};

// Auto-seed default team channels if database collection is empty
const seedDefaultChannels = async () => {
  try {
    const count = await Channel.countDocuments();
    if (count === 0) {
      const firstUser = await User.findOne();
      const creatorId = firstUser ? firstUser._id : new mongoose.Types.ObjectId();
      const allUsers = await User.find().select('_id');
      const allUserIds = allUsers.map((u) => u._id);

      const defaultChannels = [
        {
          name: 'General',
          description: 'General team discussions, announcements, and office chatter',
          createdBy: creatorId,
          members: allUserIds,
          isPrivate: false,
        },
        {
          name: 'Android Team',
          description: 'Android mobile application development discussions and releases',
          createdBy: creatorId,
          members: allUserIds,
          isPrivate: false,
        },
        {
          name: 'HRMS',
          description: 'Human Resource Management System project updates and sprints',
          createdBy: creatorId,
          members: allUserIds,
          isPrivate: false,
        },
        {
          name: 'Ad Promo Team',
          description: 'Marketing campaigns, user acquisitions, and promotional events',
          createdBy: creatorId,
          members: allUserIds,
          isPrivate: false,
        },
        {
          name: 'Project Testing',
          description: 'QA testing results, bug tracking, and stability verification',
          createdBy: creatorId,
          members: allUserIds,
          isPrivate: false,
        },
      ];

      await Channel.insertMany(defaultChannels);
      console.log('Default team channels successfully seeded into MongoDB');
    }
  } catch (err) {
    console.error('Channel Seeding Error:', err.message);
  }
};

// @desc    Update channel details (name, description)
// @route   PUT /api/channels/:id (or PATCH)
// @access  Private (Creator or Admin only)
const updateChannel = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid channel ID format',
      });
    }

    const channel = await Channel.findById(id);
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: 'Channel not found',
      });
    }

    // Enforce Company Isolation
    if (channel.organization && channel.organization.toString() !== req.user.currentOrganizationId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Channel belongs to another workspace',
      });
    }

    // Only creator or admin can update channel details
    const userIdStr = userId.toString();
    const creatorIdStr = (channel.createdBy?._id || channel.createdBy?.id || channel.createdBy)?.toString();
    const isCreator = Boolean(creatorIdStr && creatorIdStr === userIdStr);
    const isChannelAdmin = (channel.admins || []).some(
      (a) => (a?._id || a?.id || a)?.toString() === userIdStr
    );
    const isAdmin = ['admin', 'owner'].includes(userRole);

    if (!isCreator && !isChannelAdmin && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Only the channel creator or an admin can edit this channel',
      });
    }

    if (name && typeof name === 'string' && name.trim()) {
      const cleanName = name.trim().replace(/^#+/, '');
      // Check if new name collides with another channel in this organization
      const existing = await Channel.findOne({
        _id: { $ne: id },
        organization: channel.organization,
        name: { $regex: new RegExp(`^${cleanName}$`, 'i') },
      });
      if (existing) {
        return res.status(409).json({
          success: false,
          message: `Channel '#${cleanName}' already exists`,
        });
      }
      channel.name = cleanName;
    }

    if (description !== undefined && typeof description === 'string') {
      channel.description = description.trim();
    }

    const { isAdminOnly, adminOnly } = req.body;
    if (isAdminOnly !== undefined || adminOnly !== undefined) {
      channel.isAdminOnly = Boolean(isAdminOnly !== undefined ? isAdminOnly : adminOnly);
    }

    await channel.save();

    const populated = await Channel.findById(id)
      .populate('members', 'name email avatar')
      .populate('admins', 'name email avatar')
      .populate('createdBy', 'name email avatar')
      .populate({
        path: 'lastMessage',
        populate: { path: 'sender', select: 'name email avatar' },
      });

    // Real-Time Socket.IO emission to company members
    const io = req.app.get('io');
    if (io) {
      io.to(`company:${channel.organization}`).emit('channel:updated', { channel: populated });
      io.to(`channel:${id}`).emit('channel:updated', { channel: populated });
    }

    return res.status(200).json({
      success: true,
      message: 'Channel updated successfully',
      channel: populated,
    });
  } catch (error) {
    console.error('Update Channel Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error updating channel',
    });
  }
};

// @desc    Promote a channel member to Channel Admin
// @route   POST /api/channels/:id/admins
// @access  Private (Channel Admin, Creator, or Org Admin)
const promoteChannelAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    let { userId: targetUserId } = req.body;
    if (!targetUserId && req.body.memberId) {
      targetUserId = req.body.memberId;
    }

    const currentUserId = req.user.id;
    const userRole = req.user.role;

    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(targetUserId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid channel ID or target user ID format',
      });
    }

    const channel = await Channel.findById(id);
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: 'Channel not found',
      });
    }

    // Enforce Company Isolation
    if (channel.organization && channel.organization.toString() !== req.user.currentOrganizationId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Channel belongs to another workspace',
      });
    }

    // Check permission: requester must be channel creator, channel admin, or org admin
    const currentUserIdStr = currentUserId.toString();
    const creatorIdStr = (channel.createdBy?._id || channel.createdBy?.id || channel.createdBy)?.toString();
    const isCreator = Boolean(creatorIdStr && creatorIdStr === currentUserIdStr);
    const isChannelAdmin = (channel.admins || []).some(
      (a) => (a?._id || a?.id || a)?.toString() === currentUserIdStr
    );
    const isOrgAdmin = ['admin', 'owner'].includes(userRole);

    if (!isCreator && !isChannelAdmin && !isOrgAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Only channel admins can promote members to admin',
      });
    }

    // Verify target user is a member of the channel
    const isMember = (channel.members || []).some(
      (m) => (m?._id || m?.id || m)?.toString() === targetUserId.toString()
    );
    if (!isMember) {
      return res.status(400).json({
        success: false,
        message: 'Target user must be a member of the channel to be promoted',
      });
    }

    // Add targetUserId to admins if not already present
    const alreadyAdmin = (channel.admins || []).some((a) => a.toString() === targetUserId.toString());
    if (!alreadyAdmin) {
      if (!channel.admins) channel.admins = [];
      channel.admins.push(targetUserId);
      await channel.save();
    }

    const populated = await Channel.findById(id)
      .populate('members', 'name email avatar')
      .populate('admins', 'name email avatar')
      .populate('createdBy', 'name email avatar')
      .populate({
        path: 'lastMessage',
        populate: { path: 'sender', select: 'name email avatar' },
      });

    // Real-Time Socket.IO emission to company, channel, and target user
    const io = req.app.get('io');
    if (io) {
      io.to(`channel:${id}`).emit('channel:updated', { channel: populated });
      io.to(`company:${channel.organization}`).emit('channel:updated', { channel: populated });
      io.to(`user:${targetUserId}`).emit('channel:updated', { channel: populated });
    }

    return res.status(200).json({
      success: true,
      message: 'Member promoted to Channel Admin successfully',
      channel: populated,
    });
  } catch (error) {
    console.error('Promote Channel Admin Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error promoting channel admin',
    });
  }
};

// @desc    Get organization channel policy settings for client-side capability checking
// @route   GET /api/channels/settings/organization
// @access  Private
const getPublicOrganizationSettings = async (req, res) => {
  try {
    const settings = await OrganizationSettings.getSettings();
    return res.status(200).json({
      success: true,
      settings: {
        allowPublicChannels: settings.allowPublicChannels,
        allowPrivateChannels: settings.allowPrivateChannels,
        allowUserChannelCreation: settings.allowUserChannelCreation,
      },
    });
  } catch (error) {
    console.error('Get Public Org Settings Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching organization settings',
    });
  }
};

module.exports = {
  createChannel,
  getChannels,
  updateChannel,
  promoteChannelAdmin,
  updateChannelSetting,
  getChannel,
  joinChannel,
  leaveChannel,
  addChannelMembers,
  getChannelMessages,
  sendChannelMessage,
  seedDefaultChannels,
  getPublicOrganizationSettings,
};
