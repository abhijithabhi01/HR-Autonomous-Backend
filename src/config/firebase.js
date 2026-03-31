// src/config/firebase.js
// Firebase Admin SDK — single initialization shared across all route files.
//
// Supports TWO ways to provide the service account credentials:
//
//  Option A — Individual fields in .env (recommended, easiest to set up):
//    SA_TYPE, SA_PROJECT_ID, SA_PRIVATE_KEY_ID, SA_PRIVATE_KEY,
//    SA_CLIENT_EMAIL, SA_CLIENT_ID, SA_AUTH_URI, SA_TOKEN_URI,
//    SA_AUTH_PROVIDER_CERT_URL, SA_CLIENT_CERT_URL
//
//  Option B — Entire JSON as one line (useful for Render/Heroku secrets):
//    GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}

import admin from 'firebase-admin'

let adminReady = false
let db, auth, storage

// ── Build credentials object from whichever option is present ──
function resolveCredentials() {
  // Option A: individual SA_ fields
  if (process.env.SA_CLIENT_EMAIL && process.env.SA_PRIVATE_KEY) {
    return {
      type:                        process.env.SA_TYPE                    || 'service_account',
      project_id:                  process.env.SA_PROJECT_ID              || process.env.FIREBASE_PROJECT_ID,
      private_key_id:              process.env.SA_PRIVATE_KEY_ID,
      // dotenv strips surrounding quotes but keeps literal \n — replace with real newlines
      private_key:                 process.env.SA_PRIVATE_KEY.replace(/\\n/g, '\n'),
      client_email:                process.env.SA_CLIENT_EMAIL,
      client_id:                   process.env.SA_CLIENT_ID,
      auth_uri:                    process.env.SA_AUTH_URI                || 'https://accounts.google.com/o/oauth2/auth',
      token_uri:                   process.env.SA_TOKEN_URI               || 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: process.env.SA_AUTH_PROVIDER_CERT_URL || 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url:        process.env.SA_CLIENT_CERT_URL,
    }
  }

  // Option B: single JSON blob
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    // Ensure private_key newlines are real newlines (some env systems escape them)
    if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n')
    return parsed
  }

  return null
}

try {
  const projectId = process.env.FIREBASE_PROJECT_ID
  let   bucket    = process.env.FIREBASE_STORAGE_BUCKET

  if (!projectId) throw new Error('FIREBASE_PROJECT_ID not set in .env')

  // Auto-correct the wrong bucket suffix.
  // GCP console shows .firebasestorage.app but Admin SDK needs .appspot.com
  // if (bucket && bucket.endsWith('.firebasestorage.app')) {
  //   const corrected = bucket.replace('.firebasestorage.app', '.appspot.com')
  //   console.warn('⚠️   FIREBASE_STORAGE_BUCKET ends with .firebasestorage.app — Admin SDK needs .appspot.com')
  //   console.warn(`    Auto-correcting to: ${corrected}`)
  //   bucket = corrected
  // }

  const credentials = resolveCredentials()

  if (credentials) {
    admin.initializeApp({
      credential:    admin.credential.cert(credentials),
      projectId,
      storageBucket: bucket,
    })
    const source = process.env.SA_CLIENT_EMAIL ? 'individual SA_ fields' : 'GOOGLE_SERVICE_ACCOUNT_JSON'
    console.log(`✅  Firebase Admin initialised (${source})`)
    // console.log('    Project:', projectId)
    // console.log('    SA email:', credentials.client_email)
    if (bucket) console.log('    Storage bucket:')
  } else {
    // ADC fallback — only works locally with: gcloud auth application-default login
    admin.initializeApp({ projectId, storageBucket: bucket })
    console.log('✅  Firebase Admin initialised (ADC fallback)')
    console.warn('    ⚠️  No credentials found — add SA_ fields or GOOGLE_SERVICE_ACCOUNT_JSON to .env')
  }

  db      = admin.firestore()
  auth    = admin.auth()
  storage = admin.storage().bucket()
  adminReady = true

} catch (err) {
  console.warn('⚠️   Firebase Admin failed:', err.message)
  console.warn('    Check SA_CLIENT_EMAIL + SA_PRIVATE_KEY (or GOOGLE_SERVICE_ACCOUNT_JSON) in .env')
}

export { admin, db, auth, storage, adminReady }