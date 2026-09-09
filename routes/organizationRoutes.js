const express = require('express');
const router = express.Router();
const {
  registerAndCreateCompany,
  createOrganization,
  getMyOrganizations,
  switchOrganization,
  getOrganizationPlanDetails,
  upgradeOrganizationPlan,
} = require('../controllers/organizationController');
const { protect } = require('../middleware/authMiddleware');

// --- Public registration route ---
router.post('/register-company', registerAndCreateCompany);

// --- Protected routes (require auth) ---
router.use(protect);

router.post('/', createOrganization);
router.get('/my', getMyOrganizations);
router.post('/:id/switch', switchOrganization);
router.get('/:id/plan', getOrganizationPlanDetails);
router.post('/:id/upgrade', upgradeOrganizationPlan);

module.exports = router;

