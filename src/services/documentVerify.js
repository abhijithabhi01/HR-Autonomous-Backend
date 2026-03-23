// src/services/documentVerify.js
// Document verification using Google Document AI with Gemini Vision fallback.
// When Document AI returns raw text only (OCR processor), we parse it ourselves.

import { docAiClient, DOC_AI_PROJECT, DOC_AI_LOCATION, PROCESSOR_IDS } from '../config/documentai.js'

const FIELD_TEMPLATES = {
  passport:          '{"name":"","passport_number":"","date_of_birth":"","nationality":"","expiry_date":"","is_authentic":true,"confidence":90,"flags":[]}',
  visa:              '{"visa_type":"","holder_name":"","country":"","expiry_date":"","permitted_activities":"","is_authentic":true,"confidence":90,"flags":[]}',
  degree:            '{"student_name":"","institution":"","degree":"","field_of_study":"","graduation_year":"","is_authentic":true,"confidence":88,"flags":[]}',
  employment_letter: '{"employee_name":"","company":"","position":"","start_date":"","end_date":"","is_authentic":true,"confidence":85,"flags":[]}',
  bank_details:      '{"account_holder":"","bank_name":"","account_type":"","account_number":"","ifsc_code":"","is_authentic":true,"confidence":90,"flags":[]}',
  aadhaar:           '{"name":"","aadhaar_number":"","date_of_birth":"","gender":"","address":"","is_authentic":true,"confidence":90,"flags":[]}',
  pan_card:          '{"name":"","pan_number":"","father_name":"","date_of_birth":"","is_authentic":true,"confidence":90,"flags":[]}',
}

const FIELD_MAPS = {
  passport: {
    given_names: 'name', surname: 'name', 'given-name': 'name',
    document_number: 'passport_number', doc_number: 'passport_number',
    expiration_date: 'expiry_date', expiry: 'expiry_date', valid_until: 'expiry_date',
    country_code: 'nationality', issuing_country: 'nationality',
    date_of_birth: 'date_of_birth', dob: 'date_of_birth',
  },
  aadhaar: {
    uid: 'aadhaar_number', uid_number: 'aadhaar_number',
    dob: 'date_of_birth', birth_date: 'date_of_birth',
  },
  pan_card: {
    permanent_account_number: 'pan_number', pan: 'pan_number',
    "father's_name": 'father_name', dob: 'date_of_birth',
  },
}

function normalizeFields(fields, docType) {
  const map    = FIELD_MAPS[docType] || {}
  const result = { ...fields }
  Object.entries(map).forEach(([raw, normalized]) => {
    if (fields[raw] && !result[normalized]) result[normalized] = fields[raw]
  })
  return result
}

// ── Raw text parsers — used when OCR processor returns text only ──

function mrzDate(yymmdd) {
  if (!yymmdd || yymmdd.length < 6) return ''
  const yy = parseInt(yymmdd.slice(0, 2))
  const mm = yymmdd.slice(2, 4)
  const dd = yymmdd.slice(4, 6)
  const year = yy <= 30 ? 2000 + yy : 1900 + yy
  return `${dd}/${mm}/${year}`
}

function parseMRZLine2(line) {
  if (!line || line.length < 44) return {}
  const clean = line.replace(/\s/g, '')
  return {
    passport_number: clean.slice(0, 9).replace(/</g, '').trim(),
    nationality:     clean.slice(10, 13).replace(/</g, '').trim(),
    date_of_birth:   mrzDate(clean.slice(13, 19)),
    expiry_date:     mrzDate(clean.slice(21, 27)),
    sex:             clean.slice(20, 21),
  }
}

// ── VISA / WORK PERMIT ───────────────────────────────────────
// Handles structured visa format with labelled fields:
// "HOLDER NAME\nAisha Rahman\nVISA TYPE\nEmployment Visa\nCOUNTRY\nBrazil\nEXPIRY DATE\n13 Mar 2034"
function parseVisaRawText(text) {
  const result = {}
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

  // Label → next line value mapping
  const LABELS = [
    { pattern: /^HOLDER\s*NAME$/i,         field: 'holder_name' },
    { pattern: /^VISA\s*TYPE$/i,            field: 'visa_type' },
    { pattern: /^COUNTRY$/i,                 field: 'country' },
    { pattern: /^EXPIRY\s*DATE$/i,          field: 'expiry_date' },
    { pattern: /^DATE\s*OF\s*ISSUE$/i,     field: 'issue_date' },
    { pattern: /^PERMITTED\s*ACTIVITIES$/i, field: 'permitted_activities' },
  ]

  for (let i = 0; i < lines.length - 1; i++) {
    for (const { pattern, field } of LABELS) {
      if (pattern.test(lines[i]) && !result[field]) {
        const val = lines[i + 1].trim()
        if (val && !LABELS.some(l => l.pattern.test(val))) {
          result[field] = val
        }
      }
    }
  }

  // Regex fallbacks for inline formats
  if (!result.holder_name) {
    const m = text.match(/HOLDER\s*NAME[:\s]+([A-Za-z\s]+)/i)
    if (m) result.holder_name = m[1].trim()
  }
  if (!result.visa_type) {
    const m = text.match(/VISA\s*TYPE[:\s]+([A-Za-z\s]+)/i)
    if (m) result.visa_type = m[1].trim()
  }
  if (!result.country) {
    const m = text.match(/COUNTRY[:\s]+([A-Za-z\s]+)/i)
    if (m) result.country = m[1].trim()
  }
  if (!result.expiry_date) {
    const m = text.match(/EXPIRY\s*DATE[:\s]+(\d{1,2}\s+\w+\s+\d{4}|\d{2}[\/\-]\d{2}[\/\-]\d{4})/i)
    if (m) result.expiry_date = m[1].trim()
  }

  // Document title as visa_type fallback
  if (!result.visa_type) {
    const titleM = text.match(/^(EMPLOYMENT VISA|WORK PERMIT|STUDENT VISA|TOURIST VISA|BUSINESS VISA)/im)
    if (titleM) result.visa_type = titleM[1]
  }

  return result
}

// ── PASSPORT ─────────────────────────────────────────────────
function parsePassportRawText(text) {
  const lines  = text.split('\n').map(l => l.trim()).filter(Boolean)
  const result = {}

  // MRZ lines (contain many < chars)
  const mrzLines = lines.filter(l => l.includes('<') && l.replace(/[^<]/g, '').length > 5)
  if (mrzLines.length >= 2) {
    const mrz2 = mrzLines[mrzLines.length - 1]
    const mrz1 = mrzLines[mrzLines.length - 2]
    Object.assign(result, parseMRZLine2(mrz2))
    if (mrz1.startsWith('P<')) {
      const parts = mrz1.slice(5).split('<<')
      const surname    = (parts[0] || '').replace(/</g, ' ').trim()
      const givenNames = (parts[1] || '').replace(/</g, ' ').trim()
      result.name = givenNames && surname ? `${givenNames} ${surname}`.trim() : surname || givenNames
    }
  }

  // Readable field patterns (supplement MRZ)
  const natM = text.match(/NATIONALITY[\s\n]+([A-Za-z]+)/i)
  if (natM && !result.nationality) result.nationality = natM[1].trim()

  const nameM = text.match(/SURNAME\s*\/\s*GIVEN\s*NAMES?[\s\n]+([A-Za-z ,]+)/i)
  if (nameM && !result.name) {
    const raw   = nameM[1].trim().replace(/\n/g, ' ')
    const parts = raw.split(',').map(s => s.trim())
    result.name = parts.length > 1 ? `${parts[1]} ${parts[0]}`.trim() : raw
  }

  const pnoM = text.match(/PASSPORT\s*NO\.?[\s\n]+([A-Z][A-Z0-9]{6,9})/i)
  if (pnoM && !result.passport_number) result.passport_number = pnoM[1].trim()

  const dobM = text.match(/DATE\s*OF\s*BIRTH[\s\n]+(\d{1,2}[\s\/\-]\w+[\s\/\-]\d{2,4}|\d{2}[\/\-]\d{2}[\/\-]\d{4})/i)
  if (dobM && !result.date_of_birth) result.date_of_birth = dobM[1].trim()

  const expM = text.match(/DATE\s*OF\s*EXPIRY[\s\n]+(\d{1,2}[\s\/\-]\w+[\s\/\-]\d{2,4}|\d{2}[\/\-]\d{2}[\/\-]\d{4})/i)
  if (expM && !result.expiry_date) result.expiry_date = expM[1].trim()

  return result
}

// ── AADHAAR ───────────────────────────────────────────────────
// Handles TWO Aadhaar formats:
//
// Format A — Digital/e-Aadhaar (new UI with white background):
//   "Name / नाम\nAbhijith S\nDate of Birth\n22/08/1998\nGender / लिंग\nMale\nAddress\nPeroorkada..."
//   Unique ID shown at top: "7284 5193 6047"
//
// Format B — Physical card scan / older format:
//   Name, DOB, gender appear directly without bilingual labels
//   "Abhijith S\nDate of Birth/ DOB: 18/11/2001\nMale/ MALE"
//   Aadhaar number at bottom: "7284 5193 6047" or "xxxx xxxx 6047"
function parseAadhaarRawText(text) {
  const result = {}
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

  // ── Aadhaar number (works for both formats) ───────────────
  // Full 12-digit: "7284 5193 6047" or "728451936047"
  const fullNum = text.match(/\b(\d{4}\s\d{4}\s\d{4})\b/)
  if (fullNum) result.aadhaar_number = fullNum[1]
  if (!result.aadhaar_number) {
    const fullNum2 = text.match(/\b(\d{12})\b/)
    if (fullNum2) result.aadhaar_number = fullNum2[1].replace(/(\d{4})(\d{4})(\d{4})/, '$1 $2 $3')
  }
  // Masked format: "xxxx xxxx 6047" — still useful
  if (!result.aadhaar_number) {
    const maskedM = text.match(/[xX*]{4}\s[xX*]{4}\s(\d{4})/)
    if (maskedM) result.aadhaar_number = `XXXX XXXX ${maskedM[1]}`
  }

  // ── DOB (both formats) ────────────────────────────────────
  // Format A: "Date of Birth\n22/08/1998"
  // Format B: "Date of Birth/ DOB: 18/11/2001" or "DOB: 18/11/2001"
  const dobM = text.match(/(?:Date\s*of\s*Birth|DOB)[\s\/:\-]+(\d{2}[\/\-]\d{2}[\/\-]\d{4})/i)
  if (dobM) result.date_of_birth = dobM[1]
  if (!result.date_of_birth) {
    const dobFallback = text.match(/(\d{2}[\/\-]\d{2}[\/\-]\d{4})/)
    if (dobFallback) result.date_of_birth = dobFallback[1]
  }

  // ── Gender ────────────────────────────────────────────────
  // Format B has "Male/ MALE" — pick the readable part
  const genderM = text.match(/\b(Male|Female)(?:\s*\/\s*(?:MALE|FEMALE))?/i)
  if (genderM) result.gender = genderM[1].charAt(0).toUpperCase() + genderM[1].slice(1).toLowerCase()
  if (!result.gender) {
    const genderM2 = text.match(/\b(MALE|FEMALE)\b/)
    if (genderM2) result.gender = genderM2[1].charAt(0) + genderM2[1].slice(1).toLowerCase()
  }

  // ── Name (trickiest — must skip non-Latin lines) ──────────
  // Format A: line after "Name / नाम" label
  for (let i = 0; i < lines.length - 1; i++) {
    if (/Name\s*[/|]\s*(नाम)?/i.test(lines[i]) && !lines[i].match(/Malayalam|मलयालम/i)) {
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        // Must be Latin script only, proper name length
        if (/^[A-Za-z][A-Za-z\s\.]{1,50}$/.test(lines[j]) && lines[j].trim().split(' ').length <= 5) {
          result.name = lines[j].trim()
          break
        }
      }
      if (result.name) break
    }
  }

  // Format B: name appears as first Latin proper-cased line near top
  if (!result.name) {
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      const l = lines[i]
      // Proper name: starts with capital, all Latin, 2-5 words, not a label
      if (/^[A-Z][a-z]+(?:\s[A-Z][a-z]+)*$/.test(l) &&
          l.split(' ').length <= 5 &&
          l.length >= 3 && l.length <= 50 &&
          !/(?:Date|Birth|Male|Female|Address|Government|India|Aadhaar)/i.test(l)) {
        result.name = l
        break
      }
    }
  }

  // Format B fallback: look for "S/O SreeKu..." pattern and use first line
  if (!result.name) {
    const nameM = text.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)(?:\n|\r)/m)
    if (nameM) result.name = nameM[1].trim()
  }

  // ── Address ───────────────────────────────────────────────
  // Format A: line(s) after "Address" label
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^Address$/i.test(lines[i])) {
      const addrParts = []
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (/^[A-Za-z0-9,\s\-\.]+$/.test(lines[j]) && lines[j].length > 2) {
          addrParts.push(lines[j])
        } else break
      }
      if (addrParts.length) { result.address = addrParts.join(', '); break }
    }
  }

  // Format B: address on the right side — look for S/O pattern
  if (!result.address) {
    const addrM = text.match(/Address:[\s\S]*?([A-Z]\/O\s+[A-Za-z\s]+,[^\n]+)/i)
    if (addrM) result.address = addrM[1].trim()
    else {
      // Collect lines after "Address:" marker
      const addrLineM = text.match(/Address:\s*([\s\S]{10,200}?)(?:\n{2}|$)/i)
      if (addrLineM) result.address = addrLineM[1].replace(/\n/g, ', ').trim()
    }
  }

  return result
}

// ── PAN CARD ──────────────────────────────────────────────────
// Layout: INCOME TAX DEPARTMENT header, then PAN number, then NAME, then FATHER'S NAME, then DOB
function parsePanRawText(text) {
  const result = {}
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

  // PAN number — format ABCDE1234F
  const panM = text.match(/\b([A-Z]{5}[0-9]{4}[A-Z])\b/)
  if (panM) result.pan_number = panM[1]

  // Find the labelled fields
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase()

    // NAME label → next non-empty line that's not a label
    if (l === 'name' && lines[i + 1]) {
      const candidate = lines[i + 1].trim()
      // Must be all caps alphabetic (PAN names are printed in CAPS)
      if (/^[A-Z\s]+$/.test(candidate) && candidate.length > 1 && candidate.length < 50) {
        result.name = candidate
      }
    }

    // FATHER'S NAME label
    if ((l === "father's name" || l === 'fathers name') && lines[i + 1]) {
      const candidate = lines[i + 1].trim()
      if (/^[A-Z\s]+$/.test(candidate) && candidate.length > 1) {
        result.father_name = candidate
      }
    }

    // DATE OF BIRTH label
    if ((l === 'date of birth' || l === 'dob') && lines[i + 1]) {
      const dobM = lines[i + 1].match(/(\d{2}[\/\-]\d{2}[\/\-]\d{4})/)
      if (dobM) result.date_of_birth = dobM[1]
    }
  }

  // Fallback DOB from anywhere
  if (!result.date_of_birth) {
    const dobM = text.match(/(\d{2}[\/\-]\d{2}[\/\-]\d{4})/)
    if (dobM) result.date_of_birth = dobM[1]
  }

  // Fallback name — first ALL CAPS line that isn't a label or institution name
  if (!result.name) {
    const skipWords = ['INCOME', 'GOVT', 'GOVERNMENT', 'DEPARTMENT', 'PERMANENT', 'ACCOUNT', 'NUMBER']
    for (const line of lines) {
      if (/^[A-Z][A-Z\s]{2,40}$/.test(line) && !skipWords.some(w => line.includes(w))) {
        result.name = line.trim()
        break
      }
    }
  }

  return result
}

// ── BANK DETAILS ─────────────────────────────────────────────
// SBI Account Certificate OCR has a two-column table layout.
// Document AI / OCR reads the LEFT column labels as one block,
// then the RIGHT column values as another block:
//
//   Block 1 (labels):         Block 2 (values):
//   "Account Holder Name"     "ABHIJITH S"
//   "Account Number"          "38291047560034"
//   "Account Type"            "Savings Account"
//   "Bank Name"               "State Bank of India"
//   "Branch"                  "Peroorkada Branch, Thiruvananthapuram"
//   "IFSC Code"               "SBIN0070218"
//
// So we collect all known label lines, collect all value lines,
// then zip them together.
function parseBankRawText(text) {
  const result = {}
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

  // Known label strings (in order they appear on SBI cert)
  const ORDERED_LABELS = [
    { pattern: /^Account\s*Holder\s*(Name)?$/i,  field: 'account_holder' },
    { pattern: /^Account\s*Number$/i,              field: 'account_number' },
    { pattern: /^Account\s*Type$/i,                field: 'account_type' },
    { pattern: /^Bank\s*Name$/i,                   field: 'bank_name' },
    { pattern: /^Branch$/i,                         field: 'branch' },
    { pattern: /^IFSC\s*Code$/i,                   field: 'ifsc_code' },
    { pattern: /^MICR\s*Code$/i,                   field: 'micr_code' },
    { pattern: /^Account\s*Status$/i,              field: 'account_status' },
    { pattern: /^Linked\s*Mobile$/i,               field: 'linked_mobile' },
    { pattern: /^PAN\s*Linked$/i,                  field: 'pan_linked' },
  ]

  // Classify each line as label or value
  const labelLines   = []
  const valueLines   = []
  const usedAsLabel  = new Set()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const isLabel = ORDERED_LABELS.some(l => l.pattern.test(line))
    if (isLabel) {
      labelLines.push({ line, idx: i })
      usedAsLabel.add(i)
    }
  }

  // Strategy A: Two-column block — labels in one block, values in another
  // Detected when we have consecutive label lines (≥3 in a row)
  let consecutiveLabels = 0
  for (let i = 0; i < lines.length; i++) {
    if (ORDERED_LABELS.some(l => l.pattern.test(lines[i]))) consecutiveLabels++
    else consecutiveLabels = 0
    if (consecutiveLabels >= 3) {
      // Found a label block — find where it ends
      let labelStart = i - consecutiveLabels + 1
      let labelEnd = i
      while (labelEnd + 1 < lines.length && ORDERED_LABELS.some(l => l.pattern.test(lines[labelEnd + 1]))) {
        labelEnd++
      }
      // Values should follow immediately after
      const labelsInBlock = lines.slice(labelStart, labelEnd + 1)
      const valuesStart   = labelEnd + 1
      const valuesInBlock = []
      for (let j = valuesStart; j < Math.min(valuesStart + labelsInBlock.length + 3, lines.length); j++) {
        if (!ORDERED_LABELS.some(l => l.pattern.test(lines[j]))) {
          valuesInBlock.push(lines[j])
        }
      }
      // Zip labels with values
      labelsInBlock.forEach((labelLine, idx) => {
        const labelDef = ORDERED_LABELS.find(l => l.pattern.test(labelLine))
        if (labelDef && valuesInBlock[idx] && !result[labelDef.field]) {
          result[labelDef.field] = valuesInBlock[idx].trim()
        }
      })
      console.log('[bank] Strategy A (two-column): matched', Object.keys(result).length, 'fields')
      if (Object.keys(result).length >= 3) break
    }
  }

  // Strategy B: Alternating label/value lines
  if (Object.keys(result).length < 2) {
    for (let i = 0; i < lines.length - 1; i++) {
      for (const { pattern, field } of ORDERED_LABELS) {
        if (pattern.test(lines[i]) && !result[field]) {
          const val = lines[i + 1].trim()
          if (val && !ORDERED_LABELS.some(l => l.pattern.test(val))) {
            result[field] = val
          }
        }
      }
    }
    if (Object.keys(result).length >= 2) {
      console.log('[bank] Strategy B (alternating): matched', Object.keys(result).length, 'fields')
    }
  }

  // Strategy C: single-line "Label    Value" (2+ spaces)
  if (Object.keys(result).length < 2) {
    for (const line of lines) {
      const m = line.match(/^(.+?)\s{2,}(.+)$/)
      if (!m) continue
      const key = m[1].trim()
      const val = m[2].trim()
      const labelDef = ORDERED_LABELS.find(l => l.pattern.test(key))
      if (labelDef && !result[labelDef.field]) result[labelDef.field] = val
    }
    console.log('[bank] Strategy C (inline): matched', Object.keys(result).length, 'fields')
  }

  // Clean up
  if (result.account_number) result.account_number = result.account_number.replace(/[^0-9]/g, '')
  if (result.pan_linked)     result.pan_linked = result.pan_linked.replace(/^Yes\s*[—\-]\s*/i, '').trim()

  // Regex fallbacks for critical fields
  if (!result.ifsc_code) {
    const m = text.match(/\b([A-Z]{4}0[A-Z0-9]{6})\b/)
    if (m) result.ifsc_code = m[1]
  }
  if (!result.account_number) {
    const m = text.match(/\b(\d{11,18})\b/)
    if (m) result.account_number = m[1]
  }
  if (!result.account_holder) {
    const m = text.match(/Account\s*Holder(?:\s*Name)?[:\s]+([A-Z][A-Z\s]{2,40})/i)
    if (m) result.account_holder = m[1].trim()
  }
  if (!result.bank_name) {
    if (/state bank of india/i.test(text))   result.bank_name = 'State Bank of India'
    else if (/hdfc/i.test(text))             result.bank_name = 'HDFC Bank'
    else if (/icici/i.test(text))            result.bank_name = 'ICICI Bank'
    else if (/axis bank/i.test(text))        result.bank_name = 'Axis Bank'
    else if (/canara/i.test(text))           result.bank_name = 'Canara Bank'
    else if (/kotak/i.test(text))            result.bank_name = 'Kotak Mahindra Bank'
  }

  return result
}

// ── DEGREE CERTIFICATE ────────────────────────────────────────
// Handles formal certificate layout:
// "Model Engineering College, Thrikkakara"
// "...THIS IS TO CERTIFY THAT..."
// "Abhijith S"
// "...is hereby awarded the degree of..."
// "Master of Computer Applications"
function parseDegreeRawText(text) {
  const result = {}
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

  // Student name — line after "THIS IS TO CERTIFY THAT" or "CERTIFY THAT"
  for (let i = 0; i < lines.length - 1; i++) {
    if (/certify\s+that/i.test(lines[i])) {
      const candidate = lines[i + 1]
      if (candidate && /^[A-Za-z\s\.]+$/.test(candidate) && candidate.length < 60) {
        result.student_name = candidate.trim()
      }
      break
    }
  }

  // Degree — line after "awarded the degree of" or "degree of"
  for (let i = 0; i < lines.length - 1; i++) {
    if (/degree\s+of/i.test(lines[i]) || /awarded.*degree/i.test(lines[i])) {
      const candidate = lines[i + 1]
      if (candidate && candidate.length < 80) {
        result.degree = candidate.trim()
      }
      break
    }
    // Sometimes "awarded the degree of" is on same line as degree
    const degreeM = lines[i].match(/degree\s+of\s+([A-Za-z\s]+)/i)
    if (degreeM) {
      result.degree = degreeM[1].trim()
      break
    }
  }

  // Field of study — line after degree (often "in [Field]")
  if (result.degree) {
    const degreeIdx = lines.findIndex(l => l.includes(result.degree))
    if (degreeIdx >= 0 && lines[degreeIdx + 1]) {
      const next = lines[degreeIdx + 1]
      const fieldM = next.match(/^in\s+(.+)$/i)
      if (fieldM) result.field_of_study = fieldM[1].trim()
    }
  }

  // Institution — first long line with "College" or "University"
  for (const line of lines) {
    if (/(?:college|university|institute)/i.test(line) && line.length > 10) {
      result.institution = line.trim()
      break
    }
  }

  // Graduation year — from "Convocation:" or 4-digit year near end
  const convM = text.match(/Convocation[:\s]+.*?(\d{4})/i)
  if (convM) result.graduation_year = convM[1]
  if (!result.graduation_year) {
    // Last 4-digit year in the document
    const years = [...text.matchAll(/\b(20\d{2})\b/g)].map(m => m[1])
    if (years.length) result.graduation_year = years[years.length - 1]
  }

  return result
}

// Route raw text to the right parser
function parseRawText(text, docType) {
  if (!text) return {}
  switch (docType) {
    case 'passport':          return parsePassportRawText(text)
    case 'visa':              return parseVisaRawText(text)
    case 'aadhaar':           return parseAadhaarRawText(text)
    case 'pan_card':          return parsePanRawText(text)
    case 'bank_details':      return parseBankRawText(text)
    case 'degree':            return parseDegreeRawText(text)
    default:                  return {}
  }
}

// ── Document AI ───────────────────────────────────────────────
async function verifyWithDocumentAI(base64, mimeType, documentType) {
  if (!docAiClient) throw new Error('Document AI client not initialized — check SA_ credentials in Render env vars')
  if (!DOC_AI_PROJECT) throw new Error('DOCUMENT_AI_PROJECT_ID not set in Render env vars')

  const processorId = PROCESSOR_IDS[documentType] || PROCESSOR_IDS.passport
  if (!processorId) {
    throw new Error(
      'PROCESSOR_ID_DEFAULT missing or still placeholder. ' +
      'GCP Console → Document AI → your processor → copy the ID → add to Render env vars'
    )
  }

  const name = `projects/${DOC_AI_PROJECT}/locations/${DOC_AI_LOCATION}/processors/${processorId}`
  console.log(`[documentVerify] Calling processor: ${name} | docType: ${documentType}`)

  let result
  try {
    ;[result] = await docAiClient.processDocument({
      name,
      rawDocument: { content: base64, mimeType },
    })
  } catch (err) {
    const msg = err?.message || String(err)
    if (msg.includes('INVALID_ARGUMENT')) {
      throw new Error(
        `Document AI INVALID_ARGUMENT. Check: (1) DOCUMENT_AI_LOCATION is "us" or "eu" ` +
        `(2) PROCESSOR_ID is short hex only (3) mimeType "${mimeType}" is supported`
      )
    }
    if (msg.includes('NOT_FOUND') || msg.includes('404')) {
      throw new Error(`Processor not found: "${processorId}" in ${DOC_AI_PROJECT}/${DOC_AI_LOCATION}`)
    }
    if (msg.includes('PERMISSION_DENIED') || msg.includes('403')) {
      throw new Error('Permission denied — add "Document AI API User" role to service account in GCP IAM')
    }
    throw err
  }

  const doc    = result?.document || {}
  const fields = {}

  // Log what came back
  console.log(`[documentVerify] entities: ${(doc.entities||[]).length} | pages: ${(doc.pages||[]).length} | text: ${(doc.text||'').length} chars`)

  // Extract entities (ID Document Parser returns these)
  ;(doc.entities || []).forEach(e => {
    const key   = (e.type || '').toLowerCase().replace(/[^a-z0-9]/g, '_')
    const value = e.mentionText || e.normalizedValue?.text || ''
    if (key && value) fields[key] = value
  })

  // Extract form fields (Form Parser returns these)
  ;(doc.pages || []).forEach(page => {
    ;(page.formFields || []).forEach(f => {
      const key   = (f.fieldName?.textAnchor?.content  || '').toLowerCase().replace(/[^a-z0-9]/g, '_').trim()
      const value = (f.fieldValue?.textAnchor?.content || '').trim()
      if (key && value) fields[key] = value
    })
  })

  const rawText    = (doc.text || '').trim()
  let normalized   = normalizeFields(fields, documentType)
  let entityCount  = Object.keys(normalized).length

  // ── KEY FIX: If no structured fields but we have raw text, parse it ourselves ──
  if (entityCount === 0 && rawText) {
    console.log(`[documentVerify] 0 entities from processor — parsing raw text (${rawText.length} chars)`)
    const parsed = parseRawText(rawText, documentType)
    const parsedCount = Object.keys(parsed).length
    console.log(`[documentVerify] Raw text parsing extracted ${parsedCount} fields:`, JSON.stringify(parsed))
    normalized  = { ...parsed }
    entityCount = parsedCount
  }

  if (entityCount === 0 && !rawText) {
    throw new Error(
      'Document AI returned 0 fields and no text. ' +
      'Check image quality or use "ID Document Parser" processor in GCP Console.'
    )
  }

  console.log(`[documentVerify] Final extracted fields (${entityCount}):`, JSON.stringify(normalized))

  return {
    ...normalized,
    is_authentic: true,
    confidence:   entityCount > 3 ? 88 : entityCount > 0 ? 72 : 50,
    flags:        entityCount === 0
      ? ['No fields extracted from document']
      : entityCount < 3
        ? ['Partial extraction — some fields detected. Please review and correct.']
        : [],
    raw_text: rawText,
    _source:  entityCount > 0 && Object.keys(fields).length === 0 ? 'raw_text_parser' : 'document_ai',
  }
}

// ── Gemini Vision fallback ────────────────────────────────────
const GEMINI_PROMPTS = {
  passport: `Extract from this Indian passport image. Return ONLY valid JSON, no markdown:
{"name":"full name from SURNAME/GIVEN NAMES field","passport_number":"passport number","date_of_birth":"DD/MM/YYYY","nationality":"nationality text","expiry_date":"DD/MM/YYYY","is_authentic":true,"confidence":88,"flags":[]}`,

  visa: `Extract from this visa/work permit document. Return ONLY valid JSON, no markdown:
{"visa_type":"type of visa","holder_name":"full name","country":"issuing country","expiry_date":"date","permitted_activities":"allowed activities","is_authentic":true,"confidence":85,"flags":[]}`,

  aadhaar: `Extract from this Indian Aadhaar card image. Return ONLY valid JSON, no markdown:
{"name":"English name (NOT Malayalam script)","aadhaar_number":"12-digit number with spaces like XXXX XXXX XXXX","date_of_birth":"DD/MM/YYYY","gender":"Male or Female","address":"full address text","is_authentic":true,"confidence":88,"flags":[]}`,

  pan_card: `Extract from this Indian PAN card image. Return ONLY valid JSON, no markdown:
{"name":"card holder name in CAPS","pan_number":"10-character PAN like ABCDE1234F","father_name":"father name in CAPS","date_of_birth":"DD/MM/YYYY","is_authentic":true,"confidence":88,"flags":[]}`,

  bank_details: `Extract from this Indian bank account document/certificate. Return ONLY valid JSON, no markdown:
{"account_holder":"account holder full name","bank_name":"full bank name","account_type":"Savings/Current/etc","account_number":"full account number digits","ifsc_code":"IFSC code like SBIN0070218","is_authentic":true,"confidence":88,"flags":[]}`,

  degree: `Extract from this degree certificate image. Return ONLY valid JSON, no markdown:
{"student_name":"graduate full name","institution":"college/university full name","degree":"degree title like Master of Computer Applications","field_of_study":"field/specialization","graduation_year":"4-digit year","is_authentic":true,"confidence":85,"flags":[]}`,

  employment_letter: `Extract from this offer letter or employment letter. Return ONLY valid JSON, no markdown:
{"employee_name":"candidate/employee full name","company":"company/organization name","position":"job title or role","start_date":"joining/start date","is_authentic":true,"confidence":85,"flags":[]}`,
}

async function verifyWithGemini(base64, mimeType, documentType) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set in Render env vars')

  const prompt = GEMINI_PROMPTS[documentType] ||
    `Extract all fields from this document. Return ONLY valid JSON: ${FIELD_TEMPLATES[documentType] || FIELD_TEMPLATES.passport}`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 800 },
      }),
    }
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `Gemini HTTP ${res.status}`)
  }

  const data   = await res.json()
  const raw    = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const clean  = raw.replace(/```json|```/gi, '').trim()
  const parsed = JSON.parse(clean.match(/\{[\s\S]*\}/)?.[0] || clean)

  console.log(`[documentVerify] Gemini extracted fields for ${documentType}:`, JSON.stringify(parsed))
  return { ...parsed, _source: 'gemini' }
}

// ── Document type validator ──────────────────────────────────
// Checks if the document content actually matches the expected type.
// Returns { valid: true } or { valid: false, reason: "..." }
function validateDocumentType(extractedFields, rawText, documentType) {
  const text = (rawText || '').toLowerCase()
  const fields = extractedFields || {}

  switch (documentType) {

    case 'passport':
      // Must have passport number (letter + digits) or MRZ lines
      if (fields.passport_number && /^[A-Z][0-9]{7}/.test(fields.passport_number)) return { valid: true }
      if (text.includes('passport') && (text.includes('nationality') || text.includes('date of birth'))) return { valid: true }
      if (text.includes('p<ind') || text.includes('p<gbr') || text.includes('p<usa')) return { valid: true }
      return { valid: false, reason: 'This does not appear to be a passport. Please upload a valid passport document.' }

    case 'aadhaar':
      // Must have 12-digit Aadhaar number or UIDAI text
      if (fields.aadhaar_number && /^\d{4}\s?\d{4}\s?\d{4}$/.test(fields.aadhaar_number)) return { valid: true }
      if (text.includes('aadhaar') || text.includes('uidai') || text.includes('unique identification')) return { valid: true }
      if (/\d{4}\s\d{4}\s\d{4}/.test(rawText || '')) return { valid: true }
      return { valid: false, reason: 'This does not appear to be an Aadhaar card. Please upload your Aadhaar card.' }

    case 'pan_card':
      // Must have PAN format ABCDE1234F
      if (fields.pan_number && /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(fields.pan_number)) return { valid: true }
      if (text.includes('income tax') || text.includes('permanent account number') || text.includes('pan')) return { valid: true }
      if (/[A-Z]{5}[0-9]{4}[A-Z]/.test(rawText || '')) return { valid: true }
      return { valid: false, reason: 'This does not appear to be a PAN card. Please upload your PAN card.' }

    case 'bank_details':
      // Must have account number or IFSC or bank-related text
      if (fields.account_number && fields.account_number.length >= 9) return { valid: true }
      if (fields.ifsc_code && /^[A-Z]{4}0[A-Z0-9]{6}$/.test(fields.ifsc_code)) return { valid: true }
      if (text.includes('account') && (text.includes('ifsc') || text.includes('bank') || text.includes('savings'))) return { valid: true }
      return { valid: false, reason: 'This does not appear to be a bank document. Please upload a bank passbook, statement, or account certificate.' }

    case 'degree':
      // Must have degree/university related text
      if (fields.degree && fields.degree.length > 3) return { valid: true }
      if (text.includes('university') || text.includes('college') || text.includes('degree') ||
          text.includes('bachelor') || text.includes('master') || text.includes('certify that')) return { valid: true }
      return { valid: false, reason: 'This does not appear to be a degree certificate. Please upload your graduation/degree certificate.' }

    case 'visa':
      // Must have visa-related text
      if (fields.visa_type || fields.holder_name) return { valid: true }
      if (text.includes('visa') || text.includes('work permit') || text.includes('immigration') ||
          text.includes('permitted activities') || text.includes('permitted to work')) return { valid: true }
      return { valid: false, reason: 'This does not appear to be a visa or work permit. Please upload your visa document.' }

    case 'employment_letter':
      // Offer letter / appointment letter
      if (fields.employee_name && fields.company) return { valid: true }
      if (text.includes('offer') || text.includes('appointment') || text.includes('employment') ||
          text.includes('joining') || text.includes('position') || text.includes('designation')) return { valid: true }
      return { valid: false, reason: 'This does not appear to be an offer letter. Please upload your offer/appointment letter.' }

    default:
      return { valid: true } // Unknown type — allow through
  }
}

// ── Main export ───────────────────────────────────────────────
export async function verifyDocument(base64, mimeType, documentType) {
  let docAiResult = null
  let rawText = ''

  try {
    docAiResult = await verifyWithDocumentAI(base64, mimeType, documentType)
    rawText = docAiResult.raw_text || ''

    const fieldCount = Object.keys(docAiResult).filter(k =>
      !['is_authentic','confidence','flags','raw_text','_source'].includes(k) && docAiResult[k]
    ).length

    if (fieldCount >= 2) {
      console.log(`[documentVerify] Document AI: ${fieldCount} fields`)
      const check = validateDocumentType(docAiResult, rawText, documentType)
      if (!check.valid) {
        console.warn(`[documentVerify] Wrong doc type: ${check.reason}`)
        return { is_authentic: false, confidence: 0, flags: [check.reason], _source: 'validation_failed', wrong_document: true }
      }
      return docAiResult
    }

    console.log(`[documentVerify] Document AI got ${fieldCount} fields — trying Gemini`)
  } catch (err) {
    console.warn(`[documentVerify] Document AI failed: ${err.message}`)
  }

  // Gemini fallback
  let geminiResult = null
  try {
    geminiResult = await verifyWithGemini(base64, mimeType, documentType)
    if (!rawText && geminiResult) rawText = geminiResult.raw_text || ''
  } catch (err) {
    console.error('[documentVerify] Gemini failed:', err.message)
  }

  // Pick best result by field count
  const countFields = r => r ? Object.keys(r).filter(k =>
    !['is_authentic','confidence','flags','raw_text','_source','wrong_document'].includes(k) && r[k]
  ).length : 0

  const bestResult = countFields(geminiResult) >= countFields(docAiResult) ? geminiResult : docAiResult

  if (!bestResult) {
    return { is_authentic: null, confidence: 0, flags: ['Extraction failed — both Document AI and Gemini unavailable'], _source: 'error' }
  }

  // Validate document type
  const check = validateDocumentType(bestResult, rawText, documentType)
  if (!check.valid) {
    console.warn(`[documentVerify] Wrong doc type: ${check.reason}`)
    return { is_authentic: false, confidence: 0, flags: [check.reason], _source: 'validation_failed', wrong_document: true }
  }

  const fc = countFields(bestResult)
  console.log(`[documentVerify] Final: ${fc} fields from ${bestResult._source || 'gemini'}`)
  return { ...bestResult, is_authentic: true, confidence: bestResult.confidence || 85 }
}