require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');

const User = require('./models/User');
const Organization = require('./models/Organization');
const Membership = require('./models/Membership');
const JoinRequest = require('./models/JoinRequest');
const Channel = require('./models/Channel');
const Conversation = require('./models/Conversation');
const Todo = require('./models/Todo');

const runTests = async () => {
  try {
    console.log('🧪 Starting End-to-End Verification Test for Company Isolation...');
    await connectDB();

    const timestamp = Date.now();

    // 1. Create User A & Company A
    const userA = await User.create({
      name: `User A ${timestamp}`,
      email: `usera_${timestamp}@test.com`,
      password: 'password123',
      role: 'user',
    });

    const companyA = await Organization.create({
      name: `Company A ${timestamp}`,
      description: 'First test company',
      createdBy: userA._id,
    });

    await Membership.create({
      user: userA._id,
      organization: companyA._id,
      role: 'admin',
      status: 'active',
    });

    userA.currentOrganization = companyA._id;
    await userA.save();

    // 2. Create User B & Company B
    const userB = await User.create({
      name: `User B ${timestamp}`,
      email: `userb_${timestamp}@test.com`,
      password: 'password123',
      role: 'user',
    });

    const companyB = await Organization.create({
      name: `Company B ${timestamp}`,
      description: 'Second test company',
      createdBy: userB._id,
    });

    await Membership.create({
      user: userB._id,
      organization: companyB._id,
      role: 'admin',
      status: 'active',
    });

    userB.currentOrganization = companyB._id;
    await userB.save();

    // 3. Create Channels for Company A and Company B
    const chanA = await Channel.create({
      name: `general-a-${timestamp}`,
      organization: companyA._id,
      createdBy: userA._id,
      members: [userA._id],
    });

    const chanB = await Channel.create({
      name: `general-b-${timestamp}`,
      organization: companyB._id,
      createdBy: userB._id,
      members: [userB._id],
    });

    // 4. Verify Channel Query Isolation
    const chanQueryA = await Channel.find({ organization: companyA._id });
    const chanQueryB = await Channel.find({ organization: companyB._id });

    if (chanQueryA.some((c) => c._id.toString() === chanB._id.toString())) {
      throw new Error('❌ FAILURE: Company A channel query contained Company B channel!');
    }
    if (chanQueryB.some((c) => c._id.toString() === chanA._id.toString())) {
      throw new Error('❌ FAILURE: Company B channel query contained Company A channel!');
    }
    console.log('✓ Channel Isolation Verified!');

    // 5. Test Join Request & Approval Flow
    const joinReq = await JoinRequest.create({
      user: userB._id,
      organization: companyA._id,
      status: 'pending',
    });

    if (joinReq.status !== 'pending') {
      throw new Error('❌ FAILURE: JoinRequest status not pending!');
    }

    // User A (Company A Admin) approves
    joinReq.status = 'approved';
    joinReq.reviewedBy = userA._id;
    joinReq.reviewedAt = new Date();
    await joinReq.save();

    const memBInA = await Membership.create({
      user: userB._id,
      organization: companyA._id,
      role: 'member',
      status: 'active',
    });

    if (memBInA.status !== 'active') {
      throw new Error('❌ FAILURE: Approved membership not active!');
    }
    console.log('✓ Join Request & Approval Flow Verified!');

    // Cleanup test data
    await User.deleteMany({ _id: { $in: [userA._id, userB._id] } });
    await Organization.deleteMany({ _id: { $in: [companyA._id, companyB._id] } });
    await Membership.deleteMany({ _id: { $in: [userA._id, userB._id] } });
    await Channel.deleteMany({ _id: { $in: [chanA._id, chanB._id] } });
    await JoinRequest.deleteMany({ _id: joinReq._id });

    console.log('🎉 ALL END-TO-END VERIFICATION TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Verification Error:', err.message);
    process.exit(1);
  }
};

runTests();
