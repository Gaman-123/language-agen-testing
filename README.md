# 🏥 Spot Medicine AI

Spot Medicine AI is an advanced AI-powered clinical consultation assistant designed to bridge language barriers between doctors and patients in India. It leverages multi-model AI to provide real-time translation, automated intake auditing, and editable digital prescriptions — all spoken aloud in the patient's regional language.

---

## 🚀 Key Features

### 🎙️ Dual Microphone Consultation
- Separate **Doctor (English)** and **Patient (Regional Language)** mic buttons.
- High-accuracy speech-to-text powered by **Sarvam AI** (`saaras:v3`).
- Pulsing mic animations and live status indicators during recording.

### 🌐 Real-Time Translation (All Indian Languages)
- Automatic translation after every recording using **Meta Llama 3.3-70B** via HuggingFace Router.
- Supports: **Hindi, Tamil, Telugu, Kannada, Tulu, Bengali, Malayalam, Gujarati, Marathi, Punjabi**.
- **Medical terms are preserved in English** — medicine names, dosages (mg/ml), frequencies (1-0-1, OD, BD, TDS), and disease names are never translated, only the surrounding conversational text.

### 🔊 Voice Playback (2-Layer TTS)
Audio playback works for all supported Indian languages with a robust fallback chain:

| Layer | Engine | Notes |
|---|---|---|
| **1️⃣ Sarvam AI** (`bulbul:v2`) | Premium natural Indian voice (Anushka) | Best quality, supports all Indian languages |
| **2️⃣ Browser Web Speech API** | Built-in system voices | Last resort fallback |

- **Auto-Speak**: Automatically reads translations aloud after each recording.
- **Inline 🔊 Buttons**: Each translated chat message has a speaker button for manual replay.

### 🧠 AI Clinical Intake Auditor
Triggered by **"Check Completeness & Generate Rx"**:
- Checks consultation against **7 clinical dimensions**:
  - Chief Complaint, Duration, Severity, Associated Symptoms, Medical History, Allergies, Current Medications
- Displays missing clinical points in a color-coded warning panel.
- Suggests specific **follow-up questions** for the doctor (with 🔊 speaker on each).

### 📋 Doctor-Editable Digital Prescription
The AI generates a structured JSON clinical report that the doctor can edit before finalizing:

**✏️ Edit Mode:**
- Editable **Diagnosis**, **Advice**, and **Follow-up** fields.
- Full prescription table with editable rows: **Medicine, Dose, Frequency, Duration**.
- ➕ Add rows / ✕ Remove rows.

**🔒 Finalized View:**
- Locks the prescription into a clean read-only format.
- **🔊 "Read to Patient"** button: translates the entire prescription to the patient's selected language (keeping medicine names in English) and speaks it aloud using Sarvam AI TTS.

---

## 🛠️ Technology Stack

| Layer | Technology |
|---|---|
| **Frontend** | React, TypeScript, Framer Motion, Lucide Icons |
| **AI Report Generation** | Google Gemini 2.0 Flash |
| **Translation** | Meta Llama 3.3-70B-Instruct (via HuggingFace Router) |
| **Speech-to-Text** | Sarvam AI (`saaras:v3`) |
| **Text-to-Speech** | Sarvam AI (`bulbul:v2`, speaker: `anushka`) |
| **HTTP Client** | Axios |

---

## 🔑 Environment Variables

Create a `.env` file in the root directory:

```env
VITE_GEMINI_API_KEY=your_google_gemini_key
VITE_SARVAM_API_KEY=your_sarvam_ai_key
VITE_HF_API_KEY=your_huggingface_key
```

---

## 📜 Usage

1. Select the **Patient Language** from the dropdown.
2. Use the **🎤 Doctor (EN)** and **🎤 Patient (KN/HI/...)** buttons to record each side of the consultation.
3. Translations appear automatically in the chat and are spoken aloud.
4. Click **"✅ Check Completeness & Generate Rx"** to audit the consultation and generate the draft report.
5. Edit the **Diagnosis**, **Medicines**, **Advice**, and **Follow-up** in the clinical report panel.
6. Click **"🔒 Finalize Prescription"** to lock the prescription.
7. Click **"🔊 Read to Patient"** to have the prescription read out in the patient's language.

---

## 📌 Changelog

### v3.0 — 14 March 2026
- 🔊 Fixed Sarvam TTS — updated model `bulbul:v1` → `bulbul:v2` (old model deprecated)
- 🔊 Fixed Sarvam TTS speaker — changed `meera` → `anushka` (valid for `bulbul:v2`)
- 🌐 Upgraded translation model from **Llama-3.1-8B** → **Llama-3.3-70B** for better accuracy
- 💊 Medical terms (medicine names, dosages, frequencies) now preserved in English during all translations
- 🗣️ Added **"Read to Patient"** — prescription translated to patient's language and spoken aloud
- 🔧 Fixed JSON extraction bug (regex now correctly picks last valid JSON block from AI response)
- 🔧 Added all required Sarvam TTS fields: `speech_sample_rate`, `enable_preprocessing`, `pace`, `loudness`

### v2.0 — Initial Session
- Dual-mic consultation (Doctor EN + Patient Regional)
- HuggingFace Llama translation for all languages including Tulu
- Sarvam AI Speech-to-Text integration
- AI Clinical Intake Auditor (7-point framework)
- Doctor-editable prescription (add/remove medicine rows)
- Finalize Prescription with lock & edit toggle
- Auto-speak translations after each recording
- Inline 🔊 speaker buttons on each chat message