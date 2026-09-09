const mongoose = require('mongoose');

const noteSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      index: true,
    },
    title: {
      type: String,
      trim: true,
      default: 'Untitled Note',
      maxlength: [250, 'Note title cannot exceed 250 characters'],
    },
    content: {
      type: String,
      default: '',
      maxlength: [50000, 'Note content cannot exceed 50,000 characters'],
    },
    tags: {
      type: [String],
      default: [],
    },
    deleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for optimized querying of active notes per user
noteSchema.index({ userId: 1, deleted: 1, updatedAt: -1 });

module.exports = mongoose.model('Note', noteSchema);
