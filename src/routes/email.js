// src/routes/email.js
import { Router }           from 'express'
import { sendWelcomeEmail } from '../services/email.js'

const router = Router()

// POST /api/sendmail
router.post('/', async (req, res) => {
  const { toEmail, toName, loginEmail, tempPassword, workEmail, position, department, startDate, portalUrl } = req.body
  if (!toEmail || !toName || !loginEmail || !tempPassword)
    return res.status(400).json({ error: 'Missing: toEmail, toName, loginEmail, tempPassword' })
  try {
    const result = await sendWelcomeEmail({
      toEmail, toName, loginEmail, tempPassword, workEmail,
      position, department, startDate,
      portalUrl: portalUrl || (req.headers.origin || '') + '/login',
    })
    res.json(result)
  } catch (err) {
    console.error('[email]', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router