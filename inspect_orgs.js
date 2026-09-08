const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const Organization = require('./models/Organization');
const Membership = require('./models/Membership');
const JoinRequest = require('./models/JoinRequest');
const Channel = require('./models/Channel');
const User = require('./models/User');

async function inspectOrganizations() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/flock_clone');
  console.log('MongoDB connected.');

  const orgs = await Organization.find({}).populate('createdBy', 'name email').lean();
  console.log(`\nFound ${orgs.length} total organizations:\n`);

  for (const org of orgs) {
    const memberCount = await Membership.countDocuments({ organization: org._id });
    const requestCount = await JoinRequest.countDocuments({ organization: org._id });
    const channelCount = await Channel.countDocuments({ organization: org._id });

    console.log(JSON.stringify({
      id: org._id,
      name: org.name,
      description: org.description,
      creator: org.createdBy ? `${org.createdBy.name} (${org.createdBy.email})` : 'Unknown',
      createdAt: org.createdAt,
      members: memberCount,
      joinRequests: requestCount,
      channels: channelCount,
    }, null, 2));
  }

  await mongoose.disconnect();
}

inspectOrganizations().catch(console.error);
