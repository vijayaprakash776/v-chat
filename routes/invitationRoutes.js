const express = require('express');
const router = express.Router();
const {
  createInvitation,
  getOrgInvitations,
  revokeInvitation,
  getMyInvitations,
  acceptInvitation,
  declineInvitation,
  validateInvitationToken,
  acceptInvitationByToken,
} = require('../controllers/invitationController');
const { protect } = require('../middleware/authMiddleware');
const { requireActiveOrg } = require('../middleware/featureMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');

// --- Public endpoints (unauthenticated) ---
router.get('/validate-token/:token', validateInvitationToken);

// All subsequent invitation routes require authentication
router.use(protect);

// --- User endpoints (any authenticated user) ---
router.get('/my', getMyInvitations);
router.post('/accept-by-token', acceptInvitationByToken);
router.post('/:id/accept', acceptInvitation);
router.post('/:id/decline', declineInvitation);

// --- Admin endpoints (restricted to active organization admins / owners) ---
router.post('/', adminOnly, requireActiveOrg, createInvitation);
router.get('/org', adminOnly, requireActiveOrg, getOrgInvitations);
router.delete('/:id', adminOnly, requireActiveOrg, revokeInvitation);

module.exports = router;
