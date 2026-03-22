// src/routes/documents.js
import { Router }        from 'express'
import { db, storage }   from '../config/firebase.js'
import { firebaseGuard } from '../middleware/guard.js'
import { verifyDocument } from '../services/documentVerify.js'

const router = Router()
router.use(firebaseGuard)

function now() { return new Date().toISOString() }

const LABEL_MAP = {
  passport: 'Passport', visa: 'Visa / Work Permit', degree: 'Degree Certificate',
  employment_letter: 'Employment Letter', bank_details: 'Bank Details',
  aadhaar: 'Aadhaar Card', pan_card: 'PAN Card',
}

function addExpiryStatus(d) {
  if (!d.expiry_date) return { ...d, expiry_status: 'ok', days_until_expiry: null }
  const days = Math.ceil((new Date(d.expiry_date) - new Date()) / 86400000)
  const expiry_status =
    days < 0   ? 'expired'  :
    days < 30  ? 'critical' :
    days < 90  ? 'warning'  :
    days < 180 ? 'notice'   : 'ok'
  return { ...d, expiry_status, days_until_expiry: days }
}

// GET /api/documents/:candidateId
router.get('/:candidateId', async (req, res) => {
  try {
    const snap = await db.collection('documents')
      .where('candidate_id', '==', req.params.candidateId)
      .orderBy('type').get()
    res.json(snap.docs.map(d => addExpiryStatus({ id: d.id, ...d.data() })))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST /api/documents/upload — receives base64 file, uploads to Firebase Storage
router.post('/upload', async (req, res) => {
  const { candidateId, docType, base64, mimeType, fileName, extractedData } = req.body
  if (!candidateId || !docType || !base64 || !mimeType)
    return res.status(400).json({ error: 'candidateId, docType, base64 and mimeType required' })

  try {
    const ext      = (fileName || 'file').split('.').pop()
    const path     = `documents/${candidateId}/${docType}_${Date.now()}.${ext}`
    const fileRef  = storage.file(path)
    const buffer   = Buffer.from(base64, 'base64')

    await fileRef.save(buffer, { metadata: { contentType: mimeType } })
    await fileRef.makePublic()
    const downloadUrl = `https://storage.googleapis.com/${storage.name}/${path}`

    const docData = {
      candidate_id: candidateId, type: docType,
      label: LABEL_MAP[docType] || docType,
      status: extractedData ? 'verified' : 'uploaded',
      uploaded_at: now(), storage_path: path, download_url: downloadUrl,
      extracted_data: extractedData || null,
      expiry_date: extractedData?.expiry_date || null,
    }

    // Upsert — replace if doc type already exists
    const existing = await db.collection('documents')
      .where('candidate_id', '==', candidateId)
      .where('type', '==', docType).get()

    let docId
    if (!existing.empty) {
      docId = existing.docs[0].id
      await db.collection('documents').doc(docId).update(docData)
    } else {
      const nd = await db.collection('documents').add(docData)
      docId = nd.id
    }

    console.log(`[documents] Uploaded ${docType} for candidate ${candidateId}`)
    res.json({ id: docId, ...docData })
  } catch (err) {
    console.error('[documents upload]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/documents/verify — run AI extraction without saving
router.post('/verify', async (req, res) => {
  const { base64, mimeType, documentType } = req.body
  if (!base64 || !mimeType) return res.status(400).json({ error: 'base64 and mimeType required' })
  try {
    const result = await verifyDocument(base64, mimeType, documentType)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message, is_authentic: null, confidence: 0, flags: [] })
  }
})

export default router