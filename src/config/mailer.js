// src/config/mailer.js
// Nodemailer Gmail transporter — shared across route files.

import nodemailer from 'nodemailer'

function createTransporter() {
  const user = process.env.GMAIL_USER
  // Strip spaces — Google displays app passwords grouped as "xxxx xxxx xxxx xxxx"
  const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '')
  if (!user || !pass) return null
  return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } })
}

export const transporter = createTransporter()

if (transporter) console.log('✅  Gmail ready →', process.env.GMAIL_USER)
else             console.warn('⚠️   Gmail not configured — add GMAIL_USER and GMAIL_APP_PASSWORD to .env')