// src/routes/email.js
import { Router }           from 'express'
import { sendWelcomeEmail } from '../services/email.js'
import { transporter }      from '../config/mailer.js'

const router = Router()

// POST /api/sendmail — welcome email (existing)
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

// POST /api/sendmail/idcard — generate HTML ID card and email it
router.post('/idcard', async (req, res) => {
  const { toEmail, toName, candidateId, position, department, workEmail, employeeId, photoUrl, startDate } = req.body
  if (!toEmail || !toName)
    return res.status(400).json({ error: 'Missing: toEmail, toName' })
  if (!transporter)
    return res.status(503).json({ error: 'Email not configured — set GMAIL_USER and GMAIL_APP_PASSWORD' })

  const joinDate = startDate
    ? new Date(startDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

  const photoHtml = photoUrl
    ? `<img src="${photoUrl}" alt="Photo" style="width:88px;height:88px;border-radius:50%;object-fit:cover;border:3px solid #4F46E5;display:block;" />`
    : `<div style="width:88px;height:88px;border-radius:50%;background:#1e1b4b;border:3px solid #4F46E5;display:flex;align-items:center;justify-content:center;font-size:32px;color:#818CF8;">👤</div>`

  const initials = toName.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>D Company ID Card</title></head>
<body style="margin:0;padding:0;background:#0f0f23;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f23;min-height:100vh;">
  <tr><td align="center" style="padding:40px 20px;">

    <p style="color:#94a3b8;font-size:13px;margin:0 0 24px;">Your D Company employee ID card is attached below. Save it for office access and identification.</p>

    <!-- ID CARD -->
    <table cellpadding="0" cellspacing="0" width="380"
      style="background:linear-gradient(135deg,#1e1b4b 0%,#0f172a 60%,#0c1a2e 100%);border-radius:20px;overflow:hidden;box-shadow:0 25px 60px rgba(0,0,0,0.6);">

      <!-- Top band -->
      <tr>
        <td style="background:linear-gradient(90deg,#4338ca,#6366f1,#8b5cf6);padding:0;height:6px;"></td>
      </tr>

      <!-- Company header -->
      <tr>
        <td style="padding:24px 28px 16px;border-bottom:1px solid rgba(255,255,255,0.07);">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                <p style="margin:0;font-size:18px;font-weight:800;color:#ffffff;letter-spacing:-0.3px;">D Company</p>
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

      <!-- Main content -->
      <tr>
        <td style="padding:24px 28px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <!-- Photo -->
              <td width="100" valign="top">
                <div style="width:88px;height:88px;border-radius:50%;overflow:hidden;border:3px solid #4F46E5;background:#1e1b4b;">
                  ${photoUrl
                    ? `<img src="${photoUrl}" alt="Photo" style="width:100%;height:100%;object-fit:cover;display:block;" />`
                    : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:28px;color:#818CF8;background:#1e1b4b;">${initials}</div>`
                  }
                </div>
                <div style="margin-top:10px;text-align:center;">
                  <div style="background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.3);border-radius:6px;padding:4px 8px;display:inline-block;">
                    <p style="margin:0;font-size:9px;color:#818CF8;letter-spacing:1px;text-transform:uppercase;font-weight:700;">EMP ID</p>
                    <p style="margin:2px 0 0;font-size:12px;color:#c7d2fe;font-weight:800;letter-spacing:1px;">${employeeId || 'DC' + candidateId?.slice(-4)?.toUpperCase()}</p>
                  </div>
                </div>
              </td>

              <!-- Details -->
              <td style="padding-left:20px;" valign="top">
                <p style="margin:0 0 2px;font-size:20px;font-weight:800;color:#ffffff;line-height:1.2;">${toName}</p>
                <p style="margin:0 0 16px;font-size:12px;color:#818CF8;font-weight:600;">${position || 'Employee'}</p>

                <table cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:0 0 10px;">
                      <p style="margin:0;font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Department</p>
                      <p style="margin:2px 0 0;font-size:12px;color:#cbd5e1;font-weight:600;">${department || '—'}</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 0 10px;">
                      <p style="margin:0;font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Work Email</p>
                      <p style="margin:2px 0 0;font-size:11px;color:#cbd5e1;font-weight:600;">${workEmail || '—'}</p>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <p style="margin:0;font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Start Date</p>
                      <p style="margin:2px 0 0;font-size:12px;color:#cbd5e1;font-weight:600;">${joinDate}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Bottom bar -->
      <tr>
        <td style="background:rgba(99,102,241,0.08);border-top:1px solid rgba(99,102,241,0.15);padding:12px 28px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                <p style="margin:0;font-size:9px;color:#475569;letter-spacing:0.5px;">If found, please return to D Company HR Department</p>
              </td>
              <td align="right">
                <p style="margin:0;font-size:9px;color:#475569;">Issued ${new Date().getFullYear()}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Bottom accent -->
      <tr>
        <td style="background:linear-gradient(90deg,#8b5cf6,#6366f1,#4338ca);padding:0;height:4px;"></td>
      </tr>
    </table>

    <p style="color:#475569;font-size:11px;margin:24px 0 0;text-align:center;">
      This is your official D Company employee ID card.<br>
      Keep it safe — contact HR if you need a replacement.
    </p>

  </td></tr>
</table>
</body>
</html>`

  try {
    await transporter.sendMail({
      from:    `"D Company HR" <${process.env.GMAIL_USER}>`,
      to:      toEmail,
      subject: `🪪 Your D Company Employee ID Card — ${toName}`,
      html,
    })
    console.log(`[email] ID card sent to ${toEmail} for ${toName}`)
    res.json({ success: true, sentTo: toEmail })
  } catch (err) {
    console.error('[email/idcard]', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router