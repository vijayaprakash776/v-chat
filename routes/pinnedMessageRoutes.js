const express = require('express');
const router = express.Router();
const {
  pinMessage,
  unpinMessage,
  getPinnedMessages,
} = require('../controllers/pinnedMessageController');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);
router.get('/', getPinnedMessages);
router.post('/:messageId/pin', pinMessage);
router.delete('/:messageId/pin', unpinMessage);

module.exports = router;
