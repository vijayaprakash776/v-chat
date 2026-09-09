const express = require('express');
const router = express.Router();
const {
  createNote,
  getNotes,
  getNoteById,
  updateNote,
  deleteNote,
} = require('../controllers/noteController');
const { protect } = require('../middleware/authMiddleware');
const { requireActiveOrg, requireApprovedOrg } = require('../middleware/featureMiddleware');

// All Note routes require JWT Authentication
router.use(protect);

router.route('/')
  .post(requireActiveOrg, createNote)
  .get(requireApprovedOrg, getNotes);

router.route('/:noteId')
  .get(requireApprovedOrg, getNoteById)
  .put(requireActiveOrg, updateNote)
  .delete(requireActiveOrg, deleteNote);

module.exports = router;
