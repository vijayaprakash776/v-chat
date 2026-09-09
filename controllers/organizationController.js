const Organization = require('../models/Organization');
const Membership = require('../models/Membership');
const JoinRequest = require('../models/JoinRequest');
const User = require('../models/User');
const Channel = require('../models/Channel');
const Message = require('../models/Message');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const mongoose = require('mongoose');
const { getPlanEntitlements, getOrganizationStorageLimitBytes } = require('../config/plans');

// Helper to escape regex special characters
const escapeRegex = (string) => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
  * Log administrative or organization action
  */
const createOrgAuditRecord = async ({
  adminId,
  organizationId,
  action,
  targetType,
  targetId = '',
  targetName = '',
  details = '',
  metadata = {},
}) => {
  try {
    await AuditLog.create({
      admin: adminId,
      organization: organizationId,
      action,
      targetType,
      targetId: targetId ? targetId.toString() : '',
      targetName,
      details,
      metadata,
    });
  } catch (err) {
    console.error('AuditLog Creation Error:', err.message);
  }
};

// @desc    Register a new user and create an organization in one pass
// @route   POST /api/organizations/register-company
// @access  Public
const registerAndCreateCompany = async (req, res) => {
  try {
    const { name, email, password, companyName, companyDescription } = req.body;
    const bcrypt = require('bcryptjs');
    const jwt = require('jsonwebtoken');

    if (!name || !email || !password || !companyName) {
      return res.status(400).json({
        success: false,
        message: 'Please provide full name, email, password, and company name',
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters long',
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // 1. Check if user already exists
    let user = await User.findOne({ email: normalizedEmail });
    if (user) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists. Please sign in first.',
      });
    }

    // 2. Hash password & create user with Company Admin role
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      role: 'admin', // Company Admin role
      status: 'active',
    });

    const requestedPlan = (req.body.plan || req.body.requestedPlan || 'free').toLowerCase();
    const validPlans = ['free', 'professional', 'enterprise'];
    const selectedPlan = validPlans.includes(requestedPlan) ? requestedPlan : 'free';

    // 3. Create Organization with pending status & pending subscription (Super Admin approves/activates)
    const organization = await Organization.create({
      name: companyName.trim(),
      description: companyDescription ? companyDescription.trim() : '',
      createdBy: user._id,
      status: 'pending',
      subscription: { plan: selectedPlan, status: 'pending', startedAt: null, expiresAt: null },
      features: { chat: true, channels: true, todos: true },
    });

    // 4. Create active Company Admin membership
    const membership = await Membership.create({
      user: user._id,
      organization: organization._id,
      role: 'admin',
      permissions: [
        'MANAGE_MEMBERS',
        'MANAGE_JOIN_REQUESTS',
        'MANAGE_CHANNELS',
        'MANAGE_TODOS',
        'MANAGE_MESSAGES',
        'VIEW_ANALYTICS',
        'MANAGE_SETTINGS',
        'MANAGE_ROLES',
      ],
      status: 'active',
    });

    // 5. Update user current organization
    user.currentOrganization = organization._id;
    await user.save();

    // 6. Generate JWT token
    const JWT_SECRET = process.env.JWT_SECRET || 'flock_secret_jwt_key_2026_super_secure_token_auth';
    const token = jwt.sign({ id: user._id }, JWT_SECRET, {
      expiresIn: '7d',
    });

    // 7. Activity Log entry
    await createOrgAuditRecord({
      adminId: user._id,
      organizationId: organization._id,
      action: 'ORGANIZATION_CREATED',
      targetType: 'Organization',
      targetId: organization._id,
      targetName: organization.name,
      details: `Company "${organization.name}" was created by ${user.name} (Awaiting Super Admin Approval)`,
    });

    // 8. Notify Platform Super Admins
    try {
      const superAdmins = await User.find({ role: 'super_admin' });
      const io = req.app.get('io');
      for (const sa of superAdmins) {
        const notif = await Notification.create({
          recipient: sa._id,
          organization: organization._id,
          sender: user._id,
          type: 'company_request',
          content: `New organization registration request: "${organization.name}" by ${user.name} (${user.email}) - Plan: ${selectedPlan.toUpperCase()}`,
        });
        const populatedNotif = await Notification.findById(notif._id)
          .populate('sender', 'name email avatar')
          .populate('organization', 'name');
        if (io) {
          io.to(`user:${sa._id}`).emit('notification:new', { notification: populatedNotif });
          io.to('super_admins').emit('superadmin:company_request', {
            organization,
            requestedBy: { id: user._id, name: user.name, email: user.email },
          });
        }
      }
    } catch (notifErr) {
      console.warn('Super Admin notification error:', notifErr.message);
    }

    return res.status(201).json({
      success: true,
      message: `Company "${organization.name}" created successfully! It is awaiting Super Admin approval.`,
      token,
      companyStatus: 'pending',
      isCompanyActive: false,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: 'admin',
        status: user.status,
        currentOrganization: organization,
        organizationStatus: 'pending',
        isCompanyActive: false,
      },
      organization,
      membership,
    });
  } catch (error) {
    console.error('Register and Create Company Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error creating company and account',
    });
  }
};

// @desc    Create a new organization/company (for already authenticated user)
// @route   POST /api/organizations
// @access  Private
const createOrganization = async (req, res) => {
  try {
    const { name, description, plan, requestedPlan } = req.body;
    const userId = req.user.id;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Organization name is required',
      });
    }

    const planInput = (plan || requestedPlan || 'free').toLowerCase();
    const validPlans = ['free', 'professional', 'enterprise'];
    const selectedPlan = validPlans.includes(planInput) ? planInput : 'free';

    // 1. Create Organization with pending status & pending subscription
    const organization = await Organization.create({
      name: name.trim(),
      description: description ? description.trim() : '',
      createdBy: userId,
      status: 'pending',
      subscription: { plan: selectedPlan, status: 'pending', startedAt: null, expiresAt: null },
      features: { chat: true, channels: true, todos: true },
    });

    // 2. Creator automatically becomes active admin of the company
    const membership = await Membership.create({
      user: userId,
      organization: organization._id,
      role: 'admin',
      permissions: [
        'MANAGE_MEMBERS',
        'MANAGE_JOIN_REQUESTS',
        'MANAGE_CHANNELS',
        'MANAGE_TODOS',
        'MANAGE_MESSAGES',
        'VIEW_ANALYTICS',
        'MANAGE_SETTINGS',
        'MANAGE_ROLES',
      ],
      status: 'active',
    });

    // 3. Set creator's role to admin (if not super_admin) and currentOrganization to the newly created company
    const userDoc = await User.findById(userId);
    if (userDoc && userDoc.role !== 'super_admin') {
      userDoc.role = 'admin';
      userDoc.currentOrganization = organization._id;
      await userDoc.save();
    } else {
      await User.findByIdAndUpdate(userId, {
        currentOrganization: organization._id,
      });
    }

    // 4. Activity Log
    await createOrgAuditRecord({
      adminId: userId,
      organizationId: organization._id,
      action: 'ORGANIZATION_CREATED',
      targetType: 'Organization',
      targetId: organization._id,
      targetName: organization.name,
      details: `Organization "${organization.name}" was created by ${req.user.name} (Awaiting Super Admin Approval)`,
    });

    // 5. Notify Platform Super Admins
    try {
      const superAdmins = await User.find({ role: 'super_admin' });
      const io = req.app.get('io');
      for (const sa of superAdmins) {
        const notif = await Notification.create({
          recipient: sa._id,
          organization: organization._id,
          sender: userId,
          type: 'company_request',
          content: `New organization registration request: "${organization.name}" by ${req.user.name} (${req.user.email}) - Plan: ${selectedPlan.toUpperCase()}`,
        });
        const populatedNotif = await Notification.findById(notif._id)
          .populate('sender', 'name email avatar')
          .populate('organization', 'name');
        if (io) {
          io.to(`user:${sa._id}`).emit('notification:new', { notification: populatedNotif });
          io.to('super_admins').emit('superadmin:company_request', {
            organization,
            requestedBy: { id: userId, name: req.user.name, email: req.user.email },
          });
        }
      }
    } catch (notifErr) {
      console.warn('Super Admin notification error:', notifErr.message);
    }

    return res.status(201).json({
      success: true,
      message: `Organization "${organization.name}" created successfully! It is awaiting Super Admin approval.`,
      companyStatus: 'pending',
      isCompanyActive: false,
      organization,
      membership,
    });
  } catch (error) {
    console.error('Create Organization Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error creating organization',
    });
  }
};

// @desc    Get all organizations user is a member of
// @route   GET /api/organizations/my
// @access  Private
const getMyOrganizations = async (req, res) => {
  try {
    const userId = req.user.id;

    const memberships = await Membership.find({
      user: userId,
      status: 'active',
    }).populate('organization');

    const organizations = memberships
      .filter((m) => m.organization)
      .map((m) => ({
        ...m.organization.toObject(),
        role: m.role,
        isCurrent: req.user.currentOrganizationId === m.organization._id.toString(),
      }));

    return res.status(200).json({
      success: true,
      organizations,
      currentOrganization: req.user.currentOrganization,
    });
  } catch (error) {
    console.error('Get My Organizations Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching user organizations',
    });
  }
};

// @desc    Switch active organization context
// @route   POST /api/organizations/:id/switch
// @access  Private
const switchOrganization = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Verify user is an active member
    const membership = await Membership.findOne({
      user: userId,
      organization: id,
      status: 'active',
    }).populate('organization');

    if (!membership) {
      return res.status(403).json({
        success: false,
        message: 'You are not an active member of this organization',
      });
    }

    await User.findByIdAndUpdate(userId, {
      currentOrganization: id,
    });

    return res.status(200).json({
      success: true,
      message: `Switched active organization to "${membership.organization.name}"`,
      organization: membership.organization,
      role: membership.role,
    });
  } catch (error) {
    console.error('Switch Organization Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error switching organization',
    });
  }
};

// @desc    Get plan details, entitlements, and usage for organization
// @route   GET /api/organizations/:id/plan
// @access  Private
const getOrganizationPlanDetails = async (req, res) => {
  try {
    let orgId = req.params.id;
    if (!orgId || orgId === 'current') {
      orgId = req.user.currentOrganizationId;
    }

    if (!mongoose.Types.ObjectId.isValid(orgId)) {
      return res.status(400).json({ success: false, message: 'Invalid organization ID format' });
    }

    // Authorization: User must be an active member of this org
    const membership = await Membership.findOne({
      user: req.user.id,
      organization: orgId,
      status: 'active',
    });

    if (!membership) {
      return res.status(403).json({ success: false, message: 'Access denied to organization plan details' });
    }

    const org = await Organization.findById(orgId);
    if (!org) {
      return res.status(404).json({ success: false, message: 'Organization not found' });
    }

    const planCode = org.subscription?.plan || 'free';
    const entitlements = getPlanEntitlements(planCode);

    const activeMemberCount = await Membership.countDocuments({ organization: orgId, status: 'active' });
    const channelCount = await Channel.countDocuments({ organization: orgId });

    const storageResult = await Message.aggregate([
      { $match: { organization: new mongoose.Types.ObjectId(orgId), 'attachments.0': { $exists: true } } },
      { $unwind: '$attachments' },
      { $group: { _id: null, totalUsedBytes: { $sum: '$attachments.fileSize' } } },
    ]);
    const usedStorageBytes = storageResult[0]?.totalUsedBytes || 0;
    const totalStorageLimitBytes = getOrganizationStorageLimitBytes(planCode, activeMemberCount);

    return res.status(200).json({
      success: true,
      organizationId: org._id,
      organizationName: org.name,
      plan: planCode,
      entitlements,
      usage: {
        members: {
          current: activeMemberCount,
          max: entitlements.maxMembers,
          isLimitReached: entitlements.maxMembers ? activeMemberCount >= entitlements.maxMembers : false,
        },
        channels: {
          current: channelCount,
          max: entitlements.maxChannels,
          isLimitReached: entitlements.maxChannels ? channelCount >= entitlements.maxChannels : false,
        },
        storage: {
          usedBytes: usedStorageBytes,
          usedFormatted: `${(usedStorageBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`,
          totalLimitBytes: totalStorageLimitBytes,
          limitFormatted: `${(totalStorageLimitBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`,
          isLimitReached: usedStorageBytes >= totalStorageLimitBytes,
        },
        maxFileSizeBytes: entitlements.maxFileSizeBytes,
        maxFileSizeMB: entitlements.maxFileSizeMB,
        messageHistoryCutoffDays: entitlements.messageHistoryCutoffDays,
      },
    });
  } catch (error) {
    console.error('Get Organization Plan Error:', error.message);
    return res.status(500).json({ success: false, message: 'Server error fetching plan details' });
  }
};

// @desc    Upgrade organization plan from FREE to PROFESSIONAL (non-destructive)
// @route   POST /api/organizations/:id/upgrade
// @access  Private (Org Admin / Owner only)
const upgradeOrganizationPlan = async (req, res) => {
  try {
    let orgId = req.params.id;
    if (!orgId || orgId === 'current') {
      orgId = req.user.currentOrganizationId;
    }

    if (!mongoose.Types.ObjectId.isValid(orgId)) {
      return res.status(400).json({ success: false, message: 'Invalid organization ID format' });
    }

    // Check membership and role: Only admin/owner in the org or system admin can upgrade
    const membership = await Membership.findOne({
      user: req.user.id,
      organization: orgId,
      status: 'active',
    });

    const isOrgAdmin = membership && ['admin', 'owner'].includes(membership.role);
    const isSysAdmin = req.user.role === 'admin';

    if (!isOrgAdmin && !isSysAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Only an organization admin or owner can upgrade subscription plans',
      });
    }

    const org = await Organization.findById(orgId);
    if (!org) {
      return res.status(404).json({ success: false, message: 'Organization not found' });
    }

    const targetPlan = (req.body.plan || 'professional').toLowerCase();
    if (targetPlan !== 'professional') {
      return res.status(400).json({
        success: false,
        message: 'Invalid plan requested. Supported upgrade target: "professional"',
      });
    }

    // Safely update plan without resetting or deleting existing data
    if (!org.subscription) {
      org.subscription = {};
    }
    org.subscription.plan = 'professional';
    org.subscription.status = 'active';
    org.subscription.updatedAt = new Date();

    await org.save();

    // Log Audit Record
    await createOrgAuditRecord({
      adminId: req.user.id,
      organizationId: org._id,
      action: 'UPGRADE_PLAN',
      targetType: 'Organization',
      targetId: org._id.toString(),
      targetName: org.name,
      details: `Upgraded workspace plan to Professional (${org.subscription.plan})`,
    });

    const entitlements = getPlanEntitlements('professional');

    // Socket.IO emission to notify all connected workspace users of plan upgrade
    const io = req.app.get('io');
    if (io) {
      io.to(`company:${org._id.toString()}`).emit('organization:plan_upgraded', {
        organizationId: org._id,
        plan: 'professional',
        entitlements,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Successfully upgraded workspace "${org.name}" to Professional plan!`,
      organization: org,
      entitlements,
    });
  } catch (error) {
    console.error('Upgrade Organization Plan Error:', error.message);
    return res.status(500).json({ success: false, message: 'Server error upgrading plan' });
  }
};

module.exports = {
  registerAndCreateCompany,
  createOrganization,
  getMyOrganizations,
  switchOrganization,
  getOrganizationPlanDetails,
  upgradeOrganizationPlan,
  createOrgAuditRecord,
};

