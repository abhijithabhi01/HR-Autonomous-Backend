import { docAiClient, DOC_AI_PROJECT, DOC_AI_LOCATION, PROCESSOR_IDS } from '../config/documentai.js'

const FIELD_TEMPLATES = {
  passport:          '{"name":"","passport_number":"","date_of_birth":"","nationality":"","expiry_date":"","is_authentic":true,"confidence":90,"flags":[]}',
  visa:              '{"visa_type":"","holder_name":"","country":"","expiry_date":"","permitted_activities":"","is_authentic":true,"confidence":90,"flags":[]}',
  degree:            '{"student_name":"","institution":"","degree":"","field_of_study":"","graduation_year":"","is_authentic":true,"confidence":88,"flags":[]}',
  employment_letter: '{"employee_name":"","company":"","position":"","start_date":"","end_date":"","is_authentic":true,"confidence":85,"flags":[]}',
  bank_details:      '{"account_holder":"","bank_name":"","account_type":"","account_number":"","ifsc_code":"","is_authentic":true,"confidence":90,"flags":[]}',
  aadhaar:           '{"name":"","aadhaar_number":"","date_of_birth":"","gender":"","address":"","is_authentic":true,"confidence":90,"flags":[]}',
  pan_card:          '{"name":"","pan_number":"","father_name":"","date_of_birth":"","is_authentic":true,"confidence":90,"flags":[]}',
}

// Field name normalizer — maps Document AI raw names to app field names
const FIELD_MAPS = {
  passport: {
    given_names: 'name', surname: 'name', 'given-name': 'name',
    document_number: 'passport_number', doc_number: 'passport_number',
    expiration_date: 'expiry_date', expiry: 'expiry_date', valid_until: 'expiry_date',
    country_code: 'nationality', issuing_country: 'nationality',
    date_of_birth: 'date_of_birth', dob: 'date_of_birth',
  },
  aadhaar: {
    uid: 'aadhaar_number', uid_number: 'aadhaar_number',
    dob: 'date_of_birth', birth_date: 'date_of_birth',
  },
  pan_card: {
    permanent_account_number: 'pan_number', pan: 'pan_number',
    "father's_name": 'father_name', dob: 'date_of_birth',
  },
}

function normalizeFields(fields, docType) {
  const map    = FIELD_MAPS[docType] || {}
  const result = { ...fields }
  Object.entries(map).forEach(([raw, normalized]) => {
    if (fields[raw] && !result[normalized]) result[normalized] = fields[raw]
  })
  return result
}

// ── Document AI ───────────────────────────────────────────────
async function verifyWithDocumentAI(base64, mimeType, documentType) {
  // Check all requirements before making the API call
  if (!docAiClient) {
    throw new Error('Document AI client not initialized — check GOOGLE_SERVICE_ACCOUNT_JSON')
  }
  if (!DOC_AI_PROJECT) {
    throw new Error('DOCUMENT_AI_PROJECT_ID not set in .env')
  }

  const processorId = PROCESSOR_IDS[documentType] || PROCESSOR_IDS.passport
  if (!processorId) {
    throw new Error(
      'PROCESSOR_ID_DEFAULT is missing or still set to placeholder "your_por_id_here".\n' +
      'Go to GCP Console → Document AI → your processor → copy the Processor ID → add to .env'
    )
  }

  const name = `projects/${DOC_AI_PROJECT}/locations/${DOC_AI_LOCATION}/processors/${processorId}`

  let result
  try {
    ;[result] = await docAiClient.processDocument({
      name,
      rawDocument: { content: base64, mimeType },
    })
  } catch (err) {
    // Surface the underlying gRPC / HTTP error clearly
    const msg = err?.message || String(err)
    if (msg.includes('NOT_FOUND') || msg.includes('404')) {
      throw new Error(
        `Processor not found: "${processorId}" in project "${DOC_AI_PROJECT}" location "${DOC_AI_LOCATION}". ` +
        'Verify the Processor ID and DOCUMENT_AI_LOCATION in your .env match what is in GCP Console.'
      )
    }
    if (msg.includes('PERMISSION_DENIED') || msg.includes('403')) {
      throw new Error(
        'Permission denied calling Document AI. ' +
        'Go to GCP Console → IAM → your service account → add role "Document AI API User".'
      )
    }
    throw err
  }

  const doc    = result?.document || {}
  const fields = {}

  // Extract entities (ID Document Parser / specialized parsers)
  ;(doc.entities || []).forEach(e => {
    const key   = (e.type || '').toLowerCase().replace(/[^a-z0-9]/g, '_')
    const value = e.mentionText || e.normalizedValue?.text || ''
    if (key && value) fields[key] = value
  })

  // Extract form fields (Form Parser)
  ;(doc.pages || []).forEach(page => {
    ;(page.formFields || []).forEach(f => {
      const key   = (f.fieldName?.textAnchor?.content  || '').toLowerCase().replace(/[^a-z0-9]/g, '_').trim()
      const value = (f.fieldValue?.textAnchor?.content || '').trim()
      if (key && value) fields[key] = value
    })
  })

  // Extract raw text blocks as a fallback for processors that return text only
  const rawText = (doc.text || '').trim()

  const normalized  = normalizeFields(fields, documentType)
  const entityCount = Object.keys(normalized).length

  console.log(`[documentVerify] Document AI extracted ${entityCount} fields for ${documentType}`)

  if (entityCount === 0 && !rawText) {
    throw new Error(
      'Document AI returned 0 fields and no text. ' +
      'For Indian IDs (Aadhaar, PAN), use the "ID Document Parser" processor type in GCP Console — ' +
      'the generic OCR processor does not extract structured fields.'
    )
  }

  return {
    ...normalized,
    is_authentic: true,
    confidence:   entityCount > 3 ? 92 : rawText ? 70 : 50,
    flags:        entityCount === 0
      ? ['No structured fields extracted — raw text only. Consider using ID Document Parser processor.']
      : [],
    raw_text: rawText,
    _source:  'document_ai',
  }
}

// ── Gemini Vision fallback ────────────────────────────────────
async function verifyWithGemini(base64, mimeType, documentType) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set in .env')

  const template = FIELD_TEMPLATES[documentType] || FIELD_TEMPLATES.passport
  const prompt   = `You are an OCR system. Extract all visible text from this document image and return ONLY a JSON object matching this exact structure — no markdown, no explanation:\n${template}\nFill every field you can read. Use empty string "" for fields you cannot read.`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 800 },
      }),
    }
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `Gemini HTTP ${res.status}`)
  }

  const data   = await res.json()
  const raw    = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const clean  = raw.replace(/```json|```/gi, '').trim()
  const parsed = JSON.parse(clean.match(/\{[\s\S]*\}/)?.[0] || clean)

  console.log(`[documentVerify] Gemini extracted fields for ${documentType}`)
  return { ...parsed, _source: 'gemini' }
}

// ── Main export ───────────────────────────────────────────────
export async function verifyDocument(base64, mimeType, documentType) {
  // Try Document AI first
  try {
    return await verifyWithDocumentAI(base64, mimeType, documentType)
  } catch (err) {
    console.warn(`[documentVerify] Document AI failed (${err.message}), trying Gemini...`)
  }

  // Gemini fallback
  try {
    return await verifyWithGemini(base64, mimeType, documentType)
  } catch (err) {
    console.error('[documentVerify] Both methods failed:', err.message)
    return {
      is_authentic: null, confidence: 0,
      flags: ['Extraction failed: ' + err.message],
      _source: 'error',
    }
  }
}