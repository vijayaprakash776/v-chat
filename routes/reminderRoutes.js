const express = require('express');
const router = express.Router();
const {
  createReminder,
  getReminders,
  getReminderById,
  updateReminder,
  toggleReminderComplete,
  snoozeReminder,
  deleteReminder,
} = require('../controllers/reminderController');
const { protect } = require('../middleware/authMiddleware');
const { requireActiveOrg, requireApprovedOrg, requireFeature } = require('../middleware/featureMiddleware');

// All Reminder routes are protected by JWT authentication
router.use(protect);
router.use(requireFeature('reminders'));

router.route('/')
  .post(requireActiveOrg, createReminder)
  .get(requireApprovedOrg, getReminders);

router.route('/:reminderId')
  .get(requireApprovedOrg, getReminderById)
  .put(requireApprovedOrg, updateReminder)
  .patch(requireApprovedOrg, updateReminder)
  .delete(requireApprovedOrg, deleteReminder);

router.patch('/:reminderId/complete', requireApprovedOrg, toggleReminderComplete);
router.patch('/:reminderId/toggle', requireApprovedOrg, toggleReminderComplete);
router.patch('/:reminderId/snooze', requireApprovedOrg, snoozeReminder);

module.exports = router;
