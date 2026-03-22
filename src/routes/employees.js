// src/routes/employees.js
import { Router }        from 'express'
import { db }            from '../config/firebase.js'
import { firebaseGuard } from '../middleware/guard.js'

const router = Router()
router.use(firebaseGuard)

// GET /api/employees
router.get('/', async (req, res) => {
  try {
    const snap = await db.collection('employees').orderBy('joined_at', 'desc').get()
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET /api/employees/:id
router.get('/:id', async (req, res) => {
  try {
    const snap = await db.collection('employees').doc(req.params.id).get()
    if (!snap.exists) return res.status(404).json({ error: 'Employee not found' })
    res.json({ id: snap.id, ...snap.data() })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

export default router