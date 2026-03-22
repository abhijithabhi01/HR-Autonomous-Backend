// src/routes/checklist.js
import { Router }        from 'express'
import { db }            from '../config/firebase.js'
import { firebaseGuard } from '../middleware/guard.js'

const router = Router()
router.use(firebaseGuard)

function now() { return new Date().toISOString() }

// GET /api/checklist/:candidateId
router.get('/:candidateId', async (req, res) => {
  try {
    const snap = await db.collection('checklist_items')
      .where('candidate_id', '==', req.params.candidateId)
      .orderBy('sort_order').get()
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// PUT /api/checklist/:itemId — toggle complete
router.put('/:itemId', async (req, res) => {
  try {
    const { completed } = req.body
    const data = { completed, completed_at: completed ? now() : null }
    await db.collection('checklist_items').doc(req.params.itemId).update(data)
    res.json({ success: true, ...data })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST /api/checklist/complete-by-title — mark a task done by its title
router.post('/complete-by-title', async (req, res) => {
  const { candidateId, title, description, category, sort_order } = req.body
  if (!candidateId || !title) return res.status(400).json({ error: 'candidateId and title required' })
  try {
    const snap  = await db.collection('checklist_items').where('candidate_id', '==', candidateId).get()
    const match = snap.docs.find(d => d.data().title.toLowerCase() === title.toLowerCase())
    const done  = { completed: true, completed_at: now() }

    if (match) {
      if (match.data().completed) return res.json({ skipped: true, id: match.id })
      await db.collection('checklist_items').doc(match.id).update(done)
      return res.json({ id: match.id, ...done })
    }

    const nd = await db.collection('checklist_items').add({
      candidate_id: candidateId, title,
      description:  description || title,
      category:     category    || 'hr',
      sort_order:   sort_order  ?? 99,
      ...done,
    })
    res.json({ id: nd.id, ...done })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

export default router