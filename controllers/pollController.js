const mongoose = require('mongoose');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const Channel = require('../models/Channel');

// @desc    Vote or update vote on a poll inside a message
// @route   POST /api/messages/:messageId/poll/vote
// @access  Private
const votePoll = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { optionIndex } = req.body;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid message ID format',
      });
    }

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
      });
    }

    if (!message.poll || !Array.isArray(message.poll.options)) {
      return res.status(400).json({
        success: false,
        message: 'This message does not contain a poll',
      });
    }

    // 7-day Expiration check
    const isExpired =
      Boolean(message.poll.expiresAt && new Date() > new Date(message.poll.expiresAt)) ||
      Boolean(message.poll.isClosed);

    if (isExpired) {
      return res.status(400).json({
        success: false,
        message: 'This poll has expired and is no longer active.',
      });
    }

    // Authorization check
    if (message.conversationId) {
      const conv = await Conversation.findById(message.conversationId);
      if (!conv || !conv.participants.some((p) => p.toString() === userId.toString())) {
        return res.status(403).json({
          success: false,
          message: 'You are not a participant in this conversation',
        });
      }
    } else if (message.channelId) {
      const channel = await Channel.findById(message.channelId);
      if (!channel || !channel.members.some((m) => m.toString() === userId.toString())) {
        return res.status(403).json({
          success: false,
          message: 'You are not a member of this channel',
        });
      }
    }

    // Check if unvote action requested
    const isExplicitUnvote =
      optionIndex === null ||
      optionIndex === undefined ||
      optionIndex === -1 ||
      optionIndex === 'unvote' ||
      req.body.action === 'unvote';

    if (isExplicitUnvote) {
      // Remove user's vote from all options in this poll
      message.poll.options.forEach((opt) => {
        opt.votes = (opt.votes || []).filter(
          (v) => (v._id || v.id || v)?.toString() !== userId.toString()
        );
      });
    } else {
      const index = parseInt(optionIndex, 10);
      if (isNaN(index) || index < 0 || index >= message.poll.options.length) {
        return res.status(400).json({
          success: false,
          message: 'Invalid poll option index',
        });
      }

      const targetOption = message.poll.options[index];

      // Check if user already voted for this exact option
      const alreadyVotedThis = (targetOption.votes || []).some(
        (v) => (v._id || v.id || v)?.toString() === userId.toString()
      );

      // Remove user's vote from all options in this poll
      message.poll.options.forEach((opt) => {
        opt.votes = (opt.votes || []).filter(
          (v) => (v._id || v.id || v)?.toString() !== userId.toString()
        );
      });

      // If not already voted for this option, add vote (switching or setting new vote)
      // If already voted for this option, it unvotes (toggle off)
      if (!alreadyVotedThis) {
        targetOption.votes.push(userId);
      }
    }

    // Mark poll subdocument modified
    message.markModified('poll');
    await message.save();

    // Populate references for consistent client payload
    const populatedMessage = await Message.findById(message._id)
      .populate('sender', 'name email avatar')
      .populate('receiver', 'name email avatar')
      .populate({
        path: 'replyTo',
        populate: { path: 'sender', select: 'name email avatar' },
      });

    // Emit Real-time Socket.IO event to chat or channel room
    const io = req.app.get('io');
    if (io) {
      if (message.conversationId) {
        io.to(`conversation:${message.conversationId.toString()}`).emit(
          'message:poll_voted',
          {
            messageId: message._id,
            poll: message.poll,
            conversationId: message.conversationId,
          }
        );
      } else if (message.channelId) {
        io.to(`channel:${message.channelId.toString()}`).emit(
          'message:poll_voted',
          {
            messageId: message._id,
            poll: message.poll,
            channelId: message.channelId,
          }
        );
      }
    }

    return res.status(200).json({
      success: true,
      message: populatedMessage,
      poll: message.poll,
    });
  } catch (error) {
    console.error('Vote Poll Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error casting vote on poll',
    });
  }
};

module.exports = {
  votePoll,
};
