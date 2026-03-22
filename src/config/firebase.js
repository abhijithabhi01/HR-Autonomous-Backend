// src/config/firebase.js
// Firebase Admin SDK — single initialization shared across all route files.

import admin from 'firebase-admin'

let adminReady = false
let db, auth, storage

try {
  const saJson    = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  const projectId = process.env.FIREBASE_PROJECT_ID

  if (!projectId) throw new Error('FIREBASE_PROJECT_ID not set in .env')

  if (saJson) {
    const credentials = JSON.parse(saJson)
    admin.initializeApp({
      credential:    admin.credential.cert(credentials),
      projectId,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    })
    console.log('✅  Firebase Admin initialised (service account JSON)')
    console.log('    Project:', projectId)
    console.log('    SA email:', credentials.client_email)
  } else {
    // ADC fallback (local dev with gcloud auth application-default login)
    admin.initializeApp({
      projectId,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    })
    console.log('✅  Firebase Admin initialised (ADC)')
  }

  db      = admin.firestore()
  auth    = admin.auth()
  storage = admin.storage().bucket()
  adminReady = true

} catch (err) {
  console.warn('⚠️   Firebase Admin failed:', err.message)
  console.warn('    Set GOOGLE_SERVICE_ACCOUNT_JSON and FIREBASE_PROJECT_ID in .env')
}

export { admin, db, auth, storage, adminReady }