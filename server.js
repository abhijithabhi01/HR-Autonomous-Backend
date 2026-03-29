// server.js
// HR Onboarding Platform — Backend Entry Point
// Imports configs, then mounts route modules. No business logic here.

import 'dotenv/config'
import express from 'express'
import cors    from 'cors'

// ── Config (initializes Firebase, Document AI, Gmail on import) ──
import './src/config/firebase.js'
import './src/config/documentai.js'
import './src/config/mailer.js'

// ── Routes ────────────────────────────────────────────────────
import candidatesRouter  from './src/routes/candidates.js'
import employeesRouter   from './src/routes/employees.js'
import documentsRouter   from './src/routes/documents.js'
import checklistRouter   from './src/routes/checklist.js'
import alertsRouter      from './src/routes/alerts.js'
import provisioningRouter from './src/routes/provisioning.js'
import authRouter        from './src/routes/auth.js'
import emailRouter       from './src/routes/email.js'
import policyRouter      from './src/routes/policy.js'
import extractOfferLetterRouter from './src/routes/extractOfferLetter.js'
import { errorHandler } from './src/middleware/errorHandler.js'

const app  = express()
const PORT = process.env.PORT || 3001

// ── CORS ──────────────────────────────────────────────────────
const extraOrigins = (process.env.FRONTEND_URL || '').split(',').map(s => s.trim()).filter(Boolean)
const allowedOrigins = ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:4173', ...extraOrigins]

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true)
    if (allowedOrigins.some(o => origin === o || origin.endsWith('.vercel.app'))) return cb(null, true)
    cb(new Error(`CORS: ${origin} not allowed`))
  },
  credentials: true,
}))
app.use(express.json({ limit: '20mb' }))

// ── Mount routes ──────────────────────────────────────────────
app.use('/api/candidates',   candidatesRouter)
app.use('/api/employees',    employeesRouter)
app.use('/api/documents',    documentsRouter)
app.use('/api/checklist',    checklistRouter)
app.use('/api/alerts',       alertsRouter)
app.use('/api/provisioning', provisioningRouter)
app.use('/api/auth',         authRouter)
app.use('/api/sendmail',     emailRouter)
app.use('/api/policy',       policyRouter)
app.use('/api/candidates', extractOfferLetterRouter)
// ── Health check ──────────────────────────────────────────────
app.get('/api/health', (_, res) => {
  res.json({ ok: true, port: PORT, timestamp: new Date().toISOString() })
})

// ERROR HANDLER 
app.use(errorHandler)

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('')
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log(`║  HR Onboarding Backend  →  http://localhost:${PORT}        ║`)
  console.log('╠══════════════════════════════════════════════════════════╣')
  console.log('║  /api/candidates     — CRUD + auth + email               ║')
  console.log('║  /api/employees      — read                              ║')
  console.log('║  /api/documents      — upload + Document AI verify       ║')
  console.log('║  /api/checklist      — read + toggle + complete-by-title ║')
  console.log('║  /api/alerts         — read + resolve                    ║')
  console.log('║  /api/provisioning   — read + update                     ║')
  console.log('║  /api/auth           — delete-user, delete-orphaned      ║')
  console.log('║  /api/sendmail       — welcome email                     ║')
  console.log('║  /api/policy         — session + message logging         ║')
  console.log('║  /api/health         — status                            ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log('')
})