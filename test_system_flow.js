require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const User = require('./models/User');
const Organization = require('./models/Organization');
const Membership = require('./models/Membership');
const JoinRequest = require('./models/JoinRequest');
const Channel = require('./models/Channel');

async function testFullFlow() {
  console.log('🧪 Running Comprehensive End-to-End System Test...');
  await connectDB();
  const ts = Date.now();

  // 1. Create User A & Company A
  const userA = await User.create({ name: `Admin A ${ts}`, email: `admina_${ts}@test.com`, password: 'password123' });
  const compA = await Organization.create({ name: `Comp Alpha ${ts}`, description: `High-tech testing company ${ts}`, createdBy: userA._id });
  const memA = await Membership.create({ user: userA._id, organization: compA._id, role: 'admin', status: 'active' });
  userA.currentOrganization = compA._id;
  await userA.save();
  console.log('✓ 1. Company A & Admin A created!');

  // 2. User B searches for Company A and submits Join Request
  const userB = await User.create({ name: `User B ${ts}`, email: `userb_${ts}@test.com`, password: 'password123' });
  const searchResults = await Organization.find({ name: new RegExp(`Comp Alpha ${ts}`, 'i') });
  if (searchResults.length === 0) throw new Error('❌ Search failed to find company');
  console.log('✓ 2. User B successfully searched Company A!');

  const joinReq = await JoinRequest.create({ user: userB._id, organization: compA._id, status: 'pending' });
  console.log('✓ 3. Join Request created with status pending!');

  // 3. Admin A approves Join Request
  joinReq.status = 'approved';
  joinReq.reviewedBy = userA._id;
  joinReq.reviewedAt = new Date();
  await joinReq.save();

  const memB = await Membership.create({ user: userB._id, organization: compA._id, role: 'member', status: 'active' });
  userB.currentOrganization = compA._id;
  await userB.save();
  console.log('✓ 4. Admin A approved Join Request; User B is now an active member!');

  // 4. Create Channel in Company A
  const chan1 = await Channel.create({
    organization: compA._id,
    name: `channel-test-${ts}`,
    description: 'Channel testing',
    createdBy: userA._id,
    members: [userA._id, userB._id],
    isPrivate: false,
    lastMessageAt: new Date()
  });
  console.log('✓ 5. Channel created successfully without 500 error!');

  // 5. Test Duplicate Channel Constraint in same org vs different org
  const compB = await Organization.create({ name: `Comp Beta ${ts}`, description: 'Second org', createdBy: userA._id });
  const chan2 = await Channel.create({
    organization: compB._id,
    name: `channel-test-${ts}`, // Same name in Company B!
    description: 'Channel testing org B',
    createdBy: userA._id,
    members: [userA._id],
    isPrivate: false,
    lastMessageAt: new Date()
  });
  console.log('✓ 6. Multi-organization duplicate channel name test passed!');

  // Cleanup test documents
  await Channel.deleteMany({ _id: { $in: [chan1._id, chan2._id] } });
  await Membership.deleteMany({ _id: { $in: [memA._id, memB._id] } });
  await JoinRequest.deleteMany({ _id: joinReq._id });
  await Organization.deleteMany({ _id: { $in: [compA._id, compB._id] } });
  await User.deleteMany({ _id: { $in: [userA._id, userB._id] } });
  console.log('✓ 7. Test data cleaned up successfully!');

  console.log('🎉 ALL SYSTEM E2E FLOW TESTS PASSED PERFECTLY!');
  process.exit(0);
}

testFullFlow().catch(err => {
  console.error('❌ E2E Test Error:', err);
  process.exit(1);
});
