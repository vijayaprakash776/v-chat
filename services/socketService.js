const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Channel = require('../models/Channel');

let ioInstance = null;

// Map to track connection counts per user ID: Map<userIdString, connectionCount>
const userConnections = new Map();

/**
 * Initialize Socket.IO with authentication middleware and event handlers
 * @param {import('socket.io').Server} io
 */
const initSocket = (io) => {
  ioInstance = io;

  // 1. Socket Authentication Middleware (JWT Handshake Verification)
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;

      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      // Verify JWT using server secret
      const JWT_SECRET = process.env.JWT_SECRET || 'flock_secret_jwt_key_2026_super_secure_token_auth';
      const decoded = jwt.verify(token, JWT_SECRET);

      // Verify user exists in database
      const user = await User.findById(decoded.id).select('-password');
      if (!user) {
        return next(new Error('Authentication error: User not found'));
      }

      // Attach authenticated user information to socket instance
      socket.user = user;
      socket.userId = user._id.toString();

      next();
    } catch (error) {
      console.error('Socket Authentication Error:', error.message);
      return next(new Error('Authentication error: Invalid or expired token'));
    }
  });

  // 2. Connection Handler
  io.on('connection', async (socket) => {
    const userId = socket.userId;
    const orgId = socket.user.currentOrganization?.toString();
    console.log(`[Socket Connected] User: ${socket.user.name} (${userId}) | Org: ${orgId || 'None'} | Socket ID: ${socket.id}`);

    // Join personal user room (user:<userId>) for direct notifications
    socket.join(`user:${userId}`);

    // Join active company room (company:<companyId>) if user has an active company
    if (orgId) {
      socket.join(`company:${orgId}`);
    }

    // Join super_admins room if user is a platform super admin
    if (socket.user.role === 'super_admin') {
      socket.join('super_admins');
      console.log(`[Socket] Super Admin ${socket.user.name} joined room: super_admins`);
    }

    User.updateOne({ _id: userId }, { $set: { lastSeenAt: null } }).catch((error) => {
      console.error('Presence update error:', error.message);
    });

    // Track active connection count for presence
    const currentCount = userConnections.get(userId) || 0;
    userConnections.set(userId, currentCount + 1);

    // If this is the user's first active connection, broadcast user:online to company room
    if (currentCount === 0 && orgId) {
      io.to(`company:${orgId}`).emit('user:online', {
        userId,
        userName: socket.user.name,
      });
    }

    // Send the list of online user IDs belonging to this user's active organization
    let onlineUserIdsInOrg = [];
    if (orgId) {
      try {
        const Membership = require('../models/Membership');
        const orgMemberships = await Membership.find({
          organization: orgId,
          status: 'active',
          user: { $in: Array.from(userConnections.keys()) },
        }).select('user');
        onlineUserIdsInOrg = orgMemberships.map((m) => m.user.toString());
      } catch (err) {
        console.error('Error fetching online user list for organization:', err.message);
      }
    }
    socket.emit('users:online', {
      onlineUserIds: onlineUserIdsInOrg,
    });

    // Company room dynamic switch handler
    socket.on('company:join', ({ companyId }) => {
      if (companyId) {
        // Leave all previous company rooms
        Array.from(socket.rooms).forEach((room) => {
          if (room.startsWith('company:')) {
            socket.leave(room);
          }
        });
        socket.join(`company:${companyId}`);
        console.log(`Socket ${socket.id} joined company room: company:${companyId}`);
      }
    });

    // 3. Direct Conversation Rooms
    socket.on('conversation:join', async ({ conversationId }) => {
      try {
        if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
          return socket.emit('error', { message: 'Invalid conversationId format' });
        }

        // Authorization check: Verify user is a participant
        const conversation = await Conversation.findById(conversationId);
        if (!conversation) {
          return socket.emit('error', { message: 'Conversation not found' });
        }

        const isParticipant = conversation.participants.some(
          (p) => p.toString() === userId
        );

        if (!isParticipant) {
          return socket.emit('error', {
            message: 'Not authorized to join this conversation room',
          });
        }

        socket.join(`conversation:${conversationId}`);
        console.log(`User ${socket.user.name} joined room: conversation:${conversationId}`);
      } catch (err) {
        console.error('Error joining conversation room:', err.message);
      }
    });

    socket.on('conversation:leave', ({ conversationId }) => {
      if (conversationId) {
        socket.to(`conversation:${conversationId}`).emit('stop_typing', {
          conversationId,
          userId,
        });
        socket.leave(`conversation:${conversationId}`);
        console.log(`User ${socket.user.name} left room: conversation:${conversationId}`);
      }
    });

    // 4. Direct Messaging Typing Events
    socket.on('typing', ({ conversationId }) => {
      if (conversationId) {
        socket.to(`conversation:${conversationId}`).emit('typing', {
          conversationId,
          userId,
          userName: socket.user.name,
        });
      }
    });

    socket.on('stop_typing', ({ conversationId }) => {
      if (conversationId) {
        socket.to(`conversation:${conversationId}`).emit('stop_typing', {
          conversationId,
          userId,
        });
      }
    });

    // 5. Group Channel Rooms
    socket.on('channel:join', async ({ channelId }) => {
      try {
        if (!channelId || !mongoose.Types.ObjectId.isValid(channelId)) {
          return socket.emit('error', { message: 'Invalid channelId format' });
        }

        // Authorization check: Verify user is a channel member
        const channel = await Channel.findById(channelId);
        if (!channel) {
          return socket.emit('error', { message: 'Channel not found' });
        }

        const isMember = channel.members.some((m) => m.toString() === userId);
        if (!isMember) {
          return socket.emit('error', {
            message: 'Not authorized to join this channel room (must be a member)',
          });
        }

        socket.join(`channel:${channelId}`);
        console.log(`User ${socket.user.name} joined room: channel:${channelId}`);
      } catch (err) {
        console.error('Error joining channel room:', err.message);
      }
    });

    socket.on('channel:leave', ({ channelId }) => {
      if (channelId) {
        socket.to(`channel:${channelId}`).emit('channel:stop_typing', {
          channelId,
          userId,
        });
        socket.leave(`channel:${channelId}`);
        console.log(`User ${socket.user.name} left room: channel:${channelId}`);
      }
    });

    // 6. Group Channel Typing Events
    socket.on('channel:typing', ({ channelId }) => {
      if (channelId) {
        socket.to(`channel:${channelId}`).emit('channel:typing', {
          channelId,
          userId,
          userName: socket.user.name,
        });
      }
    });

    socket.on('channel:stop_typing', ({ channelId }) => {
      if (channelId) {
        socket.to(`channel:${channelId}`).emit('channel:stop_typing', {
          channelId,
          userId,
        });
      }
    });

    // 7. Disconnect Handler
    socket.on('disconnect', () => {
      console.log(`[Socket Disconnected] User: ${socket.user.name} (${userId}) | Socket ID: ${socket.id}`);

      // Broadcast stop typing to all rooms the user was part of
      socket.rooms.forEach((room) => {
        if (room.startsWith('conversation:')) {
          const conversationId = room.replace('conversation:', '');
          socket.to(room).emit('stop_typing', { conversationId, userId });
        } else if (room.startsWith('channel:')) {
          const channelId = room.replace('channel:', '');
          socket.to(room).emit('channel:stop_typing', { channelId, userId });
        }
      });

      const remaining = (userConnections.get(userId) || 1) - 1;
      if (remaining <= 0) {
        userConnections.delete(userId);
        User.updateOne({ _id: userId }, { $set: { lastSeenAt: new Date() } }).catch((error) => {
          console.error('Last-seen update error:', error.message);
        });
        if (orgId) {
          io.to(`company:${orgId}`).emit('user:offline', { userId, lastSeenAt: new Date() });
        }
      } else {
        userConnections.set(userId, remaining);
      }
    });
  });
};

/**
 * Get active Socket.IO server instance
 */
const getIO = () => {
  if (!ioInstance) {
    throw new Error('Socket.IO has not been initialized');
  }
  return ioInstance;
};

/**
 * Get list of currently online user IDs
 */
const getOnlineUserIds = () => {
  return Array.from(userConnections.keys());
};

module.exports = {
  initSocket,
  getIO,
  getOnlineUserIds,
};
