require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');

const Organization = require('./models/Organization');
const Membership = require('./models/Membership');
const Channel = require('./models/Channel');
const Conversation = require('./models/Conversation');
const Message = require('./models/Message');
const Todo = require('./models/Todo');
const Notification = require('./models/Notification');
const User = require('./models/User');

const migrate = async () => {
  try {
    console.log('Starting Migration Script for Multi-Company Isolation...');
    await connectDB();

    // 1. Ensure at least one default organization exists
    let defaultOrg = await Organization.findOne({});
    if (!defaultOrg) {
      const adminUser = (await User.findOne({ role: 'admin' })) || (await User.findOne({}));
      if (!adminUser) {
        console.log('No users found in database. Nothing to migrate.');
        process.exit(0);
      }
      defaultOrg = await Organization.create({
        name: 'Default Workspace',
        description: 'Primary workspace created by migration script',
        createdBy: adminUser._id,
      });
      console.log(`✓ Created default organization: "${defaultOrg.name}" (${defaultOrg._id})`);
    } else {
      console.log(`✓ Using existing organization: "${defaultOrg.name}" (${defaultOrg._id})`);
    }

    // 2. Ensure all users have at least one active Membership and currentOrganization set
    const allUsers = await User.find({});
    for (const u of allUsers) {
      let activeMem = await Membership.findOne({ user: u._id, status: 'active' });
      if (!activeMem) {
        activeMem = await Membership.create({
          user: u._id,
          organization: defaultOrg._id,
          role: u.role === 'admin' ? 'admin' : 'member',
          status: 'active',
        });
        console.log(`✓ Created membership for user ${u.email} in ${defaultOrg.name}`);
      }
      if (!u.currentOrganization) {
        u.currentOrganization = activeMem.organization;
        await u.save();
        console.log(`✓ Set currentOrganization for ${u.email}`);
      }
    }

    // 3. Migrate Channels missing organization
    const unassignedChannels = await Channel.find({ organization: { $exists: false } });
    if (unassignedChannels.length > 0) {
      for (const ch of unassignedChannels) {
        try {
          let targetOrgId = defaultOrg._id;
          const creatorMembership = await Membership.findOne({ user: ch.createdBy, status: 'active' });
          if (creatorMembership) targetOrgId = creatorMembership.organization;
          ch.organization = targetOrgId;
          await ch.save();
        } catch (chErr) {
          console.warn(`Skipping duplicate or invalid channel ${ch.name}:`, chErr.message);
          await Channel.deleteOne({ _id: ch._id });
        }
      }
      console.log(`✓ Migrated channels to their respective organizations`);
    }

    // 4. Migrate Conversations missing organization
    const unassignedConvs = await Conversation.find({ organization: { $exists: false } });
    if (unassignedConvs.length > 0) {
      for (const conv of unassignedConvs) {
        try {
          let targetOrgId = defaultOrg._id;
          if (conv.participants && conv.participants.length > 0) {
            const participantMem = await Membership.findOne({ user: conv.participants[0], status: 'active' });
            if (participantMem) targetOrgId = participantMem.organization;
          }
          conv.organization = targetOrgId;
          await conv.save();
        } catch (convErr) {
          console.warn(`Skipping invalid conversation:`, convErr.message);
        }
      }
      console.log(`✓ Migrated conversations to their respective organizations`);
    }

    // 5. Migrate Messages missing organization
    const unassignedMsgs = await Message.find({ organization: { $exists: false } });
    if (unassignedMsgs.length > 0) {
      for (const msg of unassignedMsgs) {
        try {
          let targetOrgId = defaultOrg._id;
          if (msg.channelId) {
            const ch = await Channel.findById(msg.channelId);
            if (ch && ch.organization) targetOrgId = ch.organization;
          } else if (msg.conversationId) {
            const conv = await Conversation.findById(msg.conversationId);
            if (conv && conv.organization) targetOrgId = conv.organization;
          } else if (msg.sender) {
            const senderMem = await Membership.findOne({ user: msg.sender, status: 'active' });
            if (senderMem) targetOrgId = senderMem.organization;
          }
          msg.organization = targetOrgId;
          await msg.save();
        } catch (msgErr) {
          console.warn(`Skipping message migration error:`, msgErr.message);
        }
      }
      console.log(`✓ Migrated messages to their respective organizations`);
    }

    // 6. Migrate Todos missing organization
    const unassignedTodos = await Todo.find({ organization: { $exists: false } });
    if (unassignedTodos.length > 0) {
      for (const td of unassignedTodos) {
        try {
          let targetOrgId = defaultOrg._id;
          const creatorMem = await Membership.findOne({ user: td.createdBy, status: 'active' });
          if (creatorMem) targetOrgId = creatorMem.organization;
          td.organization = targetOrgId;
          await td.save();
        } catch (tdErr) {
          console.warn(`Skipping todo migration error:`, tdErr.message);
        }
      }
      console.log(`✓ Migrated todos to their respective organizations`);
    }

    // 7. Migrate Notifications missing organization
    const unassignedNotifs = await Notification.find({ organization: { $exists: false } });
    if (unassignedNotifs.length > 0) {
      for (const n of unassignedNotifs) {
        try {
          let targetOrgId = defaultOrg._id;
          const recipMem = await Membership.findOne({ user: n.recipient, status: 'active' });
          if (recipMem) targetOrgId = recipMem.organization;
          n.organization = targetOrgId;
          await n.save();
        } catch (nErr) {
          console.warn(`Skipping notification migration error:`, nErr.message);
        }
      }
      console.log(`✓ Migrated notifications to their respective organizations`);
    }

    console.log('✅ Multi-Company Data Migration Completed Successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration Error:', err);
    process.exit(1);
  }
};

migrate();
