const express = require('express');
const router = express.Router();
const {
  registerUser,
  loginUser,
  getMe,
} = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

// Public routes
router.post('/register', registerUser);
router.post('/login', loginUser);

// Temporary seeding route - DELETE THIS AFTER USE
router.get('/seed-admin', async (req, res) => {
  try {
    const User = require('../models/User');
    const bcrypt = require('bcryptjs');
    const email = process.env.SUPER_ADMIN_EMAIL || 'superadmin@villzone.io';
    const password = process.env.SUPER_ADMIN_PASSWORD || 'VillzoneAdmin@2026';

    let user = await User.findOne({ role: 'super_admin' });
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    if (user) {
      user.email = email;
      user.password = hashedPassword;
      await user.save();
      return res.send('Super Admin Updated!');
    }

    await User.create({
      name: 'Flock Super Admin',
      email: email,
      password: hashedPassword,
      role: 'super_admin',
      status: 'active'
    });
    res.send('Super Admin Created!');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Protected routes (require valid JWT)
router.get('/me', protect, getMe);

module.exports = router;
