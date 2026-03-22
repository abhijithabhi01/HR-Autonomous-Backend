// src/services/email.js
// Builds and sends the candidate welcome email.

import { transporter } from '../config/mailer.js'

export async function sendWelcomeEmail({
  toEmail, toName, loginEmail, tempPassword,
  workEmail, position, department, startDate, portalUrl,
}) {
  if (!transporter) throw new Error('Gmail not configured')

  const firstName      = toName.split(' ')[0]
  const formattedStart = startDate
    ? new Date(startDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'TBD'
  const portalLink = portalUrl || 'http://localhost:5173/login'

  const html = buildHtml({ firstName, position, department, formattedStart, loginEmail, tempPassword, workEmail, portalLink })

  const info = await transporter.sendMail({
    from:    `"D Company HR" <${process.env.GMAIL_USER}>`,
    to:      toEmail,
    subject: `Welcome to D Company, ${firstName}! 🎉 Your login details`,
    html,
  })

  console.log(`[email] ✅  Sent to ${toEmail} (${info.messageId})`)
  return { success: true, messageId: info.messageId }
}

function buildHtml({ firstName, position, department, formattedStart, loginEmail, tempPassword, workEmail, portalLink }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 20px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

        <tr><td style="background:#0C1A1D;padding:36px 40px;border-radius:16px 16px 0 0;text-align:center">
          <div style="font-size:36px;margin-bottom:12px">🎉</div>
          <h1 style="margin:0;color:#2DD4BF;font-size:26px;font-weight:700">Welcome to D Company!</h1>
          <p style="margin:8px 0 0;color:#94a3b8;font-size:14px">We're thrilled to have you on board</p>
        </td></tr>

        <tr><td style="background:#ffffff;padding:40px;border-radius:0 0 16px 16px">
          <p style="margin:0 0 16px;font-size:16px;color:#1e293b">Hi <strong>${firstName}</strong>,</p>
          <p style="margin:0 0 28px;font-size:15px;color:#475569;line-height:1.7">
            You're joining as <strong style="color:#0f172a">${position}</strong> in the
            <strong style="color:#0f172a">${department}</strong> team,
            starting <strong style="color:#0f172a">${formattedStart}</strong>.
          </p>

          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px">
            <tr><td align="center">
              <a href="${portalLink}"
                style="display:inline-block;background:#2DD4BF;color:#0C1A1D;font-weight:700;font-size:15px;
                       text-decoration:none;padding:14px 36px;border-radius:12px">
                Click Here to Access Your Portal →
              </a>
            </td></tr>
            <tr><td align="center" style="padding-top:10px">
              <p style="margin:0;font-size:11px;color:#94a3b8">
                Or copy: <a href="${portalLink}" style="color:#2DD4BF">${portalLink}</a>
              </p>
            </td></tr>
          </table>

          <table width="100%" cellpadding="0" cellspacing="0"
            style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:28px">
            <tr><td style="padding:20px 24px 12px">
              <p style="margin:0 0 16px;font-weight:700;color:#0f172a;font-size:13px;text-transform:uppercase;letter-spacing:.05em">
                Your Login Credentials
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
                <tr>
                  <td style="padding:8px 0;color:#64748b;width:130px">Login Email</td>
                  <td style="font-weight:600;color:#0f172a">${loginEmail}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#64748b">Password</td>
                  <td>
                    <code style="background:#e2e8f0;padding:4px 10px;border-radius:6px;font-weight:700;font-size:14px;color:#0f172a">
                      ${tempPassword}
                    </code>
                  </td>
                </tr>
                ${workEmail ? `
                <tr>
                  <td style="padding:8px 0;color:#64748b">Company Email</td>
                  <td style="font-weight:600;color:#2DD4BF">${workEmail}</td>
                </tr>` : ''}
              </table>
            </td></tr>
            <tr><td style="padding:12px 24px 16px;border-top:1px solid #e2e8f0">
              <p style="margin:0;font-size:12px;color:#94a3b8">⚠️ Please change your password after first login.</p>
            </td></tr>
          </table>

          <p style="margin:0 0 12px;font-weight:700;color:#0f172a;font-size:14px">What to do next:</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">
            ${[
              ['1', 'Log in using the button above'],
              ['2', 'Complete your personal profile (~5 minutes)'],
              ['3', 'Upload your required documents'],
              ['4', 'Work through your onboarding checklist'],
            ].map(([n, text]) => `
            <tr>
              <td width="32" style="padding:5px 0;vertical-align:top">
                <div style="width:22px;height:22px;background:#dbeafe;border-radius:50%;text-align:center;
                            line-height:22px;font-size:12px;font-weight:700;color:#2563eb">${n}</div>
              </td>
              <td style="padding:5px 0;font-size:14px;color:#475569">${text}</td>
            </tr>`).join('')}
          </table>

          <p style="margin:0;font-size:14px;color:#475569">
            Looking forward to seeing you on <strong>${formattedStart}</strong>! 🚀
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
}