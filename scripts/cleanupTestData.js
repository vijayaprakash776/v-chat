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

async function runCleanup() {
  const isDryRun = !process.argv.includes('--confirm');
  const mongoUri = process.env.MONGO_URI;

  if (!mongoUri) {
    console.error('❌ MONGO_URI missing from backend/.env');
    process.exit(1);
  }

  try {
    await mongoose.connect(mongoUri);
    const db = mongoose.connection.db;

    console.log('========================================================================');
    console.log(`🛡️  MONGODB TEST DATA CLEANUP — ${isDryRun ? 'DRY RUN MODE (NO DELETIONS)' : 'CONFIRMED DELETION MODE'}`);
    console.log('========================================================================');
    console.log(`Database Name: ${mongoose.connection.name}`);
    console.log(`Execution Mode: ${isDryRun ? 'DRY RUN (Simulated)' : 'CONFIRMED (Permanent Deletion)'}`);
    console.log('------------------------------------------------------------------------\n');

    // 1. Initial collection counts
    const collections = await db.listCollections().toArray();
    console.log('📦 CURRENT DOCUMENT COUNTS:');
    const initialCounts = {};
    for (const col of collections) {
      const count = await db.collection(col.name).countDocuments();
      initialCounts[col.name] = count;
      console.log(`  - ${col.name.padEnd(20)} : ${count} documents`);
    }

    // 2. Identify Test Organizations vs Real Organizations
    const allOrgs = await Organization.find({}).lean();
    const testOrgs = [];
    const realOrgs = [];

    for (const org of allOrgs) {
      // Test organizations have synthetic timestamp patterns created by test scripts
      const isTestOrg = (
        /\d{10,}/.test(org.name) ||
        /^Acme Corp \d+$/i.test(org.name) ||
        /^Beta Labs \d+$/i.test(org.name) ||
        /^Org [AB] \d+$/i.test(org.name) ||
        /^Test Org(anization)? \d+$/i.test(org.name)
      );

      if (isTestOrg) {
        testOrgs.push(org);
      } else {
        realOrgs.push(org);
      }
    }

    const testOrgIds = testOrgs.map(o => o._id);

    console.log('\n🏢 TEST ORGANIZATIONS IDENTIFIED FOR CLEANUP:');
    if (testOrgs.length === 0) {
      console.log('  None found.');
    } else {
      testOrgs.forEach((o, idx) => {
        console.log(`  ${idx + 1}. "${o.name}" (ID: ${o._id}, Status: ${o.status})`);
      });
    }

    console.log('\n🏢 REAL ORGANIZATIONS TO PRESERVE:');
    realOrgs.forEach((o, idx) => {
      console.log(`  ${idx + 1}. "${o.name}" (ID: ${o._id}, Status: ${o.status}, Plan: ${o.subscription?.plan || 'none'})`);
    });

    // 3. Identify Test Users vs Real Users
    const allUsers = await User.find({}).lean();
    const testUsers = [];
    const realUsers = [];

    for (const user of allUsers) {
      // CRITICAL RULE 9: Super Admin must NEVER be deleted
      if (user.role === 'super_admin') {
        realUsers.push(user);
        continue;
      }

      // Check if synthetic test user
      const isTestUser = (
        /_\d{10,}@/.test(user.email) ||
        (user.email.endsWith('@example.com') && /user\d+_\d+/.test(user.email)) ||
        /^admin_[ab]_\d+@test\.com$/.test(user.email) ||
        /^employee_\d+@test\.com$/.test(user.email) ||
        /^attacker_\d+@test\.com$/.test(user.email) ||
        /^user\d+_\d+@example\.com$/.test(user.email) ||
        /^(alice|bob|carol|temp)_\d+@/.test(user.email)
      );

      if (isTestUser) {
        testUsers.push(user);
      } else {
        realUsers.push(user);
      }
    }

    const testUserIds = testUsers.map(u => u._id);

    console.log(`\n👥 TEST USERS IDENTIFIED FOR CLEANUP (${testUsers.length} total):`);
    testUsers.forEach((u, idx) => {
      console.log(`  ${idx + 1}. ${u.name} <${u.email}> (ID: ${u._id})`);
    });

    console.log(`\n👥 REAL USERS TO PRESERVE (${realUsers.length} total):`);
    realUsers.forEach((u, idx) => {
      console.log(`  ${idx + 1}. ${u.name} <${u.email}> [Role: ${u.role}] (ID: ${u._id})`);
    });

    // 4. Identify Test Channels
    // Channels belonging to test orgs OR test channels with timestamp names
    const allChannels = await Channel.find({}).lean();
    const testChannels = [];
    const realChannels = [];

    for (const ch of allChannels) {
      const isOrgTest = testOrgIds.some(id => id.toString() === ch.organization?.toString());
      const isTimestampedCh = /channel-test-\d{10,}/.test(ch.name) || /announcements-[ab]-\d{10,}/.test(ch.name) || /secret-[ab]-\d{10,}/.test(ch.name);

      if (isOrgTest || isTimestampedCh) {
        testChannels.push(ch);
      } else {
        realChannels.push(ch);
      }
    }

    const testChannelIds = testChannels.map(c => c._id);

    console.log(`\n📢 TEST CHANNELS IDENTIFIED FOR CLEANUP (${testChannels.length} total):`);
    testChannels.forEach((c, idx) => {
      console.log(`  ${idx + 1}. #${c.name} (ID: ${c._id})`);
    });

    console.log(`\n📢 REAL CHANNELS TO PRESERVE (${realChannels.length} total):`);
    realChannels.forEach((c, idx) => {
      console.log(`  ${idx + 1}. #${c.name} (ID: ${c._id})`);
    });

    // 5. Related Test Records
    // Memberships
    const testMemberships = await Membership.find({
      $or: [
        { organization: { $in: testOrgIds } },
        { user: { $in: testUserIds } },
      ],
    }).lean();

    // Messages
    const testMessages = await Message.find({
      $or: [
        { organization: { $in: testOrgIds } },
        { channel: { $in: testChannelIds } },
        { sender: { $in: testUserIds } },
      ],
    }).lean();

    // Conversations
    const testConversations = await Conversation.find({
      $or: [
        { organization: { $in: testOrgIds } },
        { participants: { $in: testUserIds } },
      ],
    }).lean();

    // Notifications
    const testNotifications = await Notification.find({
      $or: [
        { organization: { $in: testOrgIds } },
        { recipient: { $in: testUserIds } },
        { sender: { $in: testUserIds } },
      ],
    }).lean();

    // Todos
    const testTodos = await Todo.find({
      $or: [
        { organization: { $in: testOrgIds } },
        { createdBy: { $in: testUserIds } },
        { assignedTo: { $in: testUserIds } },
      ],
    }).lean();

    // Invitations
    const testInvitations = await Invitation.find({
      $or: [
        { organization: { $in: testOrgIds } },
        { invitedBy: { $in: testUserIds } },
      ],
    }).lean();

    // JoinRequests
    const testJoinRequests = await JoinRequest.find({
      $or: [
        { organization: { $in: testOrgIds } },
        { user: { $in: testUserIds } },
      ],
    }).lean();

    // AuditLogs
    const testAuditLogs = await AuditLog.find({
      $or: [
        { organization: { $in: testOrgIds } },
        { performedBy: { $in: testUserIds } },
      ],
    }).lean();

    // Pinned & Saved Messages
    const testPinned = await PinnedMessage.find({
      $or: [
        { messageId: { $in: testMessages.map(m => m._id) } },
        { pinnedBy: { $in: testUserIds } },
      ],
    }).lean();

    const testSaved = await SavedMessage.find({
      $or: [
        { messageId: { $in: testMessages.map(m => m._id) } },
        { user: { $in: testUserIds } },
      ],
    }).lean();

    console.log('\n========================================================================');
    console.log('📊 CLEANUP IMPACT SUMMARY:');
    console.log('========================================================================');
    console.log(`  Organizations to Delete  : ${testOrgs.length}`);
    console.log(`  Users to Delete          : ${testUsers.length}`);
    console.log(`  Channels to Delete       : ${testChannels.length}`);
    console.log(`  Memberships to Delete    : ${testMemberships.length}`);
    console.log(`  Messages to Delete       : ${testMessages.length}`);
    console.log(`  Conversations to Delete  : ${testConversations.length}`);
    console.log(`  Notifications to Delete  : ${testNotifications.length}`);
    console.log(`  Todos to Delete          : ${testTodos.length}`);
    console.log(`  Invitations to Delete    : ${testInvitations.length}`);
    console.log(`  Join Requests to Delete  : ${testJoinRequests.length}`);
    console.log(`  Audit Logs to Delete     : ${testAuditLogs.length}`);
    console.log(`  Pinned Msgs to Delete    : ${testPinned.length}`);
    console.log(`  Saved Msgs to Delete     : ${testSaved.length}`);
    console.log('------------------------------------------------------------------------');
    console.log(`  REAL Organizations Kept  : ${realOrgs.length}`);
    console.log(`  REAL Users Kept          : ${realUsers.length} (including Super Admin)`);
    console.log(`  REAL Channels Kept       : ${realChannels.length}`);
    console.log('========================================================================\n');

    if (isDryRun) {
      console.log('🔒 DRY RUN COMPLETE. ZERO records were modified or deleted.');
      console.log('👉 To permanently execute this cleanup, run:');
      console.log('   node backend/scripts/cleanupTestData.js --confirm\n');
    } else {
      console.log('⚠️  EXECUTING PERMANENT DELETION OF TEST RECORDS...');

      if (testOrgs.length > 0) await Organization.deleteMany({ _id: { $in: testOrgIds } });
      if (testUsers.length > 0) await User.deleteMany({ _id: { $in: testUserIds } });
      if (testChannels.length > 0) await Channel.deleteMany({ _id: { $in: testChannelIds } });
      if (testMemberships.length > 0) await Membership.deleteMany({ _id: { $in: testMemberships.map(m => m._id) } });
      if (testMessages.length > 0) await Message.deleteMany({ _id: { $in: testMessages.map(m => m._id) } });
      if (testConversations.length > 0) await Conversation.deleteMany({ _id: { $in: testConversations.map(m => m._id) } });
      if (testNotifications.length > 0) await Notification.deleteMany({ _id: { $in: testNotifications.map(m => m._id) } });
      if (testTodos.length > 0) await Todo.deleteMany({ _id: { $in: testTodos.map(m => m._id) } });
      if (testInvitations.length > 0) await Invitation.deleteMany({ _id: { $in: testInvitations.map(m => m._id) } });
      if (testJoinRequests.length > 0) await JoinRequest.deleteMany({ _id: { $in: testJoinRequests.map(m => m._id) } });
      if (testAuditLogs.length > 0) await AuditLog.deleteMany({ _id: { $in: testAuditLogs.map(m => m._id) } });
      if (testPinned.length > 0) await PinnedMessage.deleteMany({ _id: { $in: testPinned.map(m => m._id) } });
      if (testSaved.length > 0) await SavedMessage.deleteMany({ _id: { $in: testSaved.map(m => m._id) } });

      console.log('✅ CLEANUP COMPLETED SUCCESSFULLY!\n');

      // Post-cleanup counts
      console.log('📦 POST-CLEANUP DOCUMENT COUNTS:');
      for (const col of collections) {
        const count = await db.collection(col.name).countDocuments();
        console.log(`  - ${col.name.padEnd(20)} : ${count} documents (was ${initialCounts[col.name]})`);
      }
    }

  } catch (err) {
    console.error('❌ Error during cleanup:', err);
  } finally {
    await mongoose.disconnect();
  }
}

runCleanup();
