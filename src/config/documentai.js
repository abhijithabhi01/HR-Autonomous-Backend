// src/config/documentai.js
// Google Document AI client — shared across route files.

import { DocumentProcessorServiceClient } from '@google-cloud/documentai'

export const DOC_AI_PROJECT  = process.env.DOCUMENT_AI_PROJECT_ID || process.env.FIREBASE_PROJECT_ID
export const DOC_AI_LOCATION = process.env.DOCUMENT_AI_LOCATION   || 'us'

// Validate processor ID — reject the placeholder value from the .env template
function resolveProcessorId(envVar, fallback) {
  const val = envVar || fallback
  if (!val || val === 'your_por_id_here' || val.length < 8) return null
  return val
}

const DEFAULT_ID = resolveProcessorId(null, process.env.PROCESSOR_ID_DEFAULT)

// Map document types to processor IDs.
// Set PROCESSOR_ID_DEFAULT in .env for a catch-all processor.
// Optionally set per-type processors for better accuracy.
export const PROCESSOR_IDS = {
  passport:          resolveProcessorId(process.env.PROCESSOR_ID_PASSPORT,          DEFAULT_ID),
  visa:              resolveProcessorId(process.env.PROCESSOR_ID_VISA,               DEFAULT_ID),
  degree:            resolveProcessorId(process.env.PROCESSOR_ID_DEGREE,             DEFAULT_ID),
  employment_letter: resolveProcessorId(process.env.PROCESSOR_ID_EMPLOYMENT_LETTER,  DEFAULT_ID),
  bank_details:      resolveProcessorId(process.env.PROCESSOR_ID_BANK_DETAILS,       DEFAULT_ID),
  aadhaar:           resolveProcessorId(process.env.PROCESSOR_ID_AADHAAR,            DEFAULT_ID),
  pan_card:          resolveProcessorId(process.env.PROCESSOR_ID_PAN_CARD,           DEFAULT_ID),
}

let docAiClient = null

try {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  const opts   = saJson ? { credentials: JSON.parse(saJson) } : {}
  docAiClient  = new DocumentProcessorServiceClient(opts)

  if (!DOC_AI_PROJECT) {
    console.warn('⚠️   Document AI: DOCUMENT_AI_PROJECT_ID not set — extraction will fall back to Gemini')
  } else if (!DEFAULT_ID) {
    console.warn('⚠️   Document AI: PROCESSOR_ID_DEFAULT is missing or still set to placeholder "your_por_id_here"')
    console.warn('    → Go to GCP Console → Document AI → your processor → copy the Processor ID')
    console.warn('    → Add to .env:  PROCESSOR_ID_DEFAULT=<your_real_id>')
    console.warn('    → Document AI extraction will fall back to Gemini until this is set')
  } else {
    console.log('✅  Document AI client initialised')
    // console.log('    Project:', DOC_AI_PROJECT, '| Location:', DOC_AI_LOCATION)
    // console.log('    Default processor ID:', DEFAULT_ID)
  }
} catch (err) {
  console.warn('⚠️   Document AI unavailable:', err.message)
}

export { docAiClient }