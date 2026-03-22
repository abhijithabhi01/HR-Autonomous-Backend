// src/config/documentai.js
// Google Document AI client — shared across route files.

import { DocumentProcessorServiceClient } from '@google-cloud/documentai'

export const DOC_AI_PROJECT  = process.env.DOCUMENT_AI_PROJECT_ID || process.env.FIREBASE_PROJECT_ID
export const DOC_AI_LOCATION = process.env.DOCUMENT_AI_LOCATION   || 'us'

// Map document types to processor IDs.
// Set PROCESSOR_ID_DEFAULT in .env for a catch-all processor.
// Optionally set per-type processors for better accuracy.
export const PROCESSOR_IDS = {
  passport:          process.env.PROCESSOR_ID_PASSPORT          || process.env.PROCESSOR_ID_DEFAULT,
  visa:              process.env.PROCESSOR_ID_VISA               || process.env.PROCESSOR_ID_DEFAULT,
  degree:            process.env.PROCESSOR_ID_DEGREE             || process.env.PROCESSOR_ID_DEFAULT,
  employment_letter: process.env.PROCESSOR_ID_EMPLOYMENT_LETTER  || process.env.PROCESSOR_ID_DEFAULT,
  bank_details:      process.env.PROCESSOR_ID_BANK_DETAILS       || process.env.PROCESSOR_ID_DEFAULT,
  aadhaar:           process.env.PROCESSOR_ID_AADHAAR            || process.env.PROCESSOR_ID_DEFAULT,
  pan_card:          process.env.PROCESSOR_ID_PAN_CARD           || process.env.PROCESSOR_ID_DEFAULT,
}

let docAiClient = null

try {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  const opts   = saJson ? { credentials: JSON.parse(saJson) } : {}
  docAiClient  = new DocumentProcessorServiceClient(opts)
  console.log('✅  Document AI client initialised')
  if (DOC_AI_PROJECT) console.log('    Project:', DOC_AI_PROJECT, '| Location:', DOC_AI_LOCATION)
} catch (err) {
  console.warn('⚠️   Document AI unavailable:', err.message)
}

export { docAiClient }