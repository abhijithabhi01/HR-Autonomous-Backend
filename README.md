# 🤖 Autonomous HR Onboarding Agent - Backend

> Backend API for the Autonomous HR Onboarding Agent. It automates candidate onboarding, document verification, AI-powered document extraction, employee provisioning, checklist management, notifications, and HR workflows.

![Node.js](https://img.shields.io/badge/Node.js-22.x-green)
![Express](https://img.shields.io/badge/Express.js-API-black)
![Firebase](https://img.shields.io/badge/Firebase-Admin-orange)
![Vertex AI](https://img.shields.io/badge/Google-Vertex_AI-blue)

---

# 📖 Overview

The backend provides REST APIs that power the Autonomous HR Onboarding platform.

It integrates Google Cloud AI services, Firebase, and email automation to streamline the employee onboarding process from document submission to account provisioning.

---

# ✨ Features

- 🔐 Authentication APIs
- 📄 Employee Document Upload
- 🤖 AI Document Verification
- 📝 Offer Letter Extraction
- 📋 Employee Checklist Management
- 📧 Automated Email Notifications
- 👨‍💼 Employee Management
- 🔔 Alerts & Notifications
- ☁️ Firebase Integration
- 🧠 Google Vertex AI
- 📑 Google Document AI
- 🌐 RESTful APIs

---

# 🏗️ Architecture

```
Frontend (React)

        │

        ▼

Express REST API

 ├── Authentication
 ├── Candidate APIs
 ├── Employee APIs
 ├── Document APIs
 ├── Provisioning APIs
 ├── Email Service
 └── Checklist APIs

        │

        ▼

Google Vertex AI
Google Document AI
Firebase
Mail Service
```

---

# ⚙️ Tech Stack

## Backend

- Node.js
- Express.js

## Database

- Firebase Firestore

## AI Services

- Google Vertex AI
- Google Document AI

## Authentication

- Firebase Admin SDK

## Utilities

- Nodemailer
- Multer
- dotenv
- CORS

---

# 📂 Project Structure

```
src/

├── config/
├── middleware/
├── routes/
│   ├── auth
│   ├── candidates
│   ├── documents
│   ├── employees
│   ├── checklist
│   ├── provisioning
│   ├── email
│   ├── alerts
│   └── policy
│
├── services/
│   ├── documentVerify.js
│   └── email.js
│
server.js
```

---

# 🚀 Installation

```bash
git clone https://github.com/yourusername/HR-Autonomous-Backend.git

cd HR-Autonomous-Backend

npm install
```

---

# Environment Variables

Create a `.env` file.

```env
PORT=5000

GOOGLE_PROJECT_ID=

VERTEX_LOCATION=

DOCUMENT_AI_PROCESSOR_ID=

GOOGLE_APPLICATION_CREDENTIALS=

FIREBASE_PROJECT_ID=

EMAIL_USER=

EMAIL_PASSWORD=
```

---

# Run

Development

```bash
npm run dev
```

Production

```bash
npm start
```

---

# API Modules

- Authentication
- Candidates
- Employees
- Documents
- Checklist
- Email
- Provisioning
- Alerts
- Policy

---

# Workflow

1. Candidate registers.
2. HR uploads onboarding documents.
3. Document AI extracts document information.
4. Vertex AI validates uploaded documents.
5. Employee checklist is generated.
6. Email notifications are sent.
7. Employee provisioning is completed.
8. HR monitors onboarding progress.

---

# Security

- Firebase Authentication
- Protected APIs
- Environment Variables
- Error Handling Middleware

---

# Author

**Abhijith S**

AI Developer | Full Stack Developer

GitHub: https://github.com/abhijithabhi01

LinkedIn: https://www.linkedin.com/in/abhijith-s-5138a724b
