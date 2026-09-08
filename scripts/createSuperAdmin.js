/**
 * createSuperAdmin.js
 * One-time seed script to create the Flock platform Super Admin account.
 *
 * Usage:
 *   node backend/scripts/createSuperAdmin.js
 *
 * Credentials are read from environment variables:
 *   SUPER_ADMIN_NAME     (default: "Flock Super Admin")
 *   SUPER_ADMIN_EMAIL    (required - set in .env or as env var)
 *   SUPER_ADMIN_PASSWORD (required - set in .env or as env var)
 *
 * Security notes:
 *  - Never hardcode passwords in source code.
 *  - Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD in backend/.env before running.
 *  - The script prevents duplicate super_admin creation.
 *  - Passwords are hashed with bcrypt (10 rounds) — never stored in plaintext.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/flock_clone';
const SUPER_ADMIN_NAME = process.env.SUPER_ADMIN_NAME || 'Flock Super Admin';
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL;
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD;

if (!SUPER_ADMIN_EMAIL || !SUPER_ADMIN_PASSWORD) {
  console.error('\n❌ Missing required environment variables:');
  console.error('   Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD in backend/.env');
  console.error('   Example:');
  console.error('     SUPER_ADMIN_EMAIL=superadmin@flock.io');
  console.error('     SUPER_ADMIN_PASSWORD=YourSecurePassword123!');
  process.exit(1);
}

if (SUPER_ADMIN_PASSWORD.length < 8) {
  console.error('\n❌ SUPER_ADMIN_PASSWORD must be at least 8 characters long.');
  process.exit(1);
}

async function createSuperAdmin() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB:', MONGO_URI);

    const User = require('../models/User');

    // Update or Create Super Admin
    const existingSuperAdmin = await User.findOne({ role: 'super_admin' });

    // Hash password with bcrypt
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(SUPER_ADMIN_PASSWORD, salt);

    if (existingSuperAdmin) {
      console.log('\n⚠️  Updating existing Super Admin account...');
      existingSuperAdmin.email = SUPER_ADMIN_EMAIL.toLowerCase().trim();
      existingSuperAdmin.password = hashedPassword;
      existingSuperAdmin.name = SUPER_ADMIN_NAME;
      await existingSuperAdmin.save();

      console.log('\n✅ Super Admin account updated successfully!');
      console.log('   ─────────────────────────────────────────');
      console.log(`   Name:  ${existingSuperAdmin.name}`);
      console.log(`   Email: ${existingSuperAdmin.email}`);
      console.log(`   Role:  ${existingSuperAdmin.role}`);
      console.log('   ─────────────────────────────────────────');
    } else {
      const superAdmin = await User.create({
        name: SUPER_ADMIN_NAME,
        email: SUPER_ADMIN_EMAIL.toLowerCase().trim(),
        password: hashedPassword,
        role: 'super_admin',
        status: 'active',
        currentOrganization: null,
      });

      console.log('\n✅ Super Admin account created successfully!');
      console.log('   ─────────────────────────────────────────');
      console.log(`   Name:  ${superAdmin.name}`);
      console.log(`   Email: ${superAdmin.email}`);
      console.log(`   Role:  ${superAdmin.role}`);
      console.log(`   ID:    ${superAdmin._id}`);
      console.log('   ─────────────────────────────────────────');
    }
    console.log('\n🔒 IMPORTANT: Remove SUPER_ADMIN_PASSWORD from .env after initial setup.');
    console.log('   The Super Admin can now log in at the Flock login page.\n');

  } catch (err) {
    console.error('\n❌ Error creating Super Admin:', err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

createSuperAdmin();
