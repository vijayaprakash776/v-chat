const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const Organization = require('./models/Organization');
const Membership = require('./models/Membership');
const JoinRequest = require('./models/JoinRequest');
const Channel = require('./models/Channel');
const User = require('./models/User');

async function cleanTestData() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/flock_clone');
  console.log('Connected to MongoDB.');

  // Find synthetic test orgs created during automated test runs
  const testOrgs = await Organization.find({
    $or: [
      { name: { $regex: /^Comp (Alpha|Beta)/i } },
      { name: { $regex: /^FlockCorp \d+/i } }
    ]
  });

  const testOrgIds = testOrgs.map(o => o._id);
  console.log(`Found ${testOrgs.length} synthetic test companies to remove:`, testOrgs.map(o => o.name));

  if (testOrgIds.length > 0) {
    const deletedChannels = await Channel.deleteMany({ organization: { $in: testOrgIds } });
    const deletedMemberships = await Membership.deleteMany({ organization: { $in: testOrgIds } });
    const deletedJoinRequests = await JoinRequest.deleteMany({ organization: { $in: testOrgIds } });
    const deletedOrgs = await Organization.deleteMany({ _id: { $in: testOrgIds } });

    console.log(`Deleted associated data:
- Channels: ${deletedChannels.deletedCount}
- Memberships: ${deletedMemberships.deletedCount}
- Join Requests: ${deletedJoinRequests.deletedCount}
- Organizations: ${deletedOrgs.deletedCount}`);
  }

  // Also remove test synthetic users (@test.com)
  const deletedTestUsers = await User.deleteMany({ email: { $regex: /@test\.com$/i } });
  console.log(`Deleted ${deletedTestUsers.deletedCount} synthetic test users (@test.com).`);

  // Verify remaining valid companies
  const remainingOrgs = await Organization.find({}).lean();
  console.log(`\nRemaining Valid Companies (${remainingOrgs.length}):`);
  remainingOrgs.forEach(o => console.log(`- ${o.name} (ID: ${o._id})`));

  await mongoose.disconnect();
}

cleanTestData().catch(console.error);
