const Organization = require('../models/Organization');

/**
 * requireApprovedOrg
 * Verifies that the user's organization has been approved (active, suspended, or expired).
 * Allows read-only access to existing data (chats, channels, to-dos) even if plan is expired or suspended.
 * Blocks pending and rejected organizations.
 * Super Admins bypass this check.
 */
const requireApprovedOrg = async (req, res, next) => {
  try {
    if (req.user?.isSuperAdmin) return next();

    const orgId = req.user?.currentOrganizationId;
    if (!orgId) {
      return res.status(403).json({
        success: false,
        message: 'You must belong to an active organization to perform this action.',
      });
    }

    const org = await Organization.findById(orgId).select('status subscription name rejectionReason').lean();
    if (!org) {
      return res.status(403).json({
        success: false,
        message: 'Organization not found.',
      });
    }

    const status = org.status || org.subscription?.status || 'pending';

    if (status === 'pending') {
      return res.status(403).json({
        success: false,
        code: 'ORG_PENDING_APPROVAL',
        companyStatus: 'pending',
        message: `Your organization "${org.name}" is awaiting Super Admin approval before workspace features can be accessed.`,
      });
    }

    if (status === 'rejected') {
      return res.status(403).json({
        success: false,
        code: 'ORG_REJECTED',
        companyStatus: 'rejected',
        message: `Your organization "${org.name}" registration was rejected by Super Admin.${org.rejectionReason ? ` Reason: ${org.rejectionReason}` : ''}`,
      });
    }

    // Active, suspended, and expired organizations are permitted to read existing data
    next();
  } catch (err) {
    console.error('requireApprovedOrg error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error checking organization status' });
  }
};

/**
 * requireActiveOrg
 * Verifies that the user's current organization has an active plan for write operations.
 * Blocks sending new messages, creating channels, creating todos if plan is expired or suspended.
 * Super Admins bypass this check.
 */
const requireActiveOrg = async (req, res, next) => {
  try {
    // Super Admins are never blocked by org status
    if (req.user?.isSuperAdmin) return next();

    const orgId = req.user?.currentOrganizationId;
    if (!orgId) {
      return res.status(403).json({
        success: false,
        message: 'You must belong to an active organization to perform this action.',
      });
    }

    const org = await Organization.findById(orgId).select('status subscription name rejectionReason').lean();
    if (!org) {
      return res.status(403).json({
        success: false,
        message: 'Organization not found.',
      });
    }

    const status = org.status || org.subscription?.status || 'pending';

    if (status === 'pending') {
      return res.status(403).json({
        success: false,
        code: 'ORG_PENDING_APPROVAL',
        companyStatus: 'pending',
        message: `Your organization "${org.name}" is awaiting Super Admin approval before workspace features can be accessed.`,
      });
    }

    if (status === 'rejected') {
      return res.status(403).json({
        success: false,
        code: 'ORG_REJECTED',
        companyStatus: 'rejected',
        message: `Your organization "${org.name}" registration was rejected by Super Admin.${org.rejectionReason ? ` Reason: ${org.rejectionReason}` : ''}`,
      });
    }

    const isExpired =
      status === 'expired' ||
      Boolean(org.subscription?.expiresAt && new Date() > new Date(org.subscription.expiresAt));

    if (isExpired) {
      return res.status(403).json({
        success: false,
        code: 'ORG_EXPIRED',
        companyStatus: 'expired',
        message: 'Your subscription plan has expired.',
      });
    }

    if (status === 'suspended') {
      return res.status(403).json({
        success: false,
        code: 'ORG_SUSPENDED',
        companyStatus: 'suspended',
        message: 'Your subscription has been Ended',
      });
    }

    if (status !== 'active') {
      return res.status(403).json({
        success: false,
        code: 'ORG_NOT_ACTIVE',
        message: `Your organization is not active.`,
      });
    }

    // Only active organizations proceed with write actions
    next();
  } catch (err) {
    console.error('requireActiveOrg error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error checking organization status' });
  }
};

/**
 * requireFeature(featureName)
 * Factory that returns middleware checking if a named feature is enabled for the org.
 * Super Admins bypass this check.
 * Must be mounted AFTER authMiddleware.protect (and ideally after requireActiveOrg)
 *
 * @param {string} featureName - 'chat' | 'channels' | 'todos'
 */
const requireFeature = (featureName) => async (req, res, next) => {
  try {
    // Super Admins bypass feature checks
    if (req.user?.isSuperAdmin) return next();

    const orgId = req.user?.currentOrganizationId;
    if (!orgId) return next(); // No org context — let the controller handle it

    const org = await Organization.findById(orgId).select('features name').lean();
    if (!org) return next(); // Let controller handle missing org

    const features = org.features || {};

    // Default to enabled if the field doesn't exist (backward compat with existing orgs)
    const isEnabled = features[featureName] !== false;

    if (!isEnabled) {
      const featureLabels = {
        chat: 'Direct Messaging',
        channels: 'Channels',
        todos: 'To-Dos',
      };
      const label = featureLabels[featureName] || featureName;
      return res.status(403).json({
        success: false,
        code: 'FEATURE_DISABLED',
        feature: featureName,
        message: `${label} is not enabled for your organization. Please contact your administrator.`,
      });
    }

    next();
  } catch (err) {
    console.error(`requireFeature(${featureName}) error:`, err.message);
    return res.status(500).json({ success: false, message: 'Server error checking feature entitlements' });
  }
};

module.exports = { requireActiveOrg, requireApprovedOrg, requireFeature };
