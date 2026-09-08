const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const Organization = require('./models/Organization');
const Membership = require('./models/Membership');
const JoinRequest = require('./models/JoinRequest');

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function testSearchLogic(query) {
  const trimmed = query ? query.trim() : '';
  if (!trimmed) {
    return [];
  }
  const exactRegex = new RegExp(`^${escapeRegex(trimmed)}$`, 'i');
  return await Organization.find({ name: exactRegex }).lean();
}

async function runTests() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/flock_clone');
  console.log('Connected to MongoDB.\n');

  console.log('Test 1: Empty search query ->');
  const emptyRes = await testSearchLogic('');
  console.log(`Results count: ${emptyRes.length} (Expected: 0) -> ${emptyRes.length === 0 ? '✓ PASS' : '❌ FAIL'}`);

  console.log('\nTest 2: Search "Tech" (partial prefix) ->');
  const techRes = await testSearchLogic('Tech');
  console.log(`Results count: ${techRes.length} (Expected: 0) -> ${techRes.length === 0 ? '✓ PASS' : '❌ FAIL'}`);

  console.log('\nTest 3: Search "Tech world" (exact case match) ->');
  const techWorldRes = await testSearchLogic('Tech world');
  console.log(`Results: ${techWorldRes.map(o => o.name).join(', ')} (Expected: "Tech world") -> ${techWorldRes.length === 1 && techWorldRes[0].name === 'Tech world' ? '✓ PASS' : '❌ FAIL'}`);

  console.log('\nTest 4: Search "   tech WORLD   " (case-insensitive + trimmed) ->');
  const techWorldCaseRes = await testSearchLogic('   tech WORLD   ');
  console.log(`Results: ${techWorldCaseRes.map(o => o.name).join(', ')} (Expected: "Tech world") -> ${techWorldCaseRes.length === 1 && techWorldCaseRes[0].name === 'Tech world' ? '✓ PASS' : '❌ FAIL'}`);

  console.log('\nTest 5: Search "ABC Technologies" ->');
  const abcRes = await testSearchLogic('abc technologies');
  console.log(`Results: ${abcRes.map(o => o.name).join(', ')} (Matches registered "ABC Technologies" and "Abc technologies") -> count: ${abcRes.length}`);

  console.log('\nTest 6: Search "NonExistentCompanyXYZ" ->');
  const nonRes = await testSearchLogic('NonExistentCompanyXYZ');
  console.log(`Results count: ${nonRes.length} (Expected: 0) -> ${nonRes.length === 0 ? '✓ PASS' : '❌ FAIL'}`);

  await mongoose.disconnect();
}

runTests().catch(console.error);
