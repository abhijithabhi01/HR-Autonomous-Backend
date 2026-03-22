// src/routes/provisioning.js
import { Router }        from 'express'
import { db }            from '../config/firebase.js'
import { firebaseGuard } from '../middleware/guard.js'

const router = Router()
router.use(firebaseGuard)

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
router.put('/:id', async (req, res) => {
  try {
    await db.collection('provisioning_requests').doc(req.params.id).update({
      ...req.body,
      updated_at: new Date().toISOString(),
    })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

export default router