// src/routes/auth.js
import { Router }        from 'express'
import { db, auth }      from '../config/firebase.js'
import { firebaseGuard } from '../middleware/guard.js'

const router = Router()
router.use(firebaseGuard)

// POST /api/auth/delete-user — delete by uid or email
router.post('/delete-user', async (req, res) => {
  const { uid, email } = req.body
  if (!uid && !email) return res.status(400).json({ error: 'uid or email required' })
  try {
    if (uid) {
      await auth.deleteUser(uid)
      return res.json({ success: true, deleted: uid })
    }
    try {
      const user = await auth.getUserByEmail(email)
      await auth.deleteUser(user.uid)
      return res.json({ success: true, deleted: email })
    } catch (err) {
      if (err.code === 'auth/user-not-found') return res.json({ success: true, note: 'already absent' })
      throw err
    }
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST /api/auth/delete-orphaned — only deletes if no Firestore profile exists
router.post('/delete-orphaned', async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ error: 'email required' })
  try {
    let user
    try { user = await auth.getUserByEmail(email) }
    catch (err) {
      if (err.code === 'auth/user-not-found') return res.json({ success: true, note: 'already absent' })
      throw err
    }
    const profileSnap = await db.collection('profiles').doc(user.uid).get()
    if (profileSnap.exists) return res.status(409).json({ error: 'Account has a profile — not orphaned' })
    await auth.deleteUser(user.uid)
    res.json({ success: true, deleted: email })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

export default router