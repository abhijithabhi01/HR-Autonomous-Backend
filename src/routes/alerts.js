// src/routes/alerts.js
import { Router }        from 'express'
import { db }            from '../config/firebase.js'
import { firebaseGuard } from '../middleware/guard.js'

const router = Router()
router.use(firebaseGuard)

// GET /api/alerts
router.get('/', async (req, res) => {
  try {
    // No orderBy — avoids composite index requirement. Sort in JS instead.
    const snap = await db.collection('alerts')
      .where('resolved', '==', false).get()
    const alerts = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const sevOrder = { high: 0, medium: 1, low: 2 }
        const sevDiff  = (sevOrder[a.severity] ?? 1) - (sevOrder[b.severity] ?? 1)
        if (sevDiff !== 0) return sevDiff
        return (b.created_at || '').localeCompare(a.created_at || '')
      })
    res.json(alerts)
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