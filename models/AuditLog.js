const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  admin: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Admin user is required for audit log'],
  },
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    default: null,
  },
  action: {
    type: String,
    required: [true, 'Action name is required'],
    trim: true,
  },
  targetType: {
    type: String,
    required: [true, 'Target entity type is required'],
    enum: ['User', 'Channel', 'Message', 'System', 'Organization', 'JoinRequest'],
  },
  targetId: {
    type: String,
    default: '',
  },
  targetName: {
    type: String,
    default: '',
    trim: true,
  },
  details: {
    type: String,
    default: '',
    trim: true,
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Indexes for rapid filtering and chronological listing
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ admin: 1, createdAt: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1 });

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

module.exports = AuditLog;
