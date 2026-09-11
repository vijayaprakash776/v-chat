const { google } = require("googleapis");
const jwt = require("jsonwebtoken");
const GoogleCalendarToken = require("../models/GoogleCalendarToken");

const JWT_SECRET = process.env.JWT_SECRET || "flock_secret_jwt_key_2026_super_secure_token_auth";

/**
 * Validates that all required Google OAuth environment variables are present.
 * Throws a descriptive error if any are missing.
 */
const validateGoogleConfig = () => {
  const missing = [];
  if (!process.env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!process.env.GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (!process.env.GOOGLE_REDIRECT_URI) missing.push("GOOGLE_REDIRECT_URI");
  if (missing.length > 0) {
    throw new Error(
      `Google Calendar integration is not configured. Missing environment variables: ${missing.join(", ")}`
    );
  }
};

/**
 * Creates and returns a fresh Google OAuth2 client instance.
 * Reads credentials from environment variables - never hardcoded.
 */
const createOAuthClient = () => {
  validateGoogleConfig();
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
};

/**
 * Generates the Google OAuth2 authorization URL.
 *
 * The ChatApp userId is signed into a short-lived JWT and passed as the
 * OAuth `state` parameter. The callback verifies this JWT to securely
 * identify which ChatApp user initiated the flow - preventing CSRF and
 * ensuring we never trust a plain userId from the browser.
 *
 * @param {string} userId - The MongoDB ObjectId string of the ChatApp user
 * @returns {string} The full Google consent screen URL
 */
const getAuthUrl = (userId) => {
  const oauth2Client = createOAuthClient();

  // Sign userId into a short-lived state token (15 minutes)
  const stateToken = jwt.sign({ userId }, JWT_SECRET, { expiresIn: "15m" });

  return oauth2Client.generateAuthUrl({
    access_type: "offline",    // Required to receive a refresh_token
    prompt: "consent select_account", // Force consent screen to ensure new scopes are picked up
    scope: [
      "https://www.googleapis.com/auth/calendar", // Broad scope for both list and events
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    state: stateToken,         // Signed JWT - verified in the callback
  });
};

/**
 * Exchanges the Google authorization code for OAuth tokens.
 *
 * @param {string} code - The authorization code from Google's callback
 * @returns {Promise<object>} The token object { access_token, refresh_token, expiry_date, ... }
 */
const exchangeCodeForTokens = async (code) => {
  const oauth2Client = createOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
};

/**
 * Retrieves the Google account email using the access token.
 * Used after a successful token exchange to record which Google account connected.
 *
 * @param {string} accessToken
 * @returns {Promise<string|null>} The Google account email, or null on failure
 */
const getGoogleEmail = async (accessToken) => {
  try {
    const oauth2Client = createOAuthClient();
    oauth2Client.setCredentials({ access_token: accessToken });
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    return data.email || null;
  } catch (err) {
    console.error("Could not retrieve Google email:", err.message);
    return null;
  }
};

/**
 * Verifies and decodes the state JWT passed through the OAuth flow.
 * Returns the userId if valid, or throws if tampered/expired.
 *
 * @param {string} stateToken
 * @returns {{ userId: string }}
 */
const verifyStateToken = (stateToken) => {
  return jwt.verify(stateToken, JWT_SECRET);
};

/**
 * Retrieves a fully authenticated Google Calendar client for the given user.
 * It uses the stored access and refresh tokens. If the access token is expired,
 * the googleapis client will automatically refresh it using the refresh token,
 * and the 'tokens' event listener will persist the new tokens to the database.
 *
 * @param {string} userId - The ChatApp user ID
 * @returns {Promise<import('googleapis').calendar_v3.Calendar>}
 */
const getAuthenticatedCalendarClient = async (userId) => {
  const tokenDoc = await GoogleCalendarToken.findOne({ user: userId });
  if (!tokenDoc) {
    throw new Error("Google Calendar is not connected.");
  }

  const oauth2Client = createOAuthClient();

  // Listen for automatic token refreshes by the Google client
  oauth2Client.on("tokens", async (tokens) => {
    try {
      // If a refresh happens, save the new access token (and refresh token if provided)
      const updateData = { accessToken: tokens.access_token };
      if (tokens.refresh_token) {
        updateData.refreshToken = tokens.refresh_token;
      }
      if (tokens.expiry_date) {
        updateData.expiryDate = tokens.expiry_date;
      }
      await GoogleCalendarToken.findOneAndUpdate({ user: userId }, updateData);
    } catch (err) {
      console.error("Failed to persist refreshed Google tokens:", err.message);
    }
  });

  oauth2Client.setCredentials({
    access_token: tokenDoc.accessToken,
    refresh_token: tokenDoc.refreshToken,
    expiry_date: tokenDoc.expiryDate,
  });

  // Return the authenticated calendar API instance
  return google.calendar({ version: "v3", auth: oauth2Client });
};

module.exports = {
  getAuthUrl,
  exchangeCodeForTokens,
  getGoogleEmail,
  verifyStateToken,
  getAuthenticatedCalendarClient,
};
