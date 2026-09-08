const mongoose = require('mongoose');
const User = require('../models/User');
const Membership = require('../models/Membership');

// @desc    Get all registered team users in the active organization (excluding the logged-in user)
// @route   GET /api/users
// @access  Private
const getTeamUsers = async (req, res) => {
  try {
    const currentUserId = req.user.id || req.user._id?.toString();
    const currentOrgId = req.user.currentOrganizationId || req.user.currentOrganization?._id?.toString() || req.user.currentOrganization?.toString();

    if (!currentOrgId) {
      return res.status(200).json({
        success: true,
        count: 0,
        users: [],
      });
    }

    // Find all active memberships in this organization and populate the user details
    const memberships = await Membership.find({
      organization: currentOrgId,
      status: 'active',
    })
      .populate({
        path: 'user',
        select: '-password',
      })
      .sort({ createdAt: 1 });

    // Filter out:
    // 1. Memberships where user document is missing or deleted
    // 2. Memberships where user is marked inactive
    // 3. The currently authenticated user (exclude self from team directory)
    const validMembers = memberships.filter((m) => {
      if (!m.user || !m.user._id) return false;
      if (m.user.status === 'inactive') return false;
      if (m.user._id.toString() === currentUserId.toString()) return false;
      return true;
    });

    // Format the returned user list with organization membership role
    const users = validMembers.map((m) => {
      const userDoc = m.user.toObject ? m.user.toObject() : { ...m.user };
      const userCopy = {
        ...userDoc,
        id: userDoc._id.toString(),
        role: m.role || userDoc.role || 'member',
        membershipRole: m.role || 'member',
        membershipId: m._id,
      };

      // Honor privacy settings for other users
      if (userCopy.settings?.privacy?.lastSeen === false) {
        userCopy.lastSeenAt = null;
      }

      return userCopy;
    });

    // Sort alphabetically by name
    users.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    return res.status(200).json({
      success: true,
      count: users.length,
      users,
    });
  } catch (error) {
    console.error('Get Users Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching team users',
    });
  }
};

// @desc    Get current user profile
// @route   GET /api/users/profile
// @access  Private
const getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    return res.status(200).json({
      success: true,
      user,
    });
  } catch (error) {
    console.error('Get Profile Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching user profile',
    });
  }
};

// @desc    Update user profile (name, bio, title, phone, avatar)
// @route   PUT /api/users/profile (or PATCH)
// @access  Private
const updateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, bio, title, phone, avatar } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (name && typeof name === 'string' && name.trim()) {
      user.name = name.trim();
    }

    if (bio !== undefined) user.bio = typeof bio === 'string' ? bio.trim() : '';
    if (title !== undefined) user.title = typeof title === 'string' ? title.trim() : '';
    if (phone !== undefined) user.phone = typeof phone === 'string' ? phone.trim() : '';

    // Handle avatar from file upload or string URL
    const uploadedFile = req.file || (req.files && req.files.length > 0 ? req.files[0] : null);
    if (uploadedFile) {
      user.avatar = `/uploads/${uploadedFile.filename}`;
    } else if (avatar !== undefined) {
      user.avatar = typeof avatar === 'string' ? avatar.trim() : '';
    }

    await user.save();

    const safeUser = await User.findById(userId).select('-password');

    // Broadcast user profile update over socket so any active teammate/channel views update seamlessly
    try {
      const io = req.app?.get?.('io');
      if (io) {
        if (safeUser.currentOrganization) {
          io.to(`company:${safeUser.currentOrganization}`).emit('user:updated', { user: safeUser });
        }
        io.to(`user:${userId}`).emit('user:updated', { user: safeUser });
      }
    } catch (socketErr) {
      console.warn('Socket broadcast warning on profile update:', socketErr.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      user: safeUser,
    });
  } catch (error) {
    console.error('Update Profile Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error updating profile',
    });
  }
};

// @desc    Update user preferences/settings
// @route   PUT /api/users/settings (or PATCH)
// @access  Private
const updateSettings = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id?.toString();
    const { notifications, appearance, privacy, chat } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (!user.settings) {
      user.settings = {};
    }

    const currentNotifications = user.settings.notifications?.toObject
      ? user.settings.notifications.toObject()
      : (user.settings.notifications || {});

    const currentAppearance = user.settings.appearance?.toObject
      ? user.settings.appearance.toObject()
      : (user.settings.appearance || {});

    const currentPrivacy = user.settings.privacy?.toObject
      ? user.settings.privacy.toObject()
      : (user.settings.privacy || {});

    const currentChat = user.settings.chat?.toObject
      ? user.settings.chat.toObject()
      : (user.settings.chat || {});

    if (notifications && typeof notifications === 'object') {
      user.settings.notifications = {
        ...currentNotifications,
        ...notifications,
      };
    }

    if (appearance && typeof appearance === 'object') {
      user.settings.appearance = {
        ...currentAppearance,
        ...appearance,
      };
    }

    if (privacy && typeof privacy === 'object') {
      user.settings.privacy = {
        ...currentPrivacy,
        ...privacy,
      };
    }

    if (chat && typeof chat === 'object') {
      user.settings.chat = {
        ...currentChat,
        ...chat,
      };
    }

    user.markModified('settings');
    await user.save();

    const safeUser = await User.findById(userId).select('-password');

    // Notify connected sockets of user setting changes if relevant (e.g. online/privacy)
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${userId}`).emit('user:settings_updated', {
        settings: safeUser.settings,
      });
      // Broadcast presence change if onlineStatus privacy was changed
      if (privacy?.onlineStatus !== undefined) {
        io.emit('user:presence_visibility_changed', {
          userId,
          onlineStatus: safeUser.settings?.privacy?.onlineStatus,
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Settings updated successfully',
      settings: safeUser.settings,
      user: safeUser,
    });
  } catch (error) {
    console.error('Update Settings Error:', error.stack || error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error updating settings',
      error: error.message,
    });
  }
};

// @desc    Pin a chat or channel (Max 10 total combined)
// @route   POST /api/users/pin-item
// @access  Private
const pinItem = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id?.toString();
    const { itemId, itemType } = req.body;

    if (!itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({
        success: false,
        message: 'A valid itemId is required',
      });
    }

    if (!['chat', 'channel'].includes(itemType)) {
      return res.status(400).json({
        success: false,
        message: 'itemType must be either "chat" or "channel"',
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (!Array.isArray(user.pinnedChats)) user.pinnedChats = [];
    if (!Array.isArray(user.pinnedChannels)) user.pinnedChannels = [];

    const stringItemId = itemId.toString();
    const isAlreadyPinned =
      itemType === 'chat'
        ? user.pinnedChats.some((id) => id.toString() === stringItemId)
        : user.pinnedChannels.some((id) => id.toString() === stringItemId);

    if (isAlreadyPinned) {
      return res.status(200).json({
        success: true,
        message: 'Item already pinned',
        pinnedChats: user.pinnedChats,
        pinnedChannels: user.pinnedChannels,
      });
    }

    const totalPinned = user.pinnedChats.length + user.pinnedChannels.length;
    if (totalPinned >= 10) {
      return res.status(400).json({
        success: false,
        message: 'You have reached the maximum limit of 10 pinned items (chats and channels combined).',
      });
    }

    if (itemType === 'chat') {
      user.pinnedChats.push(itemId);
    } else {
      user.pinnedChannels.push(itemId);
    }

    await user.save();

    return res.status(200).json({
      success: true,
      message: 'Item pinned successfully',
      pinnedChats: user.pinnedChats,
      pinnedChannels: user.pinnedChannels,
    });
  } catch (error) {
    console.error('Pin Item Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error pinning item',
    });
  }
};

// @desc    Unpin a chat or channel
// @route   POST /api/users/unpin-item
// @access  Private
const unpinItem = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id?.toString();
    const { itemId, itemType } = req.body;

    if (!itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({
        success: false,
        message: 'A valid itemId is required',
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (!Array.isArray(user.pinnedChats)) user.pinnedChats = [];
    if (!Array.isArray(user.pinnedChannels)) user.pinnedChannels = [];

    const stringItemId = itemId.toString();

    if (!itemType || itemType === 'chat') {
      user.pinnedChats = user.pinnedChats.filter((id) => id.toString() !== stringItemId);
    }
    if (!itemType || itemType === 'channel') {
      user.pinnedChannels = user.pinnedChannels.filter((id) => id.toString() !== stringItemId);
    }

    await user.save();

    return res.status(200).json({
      success: true,
      message: 'Item unpinned successfully',
      pinnedChats: user.pinnedChats,
      pinnedChannels: user.pinnedChannels,
    });
  } catch (error) {
    console.error('Unpin Item Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error unpinning item',
    });
  }
};

module.exports = {
  getTeamUsers,
  getProfile,
  updateProfile,
  updateSettings,
  pinItem,
  unpinItem,
};
