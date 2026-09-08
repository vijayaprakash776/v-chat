const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// Main Document Generation
const doc = new PDFDocument({
  margin: 50,
  size: 'A4',
});

const outputPath = path.join(__dirname, '..', 'Flock_ChatApp_Architecture.pdf');
const writeStream = fs.createWriteStream(outputPath);
doc.pipe(writeStream);

// Colors
const primaryColor = '#0284c7'; // Flock Blue
const darkTextColor = '#0f172a';
const mutedTextColor = '#475569';
const cardBg = '#f8fafc';
const borderColor = '#e2e8f0';

function addFooter(pageNum, totalPages = 3) {
  // Use absolute positioning for footer to avoid pushing a new page
  doc.fillColor('#94a3b8').fontSize(8).font('Helvetica')
    .text(
      `Flock ChatApp System Architecture • Page ${pageNum} of ${totalPages}`,
      50,
      780,
      { align: 'center', width: doc.page.width - 100 }
    );
}

// Helpers
function addHeader(title, subtitle) {
  doc.rect(0, 0, doc.page.width, 110).fill('#0f172a');
  
  doc.fillColor('#38bdf8').fontSize(22).font('Helvetica-Bold')
    .text(title, 50, 32);
  
  doc.fillColor('#94a3b8').fontSize(11).font('Helvetica')
    .text(subtitle, 50, 62);
  
  doc.fillColor('#059669').fontSize(9).font('Helvetica-Bold')
    .text('✓ PRODUCTION GRADE • MULTI-TENANT ENTERPRISE ARCHITECTURE', 50, 84);

  doc.y = 135;
}

function addSectionTitle(title, emoji = '') {
  doc.moveDown(0.8);
  doc.fillColor(primaryColor).fontSize(14).font('Helvetica-Bold')
    .text(`${emoji ? emoji + ' ' : ''}${title}`);
  
  doc.strokeColor(borderColor).lineWidth(1)
    .moveTo(50, doc.y + 4)
    .lineTo(doc.page.width - 50, doc.y + 4)
    .stroke();
  
  doc.moveDown(0.6);
}

function addParagraph(text) {
  doc.fillColor(darkTextColor).fontSize(10).font('Helvetica').lineGap(3)
    .text(text);
  doc.moveDown(0.4);
}

function addBullet(title, desc) {
  doc.fillColor(primaryColor).fontSize(10).font('Helvetica-Bold')
    .text('• ' + title + ': ', { continued: true });
  doc.fillColor(mutedTextColor).font('Helvetica')
    .text(desc);
  doc.moveDown(0.2);
}

function addBox(title, items) {
  const startY = doc.y;
  doc.fillColor(darkTextColor).fontSize(10).font('Helvetica');

  doc.rect(50, startY, doc.page.width - 100, (items.length * 18) + 30)
    .fillAndStroke(cardBg, borderColor);

  doc.fillColor(primaryColor).fontSize(11).font('Helvetica-Bold')
    .text(title, 65, startY + 10);

  let currentY = startY + 28;
  items.forEach(item => {
    doc.fillColor(mutedTextColor).fontSize(9.5).font('Helvetica')
      .text('→ ' + item, 65, currentY);
    currentY += 16;
  });

  doc.y = currentY + 12;
}

// --- PAGE 1: Executive Architecture & High-Level System ---
addHeader('Flock ChatApp - System Architecture', 'Full-Stack Multi-Tenant Real-Time Collaboration Platform');

addSectionTitle('1. Executive Overview');
addParagraph('Flock ChatApp is a full-stack, enterprise-grade real-time team collaboration platform built with React, Node.js/Express, Socket.IO, and MongoDB. It provides multi-tenant workspace isolation, 1-on-1 direct messaging, team channels, real-time presence, audit logging, to-do management, and role-based administrative control.');

addSectionTitle('2. High-Level Architecture Layers');
addBullet('Frontend Client (React 18 + Vite)', 'Single Page Application (SPA) designed with a modular component architecture, centralized SVG icon system, responsive mobile rail/drawer system, and contextual state providers (AuthContext, SocketContext).');
addBullet('API & Real-Time Gateway (Express + Socket.IO)', 'Dual-protocol communication server managing REST API endpoints alongside low-latency bi-directional WebSocket events for instant messaging, presence tracking, and notifications.');
addBullet('Data & Storage Tier (MongoDB + Mongoose)', 'Multi-tenant database schema with strict indexing, compound organizational uniqueness constraints, and transactional consistency across 13 Mongoose models.');

doc.moveDown(0.5);
addBox('Core Technology Stack', [
  'Frontend: React 18, Vite, Vanilla CSS Design System, Lucide-style SVG icons',
  'Backend: Node.js, Express.js (MVC Pattern), Socket.IO 4.x Gateway',
  'Database: MongoDB 6.x / 7.x, Mongoose ODM with custom indexes',
  'Authentication: Stateless JSON Web Tokens (JWT) & bcrypt password hashing',
  'File Handling: Multer disk storage statically served under /uploads'
]);
addFooter(1);

// --- PAGE 2: Multi-Tenancy & Data Models ---
doc.addPage();
addSectionTitle('3. Multi-Tenant Organizational Data Architecture');
addParagraph('Flock implements scoped organizational multi-tenancy where every workspace acts as a self-contained collaborative boundary:');

addBullet('Organization Isolation', 'Every channel, member association, audit event, and join request is bound by organization ID. Users can belong to multiple companies and switch active contexts dynamically.');
addBullet('Compound Unique Constraints', 'Channel names are unique per organization ({ organization: 1, name: 1 }), enabling distinct organizations to maintain standardized channel names (e.g. #general, #announcements) without conflict.');
addBullet('Role-Based Access Control (RBAC)', 'Granular permission tiering: System Admin, Organization Administrator, and Member with scoped capabilities for channel creation, user moderation, and audit visibility.');

addSectionTitle('4. Key MongoDB Collections & Schemas');
addBullet('organizations', 'Company metadata, slug, creator ID, and custom organizational policies (requireJoinApproval, allowPublicChannels).');
addBullet('memberships', 'Maps users to organizations with assigned role (admin/member) and status (active/suspended).');
addBullet('channels', 'Public and private team channels, member rosters, and organizational reference.');
addBullet('conversations & messages', 'Direct 1-on-1 chats and channel messages with support for reactions, file attachments, and pinned/saved flags.');
addBullet('joinrequests', 'Join requests lifecycle (pending -> approved/rejected) with reviewer tracking and real-time Socket.IO dispatch.');
addBullet('todos & auditlogs', 'Task delegation and immutable audit trail records for compliance and administrative scanning.');
addFooter(2);

// --- PAGE 3: Real-Time Event Pipeline & Mobile Architecture ---
doc.addPage();
addSectionTitle('5. Real-Time Socket.IO Pipeline');
addParagraph('The real-time layer leverages room-based multiplexing to dispatch events with sub-50ms latency:');

addBullet('Presence & Online Tracking', 'Maintains an in-memory Map of active socket IDs to user IDs. Broadcasts user:online and user:offline events on connect/disconnect.');
addBullet('Room Scoping', 'Users automatically join personal rooms (user:userId) for direct notifications and specific channel/conversation rooms upon viewing.');
addBullet('Live Messaging & Typing', 'Events message:new, typing:start, and typing:stop provide live feedback without polling or database stress.');
addBullet('Instant Join Request Flow', 'Join requests emit join_request:new to the admin room in real-time. Upon approval, join_request:approved is sent directly to the applicant.');

addSectionTitle('6. Responsive Frontend & Mobile Design');
addBullet('Desktop Layout', 'Three-column workspace layout: Primary Navigation Rail -> Sub-panel List -> Main Communication Stage.');
addBullet('Mobile Experience', 'Fixed bottom navigation bar for high-frequency workflows (Chats, Channels, To-Dos, Team Directory), animated off-canvas drawer for secondary tools, and modals hoisted to root viewport scope.');
addBullet('Exact Search Engine', 'Backend-optimized regex exact-matching prevents partial over-matching and hides company lists on initial empty search.');

addSectionTitle('7. Security & Non-Functional Highlights');
addBullet('Zero Stale Renders', 'Hoisted modal views prevent CSS transform clipping bugs during mobile navigation drawer transitions.');
addBullet('JWT Security', 'HTTP authorization headers verified on every protected route with payload-embedded user IDs.');
addBullet('Audit Compliance', 'Role changes, company modifications, and channel creations generate timestamped audit records.');
addFooter(3);

doc.end();

writeStream.on('finish', () => {
  console.log('PDF generation complete: ' + outputPath);
});
