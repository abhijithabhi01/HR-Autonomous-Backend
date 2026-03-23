// src/routes/policy.js
import { Router }      from 'express'
import { VertexAI }    from '@google-cloud/vertexai'
import { db, storage } from '../config/firebase.js'
import { firebaseGuard } from '../middleware/guard.js'

const router = Router()
router.use(firebaseGuard)

// ── Vertex AI client ───────────────────────────────────────────
// Reuses the same service account creds already in .env for Firebase Admin.
function buildCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n')
    return parsed
  }
  if (process.env.SA_CLIENT_EMAIL && process.env.SA_PRIVATE_KEY) {
    return {
      type:         'service_account',
      client_email: process.env.SA_CLIENT_EMAIL,
      private_key:  process.env.SA_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }
  }
  return null // falls back to ADC
}

let vertexAI = null
try {
  const creds    = buildCredentials()
  const location = process.env.VERTEX_LOCATION || 'us-central1'
  vertexAI = new VertexAI({
    project:  process.env.FIREBASE_PROJECT_ID,
    location,
    ...(creds ? { googleAuthOptions: { credentials: creds } } : {}),
  })
  console.log('✅  Vertex AI ready → gemini-1.5-flash @', location)
} catch (err) {
  console.warn('⚠️  Vertex AI init failed:', err.message)
}

// ── Helpers ────────────────────────────────────────────────────
function configRef() {
  return db.collection('policy_config').doc('main')
}

const FALLBACK_POLICY = `
COMPANY INFORMATION:
- Company Name: D Company
- Headquarters: 4th Floor, InfoPark Building, Kochi, Kerala 682030, India
- General Inquiries: info@dcompany.com
- HR Contact: hr@dcompany.com

LEAVE POLICY:
- Annual Leave: 21 days per calendar year
- Sick Leave: 10 days per year (certificate after 2 consecutive days)
- Maternity Leave: 90 days paid. Paternity Leave: 5 days paid
- Emergency Leave: 3 days per year
- Annual leave requires manager approval 2 weeks in advance

REMOTE WORK POLICY:
- Up to 2 days/week for eligible roles. Core hours: 10 AM–4 PM local time
- Not available during probation (first 3 months)

TRAVEL & EXPENSES:
- International travel needs department head pre-approval
- Claims within 30 days. Receipts required above AED 50
- Economy < 5 hrs; Business class permitted > 5 hrs

IT & EQUIPMENT:
- Laptop issued Day 1. Personal devices need IT registration for VPN
- Requests: it@company.com

PROBATION: 3 months. Notice: 1 week during / 1 month staff / 3 months management after.

PAYROLL: Last working day of each month. Increments: January. Bonus review: December.
`

const FALLBACK_RULES = `
- Answer ONLY from the company policy provided. Never invent information.
- If a topic is not covered, say so and suggest contacting HR at hr@dcompany.com.
- Be concise, friendly, and professional.
`

// ── Chat logging ───────────────────────────────────────────────

router.post('/session', async (req, res) => {
  try {
    const ref = await db.collection('policy_sessions').add({ ...req.body, created_at: new Date().toISOString() })
    res.json({ id: ref.id })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/message', async (req, res) => {
  try {
    const ref = await db.collection('policy_messages').add({ ...req.body, created_at: new Date().toISOString() })
    res.json({ id: ref.id, session_id: req.body.session_id })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Policy config ──────────────────────────────────────────────

router.get('/config', async (req, res) => {
  try {
    const snap = await configRef().get()
    if (!snap.exists) return res.json({ rules: '', pdf_url: null, pdf_name: null })
    res.json(snap.data())
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/config', async (req, res) => {
  const { rules } = req.body
  if (typeof rules !== 'string') return res.status(400).json({ error: 'rules string required' })
  try {
    await configRef().set({ rules, updated_at: new Date().toISOString() }, { merge: true })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/upload-pdf', async (req, res) => {
  const { base64, mimeType, fileName } = req.body
  if (!base64 || !mimeType) return res.status(400).json({ error: 'base64 and mimeType required' })
  if (!storage) return res.status(503).json({ error: 'Storage not configured' })
  try {
    const safeName = (fileName || 'policy.pdf').replace(/[^a-zA-Z0-9._-]/g, '_')
    const path     = `policy_docs/${Date.now()}_${safeName}`
    const fileRef  = storage.file(path)
    await fileRef.save(Buffer.from(base64, 'base64'), { metadata: { contentType: mimeType } })
    const [url] = await fileRef.getSignedUrl({ action: 'read', expires: Date.now() + 365 * 24 * 60 * 60 * 1000 })
    await configRef().set(
      { pdf_url: url, pdf_name: fileName || 'policy.pdf', pdf_mime: mimeType, pdf_path: path, updated_at: new Date().toISOString() },
      { merge: true }
    )
    console.log('[policy] PDF uploaded:', path)
    res.json({ success: true, pdf_url: url, pdf_name: fileName })
  } catch (err) {
    console.error('[policy/upload-pdf]', err.message)
    res.status(500).json({ error: err.message })
  }
})

router.delete('/pdf', async (req, res) => {
  try {
    const snap = await configRef().get()
    const data  = snap.exists ? snap.data() : {}
    if (data.pdf_path && storage) {
      try { await storage.file(data.pdf_path).delete() } catch (_) {}
    }
    await configRef().set(
      { pdf_url: null, pdf_name: null, pdf_mime: null, pdf_path: null, updated_at: new Date().toISOString() },
      { merge: true }
    )
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── POST /api/policy/chat ──────────────────────────────────────
// Calls gemini-2.5-flash via Vertex AI using service account credentials.
// PDF is referenced from GCS directly — nothing large is sent over the wire.
// Body: { question: string, history: [{role, content, id?}] }
router.post('/chat', async (req, res) => {
  if (!vertexAI) {
    return res.status(503).json({ error: 'Vertex AI not initialised — check service account config and FIREBASE_PROJECT_ID' })
  }

  const { question, history = [] } = req.body
  if (!question?.trim()) return res.status(400).json({ error: 'question is required' })

  try {
    // Load rules + pdf_path from Firestore
    const snap   = await configRef().get()
    const config = snap.exists ? snap.data() : {}
    const rules  = config.rules || FALLBACK_RULES
    const hasPdf = !!(config.pdf_path && process.env.FIREBASE_STORAGE_BUCKET)

    // System instruction
    const systemText =
      'You are a helpful HR Policy Assistant for D Company. ' +
      (hasPdf
        ? 'Answer questions using ONLY the attached company policy PDF. Never invent policies not present in the document.'
        : 'Answer questions using ONLY the company policy text provided below.') +
      '\n\nRULES:\n' + rules +
      (!hasPdf ? '\n\nCOMPANY POLICY:\n' + FALLBACK_POLICY : '')

    // Build contents
    // Turn 0 (user):  optional PDF fileData + system text
    // Turn 1 (model): acknowledgement
    // Turns 2–N:      conversation history
    // Last (user):    current question
    const openParts = []
    if (hasPdf) {
      const gcsUri = `gs://${process.env.FIREBASE_STORAGE_BUCKET}/${config.pdf_path}`
      openParts.push({ fileData: { mimeType: config.pdf_mime || 'application/pdf', fileUri: gcsUri } })
    }
    openParts.push({ text: systemText })

    const contents = [
      { role: 'user',  parts: openParts },
      { role: 'model', parts: [{ text: 'Understood. I will answer strictly from the provided policy.' }] },
    ]

    // Last 6 turns of history
    history.filter(m => m.id !== 'init').slice(-6).forEach(msg => {
      contents.push({ role: msg.role === 'user' ? 'user' : 'model', parts: [{ text: msg.content }] })
    })
    contents.push({ role: 'user', parts: [{ text: question }] })

    const model = vertexAI.getGenerativeModel({ model: 'gemini-2.5-flash' })
    const result = await model.generateContent({
      contents,
      generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
    })

    const answer = result.response?.candidates?.[0]?.content?.parts?.[0]?.text
      || 'Sorry, I could not generate a response.'

    res.json({ answer })
  } catch (err) {
    console.error('[policy/chat]', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router