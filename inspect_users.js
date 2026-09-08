const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const User = require('./models/User');
const Membership = require('./models/Membership');

async function inspectUsers() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/flock_clone');
  
  const testUsers = await User.find({
    $or: [
      { email: { $regex: /@test\.com$/i } },
      { name: { $regex: /\d{10,}/ } }
    ]
  }).lean();
  
  console.log(`Found ${testUsers.length} synthetic test/e2e users (e.g. admina_1787986428759@test.com)`);
  
  const realUsers = await User.find({
    email: { $not: { $regex: /@test\.com$/i } },
    name: { $not: { $regex: /\d{10,}/ } }
  }).lean();
  
  console.log(`Found ${realUsers.length} standard/real registered users:`);
  realUsers.forEach(u => console.log(`- ${u.name} (${u.email}) [Role: ${u.role}]`));
  
  await mongoose.disconnect();
}

inspectUsers().catch(console.error);
