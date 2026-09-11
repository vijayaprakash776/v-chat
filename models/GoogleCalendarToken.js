const mongoose = require("mongoose");

/**
 * GoogleCalendarToken
 * Stores the Google OAuth2 tokens for a single ChatApp user.
 * One document per user - if the user re-connects, we upsert.
 *
 * SECURITY NOTE:
 *   In production, encrypt accessToken and refreshToken at rest.
 *   Tokens are NEVER returned to the frontend via any API response.
 */
const googleCalendarTokenSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    accessToken: {
      type: String,
      required: true,
    },
    refreshToken: {
      type: String,
      default: null,
    },
    expiryDate: {
      type: Number,
      default: null,
    },
    googleEmail: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("GoogleCalendarToken", googleCalendarTokenSchema);
