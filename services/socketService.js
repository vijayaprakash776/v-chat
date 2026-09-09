const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Channel = require('../models/Channel');

let ioInstance = null;

// Map to track connection counts per user ID: Map<userIdString, connectionCount>
const userConnections = new Map();

// Map to track active WebRTC call sessions: Map<sessionKey, sessionData>
const activeCalls = new Map();

/**
 * Record a call history message in MongoDB and broadcast to conversation participants
 */
const recordCallMessage = async ({
  callerId,
  receiverId,
  callType = 'audio',
  status = 'ended',
  duration = 0,
  conversationId,
  orgId,
}) => {
  try {
    const Message = require('../models/Message');
    const Conversation = require('../models/Conversation');

    if (!callerId || !receiverId) return null;

    let conv = null;
    if (conversationId && mongoose.Types.ObjectId.isValid(conversationId)) {
      conv = await Conversation.findById(conversationId);
    }
    if (!conv) {
      conv = await Conversation.findOne({
        participants: { $all: [callerId, receiverId], $size: 2 },
      });
    }

    if (!conv) return null;

    const callContent = callType === 'video' ? '📹 Video Call' : '📞 Audio Call';

    const newMessage = await Message.create({
      organization: conv.organization || orgId,
      conversationId: conv._id,
      sender: callerId,
      receiver: receiverId,
      messageType: 'call',
      content: callContent,
      call: {
        callType: callType === 'video' ? 'video' : 'audio',
        status,
        duration: Math.max(0, duration),
      },
      isRead: false,
    });

    conv.lastMessage = newMessage._id;
    conv.lastMessageAt = newMessage.createdAt;
    await conv.save();

    const populatedMessage = await Message.findById(newMessage._id).populate(
      'sender receiver',
      'name email avatar'
    );

    if (ioInstance) {
      const rooms = [
        `conversation:${conv._id.toString()}`,
        `user:${callerId.toString()}`,
        `user:${receiverId.toString()}`,
      ];
      ioInstance.to(rooms).emit('message:new', {
        message: populatedMessage,
      });
    }

    return populatedMessage;
  } catch (err) {
    console.error('Error recording call message:', err.message);
    return null;
  }
};

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

    // 8. WebRTC Calling Signaling
    socket.on('call:request', (data) => {
      if (data.receiverId) {
        const sessionKey = `${userId}_${data.receiverId}`;
        activeCalls.set(sessionKey, {
          callerId: userId,
          receiverId: data.receiverId,
          callType: data.callType || 'audio',
          conversationId: data.conversationId,
          startTime: Date.now(),
          connected: false,
          connectedAt: null,
          orgId: socket.user.currentOrganization?.toString(),
        });

        io.to(`user:${data.receiverId}`).emit('call:incoming', {
          callerId: userId,
          callerName: socket.user.name,
          callerAvatar: socket.user.avatar,
          callType: data.callType,
          conversationId: data.conversationId,
        });
      }
    });

    socket.on('call:accept', (data) => {
      if (data.callerId) {
        const sessionKey = `${data.callerId}_${userId}`;
        const session = activeCalls.get(sessionKey);
        if (session) {
          session.connected = true;
          session.connectedAt = Date.now();
        }
        io.to(`user:${data.callerId}`).emit('call:accepted', {
          receiverId: userId,
        });
      }
    });

    socket.on('call:reject', (data) => {
      if (data.callerId) {
        const sessionKey = `${data.callerId}_${userId}`;
        const session = activeCalls.get(sessionKey);
        if (session) {
          activeCalls.delete(sessionKey);
        }

        recordCallMessage({
          callerId: data.callerId,
          receiverId: userId,
          callType: session?.callType || data.callType || 'audio',
          status: 'declined',
          duration: 0,
          conversationId: session?.conversationId || data.conversationId,
          orgId: socket.user.currentOrganization?.toString(),
        });

        io.to(`user:${data.callerId}`).emit('call:rejected', {
          receiverId: userId,
        });
      }
    });

    socket.on('call:offer', (data) => {
      if (data.targetId) {
        io.to(`user:${data.targetId}`).emit('call:offer', {
          senderId: userId,
          offer: data.offer,
        });
      }
    });

    socket.on('call:answer', (data) => {
      if (data.targetId) {
        io.to(`user:${data.targetId}`).emit('call:answer', {
          senderId: userId,
          answer: data.answer,
        });
      }
    });

    socket.on('call:ice-candidate', (data) => {
      if (data.targetId) {
        io.to(`user:${data.targetId}`).emit('call:ice-candidate', {
          senderId: userId,
          candidate: data.candidate,
        });
      }
    });

    socket.on('call:end', (data) => {
      if (data.targetId) {
        const key1 = `${userId}_${data.targetId}`;
        const key2 = `${data.targetId}_${userId}`;
        const session = activeCalls.get(key1) || activeCalls.get(key2);

        if (session) {
          activeCalls.delete(key1);
          activeCalls.delete(key2);
        }

        const callerId = session?.callerId || (data.isCaller ? userId : data.targetId);
        const receiverId = session?.receiverId || (data.isCaller ? data.targetId : userId);
        const callType = session?.callType || data.callType || 'audio';
        const conversationId = session?.conversationId || data.conversationId;

        let status = 'ended';
        let duration = 0;

        if (session && session.connected && session.connectedAt) {
          status = 'ended';
          duration = Math.max(1, Math.round((Date.now() - session.connectedAt) / 1000));
        } else if (data.duration && data.duration > 0) {
          status = 'ended';
          duration = data.duration;
        } else if (session && !session.connected) {
          status = userId === session.callerId ? 'cancelled' : 'missed';
          duration = 0;
        } else {
          status = data.status || 'ended';
          duration = data.duration || 0;
        }

        recordCallMessage({
          callerId,
          receiverId,
          callType,
          status,
          duration,
          conversationId,
          orgId: socket.user.currentOrganization?.toString(),
        });

        io.to(`user:${data.targetId}`).emit('call:ended', {
          senderId: userId,
        });
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
