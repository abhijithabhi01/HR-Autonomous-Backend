// src/routes/policy.js
import { Router }        from 'express'
import { db }            from '../config/firebase.js'
import { firebaseGuard } from '../middleware/guard.js'

const router = Router()
router.use(firebaseGuard)

// POST /api/policy/session
router.post('/session', async (req, res) => {
  try {
    const ref = await db.collection('policy_sessions').add({
      ...req.body, created_at: new Date().toISOString(),
    })
    res.json({ id: ref.id })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST /api/policy/message
router.post('/message', async (req, res) => {
  try {
    const ref = await db.collection('policy_messages').add({
      ...req.body, created_at: new Date().toISOString(),
    })
    res.json({ id: ref.id, session_id: req.body.session_id })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

export default router