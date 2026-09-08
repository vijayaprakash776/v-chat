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

async function auditDatabase() {
  try {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
      console.error('MONGO_URI is missing from backend/.env');
      process.exit(1);
    }

    await mongoose.connect(mongoUri);
    const db = mongoose.connection.db;

    console.log('========================================================================');
    console.log('📊 MONGODB DATABASE AUDIT — EXISTING DATA INSPECTION');
    console.log('========================================================================');
    console.log(`Host / URL: ${mongoUri.replace(/:([^:@]+)@/, ':***@')}`);
    console.log(`Database Name: ${mongoose.connection.name}`);
    console.log('------------------------------------------------------------------------');

    // 1. Collection document counts
    const collections = await db.listCollections().toArray();
    console.log('\n📦 COLLECTION DOCUMENT COUNTS:');
    for (const col of collections) {
      const count = await db.collection(col.name).countDocuments();
      console.log(`  - ${col.name.padEnd(24)} : ${count} documents`);
    }

    // 2. Inspect All Organizations
    const orgs = await Organization.find({}).lean();
    console.log(`\n🏢 ALL ORGANIZATIONS (${orgs.length} total):`);
    for (const org of orgs) {
      const memberCount = await Membership.countDocuments({ organization: org._id });
      const channelCount = await Channel.countDocuments({ organization: org._id });
      const messageCount = await Message.countDocuments({ organization: org._id });
      const todoCount = await Todo.countDocuments({ organization: org._id });
      const convCount = await Conversation.countDocuments({ organization: org._id });
      console.log(`  ID: ${org._id} | Name: "${org.name}" | Status: ${org.status} | Plan: ${org.subscription?.plan || 'none'} | Members: ${memberCount} | Channels: ${channelCount} | Msgs: ${messageCount} | Convs: ${convCount} | Created: ${org.createdAt?.toISOString()}`);
    }

    // 3. Inspect All Users
    const users = await User.find({}).lean();
    console.log(`\n👥 ALL USERS (${users.length} total):`);
    for (const u of users) {
      const memberships = await Membership.find({ user: u._id }).populate('organization', 'name').lean();
      const orgNames = memberships.map(m => m.organization?.name || 'UnknownOrg').join(', ');
      console.log(`  ID: ${u._id} | Name: "${u.name}" | Email: "${u.email}" | Role: ${u.role} | Orgs: [${orgNames}] | Created: ${u.createdAt?.toISOString()}`);
    }

    // 4. Inspect Channels
    const channels = await Channel.find({}).populate('organization', 'name').lean();
    console.log(`\n📢 ALL CHANNELS (${channels.length} total):`);
    for (const ch of channels) {
      console.log(`  ID: ${ch._id} | Name: "#${ch.name}" | Org: "${ch.organization?.name}" | Type: ${ch.isPrivate ? 'private' : 'public'} | Members: ${ch.members?.length || 0}`);
    }

    // 5. Inspect Invitations and JoinRequests
    const invs = await Invitation.find({}).populate('organization', 'name').lean();
    console.log(`\n✉️ INVITATIONS (${invs.length} total):`);
    for (const inv of invs) {
      console.log(`  ID: ${inv._id} | Email: ${inv.email} | Org: "${inv.organization?.name}" | Status: ${inv.status}`);
    }

    const jrs = await JoinRequest.find({}).populate('organization', 'name').lean();
    console.log(`\n📩 JOIN REQUESTS (${jrs.length} total):`);
    for (const jr of jrs) {
      console.log(`  ID: ${jr._id} | User: ${jr.user || jr.userId} | Org: "${jr.organization?.name}" | Status: ${jr.status}`);
    }

    console.log('\n========================================================================\n');
  } catch (err) {
    console.error('Audit error:', err);
  } finally {
    await mongoose.disconnect();
  }
}

auditDatabase();
