const express = require('express');
const router = express.Router();
const {
  searchAll,
  searchMessages,
} = require('../controllers/searchController');
const { protect } = require('../middleware/authMiddleware');
const { requireApprovedOrg } = require('../middleware/featureMiddleware');

// All search endpoints require JWT authentication and an approved organization
router.use(protect);
router.use(requireApprovedOrg);

// Unified search
router.get('/', searchAll);

// Advanced message search
router.get('/messages', searchMessages);

module.exports = router;
