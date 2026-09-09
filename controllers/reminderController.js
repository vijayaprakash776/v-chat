const mongoose = require('mongoose');
const Reminder = require('../models/Reminder');

// @desc    Create a new reminder
// @route   POST /api/reminders
// @access  Private
const createReminder = async (req, res) => {
  try {
    const {
      title,
      description = '',
      reminderTime,
      repeat = 'never',
      conversationId = null,
      channelId = null,
      sourceMessageId = null,
      todoId = null,
    } = req.body;

    const userId = req.user.id;
    const orgId = req.user.currentOrganizationId;

    if (!title || !title.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Reminder title is required',
      });
    }

    if (!reminderTime || isNaN(new Date(reminderTime).getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Valid reminder date and time is required',
      });
    }

    const validRepeatOptions = ['never', 'daily', 'weekly', 'monthly'];
    const cleanRepeat = validRepeatOptions.includes(repeat) ? repeat : 'never';

    const newReminder = await Reminder.create({
      organization: orgId,
      userId,
      title: title.trim(),
      description: description.trim(),
      reminderTime: new Date(reminderTime),
      repeat: cleanRepeat,
      status: 'pending',
      isNotified: false,
      conversationId: conversationId && mongoose.Types.ObjectId.isValid(conversationId) ? conversationId : null,
      channelId: channelId && mongoose.Types.ObjectId.isValid(channelId) ? channelId : null,
      sourceMessageId: sourceMessageId && mongoose.Types.ObjectId.isValid(sourceMessageId) ? sourceMessageId : null,
      todoId: todoId && mongoose.Types.ObjectId.isValid(todoId) ? todoId : null,
    });

    const populated = await Reminder.findById(newReminder._id)
      .populate('userId', 'name email avatar')
      .populate('conversationId')
      .populate('channelId', 'name isPrivate');

    // Real-Time Socket.IO emission to creator's personal user room
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${userId}`).emit('reminder:created', { reminder: populated });
    }

    return res.status(201).json({
      success: true,
      message: 'Reminder set successfully',
      reminder: populated,
    });
  } catch (error) {
    console.error('Create Reminder Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error creating reminder',
    });
  }
};

// @desc    Get user's reminders in current organization
// @route   GET /api/reminders
// @access  Private
const getReminders = async (req, res) => {
  try {
    const userId = req.user.id;
    const orgId = req.user.currentOrganizationId;
    const { status = 'all', search = '', limit = 100 } = req.query;

    const query = {
      organization: orgId,
      userId,
      deleted: false,
    };

    const now = new Date();

    if (status === 'upcoming' || status === 'pending') {
      query.status = { $in: ['pending', 'snoozed'] };
    } else if (status === 'completed') {
      query.status = 'completed';
    }

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      query.$or = [{ title: regex }, { description: regex }];
    }

    const reminders = await Reminder.find(query)
      .populate('userId', 'name email avatar')
      .populate('conversationId')
      .populate('channelId', 'name isPrivate')
      .sort({ reminderTime: 1, createdAt: -1 })
      .limit(parseInt(limit, 10) || 100);

    return res.status(200).json({
      success: true,
      count: reminders.length,
      reminders,
    });
  } catch (error) {
    console.error('Get Reminders Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching reminders',
    });
  }
};

// @desc    Get single reminder by ID
// @route   GET /api/reminders/:reminderId
// @access  Private
const getReminderById = async (req, res) => {
  try {
    const { reminderId } = req.params;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(reminderId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid reminder ID format',
      });
    }

    const reminder = await Reminder.findOne({ _id: reminderId, userId, deleted: false })
      .populate('userId', 'name email avatar')
      .populate('conversationId')
      .populate('channelId', 'name isPrivate');

    if (!reminder) {
      return res.status(404).json({
        success: false,
        message: 'Reminder not found',
      });
    }

    return res.status(200).json({
      success: true,
      reminder,
    });
  } catch (error) {
    console.error('Get Reminder By ID Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching reminder details',
    });
  }
};

// @desc    Update a reminder
// @route   PUT /api/reminders/:reminderId (or PATCH)
// @access  Private
const updateReminder = async (req, res) => {
  try {
    const { reminderId } = req.params;
    const userId = req.user.id;
    const { title, description, reminderTime, repeat } = req.body;

    if (!mongoose.Types.ObjectId.isValid(reminderId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid reminder ID format',
      });
    }

    const reminder = await Reminder.findOne({ _id: reminderId, userId, deleted: false });
    if (!reminder) {
      return res.status(404).json({
        success: false,
        message: 'Reminder not found or access denied',
      });
    }

    if (title && title.trim()) {
      reminder.title = title.trim();
    }

    if (description !== undefined) {
      reminder.description = description.trim();
    }

    if (repeat) {
      const validRepeatOptions = ['never', 'daily', 'weekly', 'monthly'];
      if (validRepeatOptions.includes(repeat)) {
        reminder.repeat = repeat;
      }
    }

    if (reminderTime && !isNaN(new Date(reminderTime).getTime())) {
      const newTime = new Date(reminderTime);
      reminder.reminderTime = newTime;
      // Reset notification status if updated to future date
      if (newTime > new Date()) {
        reminder.isNotified = false;
        reminder.status = 'pending';
        reminder.snoozedUntil = null;
      }
    }

    await reminder.save();

    const populated = await Reminder.findById(reminderId)
      .populate('userId', 'name email avatar')
      .populate('conversationId')
      .populate('channelId', 'name isPrivate');

    const io = req.app.get('io');
    if (io) {
      io.to(`user:${userId}`).emit('reminder:updated', { reminder: populated });
    }

    return res.status(200).json({
      success: true,
      message: 'Reminder updated successfully',
      reminder: populated,
    });
  } catch (error) {
    console.error('Update Reminder Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error updating reminder',
    });
  }
};

// @desc    Toggle complete status of a reminder
// @route   PATCH /api/reminders/:reminderId/complete
// @access  Private
const toggleReminderComplete = async (req, res) => {
  try {
    const { reminderId } = req.params;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(reminderId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid reminder ID format',
      });
    }

    const reminder = await Reminder.findOne({ _id: reminderId, userId, deleted: false });
    if (!reminder) {
      return res.status(404).json({
        success: false,
        message: 'Reminder not found',
      });
    }

    const isCurrentlyCompleted = reminder.status === 'completed';
    if (isCurrentlyCompleted) {
      reminder.status = 'pending';
      reminder.completedAt = null;
      reminder.isNotified = false;
    } else {
      reminder.status = 'completed';
      reminder.completedAt = new Date();
      reminder.snoozedUntil = null;
    }

    await reminder.save();

    const populated = await Reminder.findById(reminderId)
      .populate('userId', 'name email avatar')
      .populate('conversationId')
      .populate('channelId', 'name isPrivate');

    const io = req.app.get('io');
    if (io) {
      io.to(`user:${userId}`).emit('reminder:updated', { reminder: populated });
    }

    return res.status(200).json({
      success: true,
      message: reminder.status === 'completed' ? 'Reminder marked as completed' : 'Reminder marked as pending',
      reminder: populated,
    });
  } catch (error) {
    console.error('Toggle Reminder Complete Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error updating reminder status',
    });
  }
};

// @desc    Snooze a reminder by minutes or custom date
// @route   PATCH /api/reminders/:reminderId/snooze
// @access  Private
const snoozeReminder = async (req, res) => {
  try {
    const { reminderId } = req.params;
    const userId = req.user.id;
    const { minutes = 15, customTime = null } = req.body;

    if (!mongoose.Types.ObjectId.isValid(reminderId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid reminder ID format',
      });
    }

    const reminder = await Reminder.findOne({ _id: reminderId, userId, deleted: false });
    if (!reminder) {
      return res.status(404).json({
        success: false,
        message: 'Reminder not found',
      });
    }

    let snoozeTarget;
    if (customTime && !isNaN(new Date(customTime).getTime())) {
      snoozeTarget = new Date(customTime);
    } else {
      snoozeTarget = new Date(Date.now() + Math.max(1, parseInt(minutes, 10) || 15) * 60 * 1000);
    }

    reminder.status = 'snoozed';
    reminder.snoozedUntil = snoozeTarget;
    reminder.snoozeCount = (reminder.snoozeCount || 0) + 1;
    await reminder.save();

    const populated = await Reminder.findById(reminderId)
      .populate('userId', 'name email avatar')
      .populate('conversationId')
      .populate('channelId', 'name isPrivate');

    const io = req.app.get('io');
    if (io) {
      io.to(`user:${userId}`).emit('reminder:updated', { reminder: populated });
    }

    return res.status(200).json({
      success: true,
      message: `Reminder snoozed until ${snoozeTarget.toLocaleTimeString()}`,
      reminder: populated,
    });
  } catch (error) {
    console.error('Snooze Reminder Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error snoozing reminder',
    });
  }
};

// @desc    Soft-delete a reminder
// @route   DELETE /api/reminders/:reminderId
// @access  Private
const deleteReminder = async (req, res) => {
  try {
    const { reminderId } = req.params;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(reminderId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid reminder ID format',
      });
    }

    const reminder = await Reminder.findOne({ _id: reminderId, userId, deleted: false });
    if (!reminder) {
      return res.status(404).json({
        success: false,
        message: 'Reminder not found or already deleted',
      });
    }

    reminder.deleted = true;
    reminder.deletedAt = new Date();
    reminder.deletedBy = userId;
    await reminder.save();

    const io = req.app.get('io');
    if (io) {
      io.to(`user:${userId}`).emit('reminder:deleted', { reminderId });
    }

    return res.status(200).json({
      success: true,
      message: 'Reminder deleted successfully',
      reminderId,
    });
  } catch (error) {
    console.error('Delete Reminder Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error deleting reminder',
    });
  }
};

module.exports = {
  createReminder,
  getReminders,
  getReminderById,
  updateReminder,
  toggleReminderComplete,
  snoozeReminder,
  deleteReminder,
};
