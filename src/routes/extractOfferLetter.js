// src/routes/extractOfferLetter.js
// POST /api/candidates/extract-offer-letter
// Accepts a base64-encoded offer letter (PDF or image),
// uses Gemini 2.5 Flash (Vertex AI) to:
//   1. Validate it IS an offer/employment letter (not a random doc)
//   2. Extract candidate fields: name, personal_email, position,
//      department, manager, location, start_date
// Returns { valid, fields, confidence, flags, raw }

import { Router } from 'express'
import { VertexAI } from '@google-cloud/vertexai'
import { firebaseGuard } from '../middleware/guard.js'

const router = Router()
router.use(firebaseGuard)

// ── Vertex AI client (mirrors documentVerify.js pattern) ─────
function buildVertexCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n')
    return parsed
  }
  if (process.env.SA_CLIENT_EMAIL && process.env.SA_PRIVATE_KEY) {
    return {
      type: 'service_account',
      client_email: process.env.SA_CLIENT_EMAIL,
      private_key: process.env.SA_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }
  }
  return null
}

let vertexAI = null
try {
  const creds    = buildVertexCredentials()
  const location = process.env.VERTEX_LOCATION || 'us-central1'
  vertexAI = new VertexAI({
    project: process.env.FIREBASE_PROJECT_ID,
    location,
    ...(creds ? { googleAuthOptions: { credentials: creds } } : {}),
  })
  console.log('✅  extractOfferLetter: Vertex AI ready')
} catch (err) {
  console.warn('⚠️  extractOfferLetter: Vertex AI init failed:', err.message)
}

async function callGemini(base64, mimeType, prompt) {
  if (!vertexAI) throw new Error('Vertex AI not initialised')
  const model  = vertexAI.getGenerativeModel({ model: 'gemini-2.5-flash' })
  const result = await model.generateContent({
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType, data: base64 } },
        { text: prompt },
      ],
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1200 },
  })
  return result.response?.candidates?.[0]?.content?.parts?.[0]?.text || ''
}

// ── Known departments (mirrors frontend DEPARTMENTS list) ──────
const KNOWN_DEPARTMENTS = [
  'Engineering', 'Product', 'Design', 'Marketing',
  'Finance', 'HR', 'Operations', 'Sales', 'Legal',
]

// Fuzzy-match extracted department to a known one.
function matchDepartment(raw) {
  if (!raw) return null
  const normalised = raw.trim().toLowerCase()
  const match = KNOWN_DEPARTMENTS.find(d => normalised.includes(d.toLowerCase()))
  return match || null
}

// Parse a flexible date string (DD/MM/YYYY, Month DD YYYY, YYYY-MM-DD, etc.)
// and return a JS Date object suitable for the DatePicker (or null).
function parseFlexDate(raw) {
  if (!raw) return null
  const s = raw.trim()

  // Already ISO
  let d = new Date(s)
  if (!isNaN(d)) return d

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)
  if (dmy) {
    d = new Date(`${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`)
    if (!isNaN(d)) return d
  }

  // "1st January 2025", "January 1 2025"
  d = new Date(s.replace(/(\d+)(st|nd|rd|th)/, '$1'))
  if (!isNaN(d)) return d

  return null
}

// ── POST /api/candidates/extract-offer-letter ─────────────────
router.post('/extract-offer-letter', async (req, res) => {
  const { base64, mimeType } = req.body

  if (!base64 || !mimeType) {
    return res.status(400).json({ error: 'base64 and mimeType are required' })
  }

  if (!vertexAI) {
    return res.status(503).json({ error: 'Gemini (Vertex AI) not available — check SA credentials' })
  }

  // ── Step 1: Validate document type ───────────────────────────
  let isOfferLetter = false
  try {
    const identPrompt =
      'Look at this document carefully.\n' +
      'Is it an offer letter or employment letter from a company to a new hire?\n' +
      'Respond with ONLY one word — yes or no. No punctuation, no explanation.'

    const raw = (await callGemini(base64, mimeType, identPrompt)).trim().toLowerCase().replace(/[^a-z]/g, '')
    isOfferLetter = raw === 'yes'
    console.log(`[extractOfferLetter] Document check → "${raw}" isOfferLetter=${isOfferLetter}`)
  } catch (err) {
    console.warn('[extractOfferLetter] Identification failed (fail-open):', err.message)
    // Fail-open: proceed even if identification fails
    isOfferLetter = true
  }

  if (!isOfferLetter) {
    return res.json({
      valid: false,
      fields: {},
      confidence: 0,
      flags: [
        'This does not appear to be an offer letter or employment letter. ' +
        'Please upload the candidate\'s official offer letter.',
      ],
    })
  }

  // ── Step 2: Extract fields ────────────────────────────────────
  const extractPrompt =
    'This is an offer letter / employment letter. Extract the following fields.\n' +
    'Return ONLY a valid JSON object with these exact keys — no markdown, no explanation:\n' +
    '{\n' +
    '  "full_name": "candidate full name as written in the letter",\n' +
    '  "personal_email": "candidate personal email if visible, else empty string",\n' +
    '  "position": "job title / role being offered",\n' +
    '  "department": "department name if mentioned, else empty string",\n' +
    '  "manager": "reporting manager name if mentioned, else empty string",\n' +
    '  "location": "work location / office city if mentioned, else empty string",\n' +
    '  "start_date": "joining date in DD/MM/YYYY or Month DD YYYY format, else empty string",\n' +
    '  "company": "issuing company name",\n' +
    '  "confidence": <integer 0-100 reflecting overall extraction confidence>,\n' +
    '  "flags": ["any caveats or uncertain fields as strings"]\n' +
    '}'

  let extracted = {}
  try {
    const raw   = await callGemini(base64, mimeType, extractPrompt)
    const clean = raw.replace(/```json|```/gi, '').trim()
    const match = clean.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON object in Gemini response')
    extracted = JSON.parse(match[0])
    console.log('[extractOfferLetter] Extracted fields:', JSON.stringify(extracted))
  } catch (err) {
    console.error('[extractOfferLetter] Extraction failed:', err.message)
    return res.status(500).json({ error: 'Field extraction failed: ' + err.message })
  }

  // ── Step 3: Normalise & coerce types ─────────────────────────
  const startDateObj  = parseFlexDate(extracted.start_date)
  const department    = matchDepartment(extracted.department)

  const fields = {
    full_name:      (extracted.full_name     || '').trim(),
    personal_email: (extracted.personal_email || '').trim(),
    position:       (extracted.position      || '').trim(),
    department:     department || (extracted.department || '').trim(),
    manager:        (extracted.manager       || '').trim(),
    location:       (extracted.location      || '').trim(),
    // Return ISO string so JSON serialises cleanly;
    // frontend will do `new Date(fields.start_date)` before putting it in state.
    start_date:     startDateObj ? startDateObj.toISOString() : null,
  }

  return res.json({
    valid:      true,
    fields,
    confidence: extracted.confidence || 80,
    flags:      Array.isArray(extracted.flags) ? extracted.flags : [],
    meta: {
      company:       (extracted.company || '').trim(),
      raw_start_date: extracted.start_date || null,
    },
  })
})

export default router