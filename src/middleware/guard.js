// src/middleware/guard.js
// Reusable middleware that blocks routes if Firebase Admin isn't ready.

import { adminReady } from '../config/firebase.js'

export function firebaseGuard(req, res, next) {
  if (!adminReady) {
    return res.status(503).json({
      error: 'Firebase Admin not available. Check GOOGLE_SERVICE_ACCOUNT_JSON and FIREBASE_PROJECT_ID in .env',
    })
  }
  next()
}