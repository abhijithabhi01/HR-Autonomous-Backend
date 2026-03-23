// src/routes/checklist.js
import { Router }        from 'express'
import { db }            from '../config/firebase.js'
import { firebaseGuard } from '../middleware/guard.js'

const router = Router()
router.use(firebaseGuard)

function now() { return new Date().toISOString() }

// ── Recalculate and persist onboarding_progress ───────────────
// Called after every toggle and complete-by-title so the sidebar
// and Welcome page always show the correct percentage.
async function recalcProgress(candidateId) {
  try {
    const allSnap   = await db.collection('checklist_items')
      .where('candidate_id', '==', candidateId).get()
    const total     = allSnap.size
    const doneCount = allSnap.docs.filter(d => d.data().completed).length
    const progress  = total > 0 ? Math.round((doneCount / total) * 100) : 0
    const onboarding_status =
      progress === 100 ? 'completed' :
      progress > 0     ? 'onboarding' : 'pre_joining'
    await db.collection('candidates').doc(candidateId).update({
      onboarding_progress: progress,
      onboarding_status,
    })
    console.log(`[checklist] Progress: ${candidateId} → ${progress}% (${doneCount}/${total})`)
  } catch (err) {
    console.warn('[checklist] recalcProgress failed:', err.message)
  }
}

// GET /api/checklist/:candidateId
// No orderBy — avoids composite index requirement on (candidate_id + sort_order).
// Sort is done in JS instead.
router.get('/:candidateId', async (req, res) => {
  try {
    const snap = await db.collection('checklist_items')
      .where('candidate_id', '==', req.params.candidateId)
      .get()
    const items = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.sort_order ?? 99) - (b.sort_order ?? 99))
    res.json(items)
  } catch (err) {
    console.error('[checklist GET]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/checklist/:itemId — toggle complete + recalculate progress
router.put('/:itemId', async (req, res) => {
  try {
    const { completed, candidateId } = req.body
    const data = { completed, completed_at: completed ? now() : null }
    await db.collection('checklist_items').doc(req.params.itemId).update(data)

    // Recalculate progress after toggle
    if (candidateId) await recalcProgress(candidateId)

    res.json({ success: true, ...data })
  } catch (err) {
    console.error('[checklist PUT]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/checklist/complete-by-title — mark a task done by title
// Used by Profile, Terms, Documents pages to auto-tick checklist items.
router.post('/complete-by-title', async (req, res) => {
  const { candidateId, title, description, category, sort_order } = req.body
  if (!candidateId || !title) return res.status(400).json({ error: 'candidateId and title required' })
  try {
    const snap  = await db.collection('checklist_items')
      .where('candidate_id', '==', candidateId).get()
    const match = snap.docs.find(d => d.data().title.toLowerCase() === title.toLowerCase())
    const done  = { completed: true, completed_at: now() }

    if (match) {
      if (match.data().completed) return res.json({ skipped: true, id: match.id })
      await db.collection('checklist_items').doc(match.id).update(done)
      await recalcProgress(candidateId)
      return res.json({ id: match.id, ...done })
    }

    // Item doesn't exist yet — create and mark done
    const nd = await db.collection('checklist_items').add({
      candidate_id: candidateId, title,
      description:  description || title,
      category:     category    || 'hr',
      sort_order:   sort_order  ?? 99,
      ...done,
    })
    await recalcProgress(candidateId)
    res.json({ id: nd.id, ...done })
  } catch (err) {
    console.error('[checklist complete-by-title]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/checklist/cleanup-titles — remove checklist items by exact title
// Used on deploy to purge "Team Introduction" and "Day 7 Check-in" from ALL candidates.
// Safe to call multiple times (idempotent).
router.delete('/cleanup-titles', async (req, res) => {
  const { titles } = req.body   // e.g. ["Team Introduction", "Day 7 Check-in"]
  if (!Array.isArray(titles) || titles.length === 0)
    return res.status(400).json({ error: 'titles array required' })

  try {
    let deleted = 0
    // Process in chunks to avoid Firestore query limits
    for (const title of titles) {
      const snap = await db.collection('checklist_items')
        .where('title', '==', title).get()
      for (let i = 0; i < snap.docs.length; i += 499) {
        const batch = db.batch()
        snap.docs.slice(i, i + 499).forEach(d => batch.delete(d.ref))
        await batch.commit()
      }
      deleted += snap.size
      console.log(`[checklist] Deleted ${snap.size} "${title}" items`)
    }

    // Recalculate progress for ALL affected candidates
    const allSnap = await db.collection('checklist_items').get()
    const candidateIds = [...new Set(allSnap.docs.map(d => d.data().candidate_id).filter(Boolean))]
    await Promise.all(candidateIds.map(id => recalcProgress(id)))

    res.json({ success: true, deleted, recalculated: candidateIds.length })
  } catch (err) {
    console.error('[checklist cleanup-titles]', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router