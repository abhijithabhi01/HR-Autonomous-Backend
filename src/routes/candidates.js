// src/routes/candidates.js
import { Router }       from 'express'
import { db, auth }     from '../config/firebase.js'
import { firebaseGuard } from '../middleware/guard.js'
import { sendWelcomeEmail } from '../services/email.js'

const router = Router()
router.use(firebaseGuard)

function now() { return new Date().toISOString() }

// GET /api/candidates
router.get('/', async (req, res) => {
  try {
    const snap = await db.collection('candidates').orderBy('created_at', 'desc').get()
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.graduated_at == null)
    res.json(list)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET /api/candidates/:id
router.get('/:id', async (req, res) => {
  try {
    const snap = await db.collection('candidates').doc(req.params.id).get()
    if (!snap.exists) return res.status(404).json({ error: 'Candidate not found' })
    res.json({ id: snap.id, ...snap.data() })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST /api/candidates
router.post('/', async (req, res) => {
  const fields = req.body
  try {
    const avatar    = fields.full_name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
    const nameParts = fields.full_name.toLowerCase().trim().split(/\s+/)
    const workEmail = nameParts.join('.') + '@dcompany.com'
    const personalEmail = fields.personal_email?.trim() || null

    // Uniqueness checks
    if (personalEmail) {
      const check = await db.collection('candidates').where('personal_email', '==', personalEmail).get()
      if (!check.empty) return res.status(409).json({ error: `A candidate with "${personalEmail}" already exists.` })
    }
    let finalEmail = workEmail
    const existing = await db.collection('candidates').where('work_email', '==', workEmail).get()
    if (!existing.empty) {
      for (let s = 2; s <= 99; s++) {
        const e     = nameParts.join('.') + s + '@dcompany.com'
        const taken = await db.collection('candidates').where('work_email', '==', e).get()
        if (taken.empty) { finalEmail = e; break }
      }
    }

    // 1. Candidate doc
    const candidateRef = await db.collection('candidates').add({
      avatar, full_name: fields.full_name, work_email: finalEmail,
      personal_email: personalEmail, position: fields.position,
      department: fields.department, start_date: fields.start_date || null,
      manager: fields.manager || null, location: fields.location || null,
      onboarding_status: 'pre_joining', onboarding_progress: 0,
      graduated_at: null, created_at: now(),
    })

    // 2. Checklist batch
    const batch = db.batch()
    ;[
      { title: 'Profile Completed',     description: 'Personal profile and photo uploaded',     category: 'hr',        sort_order: 0  },
      { title: 'Contract Signed',       description: 'Employment contract digitally signed',     category: 'legal',     sort_order: 1  },
      { title: 'Documents Submitted',   description: 'All required documents uploaded',          category: 'documents', sort_order: 2  },
      { title: 'Documents Verified',    description: 'AI verification of all documents',         category: 'documents', sort_order: 3  },
      { title: 'Company Email Created', description: 'Google Workspace account provisioned',     category: 'it',        sort_order: 4  },
      { title: 'System Access Granted', description: 'Access to required tools and platforms',   category: 'it',        sort_order: 5  },
      { title: 'Payroll Setup',         description: 'Salary account and payroll configured',    category: 'hr',        sort_order: 6  },
      { title: 'ID Card Issued',        description: 'Company ID card processed and issued',     category: 'hr',        sort_order: 7  },
      { title: 'Policy Training',       description: 'Mandatory compliance and policy training', category: 'training', sort_order: 8 },
    ].forEach(item => {
      const ref = db.collection('checklist_items').doc()
      batch.set(ref, { ...item, candidate_id: candidateRef.id, completed: false, completed_at: null })
    })
    await batch.commit()

    // 3. IT provisioning
    await db.collection('provisioning_requests').add({
      candidate_id: candidateRef.id, candidate_name: fields.full_name,
      work_email: finalEmail, position: fields.position, department: fields.department,
      manager: fields.manager || null, location: fields.location || null,
      start_date: fields.start_date || null, status: 'pending',
      systems_provisioned: {}, created_at: now(),
    })

    // 4. Firebase Auth
    const tempPassword = 'Welcome' + Math.floor(1000 + Math.random() * 9000) + '!'
    const loginEmail   = personalEmail || finalEmail
    let authCreated = false, authUid = null

    try {
      const userRecord = await auth.createUser({ email: loginEmail, password: tempPassword, displayName: fields.full_name })
      authUid = userRecord.uid
      await db.collection('profiles').doc(authUid).set({
        email: loginEmail, name: fields.full_name, role: 'employee',
        avatar, candidate_id: candidateRef.id, employee_id: null, created_at: now(),
      })
      authCreated = true
      console.log('[candidates] Auth + profile created for', loginEmail)
    } catch (authErr) {
      if (authErr.code === 'auth/email-already-exists') {
        try {
          const user        = await auth.getUserByEmail(loginEmail)
          authUid           = user.uid
          const profileSnap = await db.collection('profiles').doc(authUid).get()
          if (profileSnap.exists) {
            await db.collection('profiles').doc(authUid).update({ candidate_id: candidateRef.id })
            authCreated = true
          } else {
            await auth.deleteUser(authUid)
            const newUser = await auth.createUser({ email: loginEmail, password: tempPassword, displayName: fields.full_name })
            authUid = newUser.uid
            await db.collection('profiles').doc(authUid).set({
              email: loginEmail, name: fields.full_name, role: 'employee',
              avatar, candidate_id: candidateRef.id, employee_id: null, created_at: now(),
            })
            authCreated = true
          }
        } catch (relinkErr) {
          console.error('[candidates] Re-link failed:', relinkErr.message)
        }
      } else {
        console.error('[candidates] Auth error:', authErr.message)
      }
    }

    // 5. Store credentials
    await db.collection('candidates').doc(candidateRef.id).update({
      login_email: loginEmail, temp_password: tempPassword,
      auth_created: authCreated, auth_uid: authUid, work_email: finalEmail,
    })

    // 6. Welcome email
    let emailSent = false
    if (personalEmail) {
      try {
        await sendWelcomeEmail({
          toEmail: personalEmail, toName: fields.full_name,
          loginEmail, tempPassword, workEmail: finalEmail,
          position: fields.position, department: fields.department,
          startDate: fields.start_date,
          portalUrl: (req.headers.origin || '') + '/login',
        })
        emailSent = true
      } catch (emailErr) {
        console.warn('[candidates] Email failed:', emailErr.message)
      }
    }

    res.status(201).json({
      id: candidateRef.id, full_name: fields.full_name,
      loginEmail, workEmail: finalEmail, tempPassword,
      authCreated, emailSent,
    })
  } catch (err) {
    console.error('[candidates POST]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/candidates/:id
router.put('/:id', async (req, res) => {
  try {
    await db.collection('candidates').doc(req.params.id).update(req.body)
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// PUT /api/candidates/:id/complete-onboarding
router.put('/:id/complete-onboarding', async (req, res) => {
  try {
    await db.collection('candidates').doc(req.params.id).update({
      onboarding_status: 'completed', onboarding_progress: 100, completed_at: now(),
    })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// DELETE /api/candidates/:id — cascade delete everything
router.delete('/:id', async (req, res) => {
  const { id } = req.params
  try {
    const candidateSnap = await db.collection('candidates').doc(id).get()
    if (!candidateSnap.exists) return res.status(404).json({ error: 'Not found' })
    const candidate  = candidateSnap.data()
    const loginEmail = candidate.login_email || candidate.personal_email
    const authUid    = candidate.auth_uid

    const [checklistSnap, provSnap, docsSnap, profileSnap] = await Promise.all([
      db.collection('checklist_items').where('candidate_id', '==', id).get(),
      db.collection('provisioning_requests').where('candidate_id', '==', id).get(),
      db.collection('documents').where('candidate_id', '==', id).get(),
      db.collection('profiles').where('candidate_id', '==', id).get(),
    ])

    const allDocs = [...checklistSnap.docs, ...provSnap.docs, ...docsSnap.docs, ...profileSnap.docs]
    for (let i = 0; i < allDocs.length; i += 499) {
      const batch = db.batch()
      allDocs.slice(i, i + 499).forEach(d => batch.delete(d.ref))
      await batch.commit()
    }
    await db.collection('candidates').doc(id).delete()

    let authDeleted = false
    try {
      const uid = authUid || (loginEmail ? (await auth.getUserByEmail(loginEmail)).uid : null)
      if (uid) { await auth.deleteUser(uid); authDeleted = true }
    } catch (authErr) {
      if (authErr.code !== 'auth/user-not-found') console.warn('[deleteCandidate] Auth delete failed:', authErr.message)
    }

    console.log(`[candidates] Deleted ${id} | auth: ${authDeleted}`)
    res.json({ success: true, authDeleted })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

export default router