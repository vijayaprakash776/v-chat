const ALL_PERMISSIONS = [
  'MANAGE_MEMBERS',
  'MANAGE_JOIN_REQUESTS',
  'MANAGE_CHANNELS',
  'MANAGE_TODOS',
  'MANAGE_MESSAGES',
  'VIEW_ANALYTICS',
  'MANAGE_SETTINGS',
  'MANAGE_ROLES',
];

/**
 * Middleware to enforce owner or admin privileges for admin routes
 * Must be mounted AFTER authMiddleware.protect
 */
const adminOnly = (req, res, next) => {
  // Check if req.user exists and has role 'owner' or 'admin'
  if (!req.user || !['owner', 'admin'].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Forbidden: Owner or Administrator privileges required',
    });
  }

  // Ensure user account is active
  if (req.user.status !== 'active') {
    return res.status(403).json({
      success: false,
      message: 'Forbidden: Your account is currently inactive',
    });
  }

  next();
};

/**
 * Middleware factory to check fine-grained permission
 */
const hasPermission = (permissionName) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Not authorized' });
    }

    // Owner has implicit full access to all permissions
    if (req.user.role === 'owner') {
      return next();
    }

    if (req.user.role === 'admin') {
      const userPermissions = Array.isArray(req.user.permissions) ? req.user.permissions : [];
      // If user has the specific permission or ALL_PERMISSIONS default, allow
      if (userPermissions.includes(permissionName)) {
        return next();
      }
    }

    return res.status(403).json({
      success: false,
      message: `Forbidden: Permission '${permissionName}' required`,
    });
  };
};

module.exports = {
  adminOnly,
  hasPermission,
  ALL_PERMISSIONS,
};
