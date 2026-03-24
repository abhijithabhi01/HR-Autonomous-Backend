// src/routes/provisioning.js
import { Router }        from 'express'
import { db }            from '../config/firebase.js'
import { firebaseGuard } from '../middleware/guard.js'

const router = Router()
router.use(firebaseGuard)

function now() { return new Date().toISOString() }

// ── Auto-complete a candidate checklist item by title ─────────
async function autoCompleteItem(candidateId, title) {
  try {
    const snap  = await db.collection('checklist_items')
      .where('candidate_id', '==', candidateId).get()
    const match = snap.docs.find(d => d.data().title === title)
    if (match && !match.data().completed) {
      await db.collection('checklist_items').doc(match.id).update({
        completed: true, completed_at: now(),
      })
      // Recalculate progress
      const total     = snap.size
      const doneCount = snap.docs.filter(d => d.data().completed).length + 1 // +1 for the one just marked
      const progress  = total > 0 ? Math.round((doneCount / total) * 100) : 0
      const onboarding_status = progress === 100 ? 'completed' : progress > 0 ? 'onboarding' : 'pre_joining'
      await db.collection('candidates').doc(candidateId).update({ onboarding_progress: progress, onboarding_status })
      console.log(`[provisioning] Auto-ticked "${title}" for ${candidateId} → ${progress}%`)
    }
  } catch (err) {
    console.warn(`[provisioning] autoCompleteItem "${title}" failed:`, err.message)
  }
}

// GET /api/provisioning
router.get('/', async (req, res) => {
  try {
    const snap = await db.collection('provisioning_requests')
      .orderBy('created_at', 'desc').get()
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET /api/provisioning/:id
router.get('/:id', async (req, res) => {
  try {
    const snap = await db.collection('provisioning_requests').doc(req.params.id).get()
    if (!snap.exists) return res.status(404).json({ error: 'Provisioning request not found' })
    res.json({ id: snap.id, ...snap.data() })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// PUT /api/provisioning/:id — update status / systems_provisioned
// Side-effects:
//   • systems_provisioned.email = true  → auto-tick "Company Email Created" for candidate
//   • status = 'completed'              → auto-tick "System Access Granted" for candidate
router.put('/:id', async (req, res) => {
  try {
    // Fetch the existing record so we can get candidate_id + detect what changed
    const prevSnap = await db.collection('provisioning_requests').doc(req.params.id).get()
    if (!prevSnap.exists) return res.status(404).json({ error: 'Provisioning request not found' })

    const prev         = prevSnap.data()
    const candidateId  = prev.candidate_id
    const prevSystems  = prev.systems_provisioned || {}
    const newSystems   = req.body.systems_provisioned || prevSystems
    const newStatus    = req.body.status || prev.status

    // Write the update
    await db.collection('provisioning_requests').doc(req.params.id).update({
      ...req.body,
      updated_at: now(),
    })

    // ── Side-effects (non-blocking — errors are warned, not thrown) ──
    if (candidateId) {
      // When the IT admin ticks "Work Email" system → auto-mark Company Email Created
      if (!prevSystems.email && newSystems.email) {
        await autoCompleteItem(candidateId, 'Company Email Created')
      }

      // When provisioning status becomes 'completed' → auto-mark System Access Granted
      if (prev.status !== 'completed' && newStatus === 'completed') {
        await autoCompleteItem(candidateId, 'System Access Granted')
      }
    }

    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

export default router