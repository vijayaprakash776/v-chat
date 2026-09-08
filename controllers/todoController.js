const mongoose = require('mongoose');
const Todo = require('../models/Todo');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Channel = require('../models/Channel');
const Message = require('../models/Message');
const { notifyTodoAssigned } = require('../services/notificationService');

/**
 * Helper to emit Socket.IO events to relevant rooms
 */
const emitTodoSocketEvent = (io, eventName, todoData) => {
  if (!io || !todoData) return;

  const todoId = (todoData._id || todoData.id || todoData.todoId)?.toString();
  const creatorId = (todoData.createdBy?._id || todoData.createdBy)?.toString();
  const assigneeId = (todoData.assignedTo?._id || todoData.assignedTo)?.toString();
  const conversationId = (todoData.conversationId?._id || todoData.conversationId)?.toString();
  const channelId = (todoData.channelId?._id || todoData.channelId)?.toString();

  const payload = {
    todo: todoData,
    todoId,
    conversationId,
    channelId,
  };

  const isPersonal = Boolean(creatorId && assigneeId && creatorId === assigneeId);

  // 1. Direct user rooms
  if (creatorId) io.to(`user:${creatorId}`).emit(eventName, payload);

  // For shared To-Dos only: emit to other assignee and shared context rooms
  if (!isPersonal) {
    if (assigneeId && assigneeId !== creatorId) io.to(`user:${assigneeId}`).emit(eventName, payload);

    // 2. Context rooms
    if (conversationId) io.to(`conversation:${conversationId}`).emit(eventName, payload);
    if (channelId) io.to(`channel:${channelId}`).emit(eventName, payload);
  }
};

// @desc    Create a new To-Do
// @route   POST /api/todos
// @access  Private
const createTodo = async (req, res) => {
  try {
    const {
      title,
      description,
      assignedTo,
      priority,
      dueDate,
      conversationId,
      channelId,
      sourceMessageId,
    } = req.body;
    const userId = req.user.id;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Todo title is required',
      });
    }

    // If assignedTo is provided and valid, assign to that user; otherwise assign to creator (self)
    const targetAssigneeId = (assignedTo && mongoose.Types.ObjectId.isValid(assignedTo))
      ? assignedTo
      : userId;

    // Verify assigned user exists
    const assignee = await User.findById(targetAssigneeId);
    if (!assignee) {
      return res.status(404).json({
        success: false,
        message: 'Assigned user does not exist',
      });
    }

    const orgId = req.user.currentOrganizationId;
    if (!orgId) {
      return res.status(400).json({
        success: false,
        message: 'No active organization set',
      });
    }

    // Verify assignee belongs to the active organization
    const Membership = require('../models/Membership');
    const assigneeMem = await Membership.findOne({
      user: targetAssigneeId,
      organization: orgId,
      status: 'active',
    });
    if (!assigneeMem) {
      return res.status(403).json({
        success: false,
        message: 'Assignee is not a member of your active company',
      });
    }

    // If linked to a Conversation, validate membership of creator and assignee
    if (conversationId) {
      if (!mongoose.Types.ObjectId.isValid(conversationId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid conversationId format',
        });
      }

      const conversation = await Conversation.findById(conversationId);
      if (!conversation) {
        return res.status(404).json({
          success: false,
          message: 'Conversation not found',
        });
      }

      const participantIds = conversation.participants.map((p) => p.toString());
      if (!participantIds.includes(userId)) {
        return res.status(403).json({
          success: false,
          message: 'You are not a participant in this conversation',
        });
      }

      if (!participantIds.includes(targetAssigneeId.toString())) {
        return res.status(403).json({
          success: false,
          message: 'Assignee is not a participant in this conversation',
        });
      }
    }

    // If linked to a Channel, validate membership of creator and assignee
    if (channelId) {
      if (!mongoose.Types.ObjectId.isValid(channelId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid channelId format',
        });
      }

      const channel = await Channel.findById(channelId);
      if (!channel) {
        return res.status(404).json({
          success: false,
          message: 'Channel not found',
        });
      }

      const memberIds = channel.members.map((m) => m.toString());
      if (!memberIds.includes(userId)) {
        return res.status(403).json({
          success: false,
          message: 'You are not a member of this channel',
        });
      }

      if (!memberIds.includes(targetAssigneeId.toString())) {
        return res.status(403).json({
          success: false,
          message: 'Assignee is not a member of this channel',
        });
      }
    }

    // If linked to a source message, validate message existence
    if (sourceMessageId) {
      if (!mongoose.Types.ObjectId.isValid(sourceMessageId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid sourceMessageId format',
        });
      }
      const messageExists = await Message.findById(sourceMessageId);
      if (!messageExists) {
        return res.status(404).json({
          success: false,
          message: 'Source message not found',
        });
      }
    }

    const todo = await Todo.create({
      organization: orgId,
      title: title.trim(),
      description: description ? description.trim() : '',
      createdBy: userId,
      assignedTo: targetAssigneeId,
      priority: ['low', 'normal', 'high'].includes(priority) ? priority : 'normal',
      dueDate: dueDate ? new Date(dueDate) : null,
      conversationId: conversationId || null,
      channelId: channelId || null,
      sourceMessageId: sourceMessageId || null,
      status: 'pending',
    });

    const populated = await Todo.findById(todo._id)
      .populate('createdBy', 'name email avatar role')
      .populate('assignedTo', 'name email avatar role')
      .populate({
        path: 'conversationId',
        populate: { path: 'participants', select: 'name email avatar' },
      })
      .populate('channelId', 'name isPrivate')
      .populate({
        path: 'sourceMessageId',
        select: 'content sender createdAt deleted attachments',
        populate: { path: 'sender', select: 'name email avatar' },
      });

    const io = req.app.get('io');

    // Trigger notification if assigned to another user
    if (targetAssigneeId.toString() !== userId.toString()) {
      await notifyTodoAssigned({
        creator: req.user,
        assigneeId: targetAssigneeId,
        todo: populated,
        io,
      });
    }

    // Real-Time Socket Emission
    emitTodoSocketEvent(io, 'todo:created', populated);

    return res.status(201).json({
      success: true,
      todo: populated,
    });
  } catch (error) {
    console.error('Create Todo Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error creating To-Do',
    });
  }
};

// @desc    Get Todos with filtering, search, and view tabs for current organization
// @route   GET /api/todos
// @access  Private
const getTodos = async (req, res) => {
  try {
    const userId = req.user.id;
    const orgId = req.user.currentOrganizationId;

    if (!orgId) {
      return res.status(200).json({
        success: true,
        count: 0,
        todos: [],
      });
    }

    const {
      view = 'all', // 'all' | 'my'
      status, // 'all' | 'pending' | 'completed'
      priority, // 'all' | 'low' | 'normal' | 'high'
      search,
      sort = 'default', // 'default' | 'dueDate' | 'createdAt' | 'priority'
      conversationId,
      channelId,
    } = req.query;

    // 1. Gather all authorized conversation IDs and channel IDs for this user IN CURRENT ORG
    const userConversations = await Conversation.find({
      organization: orgId,
      participants: userId,
    }).select('_id');
    const userConvIds = userConversations.map((c) => c._id);

    const userChannels = await Channel.find({
      organization: orgId,
      $or: [{ members: userId }, { isPrivate: false }],
    }).select('_id');
    const userChanIds = userChannels.map((c) => c._id);

    // 2. Build Base Filter
    const filter = {
      organization: orgId,
      deleted: { $ne: true },
    };

    const andConditions = [];

    // Privacy Rule: Self-created personal To-Dos (where assignedTo == createdBy)
    // are strictly private to that user. Other members can only access shared To-Dos (where assignedTo != createdBy).
    andConditions.push({
      $or: [
        { createdBy: new mongoose.Types.ObjectId(userId) },
        { $expr: { $ne: ['$assignedTo', '$createdBy'] } },
      ],
    });

    if (view === 'my') {
      // Strictly assigned to the current user
      filter.assignedTo = userId;
    } else {
      // 'all': Tasks created by user, assigned to user, or belonging to user's conversations/channels or workspace
      andConditions.push({
        $or: [
          { assignedTo: userId },
          { createdBy: userId },
          { conversationId: { $in: userConvIds } },
          { channelId: { $in: userChanIds } },
          { conversationId: null, channelId: null },
        ],
      });
    }

    // Status Filter
    if (status && ['pending', 'completed'].includes(status)) {
      filter.status = status;
    }

    // Priority Filter
    if (priority && ['low', 'normal', 'high'].includes(priority)) {
      filter.priority = priority;
    }

    // Context Filters
    if (conversationId) {
      if (!mongoose.Types.ObjectId.isValid(conversationId)) {
        return res.status(400).json({ success: false, message: 'Invalid conversationId' });
      }
      filter.conversationId = conversationId;
    }

    if (channelId) {
      if (!mongoose.Types.ObjectId.isValid(channelId)) {
        return res.status(400).json({ success: false, message: 'Invalid channelId' });
      }
      filter.channelId = channelId;
    }

    // Search Filter
    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim().replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i');

      // Also search by user names (assignedTo, createdBy) and channel names
      const matchedUsers = await User.find({ name: searchRegex }).select('_id');
      const matchedUserIds = matchedUsers.map((u) => u._id);

      const matchedChannels = await Channel.find({ name: searchRegex }).select('_id');
      const matchedChannelIds = matchedChannels.map((c) => c._id);

      const searchConditions = [
        { title: searchRegex },
        { description: searchRegex },
        { assignedTo: { $in: matchedUserIds } },
        { createdBy: { $in: matchedUserIds } },
        { channelId: { $in: matchedChannelIds } },
      ];

      andConditions.push({ $or: searchConditions });
    }

    if (andConditions.length > 0) {
      filter.$and = andConditions;
    }

    // 3. Sorting logic
    let sortOption = {};
    if (sort === 'dueDate') {
      sortOption = { dueDate: 1, createdAt: -1 };
    } else if (sort === 'createdAt') {
      sortOption = { createdAt: -1 };
    } else if (sort === 'priority') {
      // Handled via custom priority ordering or database sort
      sortOption = { priority: 1, createdAt: -1 };
    } else {
      // Default: pending tasks first, then due dates, then created dates
      sortOption = { status: 1, dueDate: 1, createdAt: -1 };
    }

    const todos = await Todo.find(filter)
      .populate('createdBy', 'name email avatar role')
      .populate('assignedTo', 'name email avatar role')
      .populate({
        path: 'conversationId',
        populate: { path: 'participants', select: 'name email avatar' },
      })
      .populate('channelId', 'name isPrivate')
      .populate({
        path: 'sourceMessageId',
        select: 'content sender createdAt deleted attachments',
        populate: { path: 'sender', select: 'name email avatar' },
      })
      .sort(sortOption);

    return res.status(200).json({
      success: true,
      count: todos.length,
      todos,
    });
  } catch (error) {
    console.error('Get Todos Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error retrieving To-Dos',
    });
  }
};

// @desc    Get single Todo by ID
// @route   GET /api/todos/:todoId
// @access  Private
const getTodoById = async (req, res) => {
  try {
    const { todoId } = req.params;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(todoId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid todoId format',
      });
    }

    const todo = await Todo.findOne({ _id: todoId, deleted: { $ne: true } })
      .populate('createdBy', 'name email avatar role')
      .populate('assignedTo', 'name email avatar role')
      .populate({
        path: 'conversationId',
        populate: { path: 'participants', select: 'name email avatar' },
      })
      .populate('channelId', 'name isPrivate')
      .populate({
        path: 'sourceMessageId',
        select: 'content sender createdAt deleted attachments',
        populate: { path: 'sender', select: 'name email avatar' },
      });

    if (!todo) {
      return res.status(404).json({
        success: false,
        message: 'To-Do not found',
      });
    }

    // Access authorization check
    const isCreator = todo.createdBy._id.toString() === userId;
    const isAssignee = todo.assignedTo._id.toString() === userId;
    const isPersonal = (todo.createdBy._id || todo.createdBy).toString() === (todo.assignedTo._id || todo.assignedTo).toString();

    // Privacy Rule: A self-created personal To-Do is strictly private to its creator
    if (isPersonal) {
      if (!isCreator) {
        return res.status(403).json({
          success: false,
          message: 'You are not authorized to view this personal To-Do',
        });
      }
      return res.status(200).json({
        success: true,
        todo,
      });
    }

    const isAdmin = req.user.role === 'admin';

    let hasContextAccess = false;
    if (todo.conversationId) {
      const pIds = todo.conversationId.participants?.map((p) => p._id.toString()) || [];
      if (pIds.includes(userId)) hasContextAccess = true;
    } else if (todo.channelId) {
      const channel = await Channel.findById(todo.channelId);
      if (channel && (!channel.isPrivate || channel.members.some((m) => m.toString() === userId))) {
        hasContextAccess = true;
      }
    } else {
      hasContextAccess = true;
    }

    if (!isCreator && !isAssignee && !isAdmin && !hasContextAccess) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to view this To-Do',
      });
    }

    return res.status(200).json({
      success: true,
      todo,
    });
  } catch (error) {
    console.error('Get Todo By ID Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error retrieving To-Do',
    });
  }
};

// @desc    Update a To-Do
// @route   PATCH /api/todos/:todoId
// @access  Private
const updateTodo = async (req, res) => {
  try {
    const { todoId } = req.params;
    const { title, description, assignedTo, priority, dueDate } = req.body;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(todoId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid todoId format',
      });
    }

    const todo = await Todo.findOne({ _id: todoId, deleted: { $ne: true } });
    if (!todo) {
      return res.status(404).json({
        success: false,
        message: 'To-Do not found',
      });
    }

    // Permission check: Creator, Assignee, or Admin
    const isCreator = todo.createdBy.toString() === userId;
    const isAssignee = todo.assignedTo.toString() === userId;
    const isPersonal = todo.createdBy.toString() === todo.assignedTo.toString();

    // Personal To-Dos can only be edited by the creator
    if (isPersonal && !isCreator) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to edit this personal To-Do',
      });
    }

    const isAdmin = req.user.role === 'admin';

    if (!isCreator && !isAssignee && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to edit this To-Do',
      });
    }

    if (title !== undefined) {
      if (!title || typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({
          success: false,
          message: 'Title cannot be empty',
        });
      }
      todo.title = title.trim();
    }

    if (description !== undefined) {
      todo.description = typeof description === 'string' ? description.trim() : '';
    }

    if (priority !== undefined && ['low', 'normal', 'high'].includes(priority)) {
      todo.priority = priority;
    }

    if (dueDate !== undefined) {
      todo.dueDate = dueDate ? new Date(dueDate) : null;
    }

    // Reassignment check
    let reassigned = false;
    if (assignedTo && assignedTo.toString() !== todo.assignedTo.toString()) {
      if (!mongoose.Types.ObjectId.isValid(assignedTo)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid assignedTo format',
        });
      }

      const newAssignee = await User.findById(assignedTo);
      if (!newAssignee) {
        return res.status(404).json({
          success: false,
          message: 'Assigned user does not exist',
        });
      }

      // Check context validity for new assignee
      if (todo.conversationId) {
        const conv = await Conversation.findById(todo.conversationId);
        if (conv && !conv.participants.some((p) => p.toString() === assignedTo.toString())) {
          return res.status(403).json({
            success: false,
            message: 'New assignee is not a participant in this conversation',
          });
        }
      }

      if (todo.channelId) {
        const chan = await Channel.findById(todo.channelId);
        if (chan && !chan.members.some((m) => m.toString() === assignedTo.toString())) {
          return res.status(403).json({
            success: false,
            message: 'New assignee is not a member of this channel',
          });
        }
      }

      todo.assignedTo = assignedTo;
      reassigned = true;
    }

    await todo.save();

    const populated = await Todo.findById(todo._id)
      .populate('createdBy', 'name email avatar role')
      .populate('assignedTo', 'name email avatar role')
      .populate({
        path: 'conversationId',
        populate: { path: 'participants', select: 'name email avatar' },
      })
      .populate('channelId', 'name isPrivate')
      .populate({
        path: 'sourceMessageId',
        select: 'content sender createdAt deleted attachments',
        populate: { path: 'sender', select: 'name email avatar' },
      });

    const io = req.app.get('io');

    if (reassigned && todo.assignedTo.toString() !== userId) {
      await notifyTodoAssigned({
        creator: req.user,
        assigneeId: todo.assignedTo,
        todo: populated,
        io,
      });
    }

    emitTodoSocketEvent(io, 'todo:updated', populated);

    return res.status(200).json({
      success: true,
      todo: populated,
    });
  } catch (error) {
    console.error('Update Todo Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error updating To-Do',
    });
  }
};

// @desc    Toggle Todo status (pending <-> completed)
// @route   PATCH /api/todos/:todoId/status
// @access  Private
const toggleTodoStatus = async (req, res) => {
  try {
    const { todoId } = req.params;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(todoId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid todoId format',
      });
    }

    const todo = await Todo.findOne({ _id: todoId, deleted: { $ne: true } });
    if (!todo) {
      return res.status(404).json({
        success: false,
        message: 'To-Do not found',
      });
    }

    // Permission check: Creator, Assignee, or Admin
    const isCreator = todo.createdBy.toString() === userId;
    const isAssignee = todo.assignedTo.toString() === userId;
    const isPersonal = todo.createdBy.toString() === todo.assignedTo.toString();

    // Personal To-Dos can only be updated by the creator
    if (isPersonal && !isCreator) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to update status of this personal To-Do',
      });
    }

    const isAdmin = req.user.role === 'admin';

    if (!isCreator && !isAssignee && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to update status of this To-Do',
      });
    }

    const isNowCompleted = todo.status !== 'completed';
    todo.status = isNowCompleted ? 'completed' : 'pending';
    todo.completedAt = isNowCompleted ? new Date() : null;

    await todo.save();

    const populated = await Todo.findById(todo._id)
      .populate('createdBy', 'name email avatar role')
      .populate('assignedTo', 'name email avatar role')
      .populate({
        path: 'conversationId',
        populate: { path: 'participants', select: 'name email avatar' },
      })
      .populate('channelId', 'name isPrivate')
      .populate({
        path: 'sourceMessageId',
        select: 'content sender createdAt deleted attachments',
        populate: { path: 'sender', select: 'name email avatar' },
      });

    const io = req.app.get('io');
    emitTodoSocketEvent(io, isNowCompleted ? 'todo:completed' : 'todo:updated', populated);

    return res.status(200).json({
      success: true,
      todo: populated,
    });
  } catch (error) {
    console.error('Toggle Todo Status Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error updating To-Do status',
    });
  }
};

// @desc    Delete a To-Do (Soft Deletion)
// @route   DELETE /api/todos/:todoId
// @access  Private
const deleteTodo = async (req, res) => {
  try {
    const { todoId } = req.params;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(todoId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid todoId format',
      });
    }

    const todo = await Todo.findOne({ _id: todoId, deleted: { $ne: true } });
    if (!todo) {
      return res.status(404).json({
        success: false,
        message: 'To-Do not found',
      });
    }

    // Permission check: Only Creator or Admin can delete
    const isCreator = todo.createdBy.toString() === userId;
    const isPersonal = todo.createdBy.toString() === todo.assignedTo.toString();

    // Personal To-Dos can only be deleted by the creator
    if (isPersonal && !isCreator) {
      return res.status(403).json({
        success: false,
        message: 'You can only delete your own personal To-Dos',
      });
    }

    const isAdmin = req.user.role === 'admin';

    if (!isCreator && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'You can only delete To-Dos that you created',
      });
    }

    // Soft delete
    todo.deleted = true;
    todo.deletedAt = new Date();
    todo.deletedBy = userId;
    await todo.save();

    const io = req.app.get('io');
    emitTodoSocketEvent(io, 'todo:deleted', {
      todoId: todo._id,
      conversationId: todo.conversationId,
      channelId: todo.channelId,
      createdBy: todo.createdBy,
      assignedTo: todo.assignedTo,
    });

    return res.status(200).json({
      success: true,
      message: 'To-Do deleted successfully',
      todoId: todo._id,
    });
  } catch (error) {
    console.error('Delete Todo Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Server error deleting To-Do',
    });
  }
};

module.exports = {
  createTodo,
  getTodos,
  getTodoById,
  updateTodo,
  toggleTodoStatus,
  deleteTodo,
};
