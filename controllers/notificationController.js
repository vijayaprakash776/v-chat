const mongoose = require('mongoose');
const Notification = require('../models/Notification');

// @desc    Get paginated notifications for authenticated user in active organization
// @route   GET /api/notifications
// @access  Private
const getNotifications = async (req, res) => {
  try {
    const userId = req.user.id;
    const orgId = req.user.currentOrganizationId;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const skip = (page - 1) * limit;

    const query = { recipient: userId };
    if (orgId) {
      query.organization = orgId;
    }

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(query)
        .populate('sender', 'name email avatar')
        .populate('channelId', 'name isPrivate')
        .populate('conversationId')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Notification.countDocuments(query),
      Notification.countDocuments({ ...query, isRead: false }),
    ]);

    return res.status(200).json({
      success: true,
      notifications,
      unreadCount,
      page,
      totalPages: Math.ceil(total / limit) || 1,
      total,
    });
  } catch (error) {
    console.error('Get Notifications Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching notifications',
    });
  }
};

// @desc    Get total unread notification count in active organization
// @route   GET /api/notifications/unread-count
// @access  Private
const getUnreadCount = async (req, res) => {
  try {
    const userId = req.user.id;
    const orgId = req.user.currentOrganizationId;
    const query = { recipient: userId, isRead: false };
    if (orgId) {
      query.organization = orgId;
    }

    const unreadCount = await Notification.countDocuments(query);

    return res.status(200).json({
      success: true,
      unreadCount,
    });
  } catch (error) {
    console.error('Get Unread Count Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching unread count',
    });
  }
};

// @desc    Mark a single notification as read
// @route   PATCH /api/notifications/:id/read
// @access  Private
const markNotificationRead = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid notification ID format',
      });
    }

    const notification = await Notification.findById(id);
    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found',
      });
    }

    // Security: Only the recipient can mark a notification as read
    if (notification.recipient.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to modify this notification',
      });
    }

    notification.isRead = true;
    await notification.save();

    const orgId = req.user.currentOrganizationId;
    const currentUnreadCount = await Notification.countDocuments({
      recipient: userId,
      isRead: false,
      ...(orgId ? { organization: orgId } : {}),
    });

    // Multi-tab synchronization via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${userId}`).emit('notification:read', {
        notificationId: id,
      });
      io.to(`user:${userId}`).emit('notification:unread_count', {
        unreadCount: currentUnreadCount,
      });
    }

    return res.status(200).json({
      success: true,
      notification,
    });
  } catch (error) {
    console.error('Mark Notification Read Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error updating notification',
    });
  }
};

// @desc    Mark all notifications as read for authenticated user
// @route   PATCH /api/notifications/read-all
// @access  Private
const markAllNotificationsRead = async (req, res) => {
  try {
    const userId = req.user.id;
    const orgId = req.user.currentOrganizationId;
    const filter = { recipient: userId, isRead: false };
    if (orgId) {
      filter.organization = orgId;
    }

    await Notification.updateMany(
      filter,
      { $set: { isRead: true } }
    );

    const remainingUnread = await Notification.countDocuments({
      recipient: userId,
      isRead: false,
      ...(orgId ? { organization: orgId } : {}),
    });

    // Multi-tab synchronization via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${userId}`).emit('notifications:read_all', {
        userId,
      });
      io.to(`user:${userId}`).emit('notification:unread_count', {
        unreadCount: remainingUnread,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'All notifications marked as read',
    });
  } catch (error) {
    console.error('Mark All Read Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error marking all notifications as read',
    });
  }
};

module.exports = {
  getNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
};
