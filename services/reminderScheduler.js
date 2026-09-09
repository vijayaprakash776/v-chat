const Reminder = require('../models/Reminder');
const Notification = require('../models/Notification');

/**
 * Calculate the next reminder time for repeating reminders
 * @param {Date} currentTime
 * @param {string} repeat - 'daily' | 'weekly' | 'monthly'
 * @returns {Date}
 */
const calculateNextReminderTime = (currentTime, repeat) => {
  const next = new Date(currentTime);
  const now = new Date();

  do {
    if (repeat === 'daily') {
      next.setDate(next.getDate() + 1);
    } else if (repeat === 'weekly') {
      next.setDate(next.getDate() + 7);
    } else if (repeat === 'monthly') {
      next.setMonth(next.getMonth() + 1);
    } else {
      break;
    }
  } while (next <= now);

  return next;
};

let schedulerInterval = null;

/**
 * Initialize server-side scheduler to process due reminders
 * @param {Object} io - Socket.IO server instance
 */
const initReminderScheduler = (io) => {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
  }

  const checkDueReminders = async () => {
    try {
      const now = new Date();

      // Find due pending or snoozed reminders that have not been notified yet
      const dueReminders = await Reminder.find({
        deleted: false,
        status: { $ne: 'completed' },
        $or: [
          { status: 'pending', reminderTime: { $lte: now }, isNotified: false },
          { status: 'snoozed', snoozedUntil: { $lte: now } },
        ],
      });

      if (dueReminders.length === 0) return;

      for (const rawReminder of dueReminders) {
        // Atomic claim/lock to guarantee duplicate prevention during concurrent ticks or restarts
        const reminder = await Reminder.findOneAndUpdate(
          {
            _id: rawReminder._id,
            isNotified: false,
            deleted: false,
            status: { $ne: 'completed' },
          },
          {
            $set: { isNotified: true },
          },
          { new: true }
        );

        if (!reminder) continue; // Already claimed by another tick

        const userIdStr = (reminder.userId?._id || reminder.userId)?.toString();

        // 1. Create exactly ONE in-app Notification using existing Notification model
        try {
          const notification = await Notification.create({
            recipient: reminder.userId,
            organization: reminder.organization || null,
            sender: reminder.userId,
            type: 'reminder_due',
            content: `Reminder: "${reminder.title}"`,
            reminderId: reminder._id,
            conversationId: reminder.conversationId || null,
            channelId: reminder.channelId || null,
            isRead: false,
          });

          const populatedNotif = await Notification.findById(notification._id)
            .populate('sender', 'name email avatar')
            .populate('conversationId')
            .populate('channelId', 'name isPrivate');

          if (io && userIdStr && populatedNotif) {
            // Emit in-app notification event to user room
            io.to(`user:${userIdStr}`).emit('notification:new', {
              notification: populatedNotif,
            });

            // Emit unread notification count update
            const unreadCount = await Notification.countDocuments({
              recipient: reminder.userId,
              isRead: false,
              ...(reminder.organization ? { organization: reminder.organization } : {}),
            });

            io.to(`user:${userIdStr}`).emit('notification:unread_count', {
              unreadCount,
            });
          }
        } catch (notifErr) {
          console.error('Error creating in-app notification for reminder:', notifErr.message);
        }

        // 3. Handle repeat logic or auto-complete status transition
        if (reminder.repeat && reminder.repeat !== 'never') {
          const nextTime = calculateNextReminderTime(reminder.reminderTime, reminder.repeat);
          reminder.reminderTime = nextTime;
          reminder.status = 'pending';
          reminder.isNotified = false;
          reminder.snoozedUntil = null;
          await reminder.save();
        } else {
          reminder.status = 'completed';
          reminder.completedAt = new Date();
          reminder.snoozedUntil = null;
          await reminder.save();
        }

        // 4. Emit real-time reminder:due event with updated status ('completed') so UI moves it to Completed immediately
        const populatedReminder = await Reminder.findById(reminder._id)
          .populate('userId', 'name email avatar')
          .populate('conversationId')
          .populate('channelId', 'name isPrivate');

        if (io && userIdStr && populatedReminder) {
          io.to(`user:${userIdStr}`).emit('reminder:due', {
            reminder: populatedReminder,
          });
        }
      }
    } catch (err) {
      console.error('Error in reminder scheduler check:', err.message);
    }
  };

  // Run initial check immediately on server startup, then every 10 seconds
  checkDueReminders();
  schedulerInterval = setInterval(checkDueReminders, 10000);
  console.log('⏰ Server-side Reminder Scheduler initialized (checking every 10s)');
};

module.exports = {
  initReminderScheduler,
  calculateNextReminderTime,
};
