const Note = require('../models/Note');

/**
 * @desc    Create a new private note
 * @route   POST /api/notes
 * @access  Private
 */
const createNote = async (req, res) => {
  try {
    const { title, content } = req.body;
    const userId = req.user._id; // Always use authenticated user's ID

    const note = await Note.create({
      userId,
      title: title && title.trim() ? title.trim() : 'Untitled Note',
      content: content ? content.trim() : '',
    });

    res.status(201).json({
      success: true,
      message: 'Note created successfully',
      note,
    });
  } catch (error) {
    console.error('Error creating note:', error.message);
    res.status(500).json({
      success: false,
      message: 'Server error creating note',
      error: error.message,
    });
  }
};

/**
 * @desc    Get all private notes for the authenticated user
 * @route   GET /api/notes
 * @access  Private
 */
const getNotes = async (req, res) => {
  try {
    const userId = req.user._id;
    const { search, q } = req.query;
    const searchQuery = (search || q || '').trim();

    const query = {
      userId,
      deleted: false,
    };

    // Keyword search over title or content
    if (searchQuery) {
      const regex = new RegExp(searchQuery.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i');
      query.$or = [{ title: regex }, { content: regex }];
    }

    const notes = await Note.find(query).sort({ updatedAt: -1 }).lean();

    res.status(200).json({
      success: true,
      count: notes.length,
      notes,
    });
  } catch (error) {
    console.error('Error fetching notes:', error.message);
    res.status(500).json({
      success: false,
      message: 'Server error fetching notes',
      error: error.message,
    });
  }
};

/**
 * @desc    Get a single private note by ID
 * @route   GET /api/notes/:noteId
 * @access  Private
 */
const getNoteById = async (req, res) => {
  try {
    const { noteId } = req.params;
    const userId = req.user._id;

    const note = await Note.findOne({
      _id: noteId,
      userId,
      deleted: false,
    }).lean();

    if (!note) {
      return res.status(404).json({
        success: false,
        message: 'Note not found or access denied',
      });
    }

    res.status(200).json({
      success: true,
      note,
    });
  } catch (error) {
    console.error('Error fetching note:', error.message);
    res.status(500).json({
      success: false,
      message: 'Server error fetching note',
      error: error.message,
    });
  }
};

/**
 * @desc    Update a private note
 * @route   PUT /api/notes/:noteId
 * @access  Private
 */
const updateNote = async (req, res) => {
  try {
    const { noteId } = req.params;
    const { title, content } = req.body;
    const userId = req.user._id;

    const note = await Note.findOne({
      _id: noteId,
      userId,
      deleted: false,
    });

    if (!note) {
      return res.status(404).json({
        success: false,
        message: 'Note not found or access denied',
      });
    }

    if (title !== undefined) {
      note.title = title && title.trim() ? title.trim() : 'Untitled Note';
    }
    if (content !== undefined) {
      note.content = content ? content.trim() : '';
    }

    await note.save();

    res.status(200).json({
      success: true,
      message: 'Note updated successfully',
      note,
    });
  } catch (error) {
    console.error('Error updating note:', error.message);
    res.status(500).json({
      success: false,
      message: 'Server error updating note',
      error: error.message,
    });
  }
};

/**
 * @desc    Delete a private note (Soft delete)
 * @route   DELETE /api/notes/:noteId
 * @access  Private
 */
const deleteNote = async (req, res) => {
  try {
    const { noteId } = req.params;
    const userId = req.user._id;

    const note = await Note.findOne({
      _id: noteId,
      userId,
      deleted: false,
    });

    if (!note) {
      return res.status(404).json({
        success: false,
        message: 'Note not found or access denied',
      });
    }

    note.deleted = true;
    await note.save();

    res.status(200).json({
      success: true,
      message: 'Note deleted successfully',
      noteId,
    });
  } catch (error) {
    console.error('Error deleting note:', error.message);
    res.status(500).json({
      success: false,
      message: 'Server error deleting note',
      error: error.message,
    });
  }
};

module.exports = {
  createNote,
  getNotes,
  getNoteById,
  updateNote,
  deleteNote,
};
