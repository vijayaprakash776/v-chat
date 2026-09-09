const express = require('express');
const router = express.Router();
const {
  getPlatformStats,
  getAllOrganizations,
  getOrganizationDetail,
  activateOrganization,
  rejectOrganization,
  suspendOrganization,
  updateSubscription,
  updateFeatures,
} = require('../controllers/superAdminController');
const { protect } = require('../middleware/authMiddleware');
const { superAdminOnly } = require('../middleware/superAdminMiddleware');

// All Super Admin routes require: valid JWT + super_admin role
router.use(protect);
router.use(superAdminOnly);

// Platform statistics
router.get('/stats', getPlatformStats);

// Organization management
router.get('/organizations', getAllOrganizations);
router.get('/organizations/:id', getOrganizationDetail);

// Organization status control
router.patch('/organizations/:id/activate', activateOrganization);
router.patch('/organizations/:id/reject', rejectOrganization);
router.patch('/organizations/:id/suspend', suspendOrganization);

// Subscription management
router.patch('/organizations/:id/subscription', updateSubscription);

// Feature entitlement management
router.patch('/organizations/:id/features', updateFeatures);

module.exports = router;
