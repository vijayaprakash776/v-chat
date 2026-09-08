const mongoose = require('mongoose');
const User = require('../models/User');
const Channel = require('../models/Channel');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');
const Organization = require('../models/Organization');
const Membership = require('../models/Membership');
const JoinRequest = require('../models/JoinRequest');
const Invitation = require('../models/Invitation');

// Helper to escape regex special characters
const escapeRegex = (string) => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * Log an administrative action to MongoDB AuditLog collection
 */
const createAuditRecord = async ({
  adminId,
  organizationId = null,
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

// =========================================================================
// 1. WORKSPACE STATISTICS
// =========================================================================

// @desc    Get aggregated workspace metrics (scoped to admin's organization)
// @route   GET /api/admin/stats
// @access  Private / Admin
const getWorkspaceStats = async (req, res) => {
  try {
    const orgId = req.user.currentOrganizationId;
    const Todo = require('../models/Todo');

    // Get all user IDs that belong to this org
    const orgMemberships = await Membership.find({
      organization: orgId,
    }).select('user role status');

    const activeMemberships = orgMemberships.filter((m) => m.status === 'active');
    const inactiveMemberships = orgMemberships.filter((m) => m.status === 'inactive');
    const memberUserIds = orgMemberships.map((m) => m.user);
    const ownerCount = orgMemberships.filter((m) => m.role === 'owner').length;
    const adminCount = orgMemberships.filter((m) => m.role === 'admin').length;

    // Date boundaries for activity metrics
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const startOfWeek = new Date();
    startOfWeek.setDate(startOfWeek.getDate() - 7);

    // Run parallel database queries scoped strictly to orgId / memberUserIds
    const [
      activeUsers,
      inactiveUsers,
      pendingJoinRequests,
      pendingInvitations,
      totalChannels,
      publicChannels,
      privateChannels,
      totalMessages,
      messagesToday,
      messagesThisWeek,
      totalConversations,
      unreadNotifications,
      totalFiles,
      totalTodos,
      completedTodos,
      pendingTodos,
      topChannelsRaw,
    ] = await Promise.all([
      User.countDocuments({ _id: { $in: memberUserIds }, status: 'active' }),
      User.countDocuments({ _id: { $in: memberUserIds }, status: 'inactive' }),
      JoinRequest.countDocuments({ organization: orgId, status: 'pending' }),
      Invitation.countDocuments({ organization: orgId, status: 'pending' }),
      Channel.countDocuments({ organization: orgId }),
      Channel.countDocuments({ organization: orgId, isPrivate: false }),
      Channel.countDocuments({ organization: orgId, isPrivate: true }),
      Message.countDocuments({ organization: orgId }),
      Message.countDocuments({ organization: orgId, createdAt: { $gte: startOfToday } }),
      Message.countDocuments({ organization: orgId, createdAt: { $gte: startOfWeek } }),
      Conversation.countDocuments({ organization: orgId }),
      Notification.countDocuments({ isRead: false, recipient: { $in: memberUserIds } }),
      Message.countDocuments({
        organization: orgId,
        attachments: { $exists: true, $not: { $size: 0 } },
      }),
      Todo.countDocuments({ organization: orgId }),
      Todo.countDocuments({ organization: orgId, status: 'completed' }),
      Todo.countDocuments({ organization: orgId, status: 'pending' }),
      Message.aggregate([
        { $match: { organization: new mongoose.Types.ObjectId(orgId), channelId: { $ne: null } } },
        { $group: { _id: '$channelId', messageCount: { $sum: 1 } } },
        { $sort: { messageCount: -1 } },
        { $limit: 5 },
      ]),
    ]);

    // Populate top channels names
    const topChannelIds = topChannelsRaw.map((tc) => tc._id);
    const topChannelsList = await Channel.find({ _id: { $in: topChannelIds } }).select('name isPrivate');
    const channelMap = new Map();
    topChannelsList.forEach((c) => channelMap.set(c._id.toString(), c));

    const topChannels = topChannelsRaw.map((tc) => {
      const chan = channelMap.get(tc._id.toString());
      return {
        _id: tc._id,
        name: chan ? chan.name : 'Unknown Channel',
        isPrivate: chan ? chan.isPrivate : false,
        messageCount: tc.messageCount,
      };
    });

    const completionPercentage = totalTodos > 0 ? Math.round((completedTodos / totalTodos) * 100) : 0;

    return res.status(200).json({
      success: true,
      stats: {
        totalUsers: orgMemberships.length,
        activeUsers: activeMemberships.length,
        inactiveUsers: inactiveMemberships.length,
        ownerUsers: ownerCount,
        adminUsers: adminCount,
        pendingJoinRequests,
        pendingInvitations,
        totalConversations,
        totalMessages,
        messagesToday,
        messagesThisWeek,
        totalChannels,
        publicChannels,
        privateChannels,
        unreadNotifications,
        totalFiles,
        todoMetrics: {
          totalTodos,
          completedTodos,
          pendingTodos,
          completionPercentage,
        },
        topChannels,
      },
    });
  } catch (error) {
    console.error('Get Admin Stats Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error calculating workspace statistics',
    });
  }
};


// =========================================================================
// 2. USER MANAGEMENT
// =========================================================================

// @desc    Get paginated users list with search and filters (scoped to organization if applicable)
// @route   GET /api/admin/users
// @access  Private / Admin
const getUsers = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const skip = (page - 1) * limit;
    const search = req.query.search ? req.query.search.trim() : '';
    const role = req.query.role;
    const status = req.query.status;
    const orgId = req.user.currentOrganizationId;

    if (!orgId && !req.user.isSuperAdmin) {
      return res.status(200).json({
        success: true,
        count: 0,
        totalCount: 0,
        page,
        totalPages: 1,
        users: [],
      });
    }

    let userIds = null;
    let membershipRoleMap = new Map();

    if (orgId) {
      const memberQuery = { organization: orgId };
      if (role && ['user', 'admin', 'member', 'owner'].includes(role)) {
        memberQuery.role = role === 'user' ? 'member' : role;
      }
      if (status && ['active', 'inactive'].includes(status)) {
        memberQuery.status = status;
      }

      const memberships = await Membership.find(memberQuery);
      userIds = memberships.map((m) => m.user);
      memberships.forEach((m) => membershipRoleMap.set(m.user.toString(), m));
    }

    const query = {};
    if (userIds !== null) {
      query._id = { $in: userIds };
    }

    if (search) {
      const safeRegex = new RegExp(escapeRegex(search), 'i');
      query.$or = [{ name: safeRegex }, { email: safeRegex }];
    }

    if (!orgId && req.user.isSuperAdmin) {
      if (role && ['user', 'admin', 'owner'].includes(role)) {
        query.role = role;
      }
      if (status && ['active', 'inactive'].includes(status)) {
        query.status = status;
      }
    }

    const [users, totalCount] = await Promise.all([
      User.find(query)
        .select('-password')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      User.countDocuments(query),
    ]);

    // Format response including organization-specific role/status/permissions
    const formattedUsers = users.map((u) => {
      const membership = membershipRoleMap.get(u._id.toString());
      return {
        ...u.toObject(),
        role: membership ? membership.role : (u.role || 'user'),
        permissions: membership ? (membership.permissions || []) : [],
        status: membership ? membership.status : (u.status || 'active'),
        membershipId: membership?._id || null,
      };
    });

    return res.status(200).json({
      success: true,
      count: formattedUsers.length,
      totalCount,
      page,
      totalPages: Math.ceil(totalCount / limit) || 1,
      users: formattedUsers,
    });
  } catch (error) {
    console.error('Admin Get Users Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error retrieving users',
    });
  }
};

// @desc    Change user role in organization (owner, admin, member)
// @route   PATCH /api/admin/users/:id/role
// @access  Private / Admin
const updateUserRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    const adminId = req.user.id;
    const orgId = req.user.currentOrganizationId;

    if (!['owner', 'admin', 'member', 'user'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid role. Allowed roles: owner, admin, member',
      });
    }

    const targetRole = role === 'user' ? 'member' : role;

    // Security: Protect against accidental self-demotion
    if (id.toString() === adminId.toString() && targetRole !== req.user.role) {
      return res.status(400).json({
        success: false,
        message: 'Cannot demote your own account role directly',
      });
    }

    const user = await User.findById(id).select('-password');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (orgId) {
      const membership = await Membership.findOne({ user: id, organization: orgId });
      if (!membership) {
        return res.status(404).json({
          success: false,
          message: 'User is not a member of this organization',
        });
      }

      // Security: Owner Protection
      if (membership.role === 'owner' && targetRole !== 'owner') {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: The company OWNER cannot be demoted or changed by another administrator.',
        });
      }

      // Only an existing OWNER can promote another user to OWNER
      if (targetRole === 'owner' && req.user.role !== 'owner') {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: Only the current company OWNER can assign the OWNER role.',
        });
      }

      // Prevent demoting the last active admin/owner
      if (['admin', 'owner'].includes(membership.role) && targetRole === 'member') {
        const adminCount = await Membership.countDocuments({
          organization: orgId,
          role: { $in: ['admin', 'owner'] },
          status: 'active',
        });
        if (adminCount <= 1) {
          return res.status(400).json({
            success: false,
            message: 'Cannot demote the last remaining administrator in this organization.',
          });
        }
      }

      const oldRole = membership.role;
      membership.role = targetRole;

      // Assign default admin permissions if promoting to admin and permissions array is empty
      if (targetRole === 'admin' && (!membership.permissions || membership.permissions.length === 0)) {
        membership.permissions = [
          'MANAGE_MEMBERS',
          'MANAGE_JOIN_REQUESTS',
          'MANAGE_CHANNELS',
          'VIEW_ANALYTICS',
        ];
      } else if (targetRole === 'owner') {
        membership.permissions = [
          'MANAGE_MEMBERS',
          'MANAGE_JOIN_REQUESTS',
          'MANAGE_CHANNELS',
          'MANAGE_TODOS',
          'MANAGE_MESSAGES',
          'VIEW_ANALYTICS',
          'MANAGE_SETTINGS',
          'MANAGE_ROLES',
        ];
      }

      await membership.save();

      await createAuditRecord({
        adminId,
        organizationId: orgId,
        action: 'USER_ROLE_UPDATED',
        targetType: 'User',
        targetId: user._id,
        targetName: user.name,
        details: `Changed role of "${user.name}" (${user.email}) from ${oldRole} to ${targetRole}`,
        metadata: { previousRole: oldRole, newRole: targetRole },
      });

      // Emit Socket.IO notification to company room
      const io = req.app.get('io');
      if (io) {
        io.to(`company:${orgId}`).emit('membership:updated', {
          userId: user._id.toString(),
          role: targetRole,
          permissions: membership.permissions,
        });
      }

      return res.status(200).json({
        success: true,
        message: `User role updated to ${targetRole}`,
        user: { ...user.toObject(), role: targetRole, permissions: membership.permissions },
      });
    } else {
      // Global User role update fallback
      const oldRole = user.role;
      user.role = role === 'member' ? 'user' : role;
      await user.save();

      await createAuditRecord({
        adminId,
        action: 'USER_ROLE_UPDATED',
        targetType: 'User',
        targetId: user._id,
        targetName: user.name,
        details: `Changed role of "${user.name}" (${user.email}) from ${oldRole} to ${user.role}`,
        metadata: { previousRole: oldRole, newRole: user.role },
      });

      return res.status(200).json({
        success: true,
        message: `User role updated to ${user.role}`,
        user,
      });
    }
  } catch (error) {
    console.error('Update User Role Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error updating user role',
    });
  }
};

// @desc    Update user status (activate / deactivate with last-admin check)
// @route   PATCH /api/admin/users/:id/status
// @access  Private / Admin
const updateUserStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const adminId = req.user.id;
    const orgId = req.user.currentOrganizationId;

    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be "active" or "inactive"',
      });
    }

    // Security: Protect against self-deactivation
    if (id.toString() === adminId.toString() && status === 'inactive') {
      return res.status(400).json({
        success: false,
        message: 'Cannot deactivate your own administrator account',
      });
    }

    const user = await User.findById(id).select('-password');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (orgId) {
      const membership = await Membership.findOne({ user: id, organization: orgId });
      if (!membership) {
        return res.status(404).json({
          success: false,
          message: 'User is not a member of this organization',
        });
      }

      // Security: Owner Protection against deactivation
      if (membership.role === 'owner' && status === 'inactive') {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: The company OWNER account cannot be deactivated.',
        });
      }

      // Prevent deactivating the last active admin/owner
      if (['admin', 'owner'].includes(membership.role) && status === 'inactive') {
        const activeAdminCount = await Membership.countDocuments({
          organization: orgId,
          role: { $in: ['admin', 'owner'] },
          status: 'active',
        });
        if (activeAdminCount <= 1) {
          return res.status(400).json({
            success: false,
            message: 'Cannot deactivate the last remaining administrator in this organization.',
          });
        }
      }

      const oldStatus = membership.status;
      membership.status = status;
      await membership.save();

      await createAuditRecord({
        adminId,
        organizationId: orgId,
        action: 'USER_STATUS_UPDATED',
        targetType: 'User',
        targetId: user._id,
        targetName: user.name,
        details: `Changed status of "${user.name}" (${user.email}) in organization from ${oldStatus} to ${status}`,
        metadata: { previousStatus: oldStatus, newStatus: status },
      });

      const io = req.app.get('io');
      if (io) {
        io.to(`company:${orgId}`).emit('organization:members_updated', {
          organizationId: orgId,
          userId: user._id.toString(),
          status,
        });
      }

      return res.status(200).json({
        success: true,
        message: `User status changed to ${status}`,
        user: { ...user.toObject(), status },
      });
    } else {
      // Global User status update fallback
      const oldStatus = user.status;
      user.status = status;
      await user.save();

      await createAuditRecord({
        adminId,
        action: 'USER_STATUS_UPDATED',
        targetType: 'User',
        targetId: user._id,
        targetName: user.name,
        details: `Changed global status of "${user.name}" (${user.email}) from ${oldStatus} to ${status}`,
        metadata: { previousStatus: oldStatus, newStatus: status },
      });

      return res.status(200).json({
        success: true,
        message: `User status changed to ${status}`,
        user,
      });
    }
  } catch (error) {
    console.error('Update User Status Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error updating user status',
    });
  }
};

// @desc    Update user permissions in organization
// @route   PATCH /api/admin/users/:id/permissions
// @access  Private / Admin (MANAGE_ROLES permission or Owner)
const updateUserPermissions = async (req, res) => {
  try {
    const { id } = req.params;
    const { permissions } = req.body;
    const adminId = req.user.id;
    const orgId = req.user.currentOrganizationId;

    if (!Array.isArray(permissions)) {
      return res.status(400).json({
        success: false,
        message: 'Permissions must be an array of string permission keys',
      });
    }

    const user = await User.findById(id).select('-password');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    const membership = await Membership.findOne({ user: id, organization: orgId });
    if (!membership) {
      return res.status(404).json({
        success: false,
        message: 'User is not a member of this organization',
      });
    }

    // Owner protection
    if (membership.role === 'owner') {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: The company OWNER has implicit full access to all permissions.',
      });
    }

    const validPermissions = [
      'MANAGE_MEMBERS',
      'MANAGE_JOIN_REQUESTS',
      'MANAGE_CHANNELS',
      'MANAGE_TODOS',
      'MANAGE_MESSAGES',
      'VIEW_ANALYTICS',
      'MANAGE_SETTINGS',
      'MANAGE_ROLES',
    ];

    const cleanPermissions = permissions.filter((p) => validPermissions.includes(p));

    membership.permissions = cleanPermissions;
    await membership.save();

    await createAuditRecord({
      adminId,
      organizationId: orgId,
      action: 'USER_PERMISSIONS_UPDATED',
      targetType: 'User',
      targetId: user._id,
      targetName: user.name,
      details: `Updated permissions for "${user.name}" (${user.email}): [${cleanPermissions.join(', ')}]`,
      metadata: { permissions: cleanPermissions },
    });

    // Emit Socket.IO notification to company room
    const io = req.app.get('io');
    if (io) {
      io.to(`company:${orgId}`).emit('membership:updated', {
        userId: user._id.toString(),
        role: membership.role,
        permissions: cleanPermissions,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'User permissions updated successfully',
      permissions: cleanPermissions,
    });
  } catch (error) {
    console.error('Update User Permissions Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error updating user permissions',
    });
  }
};

// @desc    Invite employee by email to active organization (creates Invitation)
// @route   POST /api/admin/invite-user
// @access  Private / Admin
const inviteUserToOrganization = async (req, res) => {
  try {
    const { email } = req.body;
    const adminId = req.user.id;
    const orgId = req.user.currentOrganizationId;

    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid employee email address',
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Basic email format check
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid email address format',
      });
    }

    // 1. Check if user is already an active member of this org
    const targetUser = await User.findOne({ email: normalizedEmail }).select('-password');
    if (targetUser) {
      const existingMembership = await Membership.findOne({
        user: targetUser._id,
        organization: orgId,
        status: 'active',
      });

      if (existingMembership) {
        return res.status(400).json({
          success: false,
          message: `User ${targetUser.name} (${normalizedEmail}) is already an active member of this organization.`,
        });
      }
    }

    // 2. Check for existing pending invitation
    const existingInvitation = await Invitation.findOne({
      organization: orgId,
      email: normalizedEmail,
      status: 'pending',
    });

    if (existingInvitation) {
      if (existingInvitation.expiresAt && new Date() > existingInvitation.expiresAt) {
        existingInvitation.status = 'expired';
        await existingInvitation.save();
      } else {
        return res.status(400).json({
          success: false,
          message: `A pending invitation for "${normalizedEmail}" already exists.`,
        });
      }
    }

    // 3. Create Invitation
    const invitation = await Invitation.create({
      organization: orgId,
      email: normalizedEmail,
      invitedBy: adminId,
      status: 'pending',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });

    const populatedInvitation = await Invitation.findById(invitation._id)
      .populate('organization', 'name slug')
      .populate('invitedBy', 'name email');

    // 4. Activity Log entry
    const org = await Organization.findById(orgId);
    const orgName = org?.name || 'the organization';

    await createAuditRecord({
      adminId,
      organizationId: orgId,
      action: 'USER_ROLE_UPDATED',
      targetType: 'User',
      targetId: targetUser?._id || '',
      targetName: targetUser?.name || normalizedEmail,
      details: `Created invitation for "${normalizedEmail}" to join workspace "${orgName}"`,
      metadata: { email: normalizedEmail, invitationId: invitation._id },
    });

    // 5. Notify user if already registered + notify company room
    const io = req.app.get('io');
    if (io) {
      if (targetUser) {
        try {
          const notif = await Notification.create({
            recipient: targetUser._id,
            organization: orgId,
            sender: adminId,
            type: 'invitation_received',
            content: `You've been invited to join "${orgName}"`,
          });

          const populatedNotif = await Notification.findById(notif._id)
            .populate('sender', 'name email avatar')
            .populate('organization', 'name');

          io.to(`user:${targetUser._id}`).emit('notification:new', {
            notification: populatedNotif,
          });
          io.to(`user:${targetUser._id}`).emit('invitation:received', {
            invitation: populatedInvitation,
          });
        } catch (notifErr) {
          console.error('Failed to notify user:', notifErr.message);
        }
      }

      io.to(`company:${orgId}`).emit('invitation:created', {
        invitation: populatedInvitation,
      });
    }

    return res.status(200).json({
      success: true,
      message: targetUser
        ? `Invitation created for ${targetUser.name} (${normalizedEmail}). They will receive an in-app invitation.`
        : `Invitation created for ${normalizedEmail}. They can accept after signing up with this email.`,
      invitation: populatedInvitation,
    });
  } catch (error) {
    console.error('Invite User Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error creating invitation',
    });
  }
};

// =========================================================================
// 2B. JOIN REQUESTS MANAGEMENT (DEPRECATED — For draining legacy requests)
// =========================================================================

// @desc    Get pending join requests for current organization (@deprecated)
// @route   GET /api/admin/join-requests

// @access  Private / Admin
const getJoinRequests = async (req, res) => {
  try {
    const orgId = req.user.currentOrganizationId;
    const status = req.query.status || 'pending';

    const query = { status };
    if (orgId) {
      query.organization = orgId;
    }

    const requests = await JoinRequest.find(query)
      .populate('user', 'name email avatar title phone createdAt')
      .populate('organization', 'name slug')
      .populate('reviewedBy', 'name email')
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: requests.length,
      requests,
    });
  } catch (error) {
    console.error('Get Join Requests Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching join requests',
    });
  }
};

// @desc    Approve a join request
// @route   POST /api/admin/join-requests/:id/approve
// @access  Private / Admin
const approveJoinRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;
    const orgId = req.user.currentOrganizationId;

    const request = await JoinRequest.findById(id).populate('user', 'name email');
    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Join request not found',
      });
    }

    // Verify organization isolation
    if (orgId && request.organization.toString() !== orgId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You do not manage this organization',
      });
    }

    if (request.status === 'approved') {
      return res.status(400).json({
        success: false,
        message: 'Join request is already approved',
      });
    }

    // 1. Create or activate Membership
    const membership = await Membership.findOneAndUpdate(
      { user: request.user._id, organization: request.organization },
      { role: 'member', status: 'active' },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // 2. Update JoinRequest
    request.status = 'approved';
    request.reviewedBy = adminId;
    request.reviewedAt = new Date();
    await request.save();

    // 3. Activity Log entry
    await createAuditRecord({
      adminId,
      organizationId: request.organization,
      action: 'JOIN_REQUEST_APPROVED',
      targetType: 'JoinRequest',
      targetId: request._id,
      targetName: request.user?.name || 'User',
      details: `Approved join request for "${request.user?.name}" (${request.user?.email})`,
      metadata: { userId: request.user._id, membershipId: membership._id },
    });

    // 4. Create Notification record for user and emit real-time Socket.IO events
    const org = await Organization.findById(request.organization);
    const orgName = org?.name || 'the organization';

    try {
      const notif = await Notification.create({
        recipient: request.user._id,
        organization: request.organization,
        sender: adminId,
        type: 'join_request_approved',
        content: `Your request to join "${orgName}" has been approved!`,
      });

      const populatedNotif = await Notification.findById(notif._id)
        .populate('sender', 'name email avatar')
        .populate('organization', 'name');

      const io = req.app.get('io');
      if (io) {
        io.to(`user:${request.user._id}`).emit('notification:new', {
          notification: populatedNotif,
        });
        io.to(`user:${request.user._id}`).emit('join_request:approved', {
          organizationId: request.organization,
          organizationName: orgName,
          membership,
        });
        io.to(`company:${request.organization}`).emit('join_request:updated', {
          requestId: request._id,
          status: 'approved',
        });
      }
    } catch (notifErr) {
      console.error('Failed to create user join approval notification:', notifErr.message);
    }

    return res.status(200).json({
      success: true,
      message: `Approved join request for ${request.user?.name}`,
      request,
      membership,
    });
  } catch (error) {
    console.error('Approve Join Request Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error approving join request',
    });
  }
};

// @desc    Reject a join request
// @route   POST /api/admin/join-requests/:id/reject
// @access  Private / Admin
const rejectJoinRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;
    const orgId = req.user.currentOrganizationId;

    const request = await JoinRequest.findById(id).populate('user', 'name email');
    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Join request not found',
      });
    }

    // Verify organization isolation
    if (orgId && request.organization.toString() !== orgId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You do not manage this organization',
      });
    }

    // 1. Update JoinRequest status
    request.status = 'rejected';
    request.reviewedBy = adminId;
    request.reviewedAt = new Date();
    await request.save();

    // 2. Activity Log entry
    await createAuditRecord({
      adminId,
      organizationId: request.organization,
      action: 'JOIN_REQUEST_REJECTED',
      targetType: 'JoinRequest',
      targetId: request._id,
      targetName: request.user?.name || 'User',
      details: `Rejected join request for "${request.user?.name}" (${request.user?.email})`,
      metadata: { userId: request.user._id },
    });

    // 3. Create Notification record and emit real-time notification via Socket.IO
    const org = await Organization.findById(request.organization);
    const orgName = org?.name || 'the organization';

    try {
      const notif = await Notification.create({
        recipient: request.user._id,
        organization: request.organization,
        sender: adminId,
        type: 'join_request_rejected',
        content: `Your request to join "${orgName}" was declined.`,
      });

      const populatedNotif = await Notification.findById(notif._id)
        .populate('sender', 'name email avatar')
        .populate('organization', 'name');

      const io = req.app.get('io');
      if (io) {
        io.to(`user:${request.user._id}`).emit('notification:new', {
          notification: populatedNotif,
        });
        io.to(`user:${request.user._id}`).emit('join_request:rejected', {
          organizationId: request.organization,
          organizationName: orgName,
        });
        io.to(`company:${request.organization}`).emit('join_request:updated', {
          requestId: request._id,
          status: 'rejected',
        });
      }
    } catch (notifErr) {
      console.error('Failed to create user join rejection notification:', notifErr.message);
    }

    return res.status(200).json({
      success: true,
      message: `Rejected join request for ${request.user?.name}`,
      request,
    });
  } catch (error) {
    console.error('Reject Join Request Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error rejecting join request',
    });
  }
};

// =========================================================================
// 3. CHANNEL MANAGEMENT
// =========================================================================

// @desc    Get paginated channels list with metadata
// @route   GET /api/admin/channels
// @access  Private / Admin
const getChannels = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const skip = (page - 1) * limit;
    const search = req.query.search ? req.query.search.trim() : '';
    const orgId = req.user.currentOrganizationId;

    if (!orgId && !req.user.isSuperAdmin) {
      return res.status(200).json({
        success: true,
        count: 0,
        totalCount: 0,
        page,
        totalPages: 1,
        channels: [],
      });
    }

    const query = orgId ? { organization: orgId } : {};
    if (search) {
      const safeRegex = new RegExp(escapeRegex(search), 'i');
      query.$or = [{ name: safeRegex }, { description: safeRegex }];
    }

    const [channels, totalCount] = await Promise.all([
      Channel.find(query)
        .populate('createdBy', 'name email avatar')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Channel.countDocuments(query),
    ]);

    const formattedChannels = channels.map((ch) => ({
      _id: ch._id,
      name: ch.name,
      description: ch.description,
      isPrivate: ch.isPrivate,
      isArchived: Boolean(ch.isArchived),
      createdBy: ch.createdBy,
      memberCount: ch.members?.length || 0,
      lastMessageAt: ch.lastMessageAt,
      createdAt: ch.createdAt,
    }));

    return res.status(200).json({
      success: true,
      count: formattedChannels.length,
      totalCount,
      page,
      totalPages: Math.ceil(totalCount / limit) || 1,
      channels: formattedChannels,
    });
  } catch (error) {
    console.error('Admin Get Channels Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error retrieving channels',
    });
  }
};

// @desc    Admin create channel
// @route   POST /api/admin/channels
// @access  Private / Admin
const adminCreateChannel = async (req, res) => {
  try {
    const { name, description = '', isPrivate = false } = req.body;
    const adminId = req.user.id;
    const orgId = req.user.currentOrganizationId;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Channel name is required',
      });
    }

    const cleanName = name.trim().replace(/^#+/, '');
    const existing = await Channel.findOne({
      organization: orgId,
      name: { $regex: new RegExp(`^${cleanName}$`, 'i') },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: `Channel '#${cleanName}' already exists`,
      });
    }

    const newChannel = await Channel.create({
      organization: orgId,
      name: cleanName,
      description: description.trim(),
      createdBy: adminId,
      members: [adminId],
      isPrivate: Boolean(isPrivate),
      isArchived: false,
      lastMessageAt: new Date(),
    });

    const populatedChannel = await Channel.findById(newChannel._id)
      .populate('members', 'name email avatar')
      .populate('createdBy', 'name email avatar');

    await createAuditRecord({
      adminId,
      organizationId: orgId,
      action: 'CHANNEL_CREATED',
      targetType: 'Channel',
      targetId: newChannel._id,
      targetName: `#${cleanName}`,
      details: `Created new ${isPrivate ? 'private' : 'public'} channel #${cleanName}`,
      metadata: { isPrivate: Boolean(isPrivate), description },
    });

    const io = req.app.get('io');
    if (io) {
      if (newChannel.isPrivate) {
        io.to(`user:${adminId}`).emit('channel:created', { channel: populatedChannel });
      } else {
        io.to(`company:${orgId}`).emit('channel:created', { channel: populatedChannel });
      }
    }

    return res.status(201).json({
      success: true,
      message: `Channel #${cleanName} created successfully`,
      channel: populatedChannel,
    });
  } catch (error) {
    console.error('Admin Create Channel Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error creating channel',
    });
  }
};

// @desc    Update channel settings (name, description, privacy, archive)
// @route   PATCH /api/admin/channels/:id
// @access  Private / Admin
const updateChannel = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, isPrivate, isArchived } = req.body;
    const adminId = req.user.id;

    const channel = await Channel.findById(id);
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: 'Channel not found',
      });
    }

    if (name && name.trim() !== channel.name) {
      const existing = await Channel.findOne({
        name: name.trim(),
        _id: { $ne: id },
      });
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'Another channel already exists with this name',
        });
      }
      channel.name = name.trim();
    }

    if (description !== undefined) {
      channel.description = description.trim();
    }

    if (typeof isPrivate === 'boolean') {
      channel.isPrivate = isPrivate;
    }

    if (typeof isArchived === 'boolean') {
      channel.isArchived = isArchived;
    }

    await channel.save();

    await createAuditRecord({
      adminId,
      action: isArchived !== undefined ? (isArchived ? 'CHANNEL_ARCHIVED' : 'CHANNEL_UNARCHIVED') : 'CHANNEL_UPDATED',
      targetType: 'Channel',
      targetId: channel._id,
      targetName: `#${channel.name}`,
      details: isArchived !== undefined ? `${isArchived ? 'Archived' : 'Unarchived'} channel #${channel.name}` : `Updated settings for channel #${channel.name}`,
      metadata: { name: channel.name, isPrivate: channel.isPrivate, isArchived: channel.isArchived },
    });

    const populatedChannel = await Channel.findById(channel._id)
      .populate('members', 'name email avatar')
      .populate('createdBy', 'name email avatar');

    const io = req.app.get('io');
    if (io) {
      io.emit('channel:updated', { channel: populatedChannel });
    }

    return res.status(200).json({
      success: true,
      message: 'Channel updated successfully',
      channel: populatedChannel,
    });
  } catch (error) {
    console.error('Admin Update Channel Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error updating channel',
    });
  }
};

// @desc    Delete a channel and its message stream
// @route   DELETE /api/admin/channels/:id
// @access  Private / Admin
const deleteChannel = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;

    const channel = await Channel.findById(id);
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: 'Channel not found',
      });
    }

    const channelName = channel.name;

    // Delete all messages belonging to this channel
    await Message.deleteMany({ channelId: id });

    // Delete the channel
    await Channel.findByIdAndDelete(id);

    await createAuditRecord({
      adminId,
      action: 'CHANNEL_DELETED',
      targetType: 'Channel',
      targetId: id,
      targetName: `#${channelName}`,
      details: `Deleted channel #${channelName} and purged its message stream`,
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('channel:deleted', { channelId: id });
    }

    return res.status(200).json({
      success: true,
      message: `Channel #${channelName} deleted successfully`,
    });
  } catch (error) {
    console.error('Admin Delete Channel Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error deleting channel',
    });
  }
};

// @desc    Get channel members list
// @route   GET /api/admin/channels/:id/members
// @access  Private / Admin
const getChannelMembers = async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.currentOrganizationId;

    const channelQuery = { _id: id };
    if (orgId && !req.user.isSuperAdmin) {
      channelQuery.organization = orgId;
    }

    const channel = await Channel.findOne(channelQuery).populate(
      'members',
      'name email avatar role status createdAt'
    );
    if (!channel) {
      return res.status(404).json({
        success: false,
        message: 'Channel not found in this organization',
      });
    }

    // Filter members strictly to those with valid membership in this channel's organization
    let validMembers = channel.members || [];
    if (channel.organization) {
      const memberships = await Membership.find({
        organization: channel.organization,
        user: { $in: validMembers.map((m) => m._id) },
      }).select('user');
      const validUserIds = new Set(memberships.map((m) => m.user.toString()));
      validMembers = validMembers.filter((m) => validUserIds.has(m._id.toString()));
    }

    return res.status(200).json({
      success: true,
      count: validMembers.length,
      members: validMembers,
    });
  } catch (error) {
    console.error('Admin Get Channel Members Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching channel members',
    });
  }
};

// @desc    Add member to channel
// @route   POST /api/admin/channels/:id/members/:userId
// @access  Private / Admin
const addChannelMember = async (req, res) => {
  try {
    const { id, userId } = req.params;
    const adminId = req.user.id;
    const orgId = req.user.currentOrganizationId;

    const [channel, targetUser] = await Promise.all([
      Channel.findById(id),
      User.findById(userId).select('name email'),
    ]);

    if (!channel) {
      return res.status(404).json({ success: false, message: 'Channel not found' });
    }
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (orgId && !req.user.isSuperAdmin && channel.organization && channel.organization.toString() !== orgId.toString()) {
      return res.status(403).json({ success: false, message: 'Forbidden: Channel belongs to another organization' });
    }

    // Strictly enforce that the user is a member of this channel's organization
    if (channel.organization) {
      const membership = await Membership.findOne({
        user: userId,
        organization: channel.organization,
      });
      if (!membership) {
        return res.status(400).json({
          success: false,
          message: 'User does not belong to this organization and cannot be added to its channels.',
        });
      }
    }

    if (!channel.members.some((m) => m.toString() === userId.toString())) {
      channel.members.push(userId);
      await channel.save();
    }

    await createAuditRecord({
      adminId,
      action: 'CHANNEL_MEMBER_ADDED',
      targetType: 'Channel',
      targetId: channel._id,
      targetName: `#${channel.name}`,
      details: `Added ${targetUser.name} to channel #${channel.name}`,
      metadata: { userId, userName: targetUser.name },
    });

    const populated = await Channel.findById(id)
      .populate('members', 'name email avatar')
      .populate('createdBy', 'name email avatar');

    const io = req.app.get('io');
    if (io) {
      io.emit('channel:updated', { channel: populated });
    }

    return res.status(200).json({
      success: true,
      message: `User ${targetUser.name} added to #${channel.name}`,
      membersCount: channel.members.length,
      channel: populated,
    });
  } catch (error) {
    console.error('Admin Add Channel Member Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error adding member to channel',
    });
  }
};

// @desc    Remove member from channel
// @route   DELETE /api/admin/channels/:id/members/:userId
// @access  Private / Admin
const removeChannelMember = async (req, res) => {
  try {
    const { id, userId } = req.params;
    const adminId = req.user.id;

    const [channel, targetUser] = await Promise.all([
      Channel.findById(id),
      User.findById(userId).select('name email'),
    ]);

    if (!channel) {
      return res.status(404).json({ success: false, message: 'Channel not found' });
    }

    channel.members = channel.members.filter(
      (m) => m.toString() !== userId.toString()
    );
    await channel.save();

    await createAuditRecord({
      adminId,
      action: 'CHANNEL_MEMBER_REMOVED',
      targetType: 'Channel',
      targetId: channel._id,
      targetName: `#${channel.name}`,
      details: `Removed user from channel #${channel.name}`,
      metadata: { userId, userName: targetUser?.name || 'User' },
    });

    const populated = await Channel.findById(id)
      .populate('members', 'name email avatar')
      .populate('createdBy', 'name email avatar');

    const io = req.app.get('io');
    if (io) {
      io.emit('channel:updated', { channel: populated, leftUserId: userId });
    }

    return res.status(200).json({
      success: true,
      message: `User removed from #${channel.name}`,
      membersCount: channel.members.length,
      channel: populated,
    });
  } catch (error) {
    console.error('Admin Remove Channel Member Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error removing member from channel',
    });
  }
};

// =========================================================================
// 4. MESSAGE MANAGEMENT & MODERATION
// =========================================================================

// @desc    Search and moderate messages across workspace
// @route   GET /api/admin/messages
// @access  Private / Admin
const getMessages = async (req, res) => {
  try {
    const orgId = req.user.currentOrganizationId;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const skip = (page - 1) * limit;

    if (!orgId && !req.user.isSuperAdmin) {
      return res.status(200).json({
        success: true,
        count: 0,
        totalCount: 0,
        page,
        totalPages: 1,
        messages: [],
      });
    }

    const query = req.query.q ? req.query.q.trim() : '';
    const messageType = req.query.messageType;
    const channelId = req.query.channelId;
    const senderId = req.query.senderId;
    const hasAttachments = req.query.hasAttachments === 'true';
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    const conditions = [];

    if (orgId) {
      conditions.push({ organization: orgId });
    }

    if (query) {
      const safeRegex = new RegExp(escapeRegex(query), 'i');
      conditions.push({
        $or: [{ content: safeRegex }, { 'attachments.fileName': safeRegex }],
      });
    }

    if (messageType && ['text', 'image', 'video', 'file'].includes(messageType)) {
      conditions.push({ messageType });
    }

    if (channelId && mongoose.Types.ObjectId.isValid(channelId)) {
      conditions.push({ channelId });
    }

    if (senderId && mongoose.Types.ObjectId.isValid(senderId)) {
      conditions.push({ sender: senderId });
    }

    if (hasAttachments) {
      conditions.push({
        attachments: { $exists: true, $not: { $size: 0 } },
      });
    }

    if (startDate || endDate) {
      const dateFilter = {};
      if (startDate) dateFilter.$gte = new Date(startDate);
      if (endDate) dateFilter.$lte = new Date(endDate);
      conditions.push({ createdAt: dateFilter });
    }

    const finalQuery = conditions.length > 0 ? { $and: conditions } : {};

    const [messages, totalCount] = await Promise.all([
      Message.find(finalQuery)
        .populate('sender', 'name email avatar')
        .populate('receiver', 'name email avatar')
        .populate('channelId', 'name isPrivate')
        .populate('conversationId', 'participants')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Message.countDocuments(finalQuery),
    ]);

    return res.status(200).json({
      success: true,
      count: messages.length,
      totalCount,
      page,
      totalPages: Math.ceil(totalCount / limit) || 1,
      messages,
    });
  } catch (error) {
    console.error('Admin Get Messages Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error retrieving messages for moderation',
    });
  }
};

// @desc    Admin delete a message
// @route   DELETE /api/admin/messages/:id
// @access  Private / Admin
const deleteMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;

    const message = await Message.findById(id).populate('sender', 'name email');
    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
      });
    }

    const snippet =
      message.content?.slice(0, 40) ||
      message.attachments?.[0]?.fileName ||
      'Attachment';

    await Message.findByIdAndDelete(id);

    await createAuditRecord({
      adminId,
      action: 'MESSAGE_DELETED',
      targetType: 'Message',
      targetId: id,
      targetName: `Message by ${message.sender?.name || 'User'}`,
      details: `Deleted message: "${snippet}"`,
      metadata: {
        senderId: message.sender?._id,
        channelId: message.channelId,
        conversationId: message.conversationId,
      },
    });

    return res.status(200).json({
      success: true,
      message: 'Message deleted successfully by administrator',
    });
  } catch (error) {
    console.error('Admin Delete Message Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error deleting message',
    });
  }
};

// =========================================================================
// 5. AUDIT LOGS
// =========================================================================

// @desc    Get paginated audit logs
// @route   GET /api/admin/audit-logs
// @access  Private / Admin
const getAuditLogs = async (req, res) => {
  try {
    const orgId = req.user.currentOrganizationId;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const skip = (page - 1) * limit;

    if (!orgId && !req.user.isSuperAdmin) {
      return res.status(200).json({
        success: true,
        count: 0,
        totalCount: 0,
        page,
        totalPages: 1,
        logs: [],
      });
    }

    const targetType = req.query.targetType;

    const query = {};
    if (orgId) {
      query.organization = orgId;
    }
    if (targetType && ['User', 'Channel', 'Message', 'System', 'Organization', 'JoinRequest'].includes(targetType)) {
      query.targetType = targetType;
    }

    const [logs, totalCount] = await Promise.all([
      AuditLog.find(query)
        .populate('admin', 'name email avatar')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      AuditLog.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      count: logs.length,
      totalCount,
      page,
      totalPages: Math.ceil(totalCount / limit) || 1,
      logs,
    });
  } catch (error) {
    console.error('Admin Get Audit Logs Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error retrieving audit logs',
    });
  }
};

// =========================================================================
// 6. ORGANIZATION SETTINGS
// =========================================================================

const OrganizationSettings = require('../models/OrganizationSettings');

// @desc    Get organization settings (scoped strictly to current company)
// @route   GET /api/admin/settings
// @access  Private / Admin
const getOrganizationSettings = async (req, res) => {
  try {
    const orgId = req.user.currentOrganizationId;
    const organization = await Organization.findById(orgId).select('name description logo settings');

    if (!organization) {
      return res.status(404).json({ success: false, message: 'Organization not found' });
    }

    const defaultSettings = {
      requireJoinApproval: true,
      allowPublicChannels: true,
      allowPrivateChannels: true,
      allowUserChannelCreation: true,
      allowMemberInvites: true,
      allowMemberChannelDeletion: false,
    };

    const settings = {
      ...defaultSettings,
      ...(organization.settings ? organization.settings.toObject() : {}),
      companyName: organization.name,
      companyDescription: organization.description,
      companyLogo: organization.logo,
    };

    return res.status(200).json({
      success: true,
      settings,
    });
  } catch (error) {
    console.error('Get Organization Settings Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error retrieving organization settings',
    });
  }
};

// @desc    Update organization settings (scoped strictly to current company)
// @route   PATCH /api/admin/settings
// @access  Private / Admin
const updateOrganizationSettings = async (req, res) => {
  try {
    const adminId = req.user.id;
    const orgId = req.user.currentOrganizationId;
    const {
      companyName,
      companyDescription,
      requireJoinApproval,
      allowPublicChannels,
      allowPrivateChannels,
      allowUserChannelCreation,
      allowMemberInvites,
      allowMemberChannelDeletion,
    } = req.body;

    const organization = await Organization.findById(orgId);
    if (!organization) {
      return res.status(404).json({ success: false, message: 'Organization not found' });
    }

    if (!organization.settings) {
      organization.settings = {};
    }

    const changes = [];

    if (typeof companyName === 'string' && companyName.trim()) {
      if (organization.name !== companyName.trim()) {
        changes.push(`Company Name: "${organization.name}" -> "${companyName.trim()}"`);
        organization.name = companyName.trim();
      }
    }

    if (typeof companyDescription === 'string') {
      organization.description = companyDescription.trim();
    }

    const keys = [
      { key: 'requireJoinApproval', label: 'Require Join Approval' },
      { key: 'allowPublicChannels', label: 'Allow Public Channels' },
      { key: 'allowPrivateChannels', label: 'Allow Private Channels' },
      { key: 'allowUserChannelCreation', label: 'Allow User Channel Creation' },
      { key: 'allowMemberInvites', label: 'Allow Member Invites' },
      { key: 'allowMemberChannelDeletion', label: 'Allow Member Channel Deletion' },
    ];

    keys.forEach(({ key, label }) => {
      if (typeof req.body[key] === 'boolean') {
        const val = req.body[key];
        if (organization.settings[key] !== val) {
          changes.push(`${label}: ${val ? 'ON' : 'OFF'}`);
        }
        organization.settings[key] = val;
      }
    });

    await organization.save();

    await createAuditRecord({
      adminId,
      organizationId: orgId,
      action: 'ORGANIZATION_SETTINGS_UPDATED',
      targetType: 'Organization',
      targetId: organization._id,
      targetName: organization.name,
      details: changes.length ? changes.join(', ') : 'Company settings updated',
      metadata: organization.settings,
    });

    // Emit Socket.IO event to company room
    const io = req.app.get('io');
    if (io) {
      io.to(`company:${orgId}`).emit('organization:settings_updated', {
        settings: {
          ...organization.settings.toObject(),
          companyName: organization.name,
          companyDescription: organization.description,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Organization settings updated successfully',
      settings: {
        ...organization.settings.toObject(),
        companyName: organization.name,
        companyDescription: organization.description,
      },
    });
  } catch (error) {
    console.error('Update Organization Settings Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error updating organization settings',
    });
  }
};

module.exports = {
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
};
