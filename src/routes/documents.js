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
      .get()
    // Sort in JS — avoids needing a Firestore composite index on (candidate_id + type)
    const docs = snap.docs
      .map(d => addExpiryStatus({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.type || '').localeCompare(b.type || ''))
    res.json(docs)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST /api/documents/upload — receives base64 file, uploads to Firebase Storage
router.post('/upload', async (req, res) => {
  const { candidateId, docType, base64, mimeType, fileName, extractedData } = req.body
  if (!candidateId || !docType || !base64 || !mimeType)
    return res.status(400).json({ error: 'candidateId, docType, base64 and mimeType required' })

  try {
    const ext     = (fileName || 'file').split('.').pop()
    const path    = `documents/${candidateId}/${docType}_${Date.now()}.${ext}`
    const fileRef = storage.file(path)
    const buffer  = Buffer.from(base64, 'base64')

    await fileRef.save(buffer, { metadata: { contentType: mimeType } })

    // Generate a signed URL valid for 7 days.
    // makePublic() fails on buckets with uniform bucket-level access (GCP default).
    // Signed URLs work regardless of bucket ACL settings.
    const [downloadUrl] = await fileRef.getSignedUrl({
      action:  'read',
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    })

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

    // Auto-tick checklist items based on upload state
    // Skip profile_photo — it's not a candidate document
    if (docType !== 'profile_photo') {
      try {
        const allDocsSnap = await db.collection('documents')
          .where('candidate_id', '==', candidateId).get()
        const allDocs = allDocsSnap.docs.map(d => d.data())

        const requiredTypes = ['passport', 'visa', 'degree', 'employment_letter']
        const allUploaded = requiredTypes.every(t =>
          allDocs.some(d => d.type === t)
        )
        const allVerified = requiredTypes.every(t =>
          allDocs.some(d => d.type === t && d.status === 'verified')
        )

        const checkSnap = await db.collection('checklist_items')
          .where('candidate_id', '==', candidateId).get()

        if (allUploaded) {
          const submittedItem = checkSnap.docs.find(d =>
            d.data().title.toLowerCase() === 'documents submitted'
          )
          if (submittedItem && !submittedItem.data().completed) {
            await db.collection('checklist_items').doc(submittedItem.id).update({
              completed: true, completed_at: new Date().toISOString(),
            })
            console.log('[documents] Auto-ticked: Documents Submitted')
          }
        }

        if (allVerified) {
          const verifiedItem = checkSnap.docs.find(d =>
            d.data().title.toLowerCase() === 'documents verified'
          )
          if (verifiedItem && !verifiedItem.data().completed) {
            await db.collection('checklist_items').doc(verifiedItem.id).update({
              completed: true, completed_at: new Date().toISOString(),
            })
            console.log('[documents] Auto-ticked: Documents Verified')
          }
        }

        // Recalculate progress after any checklist updates
        if (allUploaded || allVerified) {
          const freshSnap = await db.collection('checklist_items')
            .where('candidate_id', '==', candidateId).get()
          const total     = freshSnap.size
          const doneCount = freshSnap.docs.filter(d => d.data().completed).length
          const progress  = total > 0 ? Math.round((doneCount / total) * 100) : 0
          const onboarding_status = progress === 100 ? 'completed' : progress > 0 ? 'onboarding' : 'pre_joining'
          await db.collection('candidates').doc(candidateId).update({ onboarding_progress: progress, onboarding_status })
          console.log(`[documents] Progress recalculated: ${progress}%`)
        }
      } catch (checkErr) {
        console.warn('[documents] Checklist auto-tick failed:', checkErr.message)
      }
    }

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