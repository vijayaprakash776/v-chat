const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/flock_clone').then(async () => {
  const User = require('./models/User');
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(process.env.SUPER_ADMIN_PASSWORD, salt);
  
  await User.updateOne(
    { email: 'superadmin@villzone.io' }, 
    { password: hash }
  );
  
  console.log('Password updated to match .env');
  mongoose.disconnect();
}).catch(console.error);
