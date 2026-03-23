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

// POST /api/auth/create-it-admin — create IT admin account
router.post('/create-it-admin', async (req, res) => {
  const { name, email, password } = req.body
  if (!name || !email || !password)
    return res.status(400).json({ error: 'name, email, and password required' })
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' })
  try {
    // Check if profile already exists
    let uid
    try {
      const existing = await auth.getUserByEmail(email)
      uid = existing.uid
      // Update role to it_admin if profile exists
      await db.collection('profiles').doc(uid).set({
        email, name, role: 'it_admin',
        avatar: name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase(),
        candidate_id: null, employee_id: null,
        created_at: new Date().toISOString(),
      }, { merge: true })
      return res.json({ success: true, uid, note: 'Existing user updated to it_admin role' })
    } catch (notFound) {
      if (notFound.code !== 'auth/user-not-found') throw notFound
    }

    // Create new Firebase Auth user
    const userRecord = await auth.createUser({ email, password, displayName: name })
    uid = userRecord.uid

    // Create Firestore profile with it_admin role
    await db.collection('profiles').doc(uid).set({
      email, name, role: 'it_admin',
      avatar: name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase(),
      candidate_id: null, employee_id: null,
      created_at: new Date().toISOString(),
    })

    console.log('[auth] IT admin created:', email)
    res.status(201).json({ success: true, uid, email })
  } catch (err) {
    console.error('[auth/create-it-admin]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/auth/create-hr-admin — create HR admin account
router.post('/create-hr-admin', async (req, res) => {
  const { name, email, password } = req.body
  if (!name || !email || !password)
    return res.status(400).json({ error: 'name, email, and password required' })
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' })
  try {
    let uid
    try {
      const existing = await auth.getUserByEmail(email)
      uid = existing.uid
      await db.collection('profiles').doc(uid).set({
        email, name, role: 'hr',
        avatar: name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase(),
        candidate_id: null, employee_id: null,
        created_at: new Date().toISOString(),
      }, { merge: true })
      return res.json({ success: true, uid, note: 'Existing user updated to hr role' })
    } catch (notFound) {
      if (notFound.code !== 'auth/user-not-found') throw notFound
    }

    const userRecord = await auth.createUser({ email, password, displayName: name })
    uid = userRecord.uid
    await db.collection('profiles').doc(uid).set({
      email, name, role: 'hr',
      avatar: name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase(),
      candidate_id: null, employee_id: null,
      created_at: new Date().toISOString(),
    })

    console.log('[auth] HR admin created:', email)
    res.status(201).json({ success: true, uid, email })
  } catch (err) {
    console.error('[auth/create-hr-admin]', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router