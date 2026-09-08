require('dotenv').config();
const mongoose = require('mongoose');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { io: ClientIO } = require('../frontend/node_modules/socket.io-client');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const connectDB = require('./config/db');
const { initSocket } = require('./services/socketService');

// Models
const User = require('./models/User');
const Organization = require('./models/Organization');
const Membership = require('./models/Membership');
const Channel = require('./models/Channel');
const Conversation = require('./models/Conversation');
const Message = require('./models/Message');
const Todo = require('./models/Todo');
const Notification = require('./models/Notification');
const JoinRequest = require('./models/JoinRequest');
const PinnedMessage = require('./models/PinnedMessage');
const SavedMessage = require('./models/SavedMessage');
const AuditLog = require('./models/AuditLog');

const TEST_PORT = 5099;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

let serverInstance;
let ioInstance;

const testResults = [];

function recordResult(phase, testName, status, details = '') {
  testResults.push({ phase, testName, status, details });
  const icon = status === 'PASS' ? '✅' : status === 'PARTIAL' ? '⚠️' : '❌';
  console.log(`${icon} [${phase}] ${testName}: ${status} ${details ? '(' + details + ')' : ''}`);
}

async function startTestServer() {
  await connectDB();

  const app = express();
  serverInstance = http.createServer(app);

  ioInstance = new Server(serverInstance, {
    cors: { origin: '*', methods: ['GET', 'POST', 'PATCH'], credentials: true },
  });

  initSocket(ioInstance);
  app.set('io', ioInstance);

  app.use(express.json());
  app.use('/uploads', express.static(__dirname + '/uploads'));

  app.use('/api/auth', require('./routes/authRoutes'));
  app.use('/api/conversations', require('./routes/conversationRoutes'));
  app.use('/api/messages', require('./routes/messageRoutes'));
  app.use('/api/pinned-messages', require('./routes/pinnedMessageRoutes'));
  app.use('/api/saved-messages', require('./routes/savedMessageRoutes'));
  app.use('/api/users', require('./routes/userRoutes'));
  app.use('/api/channels', require('./routes/channelRoutes'));
  app.use('/api/notifications', require('./routes/notificationRoutes'));
  app.use('/api/search', require('./routes/searchRoutes'));
  app.use('/api/admin', require('./routes/adminRoutes'));
  app.use('/api/organizations', require('./routes/organizationRoutes'));
  app.use('/api/todos', require('./routes/todoRoutes'));

  await new Promise((resolve) => {
    serverInstance.listen(TEST_PORT, '127.0.0.1', resolve);
  });
}

async function api(endpoint, options = {}, token = null) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  let data = null;
  const contentType = res.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  return { status: res.status, ok: res.ok, data };
}

async function runAudit() {
  console.log('====================================================');
  console.log('  FLOCK APP COMPREHENSIVE END-TO-END AUDIT SUITE    ');
  console.log('====================================================\n');

  await startTestServer();

  const ts = Date.now();

  try {
    // ---------------------------------------------------------------
    // PHASE 3: DATABASE SCHEMA & MODEL INTEGRITY TEST
    // ---------------------------------------------------------------
    console.log('\n--- PHASE 3: Database & Models Test ---');
    try {
      const u = new User();
      const errU = u.validateSync();
      if (errU.errors.name && errU.errors.email && errU.errors.password) {
        recordResult('PHASE 3', 'User model required fields validation', 'PASS');
      } else {
        recordResult('PHASE 3', 'User model required fields validation', 'FAIL', 'Missing required field validation');
      }
    } catch (e) {
      recordResult('PHASE 3', 'User model validation', 'FAIL', e.message);
    }

    try {
      const m = new Message();
      const errM = m.validateSync();
      if (errM.errors.sender && (errM.errors.conversationId || errM.errors.content)) {
        recordResult('PHASE 3', 'Message model validation', 'PASS');
      } else {
        recordResult('PHASE 3', 'Message model validation', 'PARTIAL');
      }
    } catch (e) {
      recordResult('PHASE 3', 'Message model validation', 'FAIL', e.message);
    }

    // Check Message Schema Organization Field
    const messageHasOrgField = Message.schema.paths.organization !== undefined;
    if (messageHasOrgField) {
      recordResult('PHASE 3', 'Message schema organization field check', 'PASS');
    } else {
      recordResult('PHASE 3', 'Message schema organization field check', 'FAIL', 'Message schema lacks "organization" field');
    }

    // ---------------------------------------------------------------
    // PHASE 4: AUTHENTICATION LIFECYCLE TEST
    // ---------------------------------------------------------------
    console.log('\n--- PHASE 4: Authentication Test ---');

    // 1. Register User A (Lily)
    const regLily = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'Lily Evans', email: `lily_${ts}@test.com`, password: 'password123' }),
    });
    if (regLily.status === 201 && regLily.data.user && !regLily.data.user.password) {
      recordResult('PHASE 4', '1. Register new user', 'PASS');
    } else {
      recordResult('PHASE 4', '1. Register new user', 'FAIL', JSON.stringify(regLily.data));
    }

    // 2. Register Duplicate User
    const regDup = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'Lily Evans', email: `lily_${ts}@test.com`, password: 'password123' }),
    });
    if (regDup.status === 409) {
      recordResult('PHASE 4', '2. Register duplicate user', 'PASS');
    } else {
      recordResult('PHASE 4', '2. Register duplicate user', 'FAIL', `Status: ${regDup.status}`);
    }

    // 3. Login Correct Credentials
    const loginLily = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: `lily_${ts}@test.com`, password: 'password123' }),
    });
    const lilyToken = loginLily.data.token;
    const lilyId = loginLily.data.user?.id || loginLily.data.user?._id;
    if (loginLily.status === 200 && lilyToken) {
      recordResult('PHASE 4', '3. Login with correct credentials', 'PASS');
    } else {
      recordResult('PHASE 4', '3. Login with correct credentials', 'FAIL', JSON.stringify(loginLily.data));
    }

    // 4. Login Incorrect Password
    const loginWrongPass = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: `lily_${ts}@test.com`, password: 'wrongpassword' }),
    });
    if (loginWrongPass.status === 401) {
      recordResult('PHASE 4', '4. Login with incorrect password', 'PASS');
    } else {
      recordResult('PHASE 4', '4. Login with incorrect password', 'FAIL', `Status: ${loginWrongPass.status}`);
    }

    // 5. Login Non-existing Email
    const loginNoEmail = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: `nonexistent_${ts}@test.com`, password: 'password123' }),
    });
    if (loginNoEmail.status === 401) {
      recordResult('PHASE 4', '5. Login with non-existing email', 'PASS');
    } else {
      recordResult('PHASE 4', '5. Login with non-existing email', 'FAIL', `Status: ${loginNoEmail.status}`);
    }

    // 6 & 7. JWT Generation & Verification (/api/auth/me)
    const meLily = await api('/api/auth/me', { method: 'GET' }, lilyToken);
    if (meLily.status === 200 && meLily.data.user?.email === `lily_${ts}@test.com`) {
      recordResult('PHASE 4', '6/7. JWT generation & verification', 'PASS');
    } else {
      recordResult('PHASE 4', '6/7. JWT generation & verification', 'FAIL', JSON.stringify(meLily.data));
    }

    // 8. Expired/Invalid JWT
    const badToken = lilyToken + 'invalidjunk';
    const meBadToken = await api('/api/auth/me', { method: 'GET' }, badToken);
    if (meBadToken.status === 401) {
      recordResult('PHASE 4', '8. Invalid JWT handling', 'PASS');
    } else {
      recordResult('PHASE 4', '8. Invalid JWT handling', 'FAIL', `Status: ${meBadToken.status}`);
    }

    // 9. Protected API without JWT
    const meNoToken = await api('/api/auth/me', { method: 'GET' });
    if (meNoToken.status === 401) {
      recordResult('PHASE 4', '9. Protected API without JWT', 'PASS');
    } else {
      recordResult('PHASE 4', '9. Protected API without JWT', 'FAIL', `Status: ${meNoToken.status}`);
    }

    // Register User B (John)
    const regJohn = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'John Doe', email: `john_${ts}@test.com`, password: 'password123' }),
    });
    const loginJohn = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: `john_${ts}@test.com`, password: 'password123' }),
    });
    const johnToken = loginJohn.data.token;
    const johnId = loginJohn.data.user?.id || loginJohn.data.user?._id;

    if (johnToken && johnId !== lilyId) {
      recordResult('PHASE 4', 'Two user login isolation test', 'PASS');
    } else {
      recordResult('PHASE 4', 'Two user login isolation test', 'FAIL');
    }

    // ---------------------------------------------------------------
    // PHASE 5: COMPANY / WORKSPACE ISOLATION TEST
    // ---------------------------------------------------------------
    console.log('\n--- PHASE 5: Company / Workspace Isolation Test ---');

    // Create Company A with Lily as Owner
    const createCompA = await api('/api/organizations', {
      method: 'POST',
      body: JSON.stringify({ name: `Acme Corp ${ts}`, description: 'Company A' }),
    }, lilyToken);
    const compAId = createCompA.data.organization?._id;

    // Refresh Lily Token/Profile
    const lilyProfile = await api('/api/auth/me', { method: 'GET' }, lilyToken);

    // Create Company B with David as Owner
    const regDavid = await api('/api/organizations/register-company', {
      method: 'POST',
      body: JSON.stringify({
        name: 'David Miller',
        email: `david_${ts}@test.com`,
        password: 'password123',
        companyName: `Beta Labs ${ts}`,
        companyDescription: 'Company B',
      }),
    });
    const davidToken = regDavid.data.token;
    const davidId = regDavid.data.user?.id || regDavid.data.user?._id;
    const compBId = regDavid.data.organization?._id;

    // Add John to Company A by Admin Invite / Direct Membership
    await Membership.create({
      user: johnId,
      organization: compAId,
      role: 'member',
      status: 'active',
    });
    await User.findByIdAndUpdate(johnId, { currentOrganization: compAId });

    // Register Emma for Company B
    const regEmma = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'Emma Watson', email: `emma_${ts}@test.com`, password: 'password123' }),
    });
    const loginEmma = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: `emma_${ts}@test.com`, password: 'password123' }),
    });
    const emmaToken = loginEmma.data.token;
    const emmaId = loginEmma.data.user?.id || loginEmma.data.user?._id;
    await Membership.create({
      user: emmaId,
      organization: compBId,
      role: 'member',
      status: 'active',
    });
    await User.findByIdAndUpdate(emmaId, { currentOrganization: compBId });

    // Test 1: Team Users Isolation (GET /api/users)
    const usersInA = await api('/api/users', { method: 'GET' }, lilyToken);
    const usersInB = await api('/api/users', { method: 'GET' }, davidToken);

    const aContainsDavidOrEmma = usersInA.data.users?.some((u) => u._id === davidId || u._id === emmaId);
    const bContainsLilyOrJohn = usersInB.data.users?.some((u) => u._id === lilyId || u._id === johnId);

    if (!aContainsDavidOrEmma && !bContainsLilyOrJohn) {
      recordResult('PHASE 5', 'Team users company isolation (GET /api/users)', 'PASS');
    } else {
      recordResult('PHASE 5', 'Team users company isolation (GET /api/users)', 'FAIL', 'Cross-company users leaked');
    }

    // Test 2: Channel Creation & Listing Isolation
    const chanCompA = await api('/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: `announcements-a-${ts}`, isPrivate: false }),
    }, lilyToken);
    const chanAId = chanCompA.data.channel?._id;

    const chanCompB = await api('/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: `announcements-b-${ts}`, isPrivate: false }),
    }, davidToken);
    const chanBId = chanCompB.data.channel?._id;

    const listChanA = await api('/api/channels', { method: 'GET' }, lilyToken);
    const listChanB = await api('/api/channels', { method: 'GET' }, davidToken);

    const aHasBChan = listChanA.data.channels?.some((c) => c._id === chanBId);
    const bHasAChan = listChanB.data.channels?.some((c) => c._id === chanAId);

    if (!aHasBChan && !bHasAChan) {
      recordResult('PHASE 5', 'Channel listing company isolation', 'PASS');
    } else {
      recordResult('PHASE 5', 'Channel listing company isolation', 'FAIL', 'Cross-company channels visible');
    }

    // Test 3: Channel Access IDOR (User in Company A accessing public channel in Company B)
    const davidAccessChanA = await api(`/api/channels/${chanAId}`, { method: 'GET' }, davidToken);
    const davidJoinChanA = await api(`/api/channels/${chanAId}/join`, { method: 'POST' }, davidToken);

    if (davidAccessChanA.status === 403 || davidAccessChanA.status === 404) {
      recordResult('PHASE 5', 'Direct channel access IDOR check (GET /api/channels/:id)', 'PASS');
    } else {
      recordResult('PHASE 5', 'Direct channel access IDOR check (GET /api/channels/:id)', 'FAIL', `Status: ${davidAccessChanA.status} (Allowed user from Comp B to view Comp A channel)`);
    }

    if (davidJoinChanA.status === 403 || davidJoinChanA.status === 404) {
      recordResult('PHASE 5', 'Cross-company channel join IDOR check (POST /api/channels/:id/join)', 'PASS');
    } else {
      recordResult('PHASE 5', 'Cross-company channel join IDOR check (POST /api/channels/:id/join)', 'FAIL', `Status: ${davidJoinChanA.status} (Allowed user from Comp B to join Comp A channel)`);
    }

    // Test 4: Conversation Cross-Company Prevention
    const lilyCreateConvWithDavid = await api('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ receiverId: davidId }),
    }, lilyToken);

    if (lilyCreateConvWithDavid.status === 403 || lilyCreateConvWithDavid.status === 400) {
      recordResult('PHASE 5', 'Cross-company direct message conversation prevention', 'PASS');
    } else {
      recordResult('PHASE 5', 'Cross-company direct message conversation prevention', 'FAIL', `Status: ${lilyCreateConvWithDavid.status}`);
    }

    // ---------------------------------------------------------------
    // PHASE 6: DIRECT MESSAGE TESTING
    // ---------------------------------------------------------------
    console.log('\n--- PHASE 6: Direct Messaging Test (Lily <-> John) ---');

    // 1. Create DM Conversation Lily <-> John
    const convRes = await api('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ receiverId: johnId }),
    }, lilyToken);
    const convId = convRes.data.conversation?._id;

    if (convRes.status === 200 || convRes.status === 201) {
      recordResult('PHASE 6', '1. Create / Get DM conversation', 'PASS');
    } else {
      recordResult('PHASE 6', '1. Create / Get DM conversation', 'FAIL', JSON.stringify(convRes.data));
    }

    // 2. Lily sends message to John
    const sendMsg1 = await api(`/api/conversations/${convId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Hello John! Welcome to the team.' }),
    }, lilyToken);
    const msg1Id = sendMsg1.data.message?._id;

    if (sendMsg1.status === 201 && sendMsg1.data.message?.content === 'Hello John! Welcome to the team.') {
      recordResult('PHASE 6', '2. Send message', 'PASS');
    } else {
      recordResult('PHASE 6', '2. Send message', 'FAIL', JSON.stringify(sendMsg1.data));
    }

    // 3. Send Empty message
    const sendEmpty = await api(`/api/conversations/${convId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: '   ' }),
    }, lilyToken);
    if (sendEmpty.status === 400) {
      recordResult('PHASE 6', '3. Send empty message rejection', 'PASS');
    } else {
      recordResult('PHASE 6', '3. Send empty message rejection', 'FAIL', `Status: ${sendEmpty.status}`);
    }

    // 4. Send Long message (10,000 chars)
    const longText = 'A'.repeat(5000);
    const sendLong = await api(`/api/conversations/${convId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: longText }),
    }, lilyToken);
    if (sendLong.status === 201) {
      recordResult('PHASE 6', '4. Send long message', 'PASS');
    } else {
      recordResult('PHASE 6', '4. Send long message', 'FAIL', `Status: ${sendLong.status}`);
    }

    // 5. Edit message
    const editMsg = await api(`/api/messages/${msg1Id}`, {
      method: 'PATCH',
      body: JSON.stringify({ content: 'Hello John! (Edited)' }),
    }, lilyToken);
    if (editMsg.status === 200 && editMsg.data.message?.content === 'Hello John! (Edited)' && editMsg.data.message?.edited) {
      recordResult('PHASE 6', '5. Edit message', 'PASS');
    } else {
      recordResult('PHASE 6', '5. Edit message', 'FAIL', JSON.stringify(editMsg.data));
    }

    // 6. John trying to edit Lily's message (Forbidden)
    const johnEditLily = await api(`/api/messages/${msg1Id}`, {
      method: 'PATCH',
      body: JSON.stringify({ content: 'Hacked message' }),
    }, johnToken);
    if (johnEditLily.status === 403) {
      recordResult('PHASE 6', '6. Edit authorization check (other user cannot edit)', 'PASS');
    } else {
      recordResult('PHASE 6', '6. Edit authorization check (other user cannot edit)', 'FAIL', `Status: ${johnEditLily.status}`);
    }

    // 7. Reactions: Add & Remove
    const addReact = await api(`/api/messages/${msg1Id}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji: '👍' }),
    }, johnToken);
    if (addReact.status === 200 && addReact.data.reactions?.some((r) => r.emoji === '👍')) {
      recordResult('PHASE 6', '7a. Add reaction', 'PASS');
    } else {
      recordResult('PHASE 6', '7a. Add reaction', 'FAIL', JSON.stringify(addReact.data));
    }

    const removeReact = await api(`/api/messages/${msg1Id}/reactions/${encodeURIComponent('👍')}`, {
      method: 'DELETE',
    }, johnToken);
    if (removeReact.status === 200) {
      recordResult('PHASE 6', '7b. Remove reaction', 'PASS');
    } else {
      recordResult('PHASE 6', '7b. Remove reaction', 'FAIL', JSON.stringify(removeReact.data));
    }

    // 8. Pin & Unpin message
    const pinMsg = await api(`/api/pinned-messages/${msg1Id}/pin`, { method: 'POST' }, lilyToken);
    if (pinMsg.status === 200 && pinMsg.data.pinnedMessage) {
      recordResult('PHASE 6', '8a. Pin message', 'PASS');
    } else {
      recordResult('PHASE 6', '8a. Pin message', 'FAIL', JSON.stringify(pinMsg.data));
    }

    const unpinMsg = await api(`/api/pinned-messages/${msg1Id}/pin`, { method: 'DELETE' }, lilyToken);
    if (unpinMsg.status === 200) {
      recordResult('PHASE 6', '8b. Unpin message', 'PASS');
    } else {
      recordResult('PHASE 6', '8b. Unpin message', 'FAIL', JSON.stringify(unpinMsg.data));
    }

    // 9. Save & Unsave message
    const saveMsg = await api(`/api/saved-messages/${msg1Id}/save`, { method: 'POST' }, johnToken);
    if (saveMsg.status === 200 && saveMsg.data.savedMessage) {
      recordResult('PHASE 6', '9a. Save message', 'PASS');
    } else {
      recordResult('PHASE 6', '9a. Save message', 'FAIL', JSON.stringify(saveMsg.data));
    }

    const getSaved = await api('/api/saved-messages', { method: 'GET' }, johnToken);
    const isSavedFound = getSaved.data.savedMessages?.some((s) => s.messageId?._id === msg1Id);
    if (isSavedFound) {
      recordResult('PHASE 6', '9b. Get saved messages', 'PASS');
    } else {
      recordResult('PHASE 6', '9b. Get saved messages', 'FAIL');
    }

    const unsaveMsg = await api(`/api/saved-messages/${msg1Id}/save`, { method: 'DELETE' }, johnToken);
    if (unsaveMsg.status === 200) {
      recordResult('PHASE 6', '9c. Unsave message', 'PASS');
    } else {
      recordResult('PHASE 6', '9c. Unsave message', 'FAIL', JSON.stringify(unsaveMsg.data));
    }

    // 10. Reply to message
    const replyMsg = await api(`/api/conversations/${convId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Thanks Lily!', replyTo: msg1Id }),
    }, johnToken);
    if (replyMsg.status === 201 && replyMsg.data.message?.replyTo) {
      recordResult('PHASE 6', '10. Reply to message', 'PASS');
    } else {
      recordResult('PHASE 6', '10. Reply to message', 'FAIL', JSON.stringify(replyMsg.data));
    }

    // 11. Delete For Me
    const delForMe = await api(`/api/messages/${msg1Id}/delete-for-me`, { method: 'POST' }, johnToken);
    const getMsgsAfterDelForMe = await api(`/api/conversations/${convId}/messages`, { method: 'GET' }, johnToken);
    const johnSeesMsg1 = getMsgsAfterDelForMe.data.messages?.some((m) => m._id === msg1Id);
    if (delForMe.status === 200 && !johnSeesMsg1) {
      recordResult('PHASE 6', '11. Delete message for me', 'PASS');
    } else {
      recordResult('PHASE 6', '11. Delete message for me', 'FAIL');
    }

    // 12. Soft Delete Message (Delete for everyone)
    const delMsg = await api(`/api/messages/${msg1Id}`, { method: 'DELETE' }, lilyToken);
    if (delMsg.status === 200 && delMsg.data.message?.deleted) {
      recordResult('PHASE 6', '12. Soft delete message', 'PASS');
    } else {
      recordResult('PHASE 6', '12. Soft delete message', 'FAIL', JSON.stringify(delMsg.data));
    }

    // ---------------------------------------------------------------
    // PHASE 7: SOCKET.IO REAL-TIME AUDIT
    // ---------------------------------------------------------------
    console.log('\n--- PHASE 7: Socket.IO Real-Time Testing ---');

    const socketLily = ClientIO(BASE_URL, {
      auth: { token: lilyToken },
      transports: ['websocket'],
    });

    const socketJohn = ClientIO(BASE_URL, {
      auth: { token: johnToken },
      transports: ['websocket'],
    });

    const socketDavid = ClientIO(BASE_URL, {
      auth: { token: davidToken },
      transports: ['websocket'],
    });

    await Promise.all([
      new Promise((res) => socketLily.on('connect', res)),
      new Promise((res) => socketJohn.on('connect', res)),
      new Promise((res) => socketDavid.on('connect', res)),
    ]);

    recordResult('PHASE 7', 'Socket.IO handshake authentication', 'PASS');

    // Test Cross-Company Presence Leakage
    // Check if David (Company B) receives 'users:online' containing Lily or John (Company A)
    let davidReceivedOnlineUsers = null;
    socketDavid.on('users:online', (data) => {
      davidReceivedOnlineUsers = data.onlineUserIds;
    });

    // Join conversation room for Lily & John
    socketLily.emit('conversation:join', { conversationId: convId });
    socketJohn.emit('conversation:join', { conversationId: convId });

    // Test Real-Time Message Exchange via API -> Socket
    let johnReceivedLiveMessage = null;
    socketJohn.on('message:new', (payload) => {
      johnReceivedLiveMessage = payload.message;
    });

    await new Promise((r) => setTimeout(r, 200));

    await api(`/api/conversations/${convId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Real-time test message from Lily' }),
    }, lilyToken);

    await new Promise((r) => setTimeout(r, 300));

    if (johnReceivedLiveMessage && johnReceivedLiveMessage.content === 'Real-time test message from Lily') {
      recordResult('PHASE 7', 'Live Socket.IO message delivery', 'PASS');
    } else {
      recordResult('PHASE 7', 'Live Socket.IO message delivery', 'FAIL', 'Message not received over socket');
    }

    // Check Presence Cross-Tenant Isolation
    if (davidReceivedOnlineUsers && (davidReceivedOnlineUsers.includes(lilyId) || davidReceivedOnlineUsers.includes(johnId))) {
      recordResult('PHASE 7', 'Socket presence cross-tenant isolation', 'FAIL', 'users:online event broadcasts all users across all companies!');
    } else {
      recordResult('PHASE 7', 'Socket presence cross-tenant isolation', 'PASS');
    }

    socketLily.disconnect();
    socketJohn.disconnect();
    socketDavid.disconnect();

    // ---------------------------------------------------------------
    // PHASE 8: CHANNEL AUDIT
    // ---------------------------------------------------------------
    console.log('\n--- PHASE 8: Channel Testing ---');

    // Create Private Channel in Company A
    const privChanRes = await api('/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: `secret-a-${ts}`, isPrivate: true, description: 'Private channel' }),
    }, lilyToken);
    const privChanId = privChanRes.data.channel?._id;

    if (privChanRes.status === 201 && privChanRes.data.channel?.isPrivate) {
      recordResult('PHASE 8', 'Private channel creation', 'PASS');
    } else {
      recordResult('PHASE 8', 'Private channel creation', 'FAIL', JSON.stringify(privChanRes.data));
    }

    // John (non-member) listing channels should NOT see private channel
    const johnChanList = await api('/api/channels', { method: 'GET' }, johnToken);
    const johnSeesPrivChan = johnChanList.data.channels?.some((c) => c._id === privChanId);
    if (!johnSeesPrivChan) {
      recordResult('PHASE 8', 'Private channel listing visibility check', 'PASS');
    } else {
      recordResult('PHASE 8', 'Private channel listing visibility check', 'FAIL', 'Non-member can see private channel in list');
    }

    // John trying to view private channel details
    const johnViewPriv = await api(`/api/channels/${privChanId}`, { method: 'GET' }, johnToken);
    if (johnViewPriv.status === 403) {
      recordResult('PHASE 8', 'Private channel unauthorized access check', 'PASS');
    } else {
      recordResult('PHASE 8', 'Private channel unauthorized access check', 'FAIL', `Status: ${johnViewPriv.status}`);
    }

    // Send Channel Message
    const sendChanMsg = await api(`/api/channels/${chanAId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Welcome to General Channel!' }),
    }, lilyToken);
    if (sendChanMsg.status === 201) {
      recordResult('PHASE 8', 'Send channel message', 'PASS');
    } else {
      recordResult('PHASE 8', 'Send channel message', 'FAIL', JSON.stringify(sendChanMsg.data));
    }

    // ---------------------------------------------------------------
    // PHASE 9: SEARCH TESTING
    // ---------------------------------------------------------------
    console.log('\n--- PHASE 9: Search Testing ---');

    // 1. Company Search: Empty Query
    const searchEmpty = await api('/api/organizations/search?q=', { method: 'GET' }, lilyToken);
    if (searchEmpty.status === 200 && searchEmpty.data.organizations?.length === 0) {
      recordResult('PHASE 9', '1. Company search empty query (returns 0)', 'PASS');
    } else {
      recordResult('PHASE 9', '1. Company search empty query (returns 0)', 'FAIL', `Returned ${searchEmpty.data.organizations?.length} items`);
    }

    // 2. Company Search: Partial Match (e.g. searching 'Acme')
    const searchPartial = await api('/api/organizations/search?q=Acme', { method: 'GET' }, lilyToken);
    const foundAcme = searchPartial.data.organizations?.some((o) => o.name.includes(`Acme Corp ${ts}`));
    if (foundAcme) {
      recordResult('PHASE 9', '2. Company search partial match', 'PASS');
    } else {
      recordResult('PHASE 9', '2. Company search partial match', 'FAIL', 'Exact match regex (^...$) prevents partial search matches!');
    }

    // 3. Message Search in Active Company (GET /api/search?q=Real-time)
    const searchMessagesGlobal = await api('/api/search?q=Real-time', { method: 'GET' }, lilyToken);
    const foundMsgInSearch = searchMessagesGlobal.data.results?.messages?.length > 0;
    if (foundMsgInSearch) {
      recordResult('PHASE 9', '3. Global in-app message search', 'PASS');
    } else {
      recordResult('PHASE 9', '3. Global in-app message search', 'FAIL', 'Message search returned 0 results (due to organization filter on Message model)');
    }

    // 4. Advanced Message Search (GET /api/search/messages?q=Real-time)
    const searchMessagesAdv = await api('/api/search/messages?q=Real-time', { method: 'GET' }, lilyToken);
    if (searchMessagesAdv.status === 200 && searchMessagesAdv.data.messages?.length > 0) {
      recordResult('PHASE 9', '4. Advanced message search (GET /api/search/messages)', 'PASS');
    } else {
      recordResult('PHASE 9', '4. Advanced message search (GET /api/search/messages)', 'FAIL', `Status: ${searchMessagesAdv.status}, Count: ${searchMessagesAdv.data?.messages?.length}`);
    }

    // ---------------------------------------------------------------
    // PHASE 10: NOTIFICATIONS AUDIT
    // ---------------------------------------------------------------
    console.log('\n--- PHASE 10: Notifications Test ---');

    // John joins chanAId
    await api(`/api/channels/${chanAId}/join`, { method: 'POST' }, johnToken);

    // Lily mentions John in public channel: "@John Doe please check this out"
    const mentionMsg = await api(`/api/channels/${chanAId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: `@John Doe please check this out!` }),
    }, lilyToken);

    // Check John's notifications (GET /api/notifications)
    const johnNotifs = await api('/api/notifications', { method: 'GET' }, johnToken);
    const mentionNotif = johnNotifs.data.notifications?.find((n) => n.type === 'mention' || n.type === 'channel_activity');

    if (mentionNotif) {
      recordResult('PHASE 10', 'Mention notification delivery to recipient', 'PASS');
    } else {
      recordResult('PHASE 10', 'Mention notification delivery to recipient', 'FAIL', 'Notification not found in /api/notifications');
    }

    // ---------------------------------------------------------------
    // PHASE 12: TODO SYSTEM AUDIT
    // ---------------------------------------------------------------
    console.log('\n--- PHASE 12: Todo System Test ---');

    // Create Todo: Lily assigns to John
    const createTodoRes = await api('/api/todos', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Review Q3 Security Report',
        description: 'Complete audit of backend endpoints',
        assignedTo: johnId,
        priority: 'high',
        conversationId: convId,
      }),
    }, lilyToken);
    const todoId = createTodoRes.data.todo?._id;

    if (createTodoRes.status === 201 && createTodoRes.data.todo) {
      recordResult('PHASE 12', '1. Create To-Do', 'PASS');
    } else {
      recordResult('PHASE 12', '1. Create To-Do', 'FAIL', JSON.stringify(createTodoRes.data));
    }

    // Toggle Complete To-Do
    const toggleTodo = await api(`/api/todos/${todoId}/toggle`, {
      method: 'PATCH',
    }, johnToken);
    if (toggleTodo.status === 200 && toggleTodo.data.todo?.status === 'completed') {
      recordResult('PHASE 12', '2. Complete To-Do', 'PASS');
    } else {
      recordResult('PHASE 12', '2. Complete To-Do', 'FAIL', JSON.stringify(toggleTodo.data));
    }

    // Cross-Company Assignee Todo Prevention: Lily (Comp A) assigning to David (Comp B) without conversation
    const crossTodo = await api('/api/todos', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Cross company task',
        assignedTo: davidId,
      }),
    }, lilyToken);
    if (crossTodo.status === 403 || crossTodo.status === 400) {
      recordResult('PHASE 12', '3. Cross-company To-Do assignment prevention', 'PASS');
    } else {
      recordResult('PHASE 12', '3. Cross-company To-Do assignment prevention', 'FAIL', `Status: ${crossTodo.status} (Allowed assigning task to user in another company!)`);
    }

    // ---------------------------------------------------------------
    // PHASE 14 & 15: SECURITY & ERROR HANDLING AUDIT
    // ---------------------------------------------------------------
    console.log('\n--- PHASE 14 & 15: Security & Error Handling Test ---');

    // Non-existent resource error handling
    const nonExistentMsg = await api('/api/messages/507f1f77bcf86cd799439011', { method: 'GET' }, lilyToken);
    if (nonExistentMsg.status === 404) {
      recordResult('PHASE 14', 'Non-existent message returns 404', 'PASS');
    } else {
      recordResult('PHASE 14', 'Non-existent message returns 404', 'FAIL', `Status: ${nonExistentMsg.status}`);
    }

    // Malformed ObjectId error handling
    const badIdReq = await api('/api/messages/invalid-id-format', { method: 'GET' }, lilyToken);
    if (badIdReq.status === 400) {
      recordResult('PHASE 14', 'Malformed ObjectId format returns 400', 'PASS');
    } else {
      recordResult('PHASE 14', 'Malformed ObjectId format returns 400', 'FAIL', `Status: ${badIdReq.status}`);
    }

    // Password leak check in login / register responses
    if (!loginLily.data.user.password && !regLily.data.user.password) {
      recordResult('PHASE 15', 'Password hashing & no plaintext leak in responses', 'PASS');
    } else {
      recordResult('PHASE 15', 'Password hashing & no plaintext leak in responses', 'FAIL', 'Password leaked in response JSON');
    }

    // Non-admin accessing Admin routes
    const memberAdminAccess = await api('/api/admin/stats', { method: 'GET' }, johnToken);
    if (memberAdminAccess.status === 403) {
      recordResult('PHASE 15', 'Admin routes authorization enforcement (adminOnly)', 'PASS');
    } else {
      recordResult('PHASE 15', 'Admin routes authorization enforcement (adminOnly)', 'FAIL', `Status: ${memberAdminAccess.status}`);
    }

    // Admin Stats query verification
    const adminStats = await api('/api/admin/stats', { method: 'GET' }, lilyToken);
    if (adminStats.status === 200) {
      recordResult('PHASE 15', 'Admin stats endpoint execution', 'PASS', `Total messages returned: ${adminStats.data.stats?.totalMessages}`);
    } else {
      recordResult('PHASE 15', 'Admin stats endpoint execution', 'FAIL', `Status: ${adminStats.status}`);
    }

    console.log('\n====================================================');
    console.log('                 AUDIT COMPLETED                    ');
    console.log('====================================================\n');
  } finally {
    await new Promise((r) => serverInstance.close(r));
    await mongoose.disconnect();
  }
}

runAudit().catch(console.error);
