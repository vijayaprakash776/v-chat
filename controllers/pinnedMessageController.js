const mongoose = require('mongoose');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const Channel = require('../models/Channel');
const PinnedMessage = require('../models/PinnedMessage');
const User = require('../models/User');

const getMessageScope = async (messageId, userId) => {
  const message = await Message.findById(messageId);
  if (!message) return { error: 'not_found' };
  if (message.deleted) return { error: 'deleted' };

  if (message.conversationId) {
    const conversation = await Conversation.findOne({
      _id: message.conversationId,
      participants: userId,
    });
    if (!conversation) return { error: 'forbidden' };
  } else if (message.channelId) {
    const channel = await Channel.findOne({ _id: message.channelId, members: userId });
    if (!channel) return { error: 'forbidden' };
  } else {
    return { error: 'forbidden' };
  }

  return { message };
};

const canPin = async (message, userId) => {
  const user = await User.findById(userId).select('role');
  if (user?.role === 'admin' || user?.role === 'superadmin') return true;
  if (message.conversationId) return true;
  if (message.channelId) {
    const channel = await Channel.findById(message.channelId).select('createdBy members organization');
    if (!channel) return false;
    if (channel.createdBy?.toString() === userId.toString()) return true;
    if (channel.members?.some((m) => (m._id || m).toString() === userId.toString())) return true;
    const Membership = require('../models/Membership');
    const membership = await Membership.findOne({ user: userId, organization: channel.organization, status: 'active' });
    if (membership && (membership.role === 'admin' || membership.role === 'owner')) return true;
  }
  return false;
};

const populatePin = (query) => query
  .populate({
    path: 'messageId',
    populate: [
      { path: 'sender', select: 'name email avatar' },
      { path: 'receiver', select: 'name email avatar' },
      { path: 'reactions.users', select: 'name' },
      { path: 'replyTo', populate: { path: 'sender', select: 'name email avatar' } },
    ],
  })
  .populate('pinnedBy', 'name email avatar');

const emitPinEvent = (req, event, pin) => {
  const io = req.app.get('io');
  if (!io) return;
  const payload = {
    messageId: pin.messageId,
    conversationId: pin.conversationId,
    channelId: pin.channelId,
    pinnedBy: pin.pinnedBy,
    pinnedAt: pin.pinnedAt,
  };
  const room = pin.conversationId
    ? `conversation:${pin.conversationId}`
    : `channel:${pin.channelId}`;
  io.to(room).emit(event, payload);
};

const pinMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;
    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({ success: false, message: 'Invalid messageId format' });
    }

    const scope = await getMessageScope(messageId, userId);
    if (scope.error === 'not_found') return res.status(404).json({ success: false, message: 'Message not found' });
    if (scope.error === 'deleted') return res.status(400).json({ success: false, message: 'Cannot pin a deleted message' });
    if (scope.error === 'forbidden') return res.status(403).json({ success: false, message: 'Not authorized to pin this message' });
    if (!(await canPin(scope.message, userId))) return res.status(403).json({ success: false, message: 'You do not have permission to pin messages here' });

    const orgId = req.user.currentOrganizationId;
     const pin = await PinnedMessage.findOneAndUpdate(
       { messageId },
       {
         $setOnInsert: {
           organization: orgId || scope.message.organization,
           messageId,
           conversationId: scope.message.conversationId,
           channelId: scope.message.channelId,
           pinnedBy: userId,
           pinnedAt: new Date(),
         },
       },
       { new: true, upsert: true }
     );
    await Message.findByIdAndUpdate(messageId, { pinned: true });
    const populated = await populatePin(PinnedMessage.findById(pin._id));
    emitPinEvent(req, 'message:pinned', populated);
    return res.status(200).json({ success: true, pinnedMessage: populated });
  } catch (error) {
    console.error('Pin Message Error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to pin this message' });
  }
};

const unpinMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;
    if (!mongoose.Types.ObjectId.isValid(messageId)) return res.status(400).json({ success: false, message: 'Invalid messageId format' });
    const scope = await getMessageScope(messageId, userId);
    if (scope.error === 'not_found') return res.status(404).json({ success: false, message: 'Message not found' });
    if (scope.error === 'forbidden') return res.status(403).json({ success: false, message: 'Not authorized to unpin this message' });
    if (!(await canPin(scope.message, userId))) return res.status(403).json({ success: false, message: 'You do not have permission to unpin messages here' });

    const pin = await PinnedMessage.findOneAndDelete({ messageId });
    await Message.findByIdAndUpdate(messageId, { pinned: false });
    if (pin) emitPinEvent(req, 'message:unpinned', pin);
    return res.status(200).json({ success: true, message: 'Message unpinned' });
  } catch (error) {
    console.error('Unpin Message Error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to unpin this message' });
  }
};

const getPinnedMessages = async (req, res) => {
  try {
    const { conversationId, channelId } = req.query;
    const userId = req.user.id;
    let filter;
    if (conversationId && mongoose.Types.ObjectId.isValid(conversationId)) {
      const allowed = await Conversation.exists({ _id: conversationId, participants: userId });
      if (!allowed) return res.status(403).json({ success: false, message: 'Not authorized to view pinned messages' });
      filter = { conversationId };
    } else if (channelId && mongoose.Types.ObjectId.isValid(channelId)) {
      const allowed = await Channel.exists({ _id: channelId, members: userId });
      if (!allowed) return res.status(403).json({ success: false, message: 'Not authorized to view pinned messages' });
      filter = { channelId };
    } else {
      return res.status(400).json({ success: false, message: 'A valid conversationId or channelId is required' });
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const pins = await populatePin(PinnedMessage.find(filter).sort({ pinnedAt: -1 }).limit(limit));
    return res.status(200).json({ success: true, pinnedMessages: pins });
  } catch (error) {
    console.error('Get Pinned Messages Error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load pinned messages' });
  }
};

module.exports = { pinMessage, unpinMessage, getPinnedMessages };
