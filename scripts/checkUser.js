const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/flock_clone').then(async () => {
  const User = require('./models/User');
  const user = await User.findOne({ email: 'superadmin@villzone.io' });
  console.log(user ? `User exists! Role: ${user.role}` : 'USER NOT FOUND!');
  mongoose.disconnect();
}).catch(console.error);
