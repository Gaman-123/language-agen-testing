import React, { useState, useRef } from 'react';
import {
  Stethoscope,
  Activity,
  Database,
  Volume2,
  FileText,
  AlertCircle,
  CheckCircle2,
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

  const [language, setLanguage] = useState('en');
  const [isRecording, setIsRecording] = useState(false);
  const [chatHistory, setChatHistory] = useState<Array<{ role: 'user' | 'model', content: string }>>([]);
  const [isIntakeComplete, setIsIntakeComplete] = useState(false);

  // Agent States
  const [translationAgent, setTranslationAgent] = useState<AgentState>({ status: 'idle', data: null });
  const [intakeAgent, setIntakeAgent] = useState<AgentState>({ status: 'idle', data: null });
  const [clinicalAgent, setClinicalAgent] = useState<AgentState>({ status: 'idle', data: null });
  const [sttStatus, setSttStatus] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
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
        setSttStatus('idle');
        handleConversationStep(response.data.transcript);
      } else {
        throw new Error("No transcript in response");
      }
    } catch (error: any) {
      console.error("STT Error details:", error.response?.data || error.message);
      const detail = error.response?.data?.message || error.response?.data?.error || error.message;
      alert(`Speech recognition failed: ${detail}`);
      setSttStatus('idle');
    }
  };

  const callSarvamTTS = async (text: string) => {
    try {
      setIsSpeaking(true);
      const langMap: Record<string, string> = {
        'hi': 'hi-IN',
        'kn': 'kn-IN',
        'ta': 'ta-IN',
        'te': 'te-IN',
        'en': 'en-IN'
      };

      const response = await axios.post('https://api.sarvam.ai/text-to-speech', {
        inputs: [text],
        target_language_code: langMap[language] || 'en-IN',
        speaker: 'meera',
        model: 'bulbul:v1'
      }, {
        headers: {
          'api-subscription-key': import.meta.env.VITE_SARVAM_API_KEY,
          'Content-Type': 'application/json'
        }
      });

      if (response.data?.audios?.[0]) {
        const audio = new Audio(`data:audio/wav;base64,${response.data.audios[0]}`);
        audio.onended = () => setIsSpeaking(false);
        await audio.play();
      }
    } catch (error) {
      console.error("TTS Error:", error);
      setIsSpeaking(false);
    }
  };

  const handleConversationStep = async (newInput: string) => {
    if (isIntakeComplete || isProcessing) return;

    setIsProcessing(true);
    const updatedHistory = [...chatHistory, { role: 'user' as const, content: newInput }];
    setChatHistory(updatedHistory);
    setIntakeAgent({ status: 'processing', data: "Thinking..." });

    const ENV_HF_KEY = import.meta.env.VITE_HF_API_KEY || '';
    const genAI = new GoogleGenerativeAI(ENV_GEMINI_KEY);

    const langNameMap: Record<string, string> = {
      'hi': 'Hindi',
      'ta': 'Tamil',
      'te': 'Telugu',
      'kn': 'Kannada',
      'tcy': 'Tulu',
      'en': 'English'
    };
    const patientLang = langNameMap[language] || 'English';

    const assistantPrompt = `
      You are a warm, empathetic medical intake assistant conducting a 
      spoken conversation with a patient in ${patientLang}.

      Your goal is to gather enough information to generate a prescription summary.
      Ask ONE question at a time. Keep questions short and simple.

      Follow this sequence naturally (don't follow rigidly — adapt based on answers):
      1. Chief complaint → "What is bothering you today?"
      2. Duration        → "How long have you had this?"
      3. Severity        → "On a scale of 1–10, how bad is it?"
      4. Associated symptoms → "Are you also experiencing [X]?"
      5. Medical history → "Do you have any existing conditions?"
      6. Allergies       → "Are you allergic to any medicines?"
      7. Current meds    → "Are you taking any medicines right now?"

      When you have enough information (minimum 4 exchanges), 
      add "INTAKE_COMPLETE" silently at the end of your last message.

      Respond always in ${patientLang}. 
      Be conversational, not clinical. Never overwhelm the patient.
    `;

    try {
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const chat = model.startChat({
        history: chatHistory.map(h => ({ role: h.role, parts: [{ text: h.content }] })),
        systemInstruction: assistantPrompt
      });

      const result = await chat.sendMessage(newInput);
      const response = await result.response;
      let assistantResponse = response.text();

      if (assistantResponse.includes("INTAKE_COMPLETE")) {
        assistantResponse = assistantResponse.replace("INTAKE_COMPLETE", "").trim();
        setIsIntakeComplete(true);
      }

      setChatHistory(prev => [...prev, { role: 'model', content: assistantResponse }]);
      setIntakeAgent({ status: 'completed', data: assistantResponse });

      callSarvamTTS(assistantResponse);

    } catch (error: any) {
      if (ENV_HF_KEY) {
        try {
          const hfResponse = await axios.post(
            "https://router.huggingface.co/v1/chat/completions",
            {
              model: "meta-llama/Llama-3.1-8B-Instruct",
              messages: [
                { role: "system", content: assistantPrompt },
                ...chatHistory,
                { role: "user", content: newInput }
              ],
              max_tokens: 500
            },
            { headers: { Authorization: `Bearer ${ENV_HF_KEY}`, "Content-Type": "application/json" } }
          );
          let hfText = hfResponse.data.choices[0]?.message?.content || "";
          if (hfText.includes("INTAKE_COMPLETE")) {
            hfText = hfText.replace("INTAKE_COMPLETE", "").trim();
            setIsIntakeComplete(true);
          }
          setChatHistory(prev => [...prev, { role: 'model', content: hfText }]);
          setIntakeAgent({ status: 'completed', data: hfText });
          callSarvamTTS(hfText);
          return;
        } catch (hfErr) {
          console.error("HF Intake Fallback Failed:", hfErr);
        }
      }
      console.error("Intake Error:", error);
      setIntakeAgent({ status: 'error', data: null, error: error.message });
    } finally {
      setIsProcessing(false);
    }
  };

  const processIntelligencePipeline = async () => {
    if (!chatHistory.length || !ENV_GEMINI_KEY) {
      alert("Missing Gemini API Key in .env file.");
      return;
    }

    const conversationText = chatHistory.map(h => `${h.role === 'user' ? 'Patient' : 'Assistant'}: ${h.content}`).join('\n');

    setIsProcessing(true);
    setTranslationAgent({ status: 'completed', data: "Using full conversation context." });
    setClinicalAgent({ status: 'processing', data: null });
    const ENV_HF_KEY = import.meta.env.VITE_HF_API_KEY || '';
    const genAI = new GoogleGenerativeAI(ENV_GEMINI_KEY);

    const medicalPrompt = `
        You are a clinical documentation assistant in an Indian hospital.
        A doctor-patient consultation history is provided.

        From the conversation history below, extract and return ONLY this JSON structure.
        Be extremely concise — no extra words, no explanations.

        {
          "summary": [
            "symptom 1 (duration)",
            "symptom 2 (duration)",
            "max 3 bullet points"
          ],
          "diagnosis": "one line max",
          "prescription": [
            {
              "medicine": "medicine name",
              "dose": "500mg",
              "frequency": "1-0-1",
              "duration": "5 days"
            }
          ],
          "tests": ["test 1", "test 2"],
          "followup": "date or condition"
        }

        Rules:
        - summary: max 3 bullets, each under 8 words
        - diagnosis: one line only
        - medicine names: generic names only, no brand names
        - frequency format: morning-afternoon-night (e.g. 1-0-1)
        - tests: only if doctor explicitly mentioned
        - followup: one line only
        - if something is not mentioned, return null for that field

        CONVERSATION HISTORY:
        ${conversationText}
      `;

    try {
      const modelsToTry = [
        "gemini-2.0-flash",
        "gemini-1.5-flash-8b",
        "gemini-1.5-flash"
      ];

      let text = "";
      let success = false;
      let errors = [];

      for (const modelName of modelsToTry) {
        if (success) break;
        try {
          console.log(`Attempting final structuring with: ${modelName}`);
          const model = genAI.getGenerativeModel({ model: modelName });
          const result = await model.generateContent(medicalPrompt);
          const response = await result.response;
          text = response.text();
          success = true;
        } catch (err: any) {
          errors.push(`[${modelName}]: ${err.message}`);
        }
      }

      if (!success && ENV_HF_KEY) {
        console.warn("Falling back to HF for final report...");
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
          errors.push(`[HuggingFace Router]: ${hfErr.message}`);
        }
      }

      if (!success) throw new Error(errors.join('\n'));

      text = text.replace(/```json|```/g, '').trim();
      setClinicalAgent({ status: 'completed', data: text });

    } catch (error: any) {
      console.error("Pipeline Final Error:", error);
      setClinicalAgent({ status: 'error', data: null, error: error.message });
    } finally {
      setIsProcessing(false);
    }
  };

  const resetChat = () => {
    setChatHistory([]);
    setIsIntakeComplete(false);
    setClinicalAgent({ status: 'idle', data: null });
    setIntakeAgent({ status: 'idle', data: null });
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
            <label>AI Intake Assistant</label>
            <div className="chat-container" style={{
              height: '300px',
              background: 'rgba(0,0,0,0.2)',
              borderRadius: '12px',
              padding: '1rem',
              overflowY: 'auto',
              marginBottom: '1rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem'
            }}>
              {chatHistory.length === 0 && <p style={{ opacity: 0.4, textAlign: 'center', marginTop: '40%' }}>Start speaking to begin the checkup...</p>}
              {chatHistory.map((chat, idx) => (
                <div key={idx} style={{
                  alignSelf: chat.role === 'user' ? 'flex-end' : 'flex-start',
                  background: chat.role === 'user' ? 'var(--primary)' : 'rgba(255,255,255,0.05)',
                  padding: '8px 12px',
                  borderRadius: '12px',
                  maxWidth: '85%',
                  fontSize: '0.9rem',
                  color: 'white',
                  border: chat.role === 'model' ? '1px solid rgba(255,255,255,0.1)' : 'none'
                }}>
                  {chat.content}
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: '8px', marginBottom: '1rem' }}>
              <button
                className="button"
                style={{ flex: 1, position: 'relative' }}
                onClick={resetChat}
              >
                Reset Chat
              </button>
              {isIntakeComplete && (
                <button
                  className="button"
                  style={{ flex: 1, background: 'var(--accent)' }}
                  onClick={processIntelligencePipeline}
                  disabled={isProcessing}
                >
                  Generate Report
                </button>
              )}
            </div>

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
                  {isSpeaking ? <Volume2 size={18} className="pulse" /> : sttStatus === 'processing' ? <div className="loader" style={{ width: '14px', height: '14px' }}></div> : isRecording ? <Square size={18} /> : <Mic size={18} />}
                  {isSpeaking ? "AI is speaking..." : sttStatus === 'processing' ? "Processing..." : isRecording ? "Stop Recording" : "Speak to Assistant"}
                </div>
              </button>
            </div>
          </div>


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
              <span className="badge" style={{ background: 'var(--accent)' }}>Intake AI (Conversational)</span>
              <StatusBadge status={intakeAgent.status} />
            </div>
            <div className="output-area" style={{ height: '60px', marginBottom: '1rem' }}>
              {intakeAgent.data || "Assistant is listening..."}
            </div>
          </div>

          <div className="agent-step active">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span className="badge badge-primary">Context Translation</span>
              <StatusBadge status={translationAgent.status} />
            </div>
            <div className="output-area" style={{ height: '60px', marginBottom: '1rem' }}>
              {translationAgent.data || "Waiting for intake completeness..."}
            </div>
          </div>

          <div className="agent-step active">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span className="badge badge-secondary">Clinical Insights (Indian Hospital Standard)</span>
              <StatusBadge status={clinicalAgent.status} />
            </div>
            <div className="output-area" style={{ flexGrow: 1, maxHeight: '500px', overflowY: 'auto' }}>
              {clinicalAgent.error ? (
                <span style={{ color: 'var(--danger)' }}>{clinicalAgent.error}</span>
              ) : (
                <ClinicalReportDisplay data={clinicalAgent.data} />
              )}
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

const ClinicalReportDisplay: React.FC<{ data: any }> = ({ data }) => {
  if (!data) return <span style={{ opacity: 0.5 }}>Waiting for intelligence processing...</span>;

  let json: any = null;
  try {
    json = typeof data === 'string' ? JSON.parse(data) : data;
  } catch (e) {
    return <pre style={{ fontSize: '12px', whiteSpace: 'pre-wrap' }}>{data}</pre>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {json.summary && (
        <div>
          <h4 style={{ color: 'var(--accent)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '0.5rem' }}>Summary</h4>
          <ul style={{ paddingLeft: '1.2rem', margin: 0 }}>
            {json.summary.map((item: string, i: number) => <li key={i} style={{ fontSize: '0.9rem', marginBottom: '0.25rem' }}>{item}</li>)}
          </ul>
        </div>
      )}

      {json.diagnosis && (
        <div>
          <h4 style={{ color: 'var(--accent)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '0.25rem' }}>Diagnosis</h4>
          <p style={{ fontSize: '1rem', fontWeight: 600, margin: 0, color: 'white' }}>{json.diagnosis}</p>
        </div>
      )}

      {json.prescription && json.prescription.length > 0 && (
        <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '8px', padding: '0.75rem', border: '1px solid rgba(255,255,255,0.05)' }}>
          <h4 style={{ color: 'var(--accent)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '0.75rem' }}>Prescription (Generic)</h4>
          <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'rgba(255,255,255,0.4)', textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                <th style={{ padding: '4px' }}>Medicine</th>
                <th style={{ padding: '4px' }}>Dose</th>
                <th style={{ padding: '4px' }}>Freq.</th>
                <th style={{ padding: '4px' }}>Dur.</th>
              </tr>
            </thead>
            <tbody>
              {json.prescription.map((m: any, i: number) => (
                <tr key={i} style={{ borderBottom: i < json.prescription.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                  <td style={{ padding: '8px 4px', fontWeight: 500 }}>{m.medicine}</td>
                  <td style={{ padding: '8px 4px' }}>{m.dose}</td>
                  <td style={{ padding: '8px 4px', color: 'var(--secondary)' }}>{m.frequency}</td>
                  <td style={{ padding: '8px 4px' }}>{m.duration}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        {json.tests && json.tests.length > 0 && (
          <div>
            <h4 style={{ color: 'var(--accent)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '0.25rem' }}>Tests</h4>
            <p style={{ fontSize: '0.85rem', margin: 0 }}>{json.tests.join(', ')}</p>
          </div>
        )}
        {json.followup && (
          <div>
            <h4 style={{ color: 'var(--accent)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '0.25rem' }}>Follow-up</h4>
            <p style={{ fontSize: '0.85rem', margin: 0, color: 'var(--secondary)' }}>{json.followup}</p>
          </div>
        )}
      </div>
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
