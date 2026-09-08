const mongoose = require('mongoose');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const Channel = require('../models/Channel');
const SavedMessage = require('../models/SavedMessage');
const User = require('../models/User');

const canAccessMessage = async (message, userId) => {
  if (message.conversationId) return Boolean(await Conversation.exists({ _id: message.conversationId, participants: userId }));
  if (message.channelId) return Boolean(await Channel.exists({ _id: message.channelId, members: userId }));
  return false;
};

const populateSaved = (query) => query
  .populate({
    path: 'messageId',
    populate: [
      { path: 'sender', select: 'name email avatar' },
      { path: 'receiver', select: 'name email avatar' },
      { path: 'reactions.users', select: 'name' },
      { path: 'replyTo', populate: { path: 'sender', select: 'name email avatar' } },
    ],
  })
  .populate('conversationId', 'participants')
  .populate('channelId', 'name isPrivate')
  .populate('userId', 'name email avatar');

const saveMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;
    if (!mongoose.Types.ObjectId.isValid(messageId)) return res.status(400).json({ success: false, message: 'Invalid messageId format' });
    const message = await Message.findById(messageId);
    if (!message) return res.status(404).json({ success: false, message: 'Message not found' });
    if (message.deleted) return res.status(400).json({ success: false, message: 'Cannot save a deleted message' });
    if (!(await canAccessMessage(message, userId))) return res.status(403).json({ success: false, message: 'Not authorized to save this message' });

    const orgId = req.user.currentOrganizationId;
    const saved = await SavedMessage.findOneAndUpdate(
      { userId, messageId },
      { $setOnInsert: { organization: orgId || message.organization, userId, messageId, conversationId: message.conversationId, channelId: message.channelId, savedAt: new Date() } },
      { new: true, upsert: true }
    );
    const populated = await populateSaved(SavedMessage.findById(saved._id));
    return res.status(200).json({ success: true, savedMessage: populated });
  } catch (error) {
    console.error('Save Message Error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to save this message' });
  }
};

const unsaveMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(messageId)) return res.status(400).json({ success: false, message: 'Invalid messageId format' });
    await SavedMessage.deleteOne({ userId: req.user.id, messageId });
    return res.status(200).json({ success: true, message: 'Message removed from saved messages' });
  } catch (error) {
    console.error('Unsave Message Error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to remove saved message' });
  }
};

const getSavedMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const orgId = req.user.currentOrganizationId;
    const query = (req.query.q || '').trim();
    const type = req.query.type || 'all';
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const scope = { userId };
    if (orgId) scope.organization = orgId;
    if (type === 'conversation') scope.conversationId = { $ne: null };
    if (type === 'channel') scope.channelId = { $ne: null };

    if (query) {
      const safeRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const savedIds = await SavedMessage.find(scope).select('messageId');
      const matchingUsers = await User.find({ name: safeRegex }).select('_id');
      const matchingMessages = await Message.find({
        _id: { $in: savedIds.map((item) => item.messageId) },
        deleted: { $ne: true },
        $or: [
          { content: safeRegex },
          { sender: { $in: matchingUsers.map((user) => user._id) } },
        ],
      }).select('_id');
      scope.messageId = { $in: matchingMessages.map((message) => message._id) };
    }

    const saved = await populateSaved(
      SavedMessage.find(scope).sort({ savedAt: -1 }).skip((page - 1) * limit).limit(limit)
    );
    const visibleSaved = await Promise.all(saved.map(async (item) => {
      const message = item.messageId;
      if (!message) return item;
      const accessible = await canAccessMessage(message, userId);
      if (message.deleted) {
        message.content = 'This message was deleted.';
        message.attachments = [];
      } else if (!accessible) {
        item.messageId = null;
        item.unavailable = true;
      }
      return item;
    }));
    return res.status(200).json({ success: true, savedMessages: visibleSaved, page, limit });
  } catch (error) {
    console.error('Get Saved Messages Error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load saved messages' });
  }
};

module.exports = { saveMessage, unsaveMessage, getSavedMessages };
