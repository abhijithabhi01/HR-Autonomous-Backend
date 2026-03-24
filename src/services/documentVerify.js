// src/services/documentVerify.js
// Document verification pipeline:
//   Step 1 — Gemini 2.5 Flash (Vertex AI) identifies WHAT the document is.
//             If it doesn't match the expected type, reject immediately.
//   Step 2 — Document AI extracts structured fields.
//   Step 3 — Gemini 2.5 Flash (Vertex AI) as fallback if Document AI
//             returns < 2 fields.

import { VertexAI } from '@google-cloud/vertexai'
import { docAiClient, DOC_AI_PROJECT, DOC_AI_LOCATION, PROCESSOR_IDS } from '../config/documentai.js'

// ── Vertex AI client (shared with policy.js auth pattern) ─────
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
  const creds = buildVertexCredentials()
  const location = process.env.VERTEX_LOCATION || 'us-central1'
  vertexAI = new VertexAI({
    project: process.env.FIREBASE_PROJECT_ID,
    location,
    ...(creds ? { googleAuthOptions: { credentials: creds } } : {}),
  })
  console.log('✅  DocumentVerify: Vertex AI ready (gemini-2.5-flash)')
} catch (err) {
  console.warn('⚠️  DocumentVerify: Vertex AI init failed:', err.message)
}

// Helper: call Gemini 2.5 Flash via Vertex AI with an image
async function callGeminiVision(base64, mimeType, promptText) {
  if (!vertexAI) throw new Error('Vertex AI not initialised — check service account credentials')
  const model = vertexAI.getGenerativeModel({ model: 'gemini-2.5-flash' })
  const result = await model.generateContent({
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType, data: base64 } },
        { text: promptText },
      ],
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 800 },
  })
  return result.response?.candidates?.[0]?.content?.parts?.[0]?.text || ''
}

// ── Human-readable labels for error messages ──────────────────
const DOC_LABELS = {
  passport: 'passport',
  visa: 'visa / work permit',
  degree: 'degree / graduation certificate',
  employment_letter: 'offer letter / employment letter',
  bank_details: 'bank document (passbook or account certificate)',
  aadhaar: 'Aadhaar card',
  pan_card: 'PAN card',
}

// ── Step 1: Gemini identifies what document was uploaded ───────
// Returns { type, geminiRan }
//   type      — one of the DOC_LABELS keys, or 'unknown'
//   geminiRan — true if Gemini responded (even with 'unknown')
//               false if the call itself failed (network/auth error)
//
// Key rule:
//   geminiRan=true  + type='unknown' → unrecognised doc (receipt, form…) → REJECT
//   geminiRan=false                  → Gemini unavailable → ALLOW (fail-open)
async function identifyDocumentType(base64, mimeType) {
  const allowedTypes = Object.keys(DOC_LABELS).join(', ')
  const prompt =
    `You are a document verification system. Look at this document carefully.\n` +
    `Identify what type of document it is.\n` +
    `Respond with ONLY one of these exact values and nothing else — no punctuation, no explanation:\n` +
    `${allowedTypes}, unknown\n\n` +
    `If the document is a receipt, invoice, form, tax document, or anything not in the list above, respond: unknown`

  try {
    const raw = await callGeminiVision(base64, mimeType, prompt)
    const detected = raw.trim().toLowerCase().replace(/[^a-z_]/g, '')
    const type = DOC_LABELS[detected] ? detected : 'unknown'
    console.log(`[documentVerify] Gemini identified: "${detected}" → type: ${type}`)
    return { type, geminiRan: true }
  } catch (err) {
    console.warn('[documentVerify] Identification call failed (fail-open):', err.message)
    return { type: 'unknown', geminiRan: false }
  }
}

// ── Field templates & maps (unchanged) ───────────────────────
const FIELD_TEMPLATES = {
  passport: '{"name":"","passport_number":"","date_of_birth":"","nationality":"","expiry_date":"","is_authentic":true,"confidence":90,"flags":[]}',
  visa: '{"visa_type":"","holder_name":"","country":"","expiry_date":"","permitted_activities":"","is_authentic":true,"confidence":90,"flags":[]}',
  degree: '{"student_name":"","institution":"","degree":"","field_of_study":"","graduation_year":"","is_authentic":true,"confidence":88,"flags":[]}',
  employment_letter: '{"employee_name":"","company":"","position":"","start_date":"","end_date":"","is_authentic":true,"confidence":85,"flags":[]}',
  bank_details: '{"account_holder":"","bank_name":"","account_type":"","account_number":"","ifsc_code":"","is_authentic":true,"confidence":90,"flags":[]}',
  aadhaar: '{"name":"","aadhaar_number":"","date_of_birth":"","gender":"","address":"","is_authentic":true,"confidence":90,"flags":[]}',
  pan_card: '{"name":"","pan_number":"","father_name":"","date_of_birth":"","is_authentic":true,"confidence":90,"flags":[]}',
}

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
  const map = FIELD_MAPS[docType] || {}
  const result = { ...fields }
  Object.entries(map).forEach(([raw, normalized]) => {
    if (fields[raw] && !result[normalized]) result[normalized] = fields[raw]
  })
  return result
}

// ── Raw text parsers (unchanged) ──────────────────────────────

function mrzDate(yymmdd) {
  if (!yymmdd || yymmdd.length < 6) return ''
  const yy = parseInt(yymmdd.slice(0, 2))
  const mm = yymmdd.slice(2, 4)
  const dd = yymmdd.slice(4, 6)
  const year = yy <= 30 ? 2000 + yy : 1900 + yy
  return `${dd}/${mm}/${year}`
}

function parseMRZLine2(line) {
  if (!line || line.length < 44) return {}
  const clean = line.replace(/\s/g, '')
  return {
    passport_number: clean.slice(0, 9).replace(/</g, '').trim(),
    nationality: clean.slice(10, 13).replace(/</g, '').trim(),
    date_of_birth: mrzDate(clean.slice(13, 19)),
    expiry_date: mrzDate(clean.slice(21, 27)),
    sex: clean.slice(20, 21),
  }
}

function parseVisaRawText(text) {
  const result = {}
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const LABELS = [
    { pattern: /^HOLDER\s*NAME$/i, field: 'holder_name' },
    { pattern: /^VISA\s*TYPE$/i, field: 'visa_type' },
    { pattern: /^COUNTRY$/i, field: 'country' },
    { pattern: /^EXPIRY\s*DATE$/i, field: 'expiry_date' },
    { pattern: /^DATE\s*OF\s*ISSUE$/i, field: 'issue_date' },
    { pattern: /^PERMITTED\s*ACTIVITIES$/i, field: 'permitted_activities' },
  ]
  for (let i = 0; i < lines.length - 1; i++) {
    for (const { pattern, field } of LABELS) {
      if (pattern.test(lines[i]) && !result[field]) {
        const val = lines[i + 1].trim()
        if (val && !LABELS.some(l => l.pattern.test(val))) result[field] = val
      }
    }
  }
  if (!result.holder_name) { const m = text.match(/HOLDER\s*NAME[:\s]+([A-Za-z\s]+)/i); if (m) result.holder_name = m[1].trim() }
  if (!result.visa_type) { const m = text.match(/VISA\s*TYPE[:\s]+([A-Za-z\s]+)/i); if (m) result.visa_type = m[1].trim() }
  if (!result.country) { const m = text.match(/COUNTRY[:\s]+([A-Za-z\s]+)/i); if (m) result.country = m[1].trim() }
  if (!result.expiry_date) { const m = text.match(/EXPIRY\s*DATE[:\s]+(\d{1,2}\s+\w+\s+\d{4}|\d{2}[\/\-]\d{2}[\/\-]\d{4})/i); if (m) result.expiry_date = m[1].trim() }
  if (!result.visa_type) { const m = text.match(/^(EMPLOYMENT VISA|WORK PERMIT|STUDENT VISA|TOURIST VISA|BUSINESS VISA)/im); if (m) result.visa_type = m[1] }
  return result
}

function parsePassportRawText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const result = {}
  const mrzLines = lines.filter(l => l.includes('<') && l.replace(/[^<]/g, '').length > 5)
  if (mrzLines.length >= 2) {
    Object.assign(result, parseMRZLine2(mrzLines[mrzLines.length - 1]))
    const mrz1 = mrzLines[mrzLines.length - 2]
    if (mrz1.startsWith('P<')) {
      const parts = mrz1.slice(5).split('<<')
      const surname = (parts[0] || '').replace(/</g, ' ').trim()
      const givenNames = (parts[1] || '').replace(/</g, ' ').trim()
      result.name = givenNames && surname ? `${givenNames} ${surname}`.trim() : surname || givenNames
    }
  }
  const natM = text.match(/NATIONALITY[\s\n]+([A-Za-z]+)/i); if (natM && !result.nationality) result.nationality = natM[1].trim()
  const nameM = text.match(/SURNAME\s*\/\s*GIVEN\s*NAMES?[\s\n]+([A-Za-z ,]+)/i); if (nameM && !result.name) { const raw = nameM[1].trim().replace(/\n/g, ' '); const parts = raw.split(',').map(s => s.trim()); result.name = parts.length > 1 ? `${parts[1]} ${parts[0]}`.trim() : raw }
  const pnoM = text.match(/PASSPORT\s*NO\.?[\s\n]+([A-Z][A-Z0-9]{6,9})/i); if (pnoM && !result.passport_number) result.passport_number = pnoM[1].trim()
  const dobM = text.match(/DATE\s*OF\s*BIRTH[\s\n]+(\d{1,2}[\s\/\-]\w+[\s\/\-]\d{2,4}|\d{2}[\/\-]\d{2}[\/\-]\d{4})/i); if (dobM && !result.date_of_birth) result.date_of_birth = dobM[1].trim()
  const expM = text.match(/DATE\s*OF\s*EXPIRY[\s\n]+(\d{1,2}[\s\/\-]\w+[\s\/\-]\d{2,4}|\d{2}[\/\-]\d{2}[\/\-]\d{4})/i); if (expM && !result.expiry_date) result.expiry_date = expM[1].trim()
  return result
}

function parseAadhaarRawText(text) {
  const result = {}
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const fullNum = text.match(/\b(\d{4}\s\d{4}\s\d{4})\b/)
  if (fullNum) result.aadhaar_number = fullNum[1]
  if (!result.aadhaar_number) { const m = text.match(/\b(\d{12})\b/); if (m) result.aadhaar_number = m[1].replace(/(\d{4})(\d{4})(\d{4})/, '$1 $2 $3') }
  if (!result.aadhaar_number) { const m = text.match(/[xX*]{4}\s[xX*]{4}\s(\d{4})/); if (m) result.aadhaar_number = `XXXX XXXX ${m[1]}` }
  const dobM = text.match(/(?:Date\s*of\s*Birth|DOB)[\s\/:\-]+(\d{2}[\/\-]\d{2}[\/\-]\d{4})/i)
  if (dobM) result.date_of_birth = dobM[1]
  if (!result.date_of_birth) { const m = text.match(/(\d{2}[\/\-]\d{2}[\/\-]\d{4})/); if (m) result.date_of_birth = m[1] }
  const genderM = text.match(/\b(Male|Female)(?:\s*\/\s*(?:MALE|FEMALE))?/i)
  if (genderM) result.gender = genderM[1].charAt(0).toUpperCase() + genderM[1].slice(1).toLowerCase()
  if (!result.gender) { const m = text.match(/\b(MALE|FEMALE)\b/); if (m) result.gender = m[1].charAt(0) + m[1].slice(1).toLowerCase() }
  for (let i = 0; i < lines.length - 1; i++) {
    if (/Name\s*[/|]\s*(नाम)?/i.test(lines[i]) && !lines[i].match(/Malayalam|मलयालम/i)) {
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        if (/^[A-Za-z][A-Za-z\s\.]{1,50}$/.test(lines[j]) && lines[j].trim().split(' ').length <= 5) { result.name = lines[j].trim(); break }
      }
      if (result.name) break
    }
  }
  if (!result.name) {
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      const l = lines[i]
      if (/^[A-Z][a-z]+(?:\s[A-Z][a-z]+)*$/.test(l) && l.split(' ').length <= 5 && l.length >= 3 && l.length <= 50 && !/(?:Date|Birth|Male|Female|Address|Government|India|Aadhaar)/i.test(l)) { result.name = l; break }
    }
  }
  if (!result.name) { const m = text.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)(?:\n|\r)/m); if (m) result.name = m[1].trim() }
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^Address$/i.test(lines[i])) {
      const addrParts = []
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) { if (/^[A-Za-z0-9,\s\-\.]+$/.test(lines[j]) && lines[j].length > 2) addrParts.push(lines[j]); else break }
      if (addrParts.length) { result.address = addrParts.join(', '); break }
    }
  }
  if (!result.address) { const m = text.match(/Address:[\s\S]*?([A-Z]\/O\s+[A-Za-z\s]+,[^\n]+)/i); if (m) result.address = m[1].trim() }
  return result
}

function parsePanRawText(text) {
  const result = {}
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const panM = text.match(/\b([A-Z]{5}[0-9]{4}[A-Z])\b/)
  if (panM) result.pan_number = panM[1]
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase()
    if (l === 'name' && lines[i + 1]) { const c = lines[i + 1].trim(); if (/^[A-Z\s]+$/.test(c) && c.length > 1 && c.length < 50) result.name = c }
    if ((l === "father's name" || l === 'fathers name') && lines[i + 1]) { const c = lines[i + 1].trim(); if (/^[A-Z\s]+$/.test(c) && c.length > 1) result.father_name = c }
    if ((l === 'date of birth' || l === 'dob') && lines[i + 1]) { const m = lines[i + 1].match(/(\d{2}[\/\-]\d{2}[\/\-]\d{4})/); if (m) result.date_of_birth = m[1] }
  }
  if (!result.date_of_birth) { const m = text.match(/(\d{2}[\/\-]\d{2}[\/\-]\d{4})/); if (m) result.date_of_birth = m[1] }
  if (!result.name) {
    const skipWords = ['INCOME', 'GOVT', 'GOVERNMENT', 'DEPARTMENT', 'PERMANENT', 'ACCOUNT', 'NUMBER']
    for (const line of lines) { if (/^[A-Z][A-Z\s]{2,40}$/.test(line) && !skipWords.some(w => line.includes(w))) { result.name = line.trim(); break } }
  }
  return result
}

function parseBankRawText(text) {
  const result = {}
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  // 🔥 STRATEGY 0 — Direct label → next line mapping (most reliable)
  for (let i = 0; i < lines.length - 1; i++) {
    const current = lines[i].toLowerCase().trim()
    const next = lines[i + 1].trim()

    for (const [label, field] of Object.entries(LABEL_KEYS)) {
      if (current === label && next && !LABEL_KEYS[next.toLowerCase()]) {
        if (!result[field]) result[field] = next
      }
    }
  }
  // 🔥 STRATEGY 1 — Inline "Label    Value"
  for (const line of lines) {
    const m = line.match(/^(.+?)\s{2,}(.+)$/)
    if (!m) continue

    const key = m[1].toLowerCase().trim()
    const val = m[2].trim()

    const field = LABEL_KEYS[key]
    if (field && !result[field]) {
      result[field] = val
    }
  }
  // 🔥 STRONG fallback for account holder (fix your issue)
  if (!result.account_holder) {
    const m = text.match(/Account\s*Holder\s*(?:Name)?[:\s]+([A-Z][A-Z\s]+)/i)
    if (m) result.account_holder = m[1].trim()
  }
  const LABEL_KEYS = {
    'account holder name': 'account_holder', 'account holder': 'account_holder',
    'account number': 'account_number', 'account no': 'account_number',
    'account type': 'account_type', 'type of account': 'account_type',
    'bank name': 'bank_name', 'name of bank': 'bank_name',
    'ifsc code': 'ifsc_code', 'ifsc': 'ifsc_code',
    'branch': 'branch', 'branch name': 'branch',
  }
  const labelIndices = []
  lines.forEach((line, i) => { const key = LABEL_KEYS[line.toLowerCase()]; if (key) labelIndices.push({ i, key }) })
  if (labelIndices.length >= 3) {
    const totalLabels = labelIndices.length
    const midPoint = Math.ceil(totalLabels / 2)
    const leftLabels = labelIndices.slice(0, midPoint)
    const rightLabels = labelIndices.slice(midPoint)
    const leftEnd = rightLabels.length > 0 ? rightLabels[0].i : lines.length
    const valueLines = lines.slice(leftEnd).filter(l => !LABEL_KEYS[l.toLowerCase()])
    leftLabels.forEach(({ key }, idx) => { if (valueLines[idx]) result[key] = valueLines[idx].trim() })
  }
  if (!result.account_number) { const m = text.match(/\b(\d{9,18})\b/); if (m) result.account_number = m[1] }
  if (!result.ifsc_code) { const m = text.match(/\b([A-Z]{4}0[A-Z0-9]{6})\b/); if (m) result.ifsc_code = m[1] }
  if (!result.account_holder) { const m = text.match(/(?:Account\s*Holder|A\/C\s*Name)[:\s]+([A-Za-z\s]+)/i); if (m) result.account_holder = m[1].trim() }
  if (!result.bank_name) {
    for (const line of lines) { if (/(?:Bank|Financial)\b/i.test(line) && line.length > 5 && line.length < 60) { result.bank_name = line.trim(); break } }
  }
  return result
}

function parseDegreeRawText(text) {
  const result = {}
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  for (let i = 0; i < lines.length - 1; i++) {
    if (/certify\s+that/i.test(lines[i])) {
      const c = lines[i + 1]
      if (c && /^[A-Za-z\s\.]+$/.test(c) && c.length < 60) { result.student_name = c.trim(); break }
    }
  }
  for (let i = 0; i < lines.length - 1; i++) {
    if (/degree\s+of/i.test(lines[i]) || /awarded.*degree/i.test(lines[i])) {
      const c = lines[i + 1]; if (c && c.length < 80) { result.degree = c.trim(); break }
    }
    const m = lines[i].match(/degree\s+of\s+([A-Za-z\s]+)/i); if (m) { result.degree = m[1].trim(); break }
  }
  if (result.degree) {
    const idx = lines.findIndex(l => l.includes(result.degree))
    if (idx >= 0 && lines[idx + 1]) { const m = lines[idx + 1].match(/^in\s+(.+)$/i); if (m) result.field_of_study = m[1].trim() }
  }
  for (const line of lines) { if (/(?:college|university|institute)/i.test(line) && line.length > 10) { result.institution = line.trim(); break } }
  const convM = text.match(/Convocation[:\s]+.*?(\d{4})/i); if (convM) result.graduation_year = convM[1]
  if (!result.graduation_year) { const years = [...text.matchAll(/\b(20\d{2})\b/g)].map(m => m[1]); if (years.length) result.graduation_year = years[years.length - 1] }
  return result
}

function parseRawText(text, docType) {
  if (!text) return {}
  switch (docType) {
    case 'passport': return parsePassportRawText(text)
    case 'visa': return parseVisaRawText(text)
    case 'aadhaar': return parseAadhaarRawText(text)
    case 'pan_card': return parsePanRawText(text)
    case 'bank_details': return parseBankRawText(text)
    case 'degree': return parseDegreeRawText(text)
    default: return {}
  }
}

// ── Step 2: Document AI extraction ────────────────────────────
async function verifyWithDocumentAI(base64, mimeType, documentType) {
  if (!docAiClient) throw new Error('Document AI client not initialized — check SA_ credentials')
  if (!DOC_AI_PROJECT) throw new Error('DOCUMENT_AI_PROJECT_ID not set')

  const processorId = PROCESSOR_IDS[documentType] || PROCESSOR_IDS.passport
  if (!processorId) throw new Error('PROCESSOR_ID_DEFAULT missing — set it in .env')

  const name = `projects/${DOC_AI_PROJECT}/locations/${DOC_AI_LOCATION}/processors/${processorId}`
  console.log(`[documentVerify] Document AI → ${name} | type: ${documentType}`)

  let result
  try {
    ;[result] = await docAiClient.processDocument({ name, rawDocument: { content: base64, mimeType } })
  } catch (err) {
    const msg = err?.message || String(err)
    if (msg.includes('INVALID_ARGUMENT')) throw new Error(`Document AI INVALID_ARGUMENT — check location, processor ID, and mimeType "${mimeType}"`)
    if (msg.includes('NOT_FOUND') || msg.includes('404')) throw new Error(`Processor not found: "${processorId}" in ${DOC_AI_PROJECT}/${DOC_AI_LOCATION}`)
    if (msg.includes('PERMISSION_DENIED') || msg.includes('403')) throw new Error('Permission denied — add "Document AI API User" role to service account')
    throw err
  }

  const doc = result?.document || {}
  const fields = {}
  console.log(`[documentVerify] entities: ${(doc.entities || []).length} | pages: ${(doc.pages || []).length} | text: ${(doc.text || '').length} chars`)

    ; (doc.entities || []).forEach(e => {
      const key = (e.type || '').toLowerCase().replace(/[^a-z0-9]/g, '_')
      const value = e.mentionText || e.normalizedValue?.text || ''
      if (key && value) fields[key] = value
    })
    ; (doc.pages || []).forEach(page => {
      ; (page.formFields || []).forEach(f => {
        const key = (f.fieldName?.textAnchor?.content || '').toLowerCase().replace(/[^a-z0-9]/g, '_').trim()
        const value = (f.fieldValue?.textAnchor?.content || '').trim()
        if (key && value) fields[key] = value
      })
    })

  const rawText = (doc.text || '').trim()
  let normalized = normalizeFields(fields, documentType)
  let entityCount = Object.keys(normalized).length

  if (entityCount === 0 && rawText) {
    console.log(`[documentVerify] 0 entities — parsing raw text (${rawText.length} chars)`)
    const parsed = parseRawText(rawText, documentType)
    console.log(`[documentVerify] Raw text parsed ${Object.keys(parsed).length} fields:`, JSON.stringify(parsed))
    normalized = { ...parsed }
    entityCount = Object.keys(parsed).length
  }

  if (entityCount === 0 && !rawText) throw new Error('Document AI returned 0 fields and no text')

  return {
    ...normalized,
    is_authentic: true,
    confidence: entityCount > 3 ? 88 : entityCount > 0 ? 72 : 50,
    flags: entityCount < 3 ? ['Partial extraction — please review fields'] : [],
    raw_text: rawText,
    _source: entityCount > 0 && Object.keys(fields).length === 0 ? 'raw_text_parser' : 'document_ai',
  }
}

// ── Step 3: Gemini 2.5 Flash extraction fallback ──────────────
const GEMINI_PROMPTS = {
  passport: `Extract from this passport image. Return ONLY valid JSON, no markdown:\n{"name":"full name","passport_number":"","date_of_birth":"DD/MM/YYYY","nationality":"","expiry_date":"DD/MM/YYYY","is_authentic":true,"confidence":88,"flags":[]}`,
  visa: `Extract from this visa/work permit. Return ONLY valid JSON, no markdown:\n{"visa_type":"","holder_name":"","country":"","expiry_date":"","permitted_activities":"","is_authentic":true,"confidence":85,"flags":[]}`,
  aadhaar: `Extract from this Aadhaar card (English text only). Return ONLY valid JSON, no markdown:\n{"name":"English name only","aadhaar_number":"XXXX XXXX XXXX","date_of_birth":"DD/MM/YYYY","gender":"Male or Female","address":"full address","is_authentic":true,"confidence":88,"flags":[]}`,
  pan_card: `Extract from this PAN card. Return ONLY valid JSON, no markdown:\n{"name":"CAPS name","pan_number":"ABCDE1234F","father_name":"CAPS name","date_of_birth":"DD/MM/YYYY","is_authentic":true,"confidence":88,"flags":[]}`,
  bank_details: `Extract from this bank document. Return ONLY valid JSON, no markdown:\n{"account_holder":"full name","bank_name":"full bank name","account_type":"Savings/Current/etc","account_number":"digits only","ifsc_code":"IFSC","is_authentic":true,"confidence":88,"flags":[]}`,
  degree: `Extract from this degree certificate. Return ONLY valid JSON, no markdown:\n{"student_name":"full name","institution":"college/university name","degree":"degree title","field_of_study":"field","graduation_year":"YYYY","is_authentic":true,"confidence":85,"flags":[]}`,
  employment_letter: `Extract from this offer/employment letter. Return ONLY valid JSON, no markdown:\n{"employee_name":"full name","company":"company name","position":"job title","start_date":"joining date","is_authentic":true,"confidence":85,"flags":[]}`,
}

async function verifyWithGemini(base64, mimeType, documentType) {
  const prompt = GEMINI_PROMPTS[documentType] ||
    `Extract all fields from this document. Return ONLY valid JSON: ${FIELD_TEMPLATES[documentType] || FIELD_TEMPLATES.passport}`

  const raw = await callGeminiVision(base64, mimeType, prompt)
  const clean = raw.replace(/```json|```/gi, '').trim()
  const parsed = JSON.parse(clean.match(/\{[\s\S]*\}/)?.[0] || clean)

  console.log(`[documentVerify] Gemini extracted fields for ${documentType}:`, JSON.stringify(parsed))
  return { ...parsed, _source: 'gemini' }
}

// ── Main export ───────────────────────────────────────────────
export async function verifyDocument(base64, mimeType, documentType) {

  // ── STEP 1: Gemini identifies what document was actually uploaded ──
  const { type: detectedType, geminiRan } = await identifyDocumentType(base64, mimeType)

  // Case A: Gemini ran and identified a completely different document type → reject
  if (geminiRan && detectedType !== 'unknown' && detectedType !== documentType) {
    const expected = DOC_LABELS[documentType] || documentType
    const detected = DOC_LABELS[detectedType] || detectedType
    const message = `Wrong document uploaded. You submitted a ${detected}, but we need your ${expected}. Please upload the correct document.`
    console.warn(`[documentVerify] Mismatch — expected: ${documentType}, got: ${detectedType}`)
    return {
      is_authentic: false,
      confidence: 0,
      flags: [message],
      _source: 'gemini_identification',
      wrong_document: true,
      detected_type: detectedType,
      expected_type: documentType,
    }
  }

  // Case B: Gemini ran and returned 'unknown' → not a valid document at all → reject
  if (geminiRan && detectedType === 'unknown') {
    const expected = DOC_LABELS[documentType] || documentType
    const message = `This file does not appear to be a valid ${expected}. Please upload the correct document (receipts, forms, and other files are not accepted).`
    console.warn(`[documentVerify] Rejected: Gemini could not identify document as any valid type`)
    return {
      is_authentic: false,
      confidence: 0,
      flags: [message],
      _source: 'gemini_identification',
      wrong_document: true,
      detected_type: 'unknown',
      expected_type: documentType,
    }
  }

  // Case C: Gemini itself failed (geminiRan=false) → fail-open, proceed to extraction
  if (!geminiRan) {
    console.warn('[documentVerify] Gemini identification unavailable — proceeding to extraction without pre-check')
  }

  // ── STEP 2: Document AI extraction ───────────────────────────
  let docAiResult = null
  let rawText = ''

  try {
    docAiResult = await verifyWithDocumentAI(base64, mimeType, documentType)
    rawText = docAiResult.raw_text || ''

    const fieldCount = Object.keys(docAiResult).filter(k =>
      !['is_authentic', 'confidence', 'flags', 'raw_text', '_source'].includes(k) && docAiResult[k]
    ).length

    if (fieldCount >= 2) {
      console.log(`[documentVerify] Document AI: ${fieldCount} fields extracted`)
      return { ...docAiResult, is_authentic: true }
    }
    console.log(`[documentVerify] Document AI got ${fieldCount} fields — falling back to Gemini`)
  } catch (err) {
    console.warn(`[documentVerify] Document AI failed: ${err.message}`)
  }

  // ── STEP 3: Gemini extraction fallback ────────────────────────
  let geminiResult = null
  try {
    geminiResult = await verifyWithGemini(base64, mimeType, documentType)
    if (!rawText && geminiResult) rawText = geminiResult.raw_text || ''
  } catch (err) {
    console.error('[documentVerify] Gemini extraction failed:', err.message)
  }

  const countFields = r => r ? Object.keys(r).filter(k =>
    !['is_authentic', 'confidence', 'flags', 'raw_text', '_source', 'wrong_document', 'detected_type', 'expected_type'].includes(k) && r[k]
  ).length : 0

  const bestResult = countFields(geminiResult) >= countFields(docAiResult) ? geminiResult : docAiResult

  if (!bestResult) {
    return { is_authentic: null, confidence: 0, flags: ['Extraction failed — both Document AI and Gemini unavailable'], _source: 'error' }
  }

  const fc = countFields(bestResult)
  console.log(`[documentVerify] Final: ${fc} fields from ${bestResult._source || 'gemini'}`)
  return { ...bestResult, is_authentic: true, confidence: bestResult.confidence || 85 }
}