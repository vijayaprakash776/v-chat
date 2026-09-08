const express = require('express');
const router = express.Router();
const {
  getWorkspaceStats,
  getUsers,
  updateUserRole,
  updateUserStatus,
  updateUserPermissions,
  inviteUserToOrganization,
  getJoinRequests,
  approveJoinRequest,
  rejectJoinRequest,
  getChannels,
  adminCreateChannel,
  updateChannel,
  deleteChannel,
  getChannelMembers,
  addChannelMember,
  removeChannelMember,
  getMessages,
  deleteMessage,
  getAuditLogs,
  getOrganizationSettings,
  updateOrganizationSettings,
} = require('../controllers/adminController');
const { protect } = require('../middleware/authMiddleware');
const { requireActiveOrg } = require('../middleware/featureMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');

// All admin endpoints strictly require valid JWT, active company status, and administrator role
router.use(protect);
router.use(requireActiveOrg);
router.use(adminOnly);

// 1. Workspace Stats
router.get('/stats', getWorkspaceStats);

// 2. User Management, Employee Invitations & Join Requests
router.get('/users', getUsers);
router.patch('/users/:id/role', updateUserRole);
router.patch('/users/:id/status', updateUserStatus);
router.patch('/users/:id/permissions', updateUserPermissions);
router.post('/invite-user', inviteUserToOrganization);
router.get('/join-requests', getJoinRequests);
router.post('/join-requests/:id/approve', approveJoinRequest);
router.post('/join-requests/:id/reject', rejectJoinRequest);

// 3. Channel Management
router.get('/channels', getChannels);
router.post('/channels', adminCreateChannel);
router.patch('/channels/:id', updateChannel);
router.delete('/channels/:id', deleteChannel);
router.get('/channels/:id/members', getChannelMembers);
router.post('/channels/:id/members/:userId', addChannelMember);
router.delete('/channels/:id/members/:userId', removeChannelMember);

// 4. Message Moderation
router.get('/messages', getMessages);
router.delete('/messages/:id', deleteMessage);

// 5. Audit Logging
router.get('/audit-logs', getAuditLogs);

// 6. Organization Settings
router.get('/settings', getOrganizationSettings);
router.patch('/settings', updateOrganizationSettings);

module.exports = router;
