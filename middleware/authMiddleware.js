const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const JWT_SECRET = process.env.JWT_SECRET || 'flock_secret_jwt_key_2026_super_secure_token_auth';

// Middleware to protect private routes by verifying JWT in Authorization header
const protect = async (req, res, next) => {
  let token;

  // 1. Check for Authorization header starting with "Bearer"
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      // 2. Extract token from header "Bearer <token>"
      token = req.headers.authorization.split(' ')[1];

      // 3. Verify token with server secret key
      const decoded = jwt.verify(token, JWT_SECRET);

      // 4. Attach user ID and active record to req.user for downstream controllers
      const User = require('../models/User');
      const Membership = require('../models/Membership');
      const Organization = require('../models/Organization');

      const user = await User.findById(decoded.id).select('-password');
      if (!user) {
        return res.status(401).json({
          message: 'User account no longer exists',
        });
      }

      const isSuperAdmin = user.role === 'super_admin';

      // Super Admins have no organization membership — skip org lookup entirely
      if (isSuperAdmin) {
        req.user = {
          id: user._id.toString(),
          _id: user._id,
          name: user.name,
          email: user.email,
          avatar: user.avatar || '',
          bio: user.bio || '',
          title: user.title || '',
          phone: user.phone || '',
          role: 'super_admin',
          globalRole: 'super_admin',
          isSuperAdmin: true,
          permissions: [],
          status: user.status || 'active',
          isDeactivated: user.status === 'inactive',
          currentOrganization: null,
          currentOrganizationId: null,
          pinnedChats: user.pinnedChats || [],
          pinnedChannels: user.pinnedChannels || [],
        };
        return next();
      }

      // Check for x-organization-id header to disambiguate current organization context
      const requestedOrgId = req.headers['x-organization-id'];
      let activeMembership = null;

      if (requestedOrgId && mongoose.Types.ObjectId.isValid(requestedOrgId)) {
        activeMembership = await Membership.findOne({
          user: user._id,
          organization: requestedOrgId,
        }).populate('organization');

        if (activeMembership && (!user.currentOrganization || user.currentOrganization.toString() !== requestedOrgId.toString())) {
          user.currentOrganization = requestedOrgId;
          await user.save();
        }
      }

      // Fallback to user.currentOrganization
      if (!activeMembership && user.currentOrganization) {
        activeMembership = await Membership.findOne({
          user: user._id,
          organization: user.currentOrganization,
        }).populate('organization');
      }

      // Fallback to any membership
      if (!activeMembership) {
        activeMembership = await Membership.findOne({
          user: user._id,
        }).populate('organization');

        if (activeMembership) {
          const orgId = activeMembership.organization?._id || activeMembership.organization;
          if (orgId) {
            user.currentOrganization = orgId;
            await user.save();
          }
        }
      }

      const org = activeMembership ? activeMembership.organization : null;
      const orgStatus = org ? (org.status || org.subscription?.status || 'pending') : null;
      const isCompanyActive = orgStatus === 'active' && (!org.subscription?.expiresAt || new Date() <= new Date(org.subscription.expiresAt));

      // User is deactivated if globally inactive OR inactive within the current organization
      const isDeactivated = Boolean(user.status === 'inactive' || (activeMembership && activeMembership.status === 'inactive'));

      req.user = {
        id: user._id.toString(),
        _id: user._id,
        name: user.name,
        email: user.email,
        avatar: user.avatar || '',
        bio: user.bio || '',
        title: user.title || '',
        phone: user.phone || '',
        role: activeMembership ? activeMembership.role : (user.role || 'user'),
        permissions: activeMembership ? (activeMembership.permissions || []) : [],
        globalRole: user.role || 'user',
        isSuperAdmin: false,
        status: isDeactivated ? 'inactive' : 'active',
        isDeactivated,
        currentOrganization: org,
        currentOrganizationId: org ? org._id.toString() : null,
        organizationStatus: orgStatus,
        isCompanyActive,
        pinnedChats: user.pinnedChats || [],
        pinnedChannels: user.pinnedChannels || [],
      };

      // Block mutating operations for deactivated users (read-only mode)
      if (isDeactivated && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        if (req.originalUrl && req.originalUrl.includes('/auth/logout')) {
          return next();
        }
        return res.status(403).json({
          success: false,
          code: 'ACCOUNT_DEACTIVATED',
          message: 'Your account is deactivated in this organization. You have read-only access to existing data.',
        });
      }

      return next(); // Proceed to the protected controller
    } catch (error) {
      console.error('JWT Verification Error:', error.message);
      return res.status(401).json({
        message: 'Not authorized, token is invalid or expired',
      });
    }
  }

  // If no token was found in header
  if (!token) {
    return res.status(401).json({
      message: 'Not authorized, no token provided',
    });
  }
};

/**
 * Middleware: Enforces that the request comes from a user belonging to an APPROVED & ACTIVE company.
 * Super Admins bypass this check.
 * Pending, Rejected, Suspended, or Expired organizations are rejected with HTTP 403.
 */
const requireActiveCompany = (req, res, next) => {
  if (req.user?.isSuperAdmin) {
    return next();
  }

  const org = req.user?.currentOrganization;
  if (!org) {
    return res.status(403).json({
      success: false,
      code: 'NO_ORGANIZATION',
      message: 'You are not associated with any organization.',
    });
  }

  const status = org.status || org.subscription?.status || 'pending';

  if (status === 'pending') {
    return res.status(403).json({
      success: false,
      code: 'COMPANY_PENDING_APPROVAL',
      companyStatus: 'pending',
      message: 'Your organization is awaiting Super Admin approval before workspace features can be accessed.',
    });
  }

  if (status === 'rejected') {
    return res.status(403).json({
      success: false,
      code: 'COMPANY_REJECTED',
      companyStatus: 'rejected',
      message: `Your organization registration was rejected by Super Admin.${org.rejectionReason ? ` Reason: ${org.rejectionReason}` : ''}`,
    });
  }

  if (status === 'suspended') {
    return res.status(403).json({
      success: false,
      code: 'COMPANY_SUSPENDED',
      companyStatus: 'suspended',
      message: 'Your organization workspace has been suspended. Please contact platform support.',
    });
  }

  if (status === 'expired' || (org.subscription?.expiresAt && new Date() > new Date(org.subscription.expiresAt))) {
    return res.status(403).json({
      success: false,
      code: 'COMPANY_EXPIRED',
      companyStatus: 'expired',
      message: 'Your organization subscription has expired. Please contact platform support.',
    });
  }

  return next();
};

// Optional auth middleware: Populates req.user if a valid Bearer token is provided, but continues without error if missing
const optionalAuth = async (req, res, next) => {
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    const token = req.headers.authorization.split(' ')[1];
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const User = require('../models/User');
        const user = await User.findById(decoded.id).select('-password');
        if (user && user.status === 'active') {
          req.user = {
            id: user._id,
            _id: user._id,
            name: user.name,
            email: user.email,
            avatar: user.avatar || '',
            bio: user.bio || '',
            title: user.title || '',
            phone: user.phone || '',
            role: user.role || 'user',
            status: user.status,
          };
        }
      } catch (err) {
        // Token expired/invalid - ignore for optional auth
      }
    }
  }
  next();
};

module.exports = {
  protect,
  requireActiveCompany,
  optionalAuth,
};
