// src/routes/alerts.js
import { Router }        from 'express'
import { db }            from '../config/firebase.js'
import { firebaseGuard } from '../middleware/guard.js'

const router = Router()
router.use(firebaseGuard)

// GET /api/alerts
router.get('/', async (req, res) => {
  try {
    const snap = await db.collection('alerts')
      .where('resolved', '==', false)
      .orderBy('severity',   'desc')
      .orderBy('created_at', 'desc').get()
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// PUT /api/alerts/:id/resolve
router.put('/:id/resolve', async (req, res) => {
  try {
    await db.collection('alerts').doc(req.params.id).update({
      resolved: true, resolved_at: new Date().toISOString(),
    })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

export default router