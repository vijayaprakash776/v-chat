/**
 * Super Admin Middleware
 * Must be mounted AFTER authMiddleware.protect
 * Guards all platform-level Super Admin routes.
 */
const superAdminOnly = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  // req.user.isSuperAdmin is set by authMiddleware.protect for super_admin users
  if (!req.user.isSuperAdmin) {
    return res.status(403).json({
      success: false,
      message: 'Forbidden: Super Admin access required. This area is restricted to Flock platform administrators.',
    });
  }

  next();
};

module.exports = { superAdminOnly };
