# Spot Medicine AI 🩺🤖

Spot Medicine AI is a high-performance clinical intelligence dashboard designed to streamline patient intake and structured medical record generation. It leverages state-of-the-art AI models to process multilingual speech, translate regional Indian languages, and generate professional JSON-structured medical reports.

## ✨ Key Features

- **Multilingual Audio Intake**: High-fidelity audio recording with real-time volume visualization.
- **AI-Powered Speech-to-Text**: Integrated with **Sarvam AI (Saaras-v3)** for high-accuracy transcription of Indian regional languages.
- **Robust Translation Layer**: Automatically translates Tulu, Hindi, Tamil, and Kannada into clinical English using **Sarvam's Mayura-v1**.
- **Resilient Intelligence Pipeline**: 
  - Primary processing via **Google Gemini (2.5-Flash/Pro)**.
  - **AI Prescription Generation**: Automatically drafts a structured medical prescription (Diagnosis, Medications, Advice, Warnings) in JSON format for doctor verification.
  - **Automatic Fallback**: If Gemini rate limits are hit (common on Free Tier), the app silently switches to **Hugging Face Router (Llama-3.1)** to finish the report and prescription.

## 🔑 How the API Keys Work

The application requires three distinct API keys to handle the different stages of the medical pipeline. These must be stored in a `.env` file at the root of the project:

1.  **`VITE_SARVAM_API_KEY`**: 
    - **Purpose**: Handles all Speech-to-Text (transcribing your voice) and Initial Translation (converting Tulu/Hindi to English).
    - **Get it from**: [Sarvam AI Dashboard](https://dashboard.sarvam.ai/).
2.  **`VITE_GEMINI_API_KEY`**: 
    - **Purpose**: Powering the "Intelligence" layer. It reads the English transcript to structure both the clinical record and the doctor's draft prescription.
    - **Get it from**: [Google AI Studio](https://aistudio.google.com/).
3.  **`VITE_HF_API_KEY`**: 
    - **Purpose**: The "Safety Net." If Gemini blocks your request, this key allows the app to use Hugging Face's open-source models to complete both the clinical record and the prescription without error.
    - **Get it from**: [Hugging Face Settings](https://huggingface.co/settings/tokens). Ensure the token has "Inference" permissions.

## 🛠️ Setup Instructions

1.  **Clone the project** and install dependencies:
    ```bash
    npm install
    ```

2.  **Configure Environment Variables**:
    Create a `.env` file in the root:
    ```env
    VITE_GEMINI_API_KEY=your_gemini_key
    VITE_SARVAM_API_KEY=your_sarvam_key
    VITE_HF_API_KEY=your_huggingface_key
    ```

3.  **Run Development Server**:
    ```bash
    npm run dev
    ```

## 📋 Note on Tulu Support
For Tulu intake, selecting "Tulu" in the UI tells the system to use the Kannada script model (`kn-IN`) on Sarvam's backend, as Tulu utilizes the same script. This ensures the highest possible translation accuracy into English.

## ⚖️ License
MIT