const express = require('express');
const router = express.Router();
const {
  createChannel,
  getChannels,
  updateChannel,
  updateChannelSetting,
  getChannel,
  joinChannel,
  leaveChannel,
  addChannelMembers,
  getChannelMessages,
  sendChannelMessage,
  promoteChannelAdmin,
  getPublicOrganizationSettings,
} = require('../controllers/channelController');
const { protect } = require('../middleware/authMiddleware');
const { requireActiveOrg, requireApprovedOrg, requireFeature } = require('../middleware/featureMiddleware');
const { handleUpload } = require('../middleware/uploadMiddleware');

// All channel endpoints require authentication
router.use(protect);

router.get('/settings/organization', getPublicOrganizationSettings);

// Channel list/create
router.route('/')
  .post(requireActiveOrg, requireFeature('channels'), createChannel)
  .get(requireApprovedOrg, requireFeature('channels'), getChannels);

router.route('/:id')
  .get(getChannel)
  .put(updateChannel)
  .patch(updateChannel);

router.route('/:id/join')
  .post(requireActiveOrg, requireFeature('channels'), joinChannel);

router.route('/:id/leave')
  .post(leaveChannel);

router.route('/:id/members')
  .post(requireActiveOrg, requireFeature('channels'), addChannelMembers);

router.post('/:id/admins', requireActiveOrg, promoteChannelAdmin);
router.post('/:id/promote-admin', requireActiveOrg, promoteChannelAdmin);

router.patch('/:id/settings', updateChannelSetting);

// Channel messages (supports JSON text or multipart with file attachments)
router.route('/:id/messages')
  .get(requireApprovedOrg, requireFeature('channels'), getChannelMessages)
  .post(requireActiveOrg, requireFeature('channels'), handleUpload('files', 5), sendChannelMessage);

module.exports = router;

