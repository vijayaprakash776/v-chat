const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  initiateGoogleAuth,
  googleCallback,
  getConnectionStatus,
  disconnectGoogleCalendar,
  getCalendars,
  getEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} = require("../controllers/googleCalendarController");

/**
 * Google Calendar OAuth Routes
 *
 * GET  /api/google/auth        - Redirect user to Google consent screen (Protected)
 * GET  /api/google/callback    - Google redirects here with auth code (Public, state-secured)
 * GET  /api/google/status      - Check if current user has connected Google Calendar (Protected)
 * DELETE /api/google/disconnect - Remove the current user's Google Calendar connection (Protected)
 */

// Initiates the OAuth flow; JWT is verified manually inside the controller
// (browser redirects cannot carry Authorization headers)
router.get("/auth", initiateGoogleAuth);

// Google's redirect target after consent - secured via signed state JWT
router.get("/callback", googleCallback);

// Status check - does not return raw tokens
router.get("/status", protect, getConnectionStatus);

// Disconnect/revoke the integration
router.delete("/disconnect", protect, disconnectGoogleCalendar);

// Calendar & Event Management (Phase 2 & 3)
router.get("/calendars", protect, getCalendars);
router.get("/events", protect, getEvents);
router.post("/events", protect, createEvent);
router.patch("/events/:eventId", protect, updateEvent);
router.delete("/events/:eventId", protect, deleteEvent);

module.exports = router;
