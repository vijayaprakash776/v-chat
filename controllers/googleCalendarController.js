const {
  getAuthUrl,
  exchangeCodeForTokens,
  getGoogleEmail,
  verifyStateToken,
  getAuthenticatedCalendarClient,
} = require("../services/googleCalendarService");
const GoogleCalendarToken = require("../models/GoogleCalendarToken");

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

/**
 * @desc    Generate the Google OAuth2 authorization URL and redirect user to Google
 * @route   GET /api/google/auth
 * @access  Private (requires ChatApp JWT via Authorization header or ?token= query param)
 *
 * NOTE: Since this endpoint is opened as a browser redirect (window.location.href),
 * the frontend cannot send an Authorization header. The protect middleware is bypassed
 * here intentionally - instead we read and verify the JWT manually from ?token=.
 * This is equivalent security to the Bearer token - both are verified with the same secret.
 */
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "flock_secret_jwt_key_2026_super_secure_token_auth";

const initiateGoogleAuth = (req, res) => {
  try {
    // Read token from query param (browser redirect) or header (fallback)
    const token =
      req.query.token ||
      (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")
        ? req.headers.authorization.split(" ")[1]
        : null);

    if (!token) {
      return res.status(401).json({ success: false, message: "Not authorized. Please log in." });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtErr) {
      return res.status(401).json({ success: false, message: "Session expired. Please log in again." });
    }

    const userId = decoded.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Invalid session." });
    }

    const authUrl = getAuthUrl(userId);
    // Redirect the browser to Google consent screen
    res.redirect(authUrl);
  } catch (err) {
    console.error("Google Auth initiation error:", err.message);
    if (err.message.includes("Missing environment variables")) {
      return res.status(500).json({
        success: false,
        message: "Google Calendar integration is not configured on this server.",
      });
    }
    res.status(500).json({
      success: false,
      message: "Could not initiate Google Calendar connection.",
    });
  }
};

/**
 * @desc    Google OAuth2 callback - exchange code, save tokens, redirect to frontend
 * @route   GET /api/google/callback
 * @access  Public (called by Google redirect, secured via signed state JWT)
 */
const googleCallback = async (req, res) => {
  const { code, state, error } = req.query;

  // 1. Handle user cancellation or Google-side errors
  if (error) {
    console.warn("Google OAuth cancelled or failed:", error);
    return res.redirect(`${FRONTEND_URL}?google_calendar=cancelled`);
  }

  if (!code || !state) {
    return res.redirect(`${FRONTEND_URL}?google_calendar=error&reason=missing_params`);
  }

  try {
    // 2. Verify the signed state JWT to identify the ChatApp user
    //    This prevents CSRF and ensures we don't trust browser-supplied user IDs
    let decoded;
    try {
      decoded = verifyStateToken(state);
    } catch (jwtErr) {
      console.error("Invalid or expired OAuth state token:", jwtErr.message);
      return res.redirect(`${FRONTEND_URL}?google_calendar=error&reason=invalid_state`);
    }

    const userId = decoded.userId;
    if (!userId) {
      return res.redirect(`${FRONTEND_URL}?google_calendar=error&reason=no_user`);
    }

    // 3. Exchange the authorization code for Google OAuth tokens
    let tokens;
    try {
      tokens = await exchangeCodeForTokens(code);
    } catch (exchangeErr) {
      console.error("Token exchange failed:", exchangeErr.message);
      return res.redirect(`${FRONTEND_URL}?google_calendar=error&reason=token_exchange`);
    }

    // 4. Fetch the connected Google account email (safe to display in UI)
    const googleEmail = await getGoogleEmail(tokens.access_token);

    // 5. Upsert the token record in MongoDB
    //    If the user re-connects, update existing record
    await GoogleCalendarToken.findOneAndUpdate(
      { user: userId },
      {
        user: userId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || undefined,
        expiryDate: tokens.expiry_date || null,
        googleEmail: googleEmail,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // 6. Redirect back to the frontend with a success signal
    //    The frontend reads this query param and updates UI state
    return res.redirect(`${FRONTEND_URL}?google_calendar=connected`);
  } catch (err) {
    console.error("Google Calendar callback error:", err.message);
    return res.redirect(`${FRONTEND_URL}?google_calendar=error&reason=server_error`);
  }
};

/**
 * @desc    Check whether the current user has connected Google Calendar
 * @route   GET /api/google/status
 * @access  Private (requires ChatApp JWT)
 */
const getConnectionStatus = async (req, res) => {
  try {
    const userId = req.user.id;

    const tokenDoc = await GoogleCalendarToken.findOne({ user: userId }).select(
      "googleEmail createdAt updatedAt"
      // Explicitly NOT selecting accessToken or refreshToken
    );

    if (!tokenDoc) {
      return res.status(200).json({
        success: true,
        connected: false,
        googleEmail: null,
      });
    }

    return res.status(200).json({
      success: true,
      connected: true,
      googleEmail: tokenDoc.googleEmail || null,
      connectedAt: tokenDoc.createdAt,
    });
  } catch (err) {
    console.error("Error fetching Google Calendar status:", err.message);
    res.status(500).json({
      success: false,
      message: "Could not retrieve Google Calendar connection status.",
    });
  }
};

/**
 * @desc    Disconnect (delete) the user's Google Calendar connection
 * @route   DELETE /api/google/disconnect
 * @access  Private (requires ChatApp JWT)
 */
const disconnectGoogleCalendar = async (req, res) => {
  try {
    const userId = req.user.id;

    const deleted = await GoogleCalendarToken.findOneAndDelete({ user: userId });

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "No Google Calendar connection found for this account.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Google Calendar has been disconnected successfully.",
    });
  } catch (err) {
    console.error("Error disconnecting Google Calendar:", err.message);
    res.status(500).json({
      success: false,
      message: "Could not disconnect Google Calendar.",
    });
  }
};

/**
 * @desc    Get all Google Calendars for the connected account
 * @route   GET /api/google/calendars
 * @access  Private
 */
const getCalendars = async (req, res) => {
  try {
    const calendar = await getAuthenticatedCalendarClient(req.user.id);
    const response = await calendar.calendarList.list();
    res.status(200).json({
      success: true,
      calendars: response.data.items,
    });
  } catch (err) {
    console.error("Error fetching calendars:", err.message);
    res.status(500).json({ success: false, message: "Could not fetch calendars." });
  }
};

/**
 * @desc    Get events for a specific calendar
 * @route   GET /api/google/events
 * @access  Private
 */
const getEvents = async (req, res) => {
  try {
    const { calendarId = "primary", timeMin, timeMax } = req.query;
    const calendar = await getAuthenticatedCalendarClient(req.user.id);
    const response = await calendar.events.list({
      calendarId,
      timeMin: timeMin || new Date().toISOString(),
      timeMax,
      maxResults: 100,
      singleEvents: true,
      orderBy: "startTime",
    });
    res.status(200).json({
      success: true,
      events: response.data.items,
    });
  } catch (err) {
    console.error("Error fetching events:", err.message);
    res.status(500).json({ success: false, message: "Could not fetch events." });
  }
};

/**
 * @desc    Create a new event
 * @route   POST /api/google/events
 * @access  Private
 */
const createEvent = async (req, res) => {
  try {
    const { calendarId = "primary", summary, description, start, end, location } = req.body;

    if (!summary || !start || !end) {
      return res.status(400).json({ success: false, message: "Summary, start time, and end time are required." });
    }

    const calendar = await getAuthenticatedCalendarClient(req.user.id);

    const response = await calendar.events.insert({
      calendarId,
      resource: {
        summary,
        description,
        start, // Already formatted as { dateTime: ... } or { date: ... } by frontend
        end,   // Already formatted as { dateTime: ... } or { date: ... } by frontend
        location
      },
    });

    res.status(201).json({
      success: true,
      event: response.data,
    });
  } catch (err) {
    console.error("Error creating event:", err.message);
    // Return specific Google error message if available
    const errorMsg = err.errors?.[0]?.message || err.message || "Could not create event.";
    res.status(500).json({ success: false, message: errorMsg });
  }
};

/**
 * @desc    Update an existing event
 * @route   PATCH /api/google/events/:eventId
 * @access  Private
 */
const updateEvent = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { calendarId = "primary", summary, description, start, end, location } = req.body;
    const calendar = await getAuthenticatedCalendarClient(req.user.id);
    const response = await calendar.events.patch({
      calendarId,
      eventId,
      resource: { summary, description, start, end, location },
    });
    res.status(200).json({
      success: true,
      event: response.data,
    });
  } catch (err) {
    console.error("Error updating event:", err.message);
    const errorMsg = err.errors?.[0]?.message || err.message || "Could not update event.";
    res.status(500).json({ success: false, message: errorMsg });
  }
};

/**
 * @desc    Delete an event
 * @route   DELETE /api/google/events/:eventId
 * @access  Private
 */
const deleteEvent = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { calendarId = "primary" } = req.query;
    const calendar = await getAuthenticatedCalendarClient(req.user.id);
    await calendar.events.delete({
      calendarId,
      eventId,
    });
    res.status(200).json({ success: true, message: "Event deleted." });
  } catch (err) {
    console.error("Error deleting event:", err.message);
    res.status(500).json({ success: false, message: "Could not delete event." });
  }
};

module.exports = {
  initiateGoogleAuth,
  googleCallback,
  getConnectionStatus,
  disconnectGoogleCalendar,
  getCalendars,
  getEvents,
  createEvent,
  updateEvent,
  deleteEvent,
};
