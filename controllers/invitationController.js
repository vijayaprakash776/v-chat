const crypto = require('crypto');
const Invitation = require('../models/Invitation');
const Membership = require('../models/Membership');
const User = require('../models/User');
const Organization = require('../models/Organization');
const Notification = require('../models/Notification');
const { sendBrevoInvitationEmail } = require('../services/emailService');

// =========================================================================
// ADMIN — Create Invitation
// POST /api/invitations
// =========================================================================
const createInvitation = async (req, res) => {
  try {
    const { email } = req.body;
    const adminId = req.user.id;
    const orgId = req.user.currentOrganizationId;

    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid email address',
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid email address format',
      });
    }

    // 0. Enforce Free Plan member limit
    const org = await Organization.findById(orgId);
    if (org?.subscription?.plan === 'free') {
      const activeMembersCount = await Membership.countDocuments({
        organization: orgId,
        status: 'active'
      });
      if (activeMembersCount >= 25) {
        return res.status(403).json({
          success: false,
          message: 'Free plan limit reached: Maximum 25 employees allowed. Please upgrade to add more members.',
        });
      }
    }

    // 1. Check if user with this email is already an active member
    const existingUser = await User.findOne({ email: normalizedEmail }).select('_id name email');
    if (existingUser) {
      const existingMembership = await Membership.findOne({
        user: existingUser._id,
        organization: orgId,
        status: 'active',
      });

      if (existingMembership) {
        return res.status(400).json({
          success: false,
          message: `"${existingUser.name}" (${normalizedEmail}) is already an active member of this organization.`,
        });
      }
    }

    // 2. Check for existing pending invitation for same email + org
    const existingInvitation = await Invitation.findOne({
      organization: orgId,
      email: normalizedEmail,
      status: 'pending',
    });

    if (existingInvitation) {
      // Check if it's expired
      if (existingInvitation.expiresAt && new Date() > existingInvitation.expiresAt) {
        // Mark old one as expired and create fresh
        existingInvitation.status = 'expired';
        await existingInvitation.save();
      } else {
        return res.status(400).json({
          success: false,
          message: `A pending invitation for "${normalizedEmail}" already exists. Revoke it first to send a new one.`,
        });
      }
    }

    // 3. Generate secure invitation token & create invitation
    const token = crypto.randomBytes(32).toString('hex');
    const invitation = await Invitation.create({
      organization: orgId,
      email: normalizedEmail,
      invitedBy: adminId,
      status: 'pending',
      token,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });

    // 4. Send email through Brevo
    const orgName = org?.name || 'an organization';
    const inviterName = req.user.name || 'Company Administrator';
    const clientUrl = process.env.CLIENT_URL || `${req.protocol}://${req.get('host')}`;
    const acceptUrl = `${clientUrl}/accept-invitation?token=${token}`;

    try {
      await sendBrevoInvitationEmail({
        toEmail: normalizedEmail,
        inviterName,
        companyName: orgName,
        acceptUrl,
        expiresAt: invitation.expiresAt,
      });
    } catch (emailErr) {
      console.error('Brevo invitation email dispatch failed:', emailErr.message);
      // Roll back: Delete the created invitation so it is never falsely marked as sent
      await Invitation.findByIdAndDelete(invitation._id);
      return res.status(502).json({
        success: false,
        message: `Failed to send invitation email via Brevo: ${emailErr.message}`,
      });
    }

    // 5. Populate for response
    const populatedInvitation = await Invitation.findById(invitation._id)
      .populate('organization', 'name slug')
      .populate('invitedBy', 'name email');

    // 6. If user already has an account, notify them via Socket.IO + Notification
    if (existingUser) {
      try {
        const notif = await Notification.create({
          recipient: existingUser._id,
          organization: orgId,
          sender: adminId,
          type: 'invitation_received',
          content: `You've been invited to join "${orgName}"`,
        });

        const populatedNotif = await Notification.findById(notif._id)
          .populate('sender', 'name email avatar')
          .populate('organization', 'name');

        const io = req.app.get('io');
        if (io) {
          io.to(`user:${existingUser._id}`).emit('notification:new', {
            notification: populatedNotif,
          });
          io.to(`user:${existingUser._id}`).emit('invitation:received', {
            invitation: populatedInvitation,
          });
        }
      } catch (notifErr) {
        console.error('Failed to create invitation notification:', notifErr.message);
      }
    }

    // 7. Notify admin company room
    const io = req.app.get('io');
    if (io) {
      io.to(`company:${orgId}`).emit('invitation:created', {
        invitation: populatedInvitation,
      });
    }

    return res.status(201).json({
      success: true,
      message: `Invitation email sent to "${normalizedEmail}" via Brevo successfully.`,
      invitation: populatedInvitation,
    });
  } catch (error) {
    console.error('Create Invitation Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error creating invitation',
    });
  }
};

// =========================================================================
// ADMIN — Get Organization Invitations
// GET /api/invitations/org
// =========================================================================
const getOrgInvitations = async (req, res) => {
  try {
    const orgId = req.user.currentOrganizationId;
    const statusFilter = req.query.status || ''; // '' = all

    const query = { organization: orgId };
    if (statusFilter) {
      query.status = statusFilter;
    }

    const invitations = await Invitation.find(query)
      .populate('invitedBy', 'name email')
      .populate('acceptedBy', 'name email')
      .populate('revokedBy', 'name email')
      .populate('organization', 'name slug')
      .sort({ createdAt: -1 });

    // Auto-expire invitations that are past their expiresAt
    const now = new Date();
    for (const inv of invitations) {
      if (inv.status === 'pending' && inv.expiresAt && now > inv.expiresAt) {
        inv.status = 'expired';
        await inv.save();
      }
    }

    return res.status(200).json({
      success: true,
      count: invitations.length,
      invitations,
    });
  } catch (error) {
    console.error('Get Org Invitations Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching invitations',
    });
  }
};

// =========================================================================
// ADMIN — Revoke Invitation
// DELETE /api/invitations/:id
// =========================================================================
const revokeInvitation = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;
    const orgId = req.user.currentOrganizationId;

    const invitation = await Invitation.findById(id);
    if (!invitation) {
      return res.status(404).json({
        success: false,
        message: 'Invitation not found',
      });
    }

    // Organization isolation
    if (invitation.organization.toString() !== orgId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You do not manage this organization',
      });
    }

    if (invitation.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Cannot revoke an invitation that is already "${invitation.status}"`,
      });
    }

    invitation.status = 'revoked';
    invitation.revokedBy = adminId;
    invitation.revokedAt = new Date();
    await invitation.save();

    const io = req.app.get('io');
    if (io) {
      io.to(`company:${orgId}`).emit('invitation:revoked', {
        invitationId: invitation._id,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Invitation for "${invitation.email}" has been revoked`,
      invitation,
    });
  } catch (error) {
    console.error('Revoke Invitation Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error revoking invitation',
    });
  }
};

// =========================================================================
// USER — Get My Invitations (matching user's email)
// GET /api/invitations/my
// =========================================================================
const getMyInvitations = async (req, res) => {
  try {
    const userEmail = req.user.email;

    if (!userEmail) {
      return res.status(400).json({
        success: false,
        message: 'User email not found',
      });
    }

    const invitations = await Invitation.find({
      email: userEmail.toLowerCase().trim(),
      status: 'pending',
    })
      .populate('organization', 'name slug description')
      .populate('invitedBy', 'name email')
      .sort({ createdAt: -1 });

    // Auto-expire invitations that are past their expiresAt
    const now = new Date();
    const validInvitations = [];
    for (const inv of invitations) {
      if (inv.expiresAt && now > inv.expiresAt) {
        inv.status = 'expired';
        await inv.save();
      } else {
        validInvitations.push(inv);
      }
    }

    return res.status(200).json({
      success: true,
      count: validInvitations.length,
      invitations: validInvitations,
    });
  } catch (error) {
    console.error('Get My Invitations Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error fetching your invitations',
    });
  }
};

// =========================================================================
// USER — Accept Invitation
// POST /api/invitations/:id/accept
// =========================================================================
const acceptInvitation = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userEmail = req.user.email?.toLowerCase().trim();

    const invitation = await Invitation.findById(id)
      .populate('organization', 'name slug');

    if (!invitation) {
      return res.status(404).json({
        success: false,
        message: 'Invitation not found',
      });
    }

    // 1. Verify email matches
    if (invitation.email !== userEmail) {
      return res.status(403).json({
        success: false,
        message: 'This invitation was sent to a different email address. You cannot accept it.',
      });
    }

    // 2. Verify status is pending
    if (invitation.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `This invitation has already been ${invitation.status}. It cannot be accepted.`,
      });
    }

    // 3. Verify not expired
    if (invitation.expiresAt && new Date() > invitation.expiresAt) {
      invitation.status = 'expired';
      await invitation.save();
      return res.status(400).json({
        success: false,
        message: 'This invitation has expired. Please ask the admin to send a new one.',
      });
    }

    // 3.5. Enforce Free Plan member limit on accept
    const org = await Organization.findById(invitation.organization._id);
    if (org?.subscription?.plan === 'free') {
      const activeMembersCount = await Membership.countDocuments({
        organization: invitation.organization._id,
        status: 'active'
      });
      if (activeMembersCount >= 25) {
        return res.status(403).json({
          success: false,
          message: 'Free plan limit reached: Maximum 25 employees allowed. Cannot join at this time.',
        });
      }
    }

    // 4. Check if already a member
    const existingMembership = await Membership.findOne({
      user: userId,
      organization: invitation.organization._id,
    });

    if (existingMembership && existingMembership.status === 'active') {
      // Already a member — mark invitation as accepted anyway
      invitation.status = 'accepted';
      invitation.acceptedBy = userId;
      invitation.acceptedAt = new Date();
      await invitation.save();

      return res.status(200).json({
        success: true,
        message: `You are already a member of "${invitation.organization.name}".`,
        alreadyMember: true,
      });
    }

    // 5. Create or activate membership
    const membership = await Membership.findOneAndUpdate(
      { user: userId, organization: invitation.organization._id },
      { role: 'member', status: 'active' },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // 6. Update user's currentOrganization if they don't have one
    const user = await User.findById(userId);
    if (user && !user.currentOrganization) {
      user.currentOrganization = invitation.organization._id;
      await user.save();
    }

    // 7. Mark invitation as accepted
    invitation.status = 'accepted';
    invitation.acceptedBy = userId;
    invitation.acceptedAt = new Date();
    await invitation.save();

    // 8. Notify the admin who created the invitation
    const orgName = invitation.organization.name || 'the organization';
    try {
      const notif = await Notification.create({
        recipient: invitation.invitedBy,
        organization: invitation.organization._id,
        sender: userId,
        type: 'invitation_accepted',
        content: `${user?.name || userEmail} accepted the invitation to join "${orgName}"`,
      });

      const populatedNotif = await Notification.findById(notif._id)
        .populate('sender', 'name email avatar')
        .populate('organization', 'name');

      const io = req.app.get('io');
      if (io) {
        io.to(`user:${invitation.invitedBy}`).emit('notification:new', {
          notification: populatedNotif,
        });
        io.to(`company:${invitation.organization._id}`).emit('invitation:accepted', {
          invitationId: invitation._id,
          user: {
            id: userId,
            name: user?.name,
            email: userEmail,
          },
        });
        io.to(`company:${invitation.organization._id}`).emit('organization:member_joined', {
          organizationId: invitation.organization._id,
          user: {
            _id: userId,
            id: userId,
            name: user?.name,
            email: userEmail,
            avatar: user?.avatar,
            role: 'member',
          },
        });
      }
    } catch (notifErr) {
      console.error('Failed to create acceptance notification:', notifErr.message);
    }

    return res.status(200).json({
      success: true,
      message: `You have joined "${orgName}" successfully!`,
      organization: invitation.organization,
      membership,
    });
  } catch (error) {
    console.error('Accept Invitation Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error accepting invitation',
    });
  }
};

// =========================================================================
// USER — Decline Invitation
// POST /api/invitations/:id/decline
// =========================================================================
const declineInvitation = async (req, res) => {
  try {
    const { id } = req.params;
    const userEmail = req.user.email?.toLowerCase().trim();

    const invitation = await Invitation.findById(id);
    if (!invitation) {
      return res.status(404).json({
        success: false,
        message: 'Invitation not found',
      });
    }

    // Verify email matches
    if (invitation.email !== userEmail) {
      return res.status(403).json({
        success: false,
        message: 'This invitation was sent to a different email address.',
      });
    }

    if (invitation.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `This invitation is already "${invitation.status}".`,
      });
    }

    invitation.status = 'revoked'; // reuse 'revoked' status for declined
    invitation.revokedAt = new Date();
    await invitation.save();

    return res.status(200).json({
      success: true,
      message: 'Invitation declined',
    });
  } catch (error) {
    console.error('Decline Invitation Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error declining invitation',
    });
  }
};

module.exports = {
  createInvitation,
  getOrgInvitations,
  revokeInvitation,
  getMyInvitations,
  acceptInvitation,
  declineInvitation,
  validateInvitationToken,
  acceptInvitationByToken,
};

// =========================================================================
// PUBLIC — Validate Invitation Token
// GET /api/invitations/validate-token/:token
// =========================================================================
async function validateInvitationToken(req, res) {
  try {
    const { token } = req.params;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Invitation token is required.',
      });
    }

    const invitation = await Invitation.findOne({ token })
      .populate('organization', 'name slug description status')
      .populate('invitedBy', 'name email avatar');

    if (!invitation) {
      return res.status(404).json({
        success: false,
        code: 'INVITATION_NOT_FOUND',
        message: 'Invitation not found or invalid link.',
      });
    }

    // Auto-expire if past expiresAt
    if (invitation.expiresAt && new Date() > invitation.expiresAt) {
      if (invitation.status === 'pending') {
        invitation.status = 'expired';
        await invitation.save();
      }
      return res.status(400).json({
        success: false,
        code: 'INVITATION_EXPIRED',
        message: 'This invitation has expired. Please request a new invitation from your company administrator.',
      });
    }

    if (invitation.status === 'revoked') {
      return res.status(400).json({
        success: false,
        code: 'INVITATION_REVOKED',
        message: 'This invitation has been revoked by the company administrator.',
      });
    }

    if (invitation.status === 'accepted') {
      return res.status(400).json({
        success: false,
        code: 'INVITATION_ALREADY_ACCEPTED',
        message: 'This invitation has already been accepted.',
      });
    }

    return res.status(200).json({
      success: true,
      invitation: {
        id: invitation._id,
        email: invitation.email,
        expiresAt: invitation.expiresAt,
        organization: {
          id: invitation.organization?._id,
          name: invitation.organization?.name || 'Workspace',
          description: invitation.organization?.description || '',
          status: invitation.organization?.status || 'active',
        },
        invitedBy: {
          name: invitation.invitedBy?.name || 'Administrator',
          email: invitation.invitedBy?.email,
          avatar: invitation.invitedBy?.avatar,
        },
      },
    });
  } catch (error) {
    console.error('Validate Invitation Token Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error validating invitation token',
    });
  }
}

// =========================================================================
// USER — Accept Invitation by Token
// POST /api/invitations/accept-by-token
// =========================================================================
async function acceptInvitationByToken(req, res) {
  try {
    const { token } = req.body;
    const userId = req.user.id;
    const userEmail = req.user.email?.toLowerCase().trim();

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Invitation token is required',
      });
    }

    const invitation = await Invitation.findOne({ token })
      .populate('organization', 'name slug status');

    if (!invitation) {
      return res.status(404).json({
        success: false,
        code: 'INVITATION_NOT_FOUND',
        message: 'Invitation not found or invalid link.',
      });
    }

    // 1. Verify email matches
    if (invitation.email !== userEmail) {
      return res.status(403).json({
        success: false,
        code: 'EMAIL_MISMATCH',
        message: `This invitation was sent to "${invitation.email}". You are currently logged in as "${userEmail}".`,
      });
    }

    // 2. Verify status is pending
    if (invitation.status !== 'pending') {
      return res.status(400).json({
        success: false,
        code: 'INVITATION_NOT_PENDING',
        message: `This invitation is already ${invitation.status}.`,
      });
    }

    // 3. Verify not expired
    if (invitation.expiresAt && new Date() > invitation.expiresAt) {
      invitation.status = 'expired';
      await invitation.save();
      return res.status(400).json({
        success: false,
        code: 'INVITATION_EXPIRED',
        message: 'This invitation has expired. Please ask your administrator to send a new one.',
      });
    }

    // 3.5. Enforce Free Plan member limit on accept
    const org = await Organization.findById(invitation.organization._id);
    if (org?.subscription?.plan === 'free') {
      const activeMembersCount = await Membership.countDocuments({
        organization: invitation.organization._id,
        status: 'active'
      });
      if (activeMembersCount >= 25) {
        return res.status(403).json({
          success: false,
          code: 'FREE_PLAN_LIMIT',
          message: 'Free plan limit reached: Maximum 25 employees allowed. Cannot join at this time.',
        });
      }
    }

    // 4. Check if already an active member
    const existingMembership = await Membership.findOne({
      user: userId,
      organization: invitation.organization._id,
      status: 'active',
    });

    if (existingMembership) {
      invitation.status = 'accepted';
      invitation.acceptedBy = userId;
      invitation.acceptedAt = new Date();
      await invitation.save();

      return res.status(200).json({
        success: true,
        message: `You are already an active member of "${invitation.organization.name}".`,
        organization: invitation.organization,
        alreadyMember: true,
      });
    }

    // 5. Create or activate membership
    const membership = await Membership.findOneAndUpdate(
      { user: userId, organization: invitation.organization._id },
      { role: 'member', status: 'active' },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // 6. Set user's currentOrganization
    const user = await User.findById(userId);
    if (user) {
      user.currentOrganization = invitation.organization._id;
      await user.save();
    }

    // 7. Mark invitation accepted
    invitation.status = 'accepted';
    invitation.acceptedBy = userId;
    invitation.acceptedAt = new Date();
    await invitation.save();

    // 8. Notifications and socket events
    const orgName = invitation.organization?.name || 'the organization';
    try {
      const notif = await Notification.create({
        recipient: invitation.invitedBy,
        organization: invitation.organization._id,
        sender: userId,
        type: 'invitation_accepted',
        content: `${user?.name || userEmail} accepted your invitation to join "${orgName}"`,
      });

      const populatedNotif = await Notification.findById(notif._id)
        .populate('sender', 'name email avatar')
        .populate('organization', 'name');

      const io = req.app.get('io');
      if (io) {
        io.to(`user:${invitation.invitedBy}`).emit('notification:new', {
          notification: populatedNotif,
        });
        io.to(`company:${invitation.organization._id}`).emit('invitation:accepted', {
          invitationId: invitation._id,
          user: {
            id: userId,
            name: user?.name,
            email: userEmail,
          },
        });
        io.to(`company:${invitation.organization._id}`).emit('organization:member_joined', {
          organizationId: invitation.organization._id,
          user: {
            _id: userId,
            id: userId,
            name: user?.name,
            email: userEmail,
            avatar: user?.avatar,
            role: 'member',
          },
        });
      }
    } catch (notifErr) {
      console.error('Failed to dispatch acceptance notifications:', notifErr.message);
    }

    return res.status(200).json({
      success: true,
      message: `You have joined "${orgName}" successfully!`,
      organization: invitation.organization,
      membership,
    });
  } catch (error) {
    console.error('Accept Invitation By Token Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error accepting invitation',
    });
  }
}
