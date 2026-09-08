const express = require('express');
const router = express.Router();
const {
  createOrGetConversation,
  getUserConversations,
  updateConversationSetting,
  markConversationRead,
  getConversationMessages,
  sendMessage,
} = require('../controllers/conversationController');
const { protect } = require('../middleware/authMiddleware');
const { requireActiveOrg, requireApprovedOrg } = require('../middleware/featureMiddleware');
const { handleUpload } = require('../middleware/uploadMiddleware');

// All conversation endpoints are protected
router.use(protect);

// Conversation management
router.route('/')
  .post(requireApprovedOrg, createOrGetConversation)
  .get(requireApprovedOrg, getUserConversations);

router.patch('/:conversationId/read', requireApprovedOrg, markConversationRead);
router.patch('/:conversationId/settings', requireApprovedOrg, updateConversationSetting);

// Conversation message operations (supports JSON text or multipart with file attachments)
router.route('/:conversationId/messages')
  .get(requireApprovedOrg, getConversationMessages)
  .post(requireActiveOrg, handleUpload('files', 5), sendMessage);

// Alternate route alias
router.route('/:id/messages')
  .get(requireApprovedOrg, getConversationMessages)
  .post(requireActiveOrg, handleUpload('files', 5), sendMessage);

module.exports = router;
