const express = require('express');
const router = express.Router();
const {
  markMessageAsRead,
  markMessagesAsRead,
  getMessageById,
  editMessage,
  deleteMessage,
  deleteMessageForMe,
  forwardMessage,
  addReaction,
  removeReaction,
} = require('../controllers/messageController');
const { votePoll } = require('../controllers/pollController');
const { protect } = require('../middleware/authMiddleware');
const { requireActiveOrg, requireApprovedOrg, requireFeature } = require('../middleware/featureMiddleware');

// All message routes are protected
router.use(protect);

// Read/mark-read operations — allowed for approved organizations (including suspended/expired)
router.patch('/read', requireApprovedOrg, markMessagesAsRead);
router.patch('/mark-read', requireApprovedOrg, markMessagesAsRead);
router.get('/:messageId', requireApprovedOrg, getMessageById);
router.patch('/:messageId/read', requireApprovedOrg, markMessageAsRead);

// Write operations — require active org + chat feature (blocked when plan is expired or suspended)
router.patch('/:messageId', requireActiveOrg, requireFeature('chat'), editMessage);
router.delete('/:messageId', requireActiveOrg, requireFeature('chat'), deleteMessage);
router.post('/:messageId/delete-for-me', requireApprovedOrg, requireFeature('chat'), deleteMessageForMe);
router.post('/:messageId/forward', requireActiveOrg, requireFeature('chat'), forwardMessage);

// Message Reactions — require active org + chat feature
router.post('/:messageId/reactions', requireActiveOrg, requireFeature('chat'), addReaction);
router.delete('/:messageId/reactions/:emoji', requireActiveOrg, requireFeature('chat'), removeReaction);

// Poll Voting — require active org + chat feature
router.post('/:messageId/poll/vote', requireActiveOrg, requireFeature('chat'), votePoll);

module.exports = router;
