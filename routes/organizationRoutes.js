const express = require('express');
const router = express.Router();
const {
  registerAndCreateCompany,
  createOrganization,
  getMyOrganizations,
  switchOrganization,
} = require('../controllers/organizationController');
const { protect } = require('../middleware/authMiddleware');

// --- Public registration route ---
router.post('/register-company', registerAndCreateCompany);

// --- Protected routes (require auth) ---
router.use(protect);

router.post('/', createOrganization);
router.get('/my', getMyOrganizations);
router.post('/:id/switch', switchOrganization);

module.exports = router;

