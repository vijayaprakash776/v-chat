const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const User = require('../models/User');
const Organization = require('../models/Organization');
const Membership = require('../models/Membership');
const Channel = require('../models/Channel');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const Notification = require('../models/Notification');
const Todo = require('../models/Todo');
const Invitation = require('../models/Invitation');
const JoinRequest = require('../models/JoinRequest');
const AuditLog = require('../models/AuditLog');
const PinnedMessage = require('../models/PinnedMessage');
const SavedMessage = require('../models/SavedMessage');

async function detailedAudit() {
  try {
    const mongoUri = process.env.MONGO_URI;
    await mongoose.connect(mongoUri);
    const db = mongoose.connection.db;

    console.log('========================================================================');
    console.log(`DATABASE: ${mongoose.connection.name}`);
    console.log('========================================================================\n');

    // Document Counts
    const collections = await db.listCollections().toArray();
    console.log('=== COLLECTION DOCUMENT TOTALS ===');
    for (const col of collections) {
      const count = await db.collection(col.name).countDocuments();
      console.log(`  ${col.name.padEnd(20)}: ${count}`);
    }

    // All Orgs
    const allOrgs = await Organization.find({}).lean();
    console.log(`\n=== ALL ORGANIZATIONS (${allOrgs.length} Total) ===`);
    const testOrgIds = [];
    const realOrgIds = [];

    for (const org of allOrgs) {
      const mCount = await Membership.countDocuments({ organization: org._id });
      const chCount = await Channel.countDocuments({ organization: org._id });
      const msgCount = await Message.countDocuments({ organization: org._id });
      
      // Determine if obvious test artifact created with timestamped test pattern
      const isTimestampedTest = /\d{10,}/.test(org.name) || /Acme Corp \d+/.test(org.name) || /Beta Labs \d+/.test(org.name) || /Org [AB] \d+/.test(org.name) || /Test Organization \d+/.test(org.name);
      
      if (isTimestampedTest) {
        testOrgIds.push(org);
      } else {
        realOrgIds.push(org);
      }

      console.log(`[${isTimestampedTest ? 'TEST' : 'REAL'}] ID: ${org._id} | Name: "${org.name}" | Status: ${org.status} | Plan: ${org.subscription?.plan} | Members: ${mCount} | Channels: ${chCount} | Msgs: ${msgCount} | Created: ${org.createdAt?.toISOString()}`);
    }

    // All Users
    const allUsers = await User.find({}).lean();
    console.log(`\n=== ALL USERS (${allUsers.length} Total) ===`);
    const testUserIds = [];
    const realUserIds = [];

    for (const u of allUsers) {
      const memberships = await Membership.find({ user: u._id }).populate('organization', 'name').lean();
      const orgNames = memberships.map(m => m.organization?.name || 'UnknownOrg').join(', ');
      
      // Check if synthetic test user (email has timestamps, example.com with timestamp, test.com with timestamp)
      const isTimestampedTestUser = /_\d{10,}@/.test(u.email) || u.email.endsWith('@example.com') && /user\d+_\d+/.test(u.email);

      if (u.role === 'super_admin') {
        console.log(`[SUPER ADMIN] ID: ${u._id} | Name: "${u.name}" | Email: "${u.email}" | Role: ${u.role}`);
      } else if (isTimestampedTestUser) {
        testUserIds.push(u);
        console.log(`[TEST USER]   ID: ${u._id} | Name: "${u.name}" | Email: "${u.email}" | Orgs: [${orgNames}]`);
      } else {
        realUserIds.push(u);
        console.log(`[REAL USER]   ID: ${u._id} | Name: "${u.name}" | Email: "${u.email}" | Role: ${u.role} | Orgs: [${orgNames}]`);
      }
    }

    console.log(`\nSummary:`);
    console.log(`  Real Orgs: ${realOrgIds.length} | Test Orgs: ${testOrgIds.length}`);
    console.log(`  Real Users: ${realUserIds.length + 1} (including Super Admin) | Test Users: ${testUserIds.length}`);

  } catch (err) {
    console.error('Audit error:', err);
  } finally {
    await mongoose.disconnect();
  }
}

detailedAudit();
