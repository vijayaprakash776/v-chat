const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const doc = new PDFDocument();
const outputPath = path.join(__dirname, '..', 'ChatApp_API_Docs.pdf');

doc.pipe(fs.createWriteStream(outputPath));

doc.fontSize(20).text('ChatApp Backend API Documentation', { align: 'center' });
doc.moveDown();

doc.fontSize(14).text('Base URL: http://localhost:5000/api');
doc.moveDown();

const sections = [
  {
    title: '1. Authentication (/api/auth)',
    items: [
      'POST /register — Register a new user.',
      'POST /login — User login.',
      'GET /me — Get current user profile (Protected).'
    ]
  },
  {
    title: '2. Messaging & Conversations',
    subtitle: 'Conversations (/api/conversations)',
    items: [
      'POST / — Create or fetch a direct conversation.',
      'GET / — List user\'s conversations.',
      'PATCH /:conversationId/read — Mark conversation as read.',
      'GET /:conversationId/messages — Fetch messages in a conversation.',
      'POST /:conversationId/messages — Send a message (supports file attachments).'
    ],
    items2: {
      subtitle: 'Messages (/api/messages)',
      list: [
        'PATCH /read — Mark multiple messages as read.',
        'PATCH /:messageId — Edit a message.',
        'DELETE /:messageId — Delete a message.',
        'POST /:messageId/reactions — Add emoji reaction.',
        'POST /:messageId/poll/vote — Vote on a poll message.'
      ]
    }
  },
  {
    title: '3. Channels & Groups (/api/channels)',
    items: [
      'POST / — Create a new channel.',
      'GET / — List all channels.',
      'POST /:id/join / POST /:id/leave — Join or leave a channel.',
      'GET /:id/messages — Fetch channel messages.',
      'POST /:id/messages — Send a message to a channel.'
    ]
  },
  {
    title: '4. User & Organization Management',
    subtitle: 'Users (/api/users)',
    items: [
      'GET /profile — Get profile details.',
      'PUT /profile — Update profile/avatar.',
      'PUT /settings — Update user preferences.'
    ],
    items2: {
      subtitle: 'Organizations (/api/organizations)',
      list: [
        'POST /register-company — Public route to register an org.',
        'GET /my — List organizations the user belongs to.',
        'POST /:id/switch — Switch active organization context.'
      ]
    }
  },
  {
    title: '5. Utilities & Features',
    items: [
      'Todos (/api/todos): CRUD operations for personal/team tasks.',
      'Reminders (/api/reminders): Create, snooze, and manage reminders.',
      'Notes (/api/notes): Personal or shared notes.',
      'Search (/api/search): Unified search across messages and users.',
      'Notifications (/api/notifications): Fetch and manage unread notifications.'
    ]
  },
  {
    title: '6. Admin & Super Admin',
    items: [
      'Admin (/api/admin): Workspace statistics, user role management, moderation, and audit logs.',
      'Super Admin (/api/super-admin): Global platform stats, organization activation/suspension, and subscription management.'
    ]
  },
  {
    title: '7. Integrations',
    items: [
      'Google Calendar (/api/google): OAuth flow (/auth, /callback), connection status, and event management (/events).'
    ]
  },
  {
    title: '8. Health Check',
    items: [
      'GET / — Base status check.',
      'GET /api/health — API health and timestamp.'
    ]
  }
];

sections.forEach(section => {
  doc.fontSize(16).fillColor('blue').text(section.title);
  doc.moveDown(0.5);

  if (section.subtitle) {
    doc.fontSize(14).fillColor('black').text(section.subtitle, { indent: 20 });
    doc.moveDown(0.2);
  }

  doc.fontSize(12).fillColor('black');
  section.items.forEach(item => {
    doc.text(`• ${item}`, { indent: 30 });
  });

  if (section.items2) {
    doc.moveDown(0.5);
    doc.fontSize(14).text(section.items2.subtitle, { indent: 20 });
    doc.moveDown(0.2);
    doc.fontSize(12);
    section.items2.list.forEach(item => {
      doc.text(`• ${item}`, { indent: 30 });
    });
  }

  doc.moveDown();
});

doc.end();

console.log(`PDF successfully generated at: ${outputPath}`);
