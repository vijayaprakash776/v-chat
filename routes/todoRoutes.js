const express = require('express');
const router = express.Router();
const {
  createTodo,
  getTodos,
  getTodoById,
  updateTodo,
  toggleTodoStatus,
  deleteTodo,
} = require('../controllers/todoController');
const { protect } = require('../middleware/authMiddleware');
const { requireActiveOrg, requireApprovedOrg, requireFeature } = require('../middleware/featureMiddleware');

// All Todo routes are protected by JWT authentication
router.use(protect);
router.use(requireFeature('todos'));

router.route('/')
  .post(requireActiveOrg, createTodo)
  .get(requireApprovedOrg, getTodos);

router.route('/:todoId')
  .get(requireApprovedOrg, getTodoById)
  .put(requireApprovedOrg, updateTodo)
  .patch(requireApprovedOrg, updateTodo)
  .delete(requireApprovedOrg, deleteTodo);

router.patch('/:todoId/status', requireApprovedOrg, toggleTodoStatus);
router.patch('/:todoId/toggle', requireApprovedOrg, toggleTodoStatus);

module.exports = router;

