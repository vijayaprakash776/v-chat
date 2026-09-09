const Organization = require('../models/Organization');
const User = require('../models/User');
const Membership = require('../models/Membership');

// =========================================================================
// HELPERS
// =========================================================================

/**
 * Escape special regex characters in a user-supplied search string
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// =========================================================================
// 1. PLATFORM STATISTICS
// =========================================================================

// @desc    Get platform-level statistics
// @route   GET /api/super-admin/stats
// @access  Super Admin only
const getPlatformStats = async (req, res) => {
  try {
    const [
      totalOrgs,
      activeOrgs,
      suspendedOrgs,
      expiredOrgs,
      pendingOrgs,
      totalUsers,
      superAdmins,
    ] = await Promise.all([
      Organization.countDocuments(),
      Organization.countDocuments({ 'subscription.status': 'active' }),
      Organization.countDocuments({ 'subscription.status': 'suspended' }),
      Organization.countDocuments({ 'subscription.status': 'expired' }),
      Organization.countDocuments({ 'subscription.status': 'pending' }),
      User.countDocuments({ role: { $ne: 'super_admin' } }),
      User.countDocuments({ role: 'super_admin' }),
    ]);

    // Plan distribution
    const planCounts = await Organization.aggregate([
      { $group: { _id: '$subscription.plan', count: { $sum: 1 } } },
    ]);
    const plans = { free: 0, professional: 0, enterprise: 0 };
    planCounts.forEach((p) => { if (p._id) plans[p._id] = p.count; });

    return res.status(200).json({
      success: true,
      stats: {
        totalOrgs,
        activeOrgs,
        suspendedOrgs,
        expiredOrgs,
        pendingOrgs,
        totalUsers,
        superAdmins,
        plans,
      },
    });
  } catch (err) {
    console.error('getPlatformStats error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error fetching platform statistics' });
  }
};

// =========================================================================
// 2. ORGANIZATION MANAGEMENT
// =========================================================================

// @desc    List all organizations (paginated, searchable)
// @route   GET /api/super-admin/organizations
// @access  Super Admin only
const getAllOrganizations = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const skip = (page - 1) * limit;
    const search = req.query.search ? req.query.search.trim() : '';
    const statusFilter = req.query.status;
    const planFilter = req.query.plan;

    const query = {};
    if (search) {
      query.name = new RegExp(escapeRegex(search), 'i');
    }
    if (statusFilter && ['pending', 'active', 'rejected', 'suspended', 'expired'].includes(statusFilter)) {
      query.$or = [{ status: statusFilter }, { 'subscription.status': statusFilter }];
    }
    if (planFilter && ['free', 'professional', 'enterprise'].includes(planFilter)) {
      query['subscription.plan'] = planFilter;
    }

    const [orgs, total] = await Promise.all([
      Organization.find(query)
        .select('name slug description logo createdBy status approvedBy approvedAt rejectedBy rejectedAt rejectionReason subscription features createdAt')
        .populate('createdBy', 'name email')
        .populate('approvedBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Organization.countDocuments(query),
    ]);

    // Enrich each org with member count and owner/admin info
    const enriched = await Promise.all(
      orgs.map(async (org) => {
        const [memberCount, ownerMembership] = await Promise.all([
          Membership.countDocuments({ organization: org._id, status: 'active' }),
          Membership.findOne({ organization: org._id, role: { $in: ['owner', 'admin'] } })
            .populate('user', 'name email')
            .lean(),
        ]);
        return {
          ...org,
          memberCount,
          primaryAdmin: ownerMembership ? ownerMembership.user : null,
        };
      })
    );

    return res.status(200).json({
      success: true,
      organizations: enriched,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('getAllOrganizations error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error fetching organizations' });
  }
};

// @desc    Get full detail of a single organization
// @route   GET /api/super-admin/organizations/:id
// @access  Super Admin only
const getOrganizationDetail = async (req, res) => {
  try {
    const org = await Organization.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email')
      .populate('rejectedBy', 'name email')
      .lean();

    if (!org) {
      return res.status(404).json({ success: false, message: 'Organization not found' });
    }

    const memberships = await Membership.find({ organization: org._id, status: 'active' })
      .populate('user', 'name email role status avatar')
      .lean();

    const memberCount = memberships.length;
    const admins = memberships.filter((m) => ['owner', 'admin'].includes(m.role));

    return res.status(200).json({
      success: true,
      organization: {
        ...org,
        memberCount,
        admins: admins.map((m) => ({ ...m.user, membershipRole: m.role })),
        members: memberships.map((m) => ({ ...m.user, membershipRole: m.role })),
      },
    });
  } catch (err) {
    console.error('getOrganizationDetail error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error fetching organization detail' });
  }
};

// =========================================================================
// 3. ORGANIZATION STATUS MANAGEMENT (APPROVE / REJECT / SUSPEND)
// =========================================================================

// @desc    Approve / Activate an organization with plan, start date, and end date
// @route   PATCH /api/super-admin/organizations/:id/activate
// @access  Super Admin only
const activateOrganization = async (req, res) => {
  try {
    const orgId = req.params.id;
    const { plan, startDate, startedAt, endDate, expiresAt } = req.body;
    const superAdminId = req.user.id || req.user._id;

    const existing = await Organization.findById(orgId);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Organization not found' });
    }

    // 1. Resolve Plan
    const allowedPlans = ['free', 'professional', 'enterprise'];
    const finalPlan = (plan && allowedPlans.includes(plan.toLowerCase()))
      ? plan.toLowerCase()
      : (existing.subscription?.plan || 'free');

    // 2. Resolve Start Date
    const rawStart = startDate || startedAt;
    let finalStartDate = rawStart ? new Date(rawStart) : new Date();
    if (isNaN(finalStartDate.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid start date format' });
    }

    // 3. Resolve End Date
    const rawEnd = endDate || expiresAt;
    let finalEndDate = null;
    if (rawEnd) {
      finalEndDate = new Date(rawEnd);
      if (isNaN(finalEndDate.getTime())) {
        return res.status(400).json({ success: false, message: 'Invalid end date format' });
      }
    } else {
      // Default durations if not explicitly provided
      finalEndDate = new Date(finalStartDate.getTime());
      if (finalPlan === 'free') {
        finalEndDate.setDate(finalEndDate.getDate() + 30); // 30 days for Free
      } else {
        finalEndDate.setFullYear(finalEndDate.getFullYear() + 1); // 1 Year for Pro / Enterprise
      }
    }

    // 4. Validate End Date > Start Date
    if (finalEndDate <= finalStartDate) {
      return res.status(400).json({
        success: false,
        message: 'End date must be strictly after the start date',
      });
    }

    // 5. Update Organization to ACTIVE with approval metadata
    const updateData = {
      status: 'active',
      approvedBy: superAdminId,
      approvedAt: new Date(),
      rejectionReason: null,
      'subscription.status': 'active',
      'subscription.plan': finalPlan,
      'subscription.startedAt': finalStartDate,
      'subscription.expiresAt': finalEndDate,
    };

    const org = await Organization.findByIdAndUpdate(orgId, updateData, { new: true })
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email');

    // 6. Notify the creator / owner
    const Notification = require('../models/Notification');
    try {
      const notif = await Notification.create({
        recipient: org.createdBy?._id || org.createdBy,
        organization: org._id,
        sender: superAdminId,
        type: 'company_approved',
        content: `Your organization "${org.name}" has been approved by Super Admin and is now ACTIVE on the ${finalPlan.toUpperCase()} plan! (Valid until ${finalEndDate.toISOString().substring(0, 10)})`,
      });

      const io = req.app.get('io');
      if (io) {
        const creatorId = (org.createdBy?._id || org.createdBy)?.toString();
        if (creatorId) {
          io.to(`user:${creatorId}`).emit('notification:new', { notification: notif });
          io.to(`user:${creatorId}`).emit('org:statusChanged', {
            organizationId: org._id.toString(),
            status: 'active',
            subscription: org.subscription,
            organization: org,
          });
        }
        io.to(`company:${org._id}`).emit('org:statusChanged', {
          organizationId: org._id.toString(),
          status: 'active',
          subscription: org.subscription,
          organization: org,
        });
      }
    } catch (notifErr) {
      console.warn('Approval notification error:', notifErr.message);
    }

    return res.status(200).json({
      success: true,
      message: `Organization "${org.name}" has been approved and activated on the ${finalPlan.toUpperCase()} plan.`,
      organization: org,
    });
  } catch (err) {
    console.error('activateOrganization error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error activating organization' });
  }
};

// @desc    Reject a company registration request
// @route   PATCH /api/super-admin/organizations/:id/reject
// @access  Super Admin only
const rejectOrganization = async (req, res) => {
  try {
    const orgId = req.params.id;
    const { reason, rejectionReason } = req.body;
    const superAdminId = req.user.id || req.user._id;

    const existing = await Organization.findById(orgId);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Organization not found' });
    }

    const finalReason = (reason || rejectionReason || 'Registration request declined by Super Admin').trim();

    const updateData = {
      status: 'rejected',
      rejectedBy: superAdminId,
      rejectedAt: new Date(),
      rejectionReason: finalReason,
      'subscription.status': 'suspended',
    };

    const org = await Organization.findByIdAndUpdate(orgId, updateData, { new: true })
      .populate('createdBy', 'name email')
      .populate('rejectedBy', 'name email');

    // Notify creator
    const Notification = require('../models/Notification');
    try {
      const notif = await Notification.create({
        recipient: org.createdBy?._id || org.createdBy,
        organization: org._id,
        sender: superAdminId,
        type: 'company_rejected',
        content: `Your organization "${org.name}" registration request was rejected by Super Admin. Reason: ${finalReason}`,
      });

      const io = req.app.get('io');
      if (io) {
        const creatorId = (org.createdBy?._id || org.createdBy)?.toString();
        if (creatorId) {
          io.to(`user:${creatorId}`).emit('notification:new', { notification: notif });
          io.to(`user:${creatorId}`).emit('org:statusChanged', {
            organizationId: org._id.toString(),
            status: 'rejected',
            reason: finalReason,
            organization: org,
          });
        }
        io.to(`company:${org._id}`).emit('org:statusChanged', {
          organizationId: org._id.toString(),
          status: 'rejected',
          reason: finalReason,
          organization: org,
        });
      }
    } catch (notifErr) {
      console.warn('Rejection notification error:', notifErr.message);
    }

    return res.status(200).json({
      success: true,
      message: `Organization "${org.name}" has been rejected.`,
      organization: org,
    });
  } catch (err) {
    console.error('rejectOrganization error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error rejecting organization' });
  }
};

// @desc    Suspend an organization
// @route   PATCH /api/super-admin/organizations/:id/suspend
// @access  Super Admin only
const suspendOrganization = async (req, res) => {
  try {
    const org = await Organization.findByIdAndUpdate(
      req.params.id,
      {
        status: 'suspended',
        'subscription.status': 'suspended',
      },
      { new: true }
    );

    if (!org) return res.status(404).json({ success: false, message: 'Organization not found' });

    // Notify connected users
    const io = req.app.get('io');
    if (io) {
      io.to(`company:${org._id}`).emit('org:statusChanged', {
        organizationId: org._id.toString(),
        status: 'suspended',
        subscription: org.subscription,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Organization "${org.name}" has been suspended.`,
      organization: org,
    });
  } catch (err) {
    console.error('suspendOrganization error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error suspending organization' });
  }
};

// =========================================================================
// 4. SUBSCRIPTION MANAGEMENT
// =========================================================================

// @desc    Update subscription details
// @route   PATCH /api/super-admin/organizations/:id/subscription
// @access  Super Admin only
const updateSubscription = async (req, res) => {
  try {
    const { plan, status, expiresAt, startedAt } = req.body;
    const allowedStatuses = ['pending', 'active', 'rejected', 'suspended', 'expired'];
    const allowedPlans = ['free', 'professional', 'enterprise'];

    const updateData = {};
    if (plan && allowedPlans.includes(plan)) updateData['subscription.plan'] = plan;
    if (status && allowedStatuses.includes(status)) {
      updateData['subscription.status'] = status;
      updateData.status = status;
    }
    if (expiresAt) updateData['subscription.expiresAt'] = new Date(expiresAt);
    if (startedAt) updateData['subscription.startedAt'] = new Date(startedAt);

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid subscription fields provided' });
    }

    const org = await Organization.findByIdAndUpdate(req.params.id, updateData, { new: true });
    if (!org) return res.status(404).json({ success: false, message: 'Organization not found' });

    const io = req.app.get('io');
    if (io && status) {
      io.to(`company:${org._id}`).emit('org:statusChanged', {
        organizationId: org._id.toString(),
        status: org.subscription.status,
        subscription: org.subscription,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Subscription updated for "${org.name}".`,
      organization: org,
    });
  } catch (err) {
    console.error('updateSubscription error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error updating subscription' });
  }
};

// =========================================================================
// 5. FEATURE MANAGEMENT
// =========================================================================

// @desc    Update feature entitlements for an organization
// @route   PATCH /api/super-admin/organizations/:id/features
// @access  Super Admin only
const updateFeatures = async (req, res) => {
  try {
    const { chat, channels, todos } = req.body;
    const allowedFeatures = ['chat', 'channels', 'todos'];

    const updateData = {};
    allowedFeatures.forEach((f) => {
      if (req.body[f] !== undefined) {
        updateData[`features.${f}`] = Boolean(req.body[f]);
      }
    });

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid feature fields provided' });
    }

    const org = await Organization.findByIdAndUpdate(req.params.id, updateData, { new: true });
    if (!org) return res.status(404).json({ success: false, message: 'Organization not found' });

    // Notify connected users of feature change
    const io = req.app.get('io');
    if (io) {
      io.to(`company:${org._id}`).emit('org:featuresChanged', {
        organizationId: org._id.toString(),
        features: org.features,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Features updated for "${org.name}".`,
      organization: org,
    });
  } catch (err) {
    console.error('updateFeatures error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error updating features' });
  }
};

module.exports = {
  getPlatformStats,
  getAllOrganizations,
  getOrganizationDetail,
  activateOrganization,
  rejectOrganization,
  suspendOrganization,
  updateSubscription,
  updateFeatures,
};
