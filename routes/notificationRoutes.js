const express = require('express');
const router = express.Router();
const {
  getNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} = require('../controllers/notificationController');
const { protect } = require('../middleware/authMiddleware');

// All notification endpoints require JWT authentication
router.use(protect);

router.route('/')
  .get(getNotifications);

router.route('/unread-count')
  .get(getUnreadCount);

router.route('/read-all')
  .patch(markAllNotificationsRead)
  .put(markAllNotificationsRead);

router.route('/:id/read')
  .patch(markNotificationRead)
  .put(markNotificationRead);

module.exports = router;
