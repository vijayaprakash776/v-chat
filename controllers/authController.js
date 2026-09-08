const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'flock_secret_jwt_key_2026_super_secure_token_auth';

// Helper to generate a signed JWT containing user ID
const generateToken = (userId) => {
  return jwt.sign({ id: userId }, JWT_SECRET, {
    expiresIn: '7d', // Token valid for 7 days
  });
};

// @desc    Register a new user
// @route   POST /api/auth/register
// @access  Public
const registerUser = async (req, res) => {
  try {
    const { name, email, password, invitationToken } = req.body;

    // 1. Validate required fields
    if (!name || !email || !password) {
      return res.status(400).json({
        message: 'Please provide name, email, and password',
      });
    }

    // 2. Validate password length
    if (password.length < 6) {
      return res.status(400).json({
        message: 'Password must be at least 6 characters long',
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // 3. Validate invitation token if provided
    let invitation = null;
    if (invitationToken) {
      const Invitation = require('../models/Invitation');
      invitation = await Invitation.findOne({ token: invitationToken })
        .populate('organization', 'name slug status');

      if (!invitation) {
        return res.status(400).json({
          message: 'Invalid invitation link or token.',
        });
      }

      if (invitation.status !== 'pending') {
        return res.status(400).json({
          message: `This invitation has already been ${invitation.status}.`,
        });
      }

      if (invitation.expiresAt && new Date() > invitation.expiresAt) {
        invitation.status = 'expired';
        await invitation.save();
        return res.status(400).json({
          message: 'This invitation has expired. Please request a new invitation.',
        });
      }

      if (invitation.email !== normalizedEmail) {
        return res.status(400).json({
          message: `This invitation was sent to "${invitation.email}". Please register using that email.`,
        });
      }
    }

    // 4. Check if user with this email already exists
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(409).json({
        message: 'Email already registered. Please login instead.',
      });
    }

    // 5. Hash password with bcryptjs (10 salt rounds)
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // 6. Create user in MongoDB
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      role: 'user',
      status: 'active',
      currentOrganization: invitation ? invitation.organization._id : null,
    });

    // 7. If registering via invitation, create Membership and mark invitation accepted
    if (invitation) {
      const Membership = require('../models/Membership');
      const Notification = require('../models/Notification');

      await Membership.findOneAndUpdate(
        { user: user._id, organization: invitation.organization._id },
        { role: 'member', status: 'active' },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      invitation.status = 'accepted';
      invitation.acceptedBy = user._id;
      invitation.acceptedAt = new Date();
      await invitation.save();

      try {
        const notif = await Notification.create({
          recipient: invitation.invitedBy,
          organization: invitation.organization._id,
          sender: user._id,
          type: 'invitation_accepted',
          content: `${user.name} (${user.email}) registered and joined "${invitation.organization.name}"`,
        });

        const io = req.app.get('io');
        if (io) {
          const populatedNotif = await Notification.findById(notif._id)
            .populate('sender', 'name email avatar')
            .populate('organization', 'name');
          io.to(`user:${invitation.invitedBy}`).emit('notification:new', {
            notification: populatedNotif,
          });
          io.to(`company:${invitation.organization._id}`).emit('invitation:accepted', {
            invitationId: invitation._id,
            user: { id: user._id, name: user.name, email: user.email },
          });
          io.to(`company:${invitation.organization._id}`).emit('organization:member_joined', {
            organizationId: invitation.organization._id,
            user: {
              _id: user._id,
              id: user._id,
              name: user.name,
              email: user.email,
              avatar: user.avatar,
              role: 'member',
            },
          });
        }
      } catch (notifErr) {
        console.error('Failed to dispatch register acceptance notifications:', notifErr.message);
      }
    }

    // 8. Generate token
    const token = generateToken(user._id);

    return res.status(201).json({
      message: invitation
        ? `Registered and joined "${invitation.organization.name}" successfully!`
        : 'User registered successfully',
      token,
      user: {
        id: user._id,
        _id: user._id,
        name: user.name,
        email: user.email,
        avatar: user.avatar || '',
        bio: user.bio || '',
        title: user.title || '',
        phone: user.phone || '',
        role: user.role,
        status: user.status,
        currentOrganization: user.currentOrganization,
      },
    });
  } catch (error) {
    console.error('Registration Error:', error.message);
    return res.status(500).json({
      message: 'Server error during user registration',
    });
  }
};

// @desc    Authenticate user and return JWT token
// @route   POST /api/auth/login
// @access  Public
const loginUser = async (req, res) => {
  try {
    const { email, password, invitationToken } = req.body;
    console.log(`[Login Attempt] Email: ${email}`);

    // 1. Validate input fields
    if (!email || !password) {
      return res.status(400).json({
        message: 'Please provide email and password',
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // 2. Check if user exists in database
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      console.log(`[Login Failed] User not found: ${normalizedEmail}`);
      return res.status(401).json({
        message: 'ERR_USER_NOT_FOUND',
      });
    }

    // 4. Verify password with bcrypt
    const isMatch = await bcrypt.compare(password, user.password);
    console.log(`[Login Verification] Password Match: ${isMatch}`);

    if (!isMatch) {
      return res.status(401).json({
        message: 'ERR_PASSWORD_MISMATCH',
      });
    }

    // 5. Generate signed JWT token
    const token = generateToken(user._id);

    // 6. Handle invitationToken on login if provided
    if (invitationToken) {
      const Invitation = require('../models/Invitation');
      const inv = await Invitation.findOne({ token: invitationToken, status: 'pending' })
        .populate('organization', 'name slug status');
      if (inv && inv.email === normalizedEmail && (!inv.expiresAt || new Date() <= inv.expiresAt)) {
        const Membership = require('../models/Membership');
        const Notification = require('../models/Notification');

        await Membership.findOneAndUpdate(
          { user: user._id, organization: inv.organization._id },
          { role: 'member', status: 'active' },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        user.currentOrganization = inv.organization._id;
        await user.save();

        inv.status = 'accepted';
        inv.acceptedBy = user._id;
        inv.acceptedAt = new Date();
        await inv.save();

        try {
          const notif = await Notification.create({
            recipient: inv.invitedBy,
            organization: inv.organization._id,
            sender: user._id,
            type: 'invitation_accepted',
            content: `${user.name} (${user.email}) logged in and joined "${inv.organization.name}"`,
          });
          const io = req.app.get('io');
          if (io) {
            const populatedNotif = await Notification.findById(notif._id)
              .populate('sender', 'name email avatar')
              .populate('organization', 'name');
            io.to(`user:${inv.invitedBy}`).emit('notification:new', { notification: populatedNotif });
            io.to(`company:${inv.organization._id}`).emit('invitation:accepted', {
              invitationId: inv._id,
              user: { id: user._id, name: user.name, email: user.email },
            });
            io.to(`company:${inv.organization._id}`).emit('organization:member_joined', {
              organizationId: inv.organization._id,
              user: {
                _id: user._id,
                id: user._id,
                name: user.name,
                email: user.email,
                avatar: user.avatar,
                role: 'member',
              },
            });
          }
        } catch (notifErr) {
          console.error('Failed to dispatch login acceptance notification:', notifErr.message);
        }
      }
    }

    const Membership = require('../models/Membership');
    let memberships = await Membership.find({ user: user._id }).populate('organization');

    let currentOrg = null;
    let activeRole = user.role || 'user';
    let activeMem = null;

    if (user.currentOrganization) {
      activeMem = memberships.find((m) => m.organization?._id.toString() === user.currentOrganization.toString());
      if (activeMem) {
        currentOrg = activeMem.organization;
        activeRole = activeMem.role;
      }
    }

    if (!currentOrg && memberships.length > 0) {
      activeMem = memberships[0];
      currentOrg = memberships[0].organization;
      activeRole = memberships[0].role;
      if (currentOrg) {
        user.currentOrganization = currentOrg._id;
        await user.save();
      }
    }

    const isUserDeactivated = user.status === 'inactive' || (activeMem && activeMem.status === 'inactive');
    const rawStatus = currentOrg?.status || currentOrg?.subscription?.status || null;
    const isExpired = rawStatus === 'expired' || Boolean(currentOrg?.subscription?.expiresAt && new Date() > new Date(currentOrg.subscription.expiresAt));
    const effectiveOrgStatus = isExpired ? 'expired' : rawStatus;

    return res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        _id: user._id,
        name: user.name,
        email: user.email,
        avatar: user.avatar || '',
        bio: user.bio || '',
        title: user.title || '',
        phone: user.phone || '',
        role: activeRole,
        status: isUserDeactivated ? 'inactive' : 'active',
        isDeactivated: Boolean(isUserDeactivated),
        currentOrganization: currentOrg,
        currentOrganizationId: currentOrg ? currentOrg._id.toString() : null,
        organizationStatus: effectiveOrgStatus,
        organizationCount: memberships.length,
        pinnedChats: user.pinnedChats || [],
        pinnedChannels: user.pinnedChannels || [],
      },
    });
  } catch (error) {
    console.error('Login Error:', error.message);
    return res.status(500).json({
      message: 'Server error during login',
    });
  }
};

// @desc    Get current authenticated user profile
// @route   GET /api/auth/me
// @access  Private (Protected by authMiddleware)
const getMe = async (req, res) => {
  try {
    const Membership = require('../models/Membership');
    const orgCount = await Membership.countDocuments({ user: req.user.id, status: 'active' });

    const currentOrg = req.user.currentOrganization;
    const rawStatus = req.user.organizationStatus || currentOrg?.status || currentOrg?.subscription?.status || null;
    const isExpired = rawStatus === 'expired' || Boolean(currentOrg?.subscription?.expiresAt && new Date() > new Date(currentOrg.subscription.expiresAt));
    const orgStatus = isExpired ? 'expired' : rawStatus;

    return res.status(200).json({
      user: {
        id: req.user.id,
        _id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        avatar: req.user.avatar || '',
        bio: req.user.bio || '',
        title: req.user.title || '',
        phone: req.user.phone || '',
        role: req.user.role,
        status: req.user.status,
        currentOrganization: currentOrg,
        organizationStatus: orgStatus,
        organizationCount: orgCount,
        pinnedChats: req.user.pinnedChats || [],
        pinnedChannels: req.user.pinnedChannels || [],
      },
    });
  } catch (error) {
    console.error('GetMe Error:', error.message);
    return res.status(500).json({
      message: 'Server error fetching user profile',
    });
  }
};

module.exports = {
  registerUser,
  loginUser,
  getMe,
};
