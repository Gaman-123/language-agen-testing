# 🏥 Spot Medicine AI

Spot Medicine AI is an advanced clinical consultation assistant designed to bridge language barriers between doctors and patients in India. It leverages multi-model AI to provide real-time translation, automated intake auditing, and editable digital prescriptions.

## 🚀 Key Features

### 🎙️ Dual Microphone Consultation
- **Hybrid Input**: Separate controls for Doctor (English) and Patient (Regional languages).
- **Real-Time Transcription**: High-accuracy speech-to-text powered by Sarvam AI (`saaras:v3`).
- **Visual Feedback**: Pulsing microphone animations and live transcription status indicators.

### 🌐 Real-Time Translation
- **Seamless Communication**: Automatic translation between English and 10+ Indian languages after every recording.
- **Language Support**: Hindi, Tamil, Telugu, Kannada, **Tulu**, Bengali, Malayalam, Gujarati, Marathi, and Punjabi.
- **LLM-Powered**: Translation logic handled by **HF Llama 3.1** via HuggingFace Router for high contextual accuracy.

### 🔊 Deep Voice Integration (3-Layer TTS)
Audio readout works for all supported languages using a robust fallback chain:
1.  **Sarvam AI**: Premium natural Indian voices (Meera).
2.  **Google Translate TTS**: Reliable fallback covering all Indian languages and Tulu.
3.  **Browser Web Speech**: Indigenous hardware fallback for major languages.
- **Auto-Speak**: Automatically reads translations to the other party during live consultation.
- **Interactive Speakers**: Individual 🔊 buttons for every chat segment and clinical suggestion.

### 🧠 AI Clinical Intake Auditor
- **7-Point Framework Audit**: Automatically checks consultations for:
    - Chief Complaint
    - Duration
    - Severity
    - Associated Symptoms
    - Medical History
    - Allergies (Highlighted ⚠️)
    - Current Medications
- **Gap Identification**: Displays a status board of missing clinical points.
- **Proactive Guidance**: Suggests specific follow-up questions for the doctor to ensure a complete medical record.

### 📋 Doctor-Editable Digital Prescription
- **AI Structured Report**: Parses consultation audio into a structured JSON medical report (via Gemini 2.0 Flash / Llama 3.1).
- **Interactive Editor**:
    - Editable **Diagnosis**, **Advice**, and **Follow-up** fields.
    - Full control over the **Prescription Table** (Generic medicine names, Dose, Frequency, Duration).
    - Add/Remove medicine rows with a single click.
- **Finalization & Audit**: Lock the prescription into a professional, read-only "Finalized" format.
- **Read Prescription**: A dedicated 🔊 **Read** button in the finalized view reads out the entire diagnosis and treatment plan aloud.

## 🛠️ Technology Stack
- **Frontend**: React, TypeScript, Framer Motion, Lucide Icons.
- **Intelligence**: Google Gemini 2.0 Flash, Meta Llama 3.1 (via HF Router).
- **Speech**: Sarvam AI (STT/TTS), Google TTS Fallback, Browser Speech API.
- **Communication**: Axios.

## 🔑 Environment Variables
The application requires the following keys in a `.env` file:
```env
VITE_GEMINI_API_KEY=your_gemini_key
VITE_SARVAM_API_KEY=your_sarvam_key
VITE_HF_API_KEY=your_huggingface_key
```

## 📜 Usage
1. Use the **Doctor (EN)** and **Patient (Lang)** microphones to record the consultation.
2. Monitor the **Translation** appearing in real-time.
3. Click **"Check Completeness & Generate Rx"** to audit the consultation and create the draft report.
4. Edit the fields in the **Clinical Report** as needed.
5. Click **"Finalize Prescription"** to produce the final treatment plan.