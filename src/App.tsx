import React, { useState, useRef } from 'react';
import {
  Stethoscope,
  Activity,
  Database,
  Volume2,
  FileText,
  AlertCircle,
  CheckCircle2,
  Sparkles,
  Mic,
  Square
} from 'lucide-react';
import { motion } from 'framer-motion';
import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from 'axios';

// Types
interface AgentState {
  status: 'idle' | 'processing' | 'completed' | 'error';
  data: any;
  error?: string;
}

const App: React.FC = () => {
  // API Keys from .env
  const ENV_GEMINI_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';

  const [inputText, setInputText] = useState('');
  const [language, setLanguage] = useState('en');
  const [isRecording, setIsRecording] = useState(false);

  // Agent States
  const [translationAgent, setTranslationAgent] = useState<AgentState>({ status: 'idle', data: null });
  const [clinicalAgent, setClinicalAgent] = useState<AgentState>({ status: 'idle', data: null });
  const [sttStatus, setSttStatus] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [isProcessing, setIsProcessing] = useState(false);
  const [volume, setVolume] = useState(0);

  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const mediaStream = useRef<MediaStream | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const animationFrame = useRef<number | null>(null);
  const audioChunks = useRef<Blob[]>([]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Setup Audio Visualizer
      audioContext.current = new AudioContext();
      analyser.current = audioContext.current.createAnalyser();
      const source = audioContext.current.createMediaStreamSource(stream);
      source.connect(analyser.current);
      analyser.current.fftSize = 256;

      const bufferLength = analyser.current.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const updateVolume = () => {
        if (!analyser.current) return;
        analyser.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;
        setVolume(average);
        animationFrame.current = requestAnimationFrame(updateVolume);
      };

      updateVolume();

      mediaRecorder.current = new MediaRecorder(stream);
      audioChunks.current = [];

      mediaRecorder.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.current.push(event.data);
        }
      };

      // Store stream to stop tracks later
      mediaStream.current = stream;

      mediaRecorder.current.start();
      setIsRecording(true);
      setSttStatus('recording');
      console.log("Recording started...");
    } catch (err: any) {
      console.error("Failed to start recording", err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        alert("Microphone access denied. Please click the lock/tune icon next to your URL bar (localhost:5173) and allow Microphone access.");
      } else if (!navigator.mediaDevices) {
        alert("Microphone API not available. Make sure you are accessing the site via localhost.");
      } else {
        alert(`Microphone error: ${err.message || 'Unknown error'}`);
      }
    }
  };

  const stopRecording = () => {
    if (mediaRecorder.current) {
      mediaRecorder.current.onstop = async () => {
        // Sarvam saaras:v3 prefers 16kHz WAV. We can't trust the browser's default webm/MP4 via MediaRecorder.
        // We need to decode the WebM/Ogg audio chunks using AudioContext and encode them strictly as 16kHz WAV.
        try {
          const blob = new Blob(audioChunks.current, { type: mediaRecorder.current?.mimeType || 'audio/webm' });
          const arrayBuffer = await blob.arrayBuffer();
          // decodeAudioData uses the browser's native capabilities to read the webm container
          const offlineContext = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(1, 1, 16000);
          const audioBuffer = await offlineContext.decodeAudioData(arrayBuffer);

          // Now we have raw PCM data. Let's encode it into a proper WAV file at 16kHz
          const wavBlob = audioBufferToWavBlob(audioBuffer);
          await handleSTT(wavBlob, 'speech.wav');
        } catch (e) {
          console.error("Failed to convert audio for Sarvam:", e);
          alert("Audio conversion failed. Your browser may not support the necessary audio features.");
          setSttStatus('idle');
        }
      };

      mediaRecorder.current.stop();

      // Stop visualization
      if (animationFrame.current) cancelAnimationFrame(animationFrame.current);
      if (audioContext.current) audioContext.current.close();
      setVolume(0);

      // Stop all tracks to release the microphone
      if (mediaStream.current) {
        mediaStream.current.getTracks().forEach((track: MediaStreamTrack) => track.stop());
        mediaStream.current = null;
      }

      setIsRecording(false);
    }
  };

  const handleSTT = async (audioBlob: Blob, filename: string) => {
    const SARVAM_KEY = import.meta.env.VITE_SARVAM_API_KEY;
    if (!SARVAM_KEY) {
      alert("Sarvam API Key missing in .env");
      return;
    }

    setSttStatus('processing');
    const formData = new FormData();
    formData.append('file', audioBlob, filename);
    formData.append('model', 'saaras:v3'); // Updated to the latest 2026 Sarvam model

    // Let Saaras V3 auto-detect the language or use explicit codes.
    // Explicit 'en-IN' may fail if the model defaults to 'en' or auto.
    const langMap: Record<string, string> = {
      'hi': 'hi-IN',
      'ta': 'ta-IN',
      'te': 'te-IN',
      'kn': 'kn-IN',
      'en': 'en-IN',
      'tcy': 'en-IN' // Fallback
    };
    const mappedLang = langMap[language];
    if (mappedLang && mappedLang !== 'en-IN') {
      formData.append('language_code', mappedLang);
    }

    try {
      const response = await axios.post('https://api.sarvam.ai/speech-to-text', formData, {
        headers: {
          'api-subscription-key': SARVAM_KEY,
          'Content-Type': 'multipart/form-data'
        }
      });

      if (response.data && response.data.transcript) {
        setInputText(response.data.transcript);
      } else {
        throw new Error("No transcript in response");
      }
    } catch (error: any) {
      console.error("STT Error details:", error.response?.data || error.message);
      const detail = error.response?.data?.message || error.response?.data?.error || error.message;
      alert(`Speech recognition failed: ${detail}`);
    } finally {
      setSttStatus('idle');
    }
  };

  const processIntelligencePipeline = async () => {
    if (!inputText.trim() || !ENV_GEMINI_KEY) {
      alert("Missing Gemini API Key in .env file.");
      return;
    }

    setIsProcessing(true);
    setTranslationAgent({ status: 'processing', data: null });
    setClinicalAgent({ status: 'idle', data: null });

    try {
      // 1. Translation Layer (Sarvam AI)
      let translatedText = inputText;
      if (language !== 'en') {
        setTranslationAgent({ status: 'processing', data: "Calling Sarvam Translate..." });
        try {
          const langMap: Record<string, string> = {
            'hi': 'hi-IN',
            'ta': 'ta-IN',
            'te': 'te-IN',
            'kn': 'kn-IN',
            'tcy': 'kn-IN' // Tulu uses Kannada script; map to kn-IN for Sarvam Translate
          };
          const sourceLang = langMap[language] || 'kn-IN';

          const sarvamResponse = await axios.post(
            "https://api.sarvam.ai/translate",
            {
              input: inputText,
              source_language_code: sourceLang,
              target_language_code: "en-IN",
              speaker_gender: "Male",
              mode: "formal",
              model: "mayura:v1"
            },
            {
              headers: {
                "api-subscription-key": import.meta.env.VITE_SARVAM_API_KEY,
                "Content-Type": "application/json"
              }
            }
          );

          translatedText = sarvamResponse.data.translated_text || inputText;
          setTranslationAgent({ status: 'completed', data: translatedText });
        } catch (err: any) {
          console.error("Sarvam Translate Error:", err.response?.data || err.message);
          const errorMsg = err.response?.data?.message || err.message || "Unknown error";
          setTranslationAgent({
            status: 'error',
            data: `Translation failed (${errorMsg}). Using original text.`,
            error: errorMsg
          });
          translatedText = inputText;
        }
      } else {
        setTranslationAgent({ status: 'completed', data: "Input already in English. Skipping translation." });
      }

      // 2. Clinical Intelligence (Multi-Model Fallback)
      setClinicalAgent({ status: 'processing', data: null });
      const genAI = new GoogleGenerativeAI(ENV_GEMINI_KEY);

      const medicalPrompt = `
        You are a medical scribe assistant. Convert the following patient interaction into a structured JSON medical record.
        Include sections: patient_summary, symptoms, duration, suspected_conditions, and suggested_next_steps.
        
        Interaction: ${translatedText}
        
        Output valid JSON only.
      `;

      const modelsToTry = [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-2.0-flash",
        "gemini-1.5-flash-8b", // Added extremely high-rate-limit free tier fallback model
        "gemini-1.5-flash"
      ];

      let text = "";
      let success = false;
      let errors = [];

      for (const modelName of modelsToTry) {
        if (success) break;
        try {
          console.log(`Attempting clinical structuring with: ${modelName}`);
          const model = genAI.getGenerativeModel({ model: modelName });
          const result = await model.generateContent(medicalPrompt);
          const response = await result.response;
          text = response.text();
          success = true;
          console.log(`Pipeline success with model: ${modelName}`);
        } catch (err: any) {
          const errMsg = err.message || "Unknown error";
          errors.push(`[${modelName}]: ${errMsg}`);
          console.warn(`Model ${modelName} failed:`, errMsg);
        }
      }

      if (!success) {
        const ENV_HF_KEY = import.meta.env.VITE_HF_API_KEY;
        if (ENV_HF_KEY) {
          console.warn("Gemini limit reached. Automatically falling back to HuggingFace Router...");
          try {
            const hfResponse = await axios.post(
              "https://router.huggingface.co/v1/chat/completions",
              {
                model: "meta-llama/Llama-3.1-8B-Instruct",
                messages: [{ role: "user", content: medicalPrompt }],
                max_tokens: 1000,
                temperature: 0.1
              },
              { headers: { Authorization: `Bearer ${ENV_HF_KEY}`, "Content-Type": "application/json" } }
            );
            text = hfResponse.data.choices[0]?.message?.content || "";
            success = true;
          } catch (hfErr: any) {
            const msg = hfErr.response?.data?.error || hfErr.message || "Unknown error";
            errors.push(`[HuggingFace Router]: ${msg}`);
          }
        }
      }

      if (!success) {
        throw new Error(`All Gemini models failed. \n${errors.join('\n')}`);
      }

      // Clean up markdown block if present
      text = text.replace(/```json|```/g, '').trim();
      setClinicalAgent({ status: 'completed', data: text });

    } catch (error: any) {
      console.error("Pipeline Final Error:", error);
      setClinicalAgent({
        status: 'error',
        data: null,
        error: error.message || 'Pipeline failed'
      });
    } finally {
      setIsProcessing(false);
    }
  };

  // Helper to convert float32 AudioBuffer to 16-bit PCM WAV (Sarvam requirement)
  const audioBufferToWavBlob = (buffer: AudioBuffer): Blob => {
    const numOfChan = buffer.numberOfChannels;
    const length = buffer.length * numOfChan * 2 + 44;
    const arrayBuffer = new ArrayBuffer(length);
    const view = new DataView(arrayBuffer);
    const channels = [];
    let i, sample, offset = 0;

    const setUint32 = (data: number) => { view.setUint32(offset, data, true); offset += 4; };
    const setUint16 = (data: number) => { view.setUint16(offset, data, true); offset += 2; };

    // WAV Header
    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8); // file length - 8
    setUint32(0x45564157); // "WAVE"
    setUint32(0x20746d66); // "fmt " chunk
    setUint32(16); // length = 16
    setUint16(1); // PCM (uncompressed)
    setUint16(numOfChan);
    setUint32(buffer.sampleRate);
    setUint32(buffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
    setUint16(numOfChan * 2); // block-align
    setUint16(16); // 16-bit
    setUint32(0x61746164); // "data" - chunk
    setUint32(length - offset - 4); // chunk length

    for (i = 0; i < buffer.numberOfChannels; i++) {
      channels.push(buffer.getChannelData(i));
    }

    // Interleave channels & convert float to 16-bit PCM
    let channel = 0;
    while (offset < length) {
      for (i = 0; i < numOfChan; i++) {
        sample = Math.max(-1, Math.min(1, channels[i][channel]));
        sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; // floatTo16BitInt
        view.setInt16(offset, sample, true);
        offset += 2;
      }
      channel++;
    }

    return new Blob([view], { type: "audio/wav" });
  };

  return (
    <div className="app-container">
      <header>
        <div className="logo">
          <Stethoscope size={32} />
          <span>Spot Medicine AI</span>
        </div>
        <div className="status-indicator">
          <div className="dot online"></div>
          <span>Systems Online</span>
        </div>
      </header>

      <main className="main-grid">
        {/* Input Panel */}
        <motion.section
          className="card"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <h2 className="card-title">
            <Activity size={24} className="gradient-text" />
            Patient Interaction
          </h2>

          <div className="input-group">
            <label>Communication Language</label>
            <select value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="en">English</option>
              <option value="tcy">Tulu</option>
              <option value="hi">Hindi</option>
              <option value="ta">Tamil</option>
            </select>
          </div>

          <div className="input-group">
            <label>Capture Audio / Text</label>

            {isRecording && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  marginBottom: '12px',
                  padding: '12px',
                  background: 'rgba(255, 255, 255, 0.03)',
                  borderRadius: '12px',
                  border: '1px solid rgba(255, 255, 255, 0.05)'
                }}
              >
                <div style={{ flex: 1, height: '4px', background: 'rgba(255, 255, 255, 0.1)', borderRadius: '2px', overflow: 'hidden' }}>
                  <motion.div
                    style={{
                      height: '100%',
                      background: 'linear-gradient(90deg, #ff4d4d, #f093fb)',
                      width: `${Math.min(100, (volume / 128) * 100)}%`
                    }}
                    transition={{ type: 'spring', bounce: 0, duration: 0.1 }}
                  />
                </div>
                <span style={{ fontSize: '10px', color: 'rgba(255, 255, 255, 0.4)', fontFamily: 'monospace', width: '30px' }}>
                  {Math.round((volume / 128) * 100)}%
                </span>
              </motion.div>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <button
                className="button"
                style={{
                  flex: 1,
                  background: isRecording ? 'var(--danger)' : sttStatus === 'processing' ? 'var(--surface-light)' : 'var(--surface)',
                  border: '1px solid var(--border)',
                  opacity: sttStatus === 'processing' ? 0.7 : 1,
                  cursor: sttStatus === 'processing' ? 'not-allowed' : 'pointer',
                  position: 'relative',
                  overflow: 'hidden'
                }}
                onClick={isRecording ? stopRecording : startRecording}
                disabled={sttStatus === 'processing'}
              >
                {isRecording && (
                  <motion.div
                    absolute-center
                    initial={{ scale: 1, opacity: 0.5 }}
                    animate={{ scale: 1.5, opacity: 0 }}
                    transition={{ repeat: Infinity, duration: 1 }}
                    style={{
                      position: 'absolute',
                      top: '50%',
                      left: '50%',
                      width: '40px',
                      height: '40px',
                      borderRadius: '50%',
                      background: 'white',
                      transform: 'translate(-50%, -50%)',
                      zIndex: 0
                    }}
                  />
                )}
                <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' }}>
                  {sttStatus === 'processing' ? <div className="loader" style={{ width: '14px', height: '14px' }}></div> : isRecording ? <Square size={18} /> : <Mic size={18} />}
                  {sttStatus === 'processing' ? "Processing..." : isRecording ? "Stop Recording" : "Start Intake"}
                </div>
              </button>
            </div>
            <textarea
              rows={4}
              placeholder="Transcript will appear here..."
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
            />
          </div>

          <button
            className="button"
            onClick={processIntelligencePipeline}
            disabled={isProcessing || !inputText}
            style={{ marginTop: 'auto' }}
          >
            {isProcessing ? <div className="loader"></div> : <><Sparkles size={18} /> Run Pipeline</>}
          </button>
        </motion.section>

        {/* Intelligence Pipeline Panel */}
        <motion.section
          className="card"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <h2 className="card-title">
            <Database size={24} style={{ color: 'var(--secondary)' }} />
            Intelligence Output
          </h2>

          <div className="agent-step active">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span className="badge badge-primary">Translation (HF/Sarvam)</span>
              <StatusBadge status={translationAgent.status} />
            </div>
            <div className="output-area" style={{ height: '80px', marginBottom: '1rem' }}>
              {translationAgent.data || "Waiting for processing..."}
            </div>
          </div>

          <div className="agent-step active">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span className="badge badge-secondary">Clinical Record (Gemini)</span>
              <StatusBadge status={clinicalAgent.status} />
            </div>
            <div className="output-area" style={{ flexGrow: 1, maxHeight: '300px' }}>
              {clinicalAgent.error ?
                <span style={{ color: 'var(--danger)' }}>{clinicalAgent.error}</span> :
                (clinicalAgent.data || "Structured data will appear here...")
              }
            </div>
          </div>

          <div style={{ marginTop: '1.5rem', display: 'flex', gap: '1rem' }}>
            <button className="button" style={{ background: 'var(--surface)', border: '1px solid var(--border)', flex: 1 }}>
              <FileText size={18} /> PDF
            </button>
            <button className="button" style={{ background: 'var(--surface)', border: '1px solid var(--border)', flex: 1 }}>
              <Volume2 size={18} /> Talk (Sarvam)
            </button>
          </div>
        </motion.section>
      </main>
    </div>
  );
};

const StatusBadge: React.FC<{ status: AgentState['status'] }> = ({ status }) => {
  switch (status) {
    case 'processing': return <span className="status-indicator"><div className="loader" style={{ width: '12px', height: '12px' }}></div> Running</span>;
    case 'completed': return <span className="status-indicator" style={{ color: 'var(--accent)' }}><CheckCircle2 size={14} /> Ready</span>;
    case 'error': return <span className="status-indicator" style={{ color: 'var(--danger)' }}><AlertCircle size={14} /> Error</span>;
    default: return <span className="status-indicator"><div className="dot"></div> Idle</span>;
  }
};

export default App;
