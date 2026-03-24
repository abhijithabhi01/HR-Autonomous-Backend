// src/routes/candidates.js
import { Router }       from 'express'
import { db, auth }     from '../config/firebase.js'
import { firebaseGuard } from '../middleware/guard.js'
import { sendWelcomeEmail } from '../services/email.js'
import { transporter }  from '../config/mailer.js'

const router = Router()
router.use(firebaseGuard)

function now() { return new Date().toISOString() }

// ── Recalculate onboarding progress after checklist changes ───
async function recalcProgress(candidateId) {
  try {
    const allSnap   = await db.collection('checklist_items').where('candidate_id', '==', candidateId).get()
    const total     = allSnap.size
    const doneCount = allSnap.docs.filter(d => d.data().completed).length
    const progress  = total > 0 ? Math.round((doneCount / total) * 100) : 0
    const onboarding_status = progress === 100 ? 'completed' : progress > 0 ? 'onboarding' : 'pre_joining'
    await db.collection('candidates').doc(candidateId).update({ onboarding_progress: progress, onboarding_status })
    console.log(`[candidates] recalcProgress: ${candidateId} → ${progress}% (${doneCount}/${total})`)
  } catch (err) {
    console.warn('[candidates] recalcProgress failed:', err.message)
  }
}

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
      graduated_at: null, final_submitted_at: null, created_at: now(),
    })

    // 2. Checklist batch — Payroll Setup removed
    const batch = db.batch()
    ;[
      { title: 'Profile Completed',     description: 'Personal profile and photo uploaded',     category: 'hr',        sort_order: 0 },
      { title: 'Contract Signed',       description: 'Employment contract digitally signed',     category: 'legal',     sort_order: 1 },
      { title: 'Documents Submitted',   description: 'All required documents uploaded',          category: 'documents', sort_order: 2 },
      { title: 'Documents Verified',    description: 'AI verification of all documents',         category: 'documents', sort_order: 3 },
      { title: 'Company Email Created', description: 'Google Workspace account provisioned',     category: 'it',        sort_order: 4 },
      { title: 'System Access Granted', description: 'Access to required tools and platforms',   category: 'it',        sort_order: 5 },
      { title: 'ID Card Issued',        description: 'Company ID card processed and issued',     category: 'hr',        sort_order: 6 },
      { title: 'Policy Training',       description: 'Mandatory compliance and policy training', category: 'training',  sort_order: 7 },
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

// ── POST /api/candidates/:id/final-submit ─────────────────────
// Called when the candidate clicks "Final Submit" on the checklist.
// 1. Guards against double-submission.
// 2. Auto-ticks "ID Card Issued" in the checklist.
// 3. Sends ID card + onboarding-complete email to the candidate's personal email.
router.post('/:id/final-submit', async (req, res) => {
  const { id } = req.params
  try {
    const snap = await db.collection('candidates').doc(id).get()
    if (!snap.exists) return res.status(404).json({ error: 'Candidate not found' })
    const c = snap.data()

    // Guard: already submitted
    if (c.final_submitted_at) {
      return res.json({ success: true, alreadySubmitted: true })
    }

    // 1. Tick "ID Card Issued" in checklist
    const checkSnap = await db.collection('checklist_items')
      .where('candidate_id', '==', id).get()
    const idCardItem = checkSnap.docs.find(d => d.data().title === 'ID Card Issued')
    if (idCardItem && !idCardItem.data().completed) {
      await db.collection('checklist_items').doc(idCardItem.id).update({
        completed: true, completed_at: now(),
      })
    }

    // 2. Mark final submission timestamp
    await db.collection('candidates').doc(id).update({ final_submitted_at: now() })

    // 3. Recalculate progress
    await recalcProgress(id)

    // 4. Fetch profile photo (if uploaded)
    const photoSnap = await db.collection('documents')
      .where('candidate_id', '==', id)
      .where('type', '==', 'profile_photo').get()
    const photoUrl = photoSnap.empty ? null : photoSnap.docs[0].data().download_url

    // 5. Send ID card + completion email to personal email
    const toEmail  = c.personal_email || c.login_email
    const empId    = 'DC' + id.slice(-4).toUpperCase()
    const joinDate = c.start_date
      ? new Date(c.start_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
      : new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    const initials = (c.full_name || 'EE').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()

    let idCardSent = false
    if (toEmail && transporter) {
      try {
        const idCardHtml = buildIdCardEmail({
          toName:     c.full_name,
          position:   c.position,
          department: c.department,
          workEmail:  c.work_email,
          empId,
          joinDate,
          initials,
          photoUrl,
        })
        await transporter.sendMail({
          from:    `"D Company HR" <${process.env.GMAIL_USER}>`,
          to:      toEmail,
          subject: `🪪 Your D Company Employee ID Card & Onboarding Complete — ${c.full_name}`,
          html:    idCardHtml,
        })
        idCardSent = true
        console.log(`[final-submit] ID card email sent to ${toEmail}`)
      } catch (emailErr) {
        console.warn('[final-submit] Email failed:', emailErr.message)
      }
    }

    res.json({ success: true, idCardSent, alreadySubmitted: false, empId })
  } catch (err) {
    console.error('[final-submit]', err.message)
    res.status(500).json({ error: err.message })
  }
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

// ── ID Card Email HTML Builder ────────────────────────────────
function buildIdCardEmail({ toName, position, department, workEmail, empId, joinDate, initials, photoUrl }) {
  const photoBlock = photoUrl
    ? `<img src="${photoUrl}" alt="Photo" style="width:100%;height:100%;object-fit:cover;display:block;" />`
    : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:28px;color:#818CF8;background:#1e1b4b;">${initials}</div>`

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>D Company ID Card</title></head>
<body style="margin:0;padding:0;background:#0f0f23;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f23;min-height:100vh;">
  <tr><td align="center" style="padding:40px 20px;">
    <p style="color:#2DD4BF;font-size:20px;font-weight:700;margin:0 0 8px;">🎉 Onboarding Complete!</p>
    <p style="color:#94a3b8;font-size:13px;margin:0 0 28px;">Congratulations ${toName.split(' ')[0]}! Your onboarding is finalised. Here is your employee ID card.</p>

    <table cellpadding="0" cellspacing="0" width="380"
      style="background:linear-gradient(135deg,#1e1b4b 0%,#0f172a 60%,#0c1a2e 100%);border-radius:20px;overflow:hidden;box-shadow:0 25px 60px rgba(0,0,0,0.6);">
      <tr><td style="background:linear-gradient(90deg,#4338ca,#6366f1,#8b5cf6);padding:0;height:6px;"></td></tr>
      <tr>
        <td style="padding:24px 28px 16px;border-bottom:1px solid rgba(255,255,255,0.07);">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                <p style="margin:0;font-size:18px;font-weight:800;color:#ffffff;">D Company</p>
                <p style="margin:2px 0 0;font-size:10px;color:#6366f1;letter-spacing:2px;text-transform:uppercase;font-weight:600;">Employee Identity Card</p>
              </td>
              <td align="right">
                <div style="width:36px;height:36px;background:#4338ca;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;">
                  <span style="color:white;font-size:18px;">🏢</span>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:24px 28px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td width="100" valign="top">
                <div style="width:88px;height:88px;border-radius:50%;overflow:hidden;border:3px solid #4F46E5;background:#1e1b4b;">
                  ${photoBlock}
                </div>
                <div style="margin-top:10px;text-align:center;">
                  <div style="background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.3);border-radius:6px;padding:4px 8px;display:inline-block;">
                    <p style="margin:0;font-size:9px;color:#818CF8;letter-spacing:1px;text-transform:uppercase;font-weight:700;">EMP ID</p>
                    <p style="margin:2px 0 0;font-size:12px;color:#c7d2fe;font-weight:800;letter-spacing:1px;">${empId}</p>
                  </div>
                </div>
              </td>
              <td style="padding-left:20px;" valign="top">
                <p style="margin:0 0 2px;font-size:20px;font-weight:800;color:#ffffff;line-height:1.2;">${toName}</p>
                <p style="margin:0 0 16px;font-size:12px;color:#818CF8;font-weight:600;">${position || 'Employee'}</p>
                <table cellpadding="0" cellspacing="0">
                  <tr><td style="padding:0 0 10px;">
                    <p style="margin:0;font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Department</p>
                    <p style="margin:2px 0 0;font-size:12px;color:#cbd5e1;font-weight:600;">${department || '—'}</p>
                  </td></tr>
                  <tr><td style="padding:0 0 10px;">
                    <p style="margin:0;font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Work Email</p>
                    <p style="margin:2px 0 0;font-size:11px;color:#cbd5e1;font-weight:600;">${workEmail || '—'}</p>
                  </td></tr>
                  <tr><td>
                    <p style="margin:0;font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Start Date</p>
                    <p style="margin:2px 0 0;font-size:12px;color:#cbd5e1;font-weight:600;">${joinDate}</p>
                  </td></tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="background:rgba(99,102,241,0.08);border-top:1px solid rgba(99,102,241,0.15);padding:12px 28px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td><p style="margin:0;font-size:9px;color:#475569;">If found, please return to D Company HR Department</p></td>
              <td align="right"><p style="margin:0;font-size:9px;color:#475569;">Issued ${new Date().getFullYear()}</p></td>
            </tr>
          </table>
        </td>
      </tr>
      <tr><td style="background:linear-gradient(90deg,#8b5cf6,#6366f1,#4338ca);padding:0;height:4px;"></td></tr>
    </table>

    <p style="color:#475569;font-size:11px;margin:24px 0 0;text-align:center;">
      Keep this ID card safe — contact HR if you need a replacement.<br>
      Welcome aboard! The HR Team · D Company
    </p>
  </td></tr>
</table>
</body>
</html>`
}