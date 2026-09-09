const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const Membership = require('../models/Membership');
const Message = require('../models/Message');
const { getPlanEntitlements, getOrganizationStorageLimitBytes } = require('../config/plans');

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// 1. Disk Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Generate secure randomized unique filename
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `upload-${uniqueSuffix}${ext}`);
  },
});

// 2. Prohibited Executable Extensions List
const DISALLOWED_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.sh',
  '.vbs',
  '.js',
  '.msi',
  '.php',
  '.cgi',
  '.jar',
  '.scr',
  '.pif',
  '.com',
  '.py',
  '.ps1',
]);

// 3. Supported Video Configurations
const ALLOWED_VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);
const ALLOWED_VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

const MAX_VIDEO_SIZE_MB = parseInt(process.env.MAX_VIDEO_SIZE_MB, 10) || 500;
const MAX_VIDEO_SIZE_BYTES = MAX_VIDEO_SIZE_MB * 1024 * 1024; // 500MB for videos
const MAX_DOC_SIZE_BYTES = 100 * 1024 * 1024; // 100MB for documents / general files
const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB for images

// 4. Security File Filter
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();

  // A. Reject all executable and script extensions
  if (DISALLOWED_EXTENSIONS.has(ext)) {
    return cb(
      new Error(`Executable or script files (${ext}) are strictly prohibited.`),
      false
    );
  }

  // B. If video file extension is used, validate allowed video MIME type
  if (ALLOWED_VIDEO_EXTENSIONS.has(ext)) {
    if (!ALLOWED_VIDEO_MIMES.has(file.mimetype)) {
      return cb(
        new Error(
          `Invalid video MIME type "${file.mimetype}" for extension "${ext}". Allowed: MP4, WebM, MOV.`
        ),
        false
      );
    }
  }

  // C. If video MIME type is used, validate allowed video extension
  if (file.mimetype.startsWith('video/')) {
    if (!ALLOWED_VIDEO_EXTENSIONS.has(ext) || !ALLOWED_VIDEO_MIMES.has(file.mimetype)) {
      return cb(
        new Error(
          'Unsupported video format. Please upload MP4 (.mp4), WebM (.webm), or MOV (.mov).'
        ),
        false
      );
    }
  }

  cb(null, true);
};

// 5. Multer Instance (Configured with highest permissible capacity)
const upload = multer({
  storage,
  limits: {
    fileSize: MAX_VIDEO_SIZE_BYTES, // Allow up to maximum video capacity (500MB)
  },
  fileFilter,
});

/**
 * Express middleware wrapper that intercepts Multer errors and validates video vs image vs document file size limits
 * @param {string} fieldName - Form field name (default 'files')
 * @param {number} maxCount - Max files (default 5)
 */
const handleUpload = (fieldName = 'files', maxCount = 5) => {
  const uploadMiddleware = upload.array(fieldName, maxCount);

  return (req, res, next) => {
    uploadMiddleware(req, res, async (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            success: false,
            message: `File upload error: File exceeds maximum allowed size.`,
          });
        }
        return res.status(400).json({
          success: false,
          message: `File upload error: ${err.message}`,
        });
      } else if (err) {
        return res.status(400).json({
          success: false,
          message: err.message || 'File upload error: Invalid file format',
        });
      }

      if (req.files && req.files.length > 0) {
        if (!req.file) {
          req.file = req.files[0];
        }

        const cleanupUploadedFiles = () => {
          for (const f of req.files) {
            if (f.path && fs.existsSync(f.path)) {
              try { fs.unlinkSync(f.path); } catch (e) {}
            }
          }
        };

        // Get organization plan & entitlement specs
        const orgId = req.user?.currentOrganizationId;
        let planEntitlements = getPlanEntitlements('free');
        let activeMemberCount = 1;

        if (orgId) {
          try {
            const org = await Organization.findById(orgId).select('subscription').lean();
            planEntitlements = getPlanEntitlements(org?.subscription?.plan);
            activeMemberCount = await Membership.countDocuments({ organization: orgId, status: 'active' });
          } catch (e) {
            console.error('Error loading org plan in uploadMiddleware:', e.message);
          }
        }

        const maxFileSizeBytes = planEntitlements.maxFileSizeBytes;
        const maxFileSizeMB = planEntitlements.maxFileSizeMB;
        let incomingBatchSize = 0;

        for (const file of req.files) {
          incomingBatchSize += file.size;

          // Check plan max per-file size limit (Free: 50MB, Professional: 200MB)
          if (file.size > maxFileSizeBytes) {
            cleanupUploadedFiles();
            return res.status(413).json({
              success: false,
              message: `File "${file.originalname}" (${(file.size / (1024 * 1024)).toFixed(1)} MB) exceeds maximum allowed size of ${maxFileSizeMB} MB for ${planEntitlements.name} plan.`,
              code: 'PLAN_FILE_SIZE_EXCEEDED',
            });
          }
        }

        // Check total workspace storage limit (Free: 10GB shared, Professional: 10GB per user)
        if (orgId) {
          try {
            const totalStorageLimitBytes = getOrganizationStorageLimitBytes(planEntitlements.code, activeMemberCount);

            const storageResult = await Message.aggregate([
              { $match: { organization: new mongoose.Types.ObjectId(orgId), 'attachments.0': { $exists: true } } },
              { $unwind: '$attachments' },
              { $group: { _id: null, totalUsedBytes: { $sum: '$attachments.fileSize' } } },
            ]);
            const currentUsedBytes = storageResult[0]?.totalUsedBytes || 0;

            if (currentUsedBytes + incomingBatchSize > totalStorageLimitBytes) {
              cleanupUploadedFiles();
              const limitGB = (totalStorageLimitBytes / (1024 * 1024 * 1024)).toFixed(1);
              const usedGB = (currentUsedBytes / (1024 * 1024 * 1024)).toFixed(2);
              return res.status(413).json({
                success: false,
                message: `Workspace storage limit reached (${usedGB} GB of ${limitGB} GB used). Upgrade to Professional for more storage capacity.`,
                code: 'PLAN_STORAGE_EXCEEDED',
              });
            }
          } catch (e) {
            console.error('Error checking org storage limits:', e.message);
          }
        }
      }

      next();
    });
  };
};

module.exports = {
  upload,
  handleUpload,
  ALLOWED_VIDEO_EXTENSIONS,
  ALLOWED_VIDEO_MIMES,
  MAX_VIDEO_SIZE_MB,
  MAX_VIDEO_SIZE_BYTES,
  MAX_DOC_SIZE_BYTES,
  MAX_IMAGE_SIZE_BYTES,
};
