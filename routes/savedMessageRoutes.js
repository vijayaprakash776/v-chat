const express = require('express');
const router = express.Router();
const {
  saveMessage,
  unsaveMessage,
  getSavedMessages,
} = require('../controllers/savedMessageController');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);
router.get('/', getSavedMessages);
router.post('/:messageId/save', saveMessage);
router.delete('/:messageId/save', unsaveMessage);

module.exports = router;
