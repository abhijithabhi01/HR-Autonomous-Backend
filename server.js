// backend/server.js
// ─────────────────────────────────────────────────────────────────────────────
// Local dev backend for HR Onboarding Platform
//
// ── IMPORTANT: No service account key file needed ────────────────────────────
// Uses Application Default Credentials (ADC) instead.
// Run ONCE in your terminal before starting this server:
//
//   gcloud auth application-default login
//
// That opens a browser, you sign in with your Google account (the one that
// has Firebase project access), and credentials are saved automatically.
// No key file, no org policy issues.
//
// If you don't have gcloud CLI:  https://cloud.google.com/sdk/docs/install
//
// ── Quick start ──────────────────────────────────────────────────────────────
//   1. gcloud auth application-default login   (once per machine)
//   2. cd backend && npm install
//   3. cp .env.example .env  →  add RESEND_API_KEY
//   4. node server.js
//   5. (separate terminal) cd .. && npm run dev
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config'
import express    from 'express'
import cors       from 'cors'
import admin      from 'firebase-admin'
import nodemailer from 'nodemailer'

const app  = express()
const PORT = process.env.PORT || 3001

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:4173',
  ],
}))
app.use(express.json())

// ── Firebase Admin via Application Default Credentials (ADC) ─────────────────
// No service account key file needed — ADC picks up credentials from:
//   1. GOOGLE_APPLICATION_CREDENTIALS env var (if set)
//   2. gcloud auth application-default login  (recommended for local dev)
//   3. GCE/Cloud Run/Cloud Functions metadata server (auto in production)
//
// Run this ONCE on your machine:  gcloud auth application-default login
// ─────────────────────────────────────────────────────────────────────────────
let adminReady = false
try {
  const projectId = process.env.FIREBASE_PROJECT_ID
  if (!projectId) {
    // Don't crash — email still works without Firebase Admin.
    // Only /api/deleteOrphanedAuth needs the project ID.
    throw new Error('FIREBASE_PROJECT_ID not set — Admin SDK disabled (email still works)')
  }
  admin.initializeApp({ projectId })   // ← ADC + explicit project
  adminReady = true
  console.log('✅  Firebase Admin SDK initialised via ADC')
  console.log('    (gcloud auth application-default login)')
} catch (err) {
  console.warn('⚠️   Firebase Admin SDK not available:', err.message)
  console.warn('    Run: gcloud auth application-default login')
  console.warn('    /api/deleteOrphanedAuth will return 503 until ADC is set up.')
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. POST /api/sendmail
//    Sends the welcome email via Nodemailer + Gmail.
//    Requires GMAIL_USER and GMAIL_APP_PASSWORD in backend/.env
//
//    How to get a Gmail App Password (30 seconds):
//      1. Go to https://myaccount.google.com/security
//      2. Enable 2-Step Verification (if not already on)
//      3. Search "App passwords" → create one → name it "HR Onboarding"
//      4. Copy the 16-character password → paste as GMAIL_APP_PASSWORD in .env
//
//    This works for ANY recipient email — no domain verification needed.
// ─────────────────────────────────────────────────────────────────────────────
// Build the Gmail transporter once at startup (reused across requests)
function createTransporter() {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) return null
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  })
}
const transporter = createTransporter()
if (transporter) {
  console.log('✅  Nodemailer/Gmail ready →', process.env.GMAIL_USER)
} else {
  console.warn('⚠️   GMAIL_USER or GMAIL_APP_PASSWORD not set — emails will fail')
  console.warn('    Add both to backend/.env')
}

app.post('/api/sendmail', async (req, res) => {
  if (!transporter) {
    return res.status(500).json({
      error: 'Email not configured. Add GMAIL_USER and GMAIL_APP_PASSWORD to backend/.env',
    })
  }

  const { toEmail, toName, loginEmail, tempPassword, workEmail, position, department, startDate, portalUrl } = req.body
  if (!toEmail || !toName || !loginEmail || !tempPassword) {
    return res.status(400).json({ error: 'Missing: toEmail, toName, loginEmail, tempPassword' })
  }
  const portalLink = portalUrl || 'http://localhost:5173/login'

  const firstName      = toName.split(' ')[0]
  const formattedStart = startDate
    ? new Date(startDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'TBD'
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 20px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

        <!-- Header -->
        <tr><td style="background:#0C1A1D;padding:36px 40px;border-radius:16px 16px 0 0;text-align:center">
          <div style="font-size:36px;margin-bottom:12px">🎉</div>
          <h1 style="margin:0;color:#2DD4BF;font-size:26px;font-weight:700;letter-spacing:-0.5px">Welcome to D Company!</h1>
          <p style="margin:8px 0 0;color:#94a3b8;font-size:14px">We're thrilled to have you on board</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:#ffffff;padding:40px;border-radius:0 0 16px 16px">
          <p style="margin:0 0 16px;font-size:16px;color:#1e293b">Hi <strong>${firstName}</strong>,</p>
          <p style="margin:0 0 28px;font-size:15px;color:#475569;line-height:1.7">
            You're joining as <strong style="color:#0f172a">${position}</strong> in the
            <strong style="color:#0f172a">${department}</strong> team,
            Last date <strong style="color:#0f172a">${formattedStart}</strong>.
            Your onboarding portal will guide you through every step — use the button below to get started.
          </p>

          <!-- CTA Button -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px">
            <tr><td align="center">
              <a href="${portalLink}"
                style="display:inline-block;background:#2DD4BF;color:#0C1A1D;font-weight:700;font-size:15px;
                       text-decoration:none;padding:14px 36px;border-radius:12px;letter-spacing:0.2px">
                Click Here to Access Your Portal →
              </a>
            </td></tr>
            <tr><td align="center" style="padding-top:10px">
              <p style="margin:0;font-size:11px;color:#94a3b8">Or copy this link: <a href="${portalLink}" style="color:#2DD4BF;text-decoration:none">${portalLink}</a></p>
            </td></tr>
          </table>

          <!-- Credentials box -->
          <table width="100%" cellpadding="0" cellspacing="0"
            style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:28px">
            <tr><td style="padding:20px 24px 12px">
              <p style="margin:0 0 16px;font-weight:700;color:#0f172a;font-size:13px;text-transform:uppercase;letter-spacing:.05em">
                Your Login Credentials
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
                <tr>
                  <td style="padding:8px 0;color:#64748b;width:130px;vertical-align:top">Login Email</td>
                  <td style="padding:8px 0;font-weight:600;color:#0f172a">${loginEmail}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#64748b;vertical-align:top">Password</td>
                  <td style="padding:8px 0">
                    <code style="background:#e2e8f0;padding:4px 10px;border-radius:6px;font-weight:700;font-size:14px;color:#0f172a;letter-spacing:0.5px">${tempPassword}</code>
                  </td>
                </tr>
                ${workEmail ? `<tr>
                  <td style="padding:8px 0;color:#64748b;vertical-align:top">Company Email</td>
                  <td style="padding:8px 0;font-weight:600;color:#2DD4BF">${workEmail}</td>
                </tr>` : ''}
              </table>
            </td></tr>
            
          </table>

          <!-- Steps -->
          <p style="margin:0 0 12px;font-weight:700;color:#0f172a;font-size:14px">What to do next:</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">
            <tr>
              <td width="32" style="padding:6px 0;vertical-align:top">
                <div style="width:22px;height:22px;background:#dbeafe;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;color:#2563eb">1</div>
              </td>
              <td style="padding:6px 0;font-size:14px;color:#475569">Click the button above and log in with your credentials</td>
            </tr>
            <tr>
              <td style="padding:6px 0;vertical-align:top">
                <div style="width:22px;height:22px;background:#dbeafe;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;color:#2563eb">2</div>
              </td>
              <td style="padding:6px 0;font-size:14px;color:#475569">Complete your personal profile (takes ~5 minutes)</td>
            </tr>
            <tr>
              <td style="padding:6px 0;vertical-align:top">
                <div style="width:22px;height:22px;background:#dbeafe;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;color:#2563eb">3</div>
              </td>
              <td style="padding:6px 0;font-size:14px;color:#475569">Upload your required onboarding documents</td>
            </tr>
            <tr>
              <td style="padding:6px 0;vertical-align:top">
                <div style="width:22px;height:22px;background:#dbeafe;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;color:#2563eb">4</div>
              </td>
              <td style="padding:6px 0;font-size:14px;color:#475569">Work through your onboarding checklist</td>
            </tr>
          </table>

          <p style="margin:0 0 4px;font-size:14px;color:#475569">
            See you on <strong>${formattedStart}</strong>! 🚀
          </p>
          <p style="margin:24px 0 0;font-size:13px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:20px">
            The HR Team · D Company
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

  try {
    const info = await transporter.sendMail({
      from:    `"D Company HR" <${process.env.GMAIL_USER}>`,
      to:      toEmail,
      subject: `Welcome to D Company, ${firstName}! 🎉 Your login details`,
      html,
    })
    console.log(`[sendmail] ✅  Sent to ${toEmail} (messageId: ${info.messageId})`)
    return res.json({ success: true, messageId: info.messageId })
  } catch (err) {
    console.error('[sendmail] ❌  Error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. POST /api/deleteOrphanedAuth
//    Deletes a Firebase Auth account that has no Firestore profile.
//    Requires ADC:  gcloud auth application-default login
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/deleteOrphanedAuth', async (req, res) => {
  if (!adminReady) {
    return res.status(503).json({
      error: 'Firebase Admin SDK not available. Run: gcloud auth application-default login',
    })
  }

  const { email } = req.body
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' })
  }

  try {
    let userRecord
    try {
      userRecord = await admin.auth().getUserByEmail(email)
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        console.log(`[deleteOrphanedAuth] ℹ️  No account found for ${email}`)
        return res.json({ success: true, note: 'account was already absent' })
      }
      throw err
    }

    // Safety: only delete if there is NO Firestore profile (genuinely orphaned)
    const profileSnap = await admin.firestore()
      .collection('profiles')
      .doc(userRecord.uid)
      .get()

    if (profileSnap.exists) {
      console.warn(`[deleteOrphanedAuth] ⚠️  Profile exists for ${email} — refusing delete`)
      return res.status(409).json({
        error: 'This account has an active profile and is not orphaned.',
        uid:   userRecord.uid,
      })
    }

    await admin.auth().deleteUser(userRecord.uid)
    console.log(`[deleteOrphanedAuth] ✅  Deleted orphaned account: ${email}`)
    return res.json({ success: true, deleted: email })

  } catch (err) {
    console.error('[deleteOrphanedAuth] Error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ ok: true, port: PORT, adminReady }))

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('')
  console.log('╔═══════════════════════════════════════════════════════╗')
  console.log(`║  HR Onboarding Backend  →  http://localhost:${PORT}     ║`)
  console.log('╠═══════════════════════════════════════════════════════╣')
  console.log('║  POST /api/sendmail            → Gmail email          ║')
  console.log('║  POST /api/deleteOrphanedAuth  → Firebase Admin (ADC) ║')
  console.log('║  GET  /api/health              → status               ║')
  console.log('╚═══════════════════════════════════════════════════════╝')
  console.log('')
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.warn('⚠️   GMAIL_USER or GMAIL_APP_PASSWORD missing — add both to backend/.env')
  }
  if (!adminReady) {
    console.warn('⚠️   ADC not found — run: gcloud auth application-default login')
  }
})