const multer = require('multer');
const path = require('path');
const fs = require('fs');

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
    uploadMiddleware(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            success: false,
            message: `File upload error: File exceeds the maximum allowed size limit.`,
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

      // Check per-file size limits: Images <= 20MB, Documents <= 100MB, Videos <= 500MB
      if (req.files && req.files.length > 0) {
        if (!req.file) {
          req.file = req.files[0];
        }
        for (const file of req.files) {
          const ext = path.extname(file.originalname).toLowerCase();
          const isVideo =
            file.mimetype.startsWith('video/') ||
            ALLOWED_VIDEO_EXTENSIONS.has(ext);
          const isImage =
            file.mimetype.startsWith('image/') ||
            ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'].includes(ext);

          if (isVideo && file.size > MAX_VIDEO_SIZE_BYTES) {
            if (file.path && fs.existsSync(file.path)) {
              fs.unlinkSync(file.path);
            }
            return res.status(413).json({
              success: false,
              message: `Video "${file.originalname}" exceeds the maximum allowed size of 500MB.`,
            });
          }

          if (isImage && file.size > MAX_IMAGE_SIZE_BYTES) {
            if (file.path && fs.existsSync(file.path)) {
              fs.unlinkSync(file.path);
            }
            return res.status(400).json({
              success: false,
              message: `Image "${file.originalname}" exceeds the maximum allowed size of 20MB.`,
            });
          }

          if (!isVideo && !isImage && file.size > MAX_DOC_SIZE_BYTES) {
            if (file.path && fs.existsSync(file.path)) {
              fs.unlinkSync(file.path);
            }
            return res.status(400).json({
              success: false,
              message: `Document "${file.originalname}" exceeds the maximum allowed size of 100MB.`,
            });
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
