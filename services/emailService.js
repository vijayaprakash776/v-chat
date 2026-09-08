const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

/**
 * Send an invitation email using Brevo's Transactional Email API (SMTP).
 * 
 * @param {Object} options
 * @param {string} options.toEmail - The recipient's email address
 * @param {string} options.inviterName - The name of the admin who sent the invite
 * @param {string} options.companyName - The name of the organization
 * @param {string} options.acceptUrl - The full URL containing the secure invitation token
 * @param {Date|string} options.expiresAt - The invitation expiry date
 * @returns {Promise<{success: boolean, messageId: string}>}
 */
async function sendBrevoInvitationEmail({ toEmail, inviterName, companyName, acceptUrl, expiresAt }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error('BREVO_API_KEY is not configured in environment variables.');
  }

  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'abhiikumar1330@gmail.com';
  const senderName = process.env.BREVO_SENDER_NAME || 'ChatApp Workspace';

  const expiryString = expiresAt
    ? new Date(expiresAt).toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : '7 days from now';

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invitation to join ${companyName}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #1e293b;
      -webkit-font-smoothing: antialiased;
    }
    .email-container {
      max-width: 580px;
      margin: 36px auto;
      background-color: #ffffff;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid #e2e8f0;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.04);
    }
    .email-header {
      background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%);
      padding: 32px 28px;
      text-align: center;
      color: #ffffff;
    }
    .brand-title {
      margin: 0;
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.025em;
      color: #ffffff;
    }
    .brand-tagline {
      margin: 6px 0 0 0;
      font-size: 13px;
      color: #e0f2fe;
      font-weight: 500;
    }
    .email-body {
      padding: 36px 32px;
    }
    .greeting {
      font-size: 18px;
      font-weight: 700;
      margin: 0 0 14px 0;
      color: #0f172a;
    }
    .lead-text {
      font-size: 15px;
      line-height: 1.6;
      color: #334155;
      margin: 0 0 24px 0;
    }
    .details-card {
      background-color: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 18px 20px;
      margin-bottom: 28px;
    }
    .detail-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #edf2f7;
      font-size: 14px;
    }
    .detail-row:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }
    .detail-label {
      color: #64748b;
      font-weight: 500;
    }
    .detail-value {
      color: #0f172a;
      font-weight: 600;
      text-align: right;
    }
    .cta-container {
      text-align: center;
      margin: 32px 0;
    }
    .btn-accept {
      display: inline-block;
      background-color: #0284c7;
      color: #ffffff !important;
      font-size: 15px;
      font-weight: 700;
      text-decoration: none;
      padding: 14px 36px;
      border-radius: 8px;
      box-shadow: 0 2px 6px rgba(2, 132, 199, 0.3);
      transition: background-color 0.2s;
    }
    .btn-accept:hover {
      background-color: #0369a1;
    }
    .fallback-note {
      font-size: 12px;
      color: #64748b;
      line-height: 1.5;
      margin-top: 24px;
      word-break: break-all;
    }
    .fallback-link {
      color: #0284c7;
      text-decoration: underline;
    }
    .email-footer {
      background-color: #f1f5f9;
      padding: 20px 32px;
      border-top: 1px solid #e2e8f0;
      text-align: center;
      font-size: 12px;
      color: #64748b;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="email-container">
    <div class="email-header">
      <h1 class="brand-title">ChatApp Workspace</h1>
      <p class="brand-tagline">Team Collaboration & Communication Platform</p>
    </div>

    <div class="email-body">
      <h2 class="greeting">You're invited!</h2>
      <p class="lead-text">
        <strong>${inviterName}</strong> has invited you to join the <strong>${companyName}</strong> team workspace on ChatApp.
      </p>

      <div class="details-card">
        <div class="detail-row">
          <span class="detail-label">Company:</span>
          <span class="detail-value">${companyName}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Invited By:</span>
          <span class="detail-value">${inviterName}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Invited Email:</span>
          <span class="detail-value">${toEmail}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Expires On:</span>
          <span class="detail-value">${expiryString}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Role:</span>
          <span class="detail-value">Team Member</span>
        </div>
      </div>

      <div class="cta-container">
        <a href="${acceptUrl}" class="btn-accept" target="_blank" rel="noopener noreferrer">
          Accept Invitation →
        </a>
      </div>

      <p class="fallback-note">
        Button not working? Copy and paste this URL into your web browser:<br>
        <a href="${acceptUrl}" class="fallback-link">${acceptUrl}</a>
      </p>
    </div>

    <div class="email-footer">
      <p style="margin: 0 0 6px 0;">This invitation was sent to <strong>${toEmail}</strong>.</p>
      <p style="margin: 0;">If you were not expecting this invitation, you can safely ignore this email.</p>
    </div>
  </div>
</body>
</html>
  `.trim();

  const payload = {
    sender: {
      name: senderName,
      email: senderEmail,
    },
    to: [
      {
        email: toEmail,
      },
    ],
    subject: `You've been invited to join ${companyName} on ChatApp`,
    htmlContent,
  };

  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const responseData = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorDetail =
      responseData?.message ||
      responseData?.error ||
      `HTTP error ${response.status} from Brevo API`;
    console.error('Brevo API email sending failed:', response.status, responseData);
    throw new Error(`Brevo sending failed: ${errorDetail}`);
  }

  return {
    success: true,
    messageId: responseData.messageId || 'sent',
  };
}

module.exports = {
  sendBrevoInvitationEmail,
};
