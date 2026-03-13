import React, { useState, useRef } from 'react';
import {
  Stethoscope,
  Activity,
  Database,
  AlertCircle,
  CheckCircle2,
  Mic,
  Volume2
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
  const ENV_SARVAM_KEY = import.meta.env.VITE_SARVAM_API_KEY || '';
  const ENV_HF_KEY = import.meta.env.VITE_HF_API_KEY || '';

  // App States
  const [patientLanguage, setPatientLanguage] = useState('hi');
  const [isRecording, setIsRecording] = useState<'doctor' | 'patient' | null>(null);
  const [activeRole, setActiveRole] = useState<'doctor' | 'patient' | null>(null);
  const [chatHistory, setChatHistory] = useState<Array<{ role: 'doctor' | 'patient' | 'assistant', content: string, translated?: string }>>([]);

  // Agent States
  const [sttStatus, setSttStatus] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [clinicalAgent, setClinicalAgent] = useState<AgentState>({ status: 'idle', data: null });
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  // Refs for recording
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const mediaStream = useRef<MediaStream | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const animationFrame = useRef<number | null>(null);
  const audioChunks = useRef<Blob[]>([]);

  const startRecording = async (role: 'doctor' | 'patient') => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setActiveRole(role);

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
      };
      updateVolume();

      mediaRecorder.current = new MediaRecorder(stream);
      audioChunks.current = [];
      mediaRecorder.current.ondataavailable = (e) => e.data.size > 0 && audioChunks.current.push(e.data);
      mediaStream.current = stream;

      mediaRecorder.current.start();
      setIsRecording(role);
      setSttStatus('recording');
    } catch (err: any) {
      alert(`Microphone error: ${err.message}`);
    }
  };

  const stopRecording = () => {
    if (mediaRecorder.current) {
      mediaRecorder.current.onstop = async () => {
        try {
          const blob = new Blob(audioChunks.current, { type: 'audio/webm' });
          const arrayBuffer = await blob.arrayBuffer();
          const offlineContext = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(1, 1, 16000);
          const audioBuffer = await offlineContext.decodeAudioData(arrayBuffer);
          const wavBlob = audioBufferToWavBlob(audioBuffer);
          await handleSTT(wavBlob);
        } catch (e) {
          console.error(e);
          setSttStatus('idle');
        }
      };
      mediaRecorder.current.stop();
      if (animationFrame.current) cancelAnimationFrame(animationFrame.current);
      if (audioContext.current) audioContext.current.close();
      if (mediaStream.current) {
        mediaStream.current.getTracks().forEach(t => t.stop());
        mediaStream.current = null;
      }
      setIsRecording(null);
    }
  };

  const handleSTT = async (audioBlob: Blob) => {
    if (!ENV_SARVAM_KEY) return alert("Sarvam Key missing");
    setSttStatus('processing');

    const roleAtTime = activeRole;
    const formData = new FormData();
    formData.append('file', audioBlob, 'speech.wav');
    formData.append('model', 'saaras:v3');

    if (roleAtTime === 'patient') {
      const langMap: Record<string, string> = { 'hi': 'hi-IN', 'ta': 'ta-IN', 'te': 'te-IN', 'kn': 'kn-IN', 'tcy': 'kn-IN', 'ml': 'ml-IN', 'bn': 'bn-IN', 'gu': 'gu-IN', 'mr': 'mr-IN', 'pa': 'pa-IN' };
      if (langMap[patientLanguage]) formData.append('language_code', langMap[patientLanguage]);
    } else {
      formData.append('language_code', 'en-IN');
    }

    try {
      const res = await axios.post('https://api.sarvam.ai/speech-to-text', formData, {
        headers: { 'api-subscription-key': ENV_SARVAM_KEY, 'Content-Type': 'multipart/form-data' }
      });

      if (res.data?.transcript) {
        const transcript = res.data.transcript;
        let translation = '';

        // Translation Logic: Opposite language
        try {
          const targetLang = roleAtTime === 'doctor' ? patientLanguage : 'en';
          const sourceLang = roleAtTime === 'doctor' ? 'en' : patientLanguage;

          if (targetLang !== sourceLang) {
            const translateRes = await axios.post('https://api.sarvam.ai/translate', {
              input: transcript,
              source_language_code: sourceLang === 'en' ? 'en-IN' : `${sourceLang}-IN`,
              target_language_code: targetLang === 'en' ? 'en-IN' : `${targetLang}-IN`,
              speaker_gender: "Female",
              mode: "formal"
            }, {
              headers: { 'api-subscription-key': ENV_SARVAM_KEY, 'Content-Type': 'application/json' }
            });
            translation = translateRes.data.translated_text;
          }
        } catch (tErr) {
          console.error("Translation failed", tErr);
        }

        setChatHistory(prev => [...prev, {
          role: roleAtTime || 'doctor',
          content: transcript,
          translated: translation
        }]);
      }
    } catch (err) {
      alert("Transcription failed");
    } finally {
      setSttStatus('idle');
    }
  };

  const callSarvamTTS = async (text: string, langCode: string) => {
    if (!ENV_SARVAM_KEY || !text) return;
    try {
      setIsSpeaking(true);
      const res = await axios.post('https://api.sarvam.ai/text-to-speech', {
        inputs: [text],
        target_language_code: langCode === 'en' ? 'en-IN' : `${langCode}-IN`,
        speaker: 'meera',
        model: 'bulbul:v1'
      }, {
        headers: { 'api-subscription-key': ENV_SARVAM_KEY, 'Content-Type': 'application/json' }
      });

      if (res.data?.audios?.[0]) {
        const audio = new Audio(`data:audio/wav;base64,${res.data.audios[0]}`);
        audio.onended = () => setIsSpeaking(false);
        await audio.play();
      }
    } catch (error) {
      console.error("TTS Error:", error);
      setIsSpeaking(false);
    }
  };

  const processIntelligencePipeline = async () => {
    if (!chatHistory.length || !ENV_GEMINI_KEY) return alert("No history or API key missing");
    setIsProcessing(true);
    setClinicalAgent({ status: 'processing', data: null });

    const conversationText = chatHistory.map(h => `${h.role.toUpperCase()}: ${h.content}`).join('\n');
    const medicalPrompt = `
      You are a clinical documentation assistant in an Indian hospital.
      From the consultation history, generate a structured clinical summary and prescription in JSON.

      Extract details strictly based on these 7 dimensions:
      1. Chief complaint (Primary issue)
      2. Duration (Time since onset)
      3. Severity (Pains scale 1-10 or descriptive)
      4. Associated symptoms
      5. Medical history (Existing conditions)
      6. Allergies (Medicine/Food allergies)
      7. Current meds (What they are taking now)

      JSON Structure to return:
      {
        "patient_profile": {
          "chief_complaint": "string",
          "duration": "string",
          "severity": "string",
          "associated_symptoms": ["string"],
          "medical_history": ["string"],
          "allergies": ["string"],
          "current_meds": ["string"]
        },
        "diagnosis": "string (one line)",
        "prescription": [
          { "medicine": "generic name", "dose": "strength", "frequency": "1-0-1", "duration": "days" }
        ],
        "advice": "string",
        "follow_up": "string"
      }

      Rules:
      - Use ONLY generic medicine names.
      - Frequency must be in X-X-X format.
      - If a field is unknown, use null.
      - Return ONLY the JSON.

      CONSULTATION HISTORY:
      ${conversationText}
    `;

    const genAI = new GoogleGenerativeAI(ENV_GEMINI_KEY);
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const result = await model.generateContent(medicalPrompt);
      let text = (await result.response).text().replace(/```json|```/g, '').trim();
      setClinicalAgent({ status: 'completed', data: text });
    } catch (err: any) {
      if (ENV_HF_KEY) {
        try {
          const hfRes = await axios.post("https://router.huggingface.co/v1/chat/completions", {
            model: "meta-llama/Llama-3.1-8B-Instruct",
            messages: [{ role: "user", content: medicalPrompt }],
            max_tokens: 1000
          }, { headers: { Authorization: `Bearer ${ENV_HF_KEY}` } });
          setClinicalAgent({ status: 'completed', data: hfRes.data.choices[0].message.content });
        } catch {
          setClinicalAgent({ status: 'error', data: null, error: err.message });
        }
      } else {
        setClinicalAgent({ status: 'error', data: null, error: err.message });
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const audioBufferToWavBlob = (buffer: AudioBuffer): Blob => {
    const numOfChan = buffer.numberOfChannels, length = buffer.length * numOfChan * 2 + 44, arrayBuffer = new ArrayBuffer(length), view = new DataView(arrayBuffer), channels = [];
    let offset = 0;
    const setUint32 = (d: number) => { view.setUint32(offset, d, true); offset += 4; };
    const setUint16 = (d: number) => { view.setUint16(offset, d, true); offset += 2; };
    setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157); setUint32(0x20746d66); setUint32(16); setUint16(1); setUint16(numOfChan); setUint32(buffer.sampleRate); setUint32(buffer.sampleRate * 2 * numOfChan); setUint16(numOfChan * 2); setUint16(16); setUint32(0x61746164); setUint32(length - offset - 4);
    for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
    let channel = 0;
    while (offset < length) {
      for (let i = 0; i < numOfChan; i++) {
        let sample = Math.max(-1, Math.min(1, channels[i][channel]));
        sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
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
        <div className="logo"><Stethoscope size={32} /><span>Spot Medicine AI (Dual Mode)</span></div>
        <div className="status-indicator"><div className="dot online"></div><span>Systems Online</span></div>
      </header>
      <main className="main-grid">
        <motion.section className="card" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <h2 className="card-title"><Activity size={24} className="gradient-text" />Consultation Mode</h2>
          <div className="chat-container" style={{ height: '350px', background: 'rgba(0,0,0,0.2)', borderRadius: '12px', padding: '1rem', overflowY: 'auto', marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {chatHistory.map((chat, idx) => (
              <div key={idx} style={{
                alignSelf: chat.role === 'doctor' ? 'flex-start' : 'flex-end',
                background: chat.role === 'doctor' ? 'rgba(78, 205, 196, 0.1)' : 'rgba(255, 107, 107, 0.1)',
                padding: '12px',
                borderRadius: '12px',
                maxWidth: '80%',
                border: '1px solid rgba(255,255,255,0.1)',
                position: 'relative'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
                  <span style={{ fontSize: '10px', opacity: 0.5 }}>{chat.role.toUpperCase()}</span>
                  {chat.translated && (
                    <button
                      onClick={() => callSarvamTTS(chat.translated!, chat.role === 'doctor' ? patientLanguage : 'en')}
                      style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0 }}
                      title="Read Translation"
                    >
                      <Volume2 size={14} />
                    </button>
                  )}
                </div>
                <div style={{ fontSize: '0.95rem' }}>{chat.content}</div>
                {chat.translated && (
                  <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.05)', fontSize: '0.85rem', color: 'var(--secondary)', fontStyle: 'italic' }}>
                    {chat.translated}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '10px', marginBottom: '1.5rem' }}>
            <button className="button" onClick={() => setChatHistory([])} style={{ flex: 1 }}>Reset</button>
            <button className="button" onClick={processIntelligencePipeline} style={{ flex: 1, background: 'var(--accent)' }} disabled={isProcessing || !chatHistory.length}>End & Generate</button>
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ fontSize: '12px', opacity: 0.6 }}>Patient Language</label>
            <select value={patientLanguage} onChange={e => setPatientLanguage(e.target.value)} style={{ width: '100%', marginTop: '5px' }}>
              <option value="hi">Hindi</option><option value="ta">Tamil</option><option value="te">Telugu</option><option value="kn">Kannada</option><option value="tcy">Tulu</option><option value="bn">Bengali</option>
            </select>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <button className="button" style={{ height: '80px', background: isRecording === 'doctor' ? '#ff4d4d' : 'var(--surface)' }} onClick={() => isRecording ? stopRecording() : startRecording('doctor')} disabled={sttStatus === 'processing' || !!(isRecording && isRecording !== 'doctor')}>
              <div style={{ textAlign: 'center' }}><Mic size={24} /><div style={{ fontSize: '10px' }}>Doctor (EN)</div></div>
            </button>
            <button className="button" style={{ height: '80px', background: isRecording === 'patient' ? 'var(--primary)' : 'var(--surface)' }} onClick={() => isRecording ? stopRecording() : startRecording('patient')} disabled={sttStatus === 'processing' || !!(isRecording && isRecording !== 'patient')}>
              <div style={{ textAlign: 'center' }}><Mic size={24} /><div style={{ fontSize: '10px' }}>Patient ({patientLanguage.toUpperCase()})</div></div>
            </button>
          </div>
        </motion.section>
        <section className="card">
          <h2 className="card-title"><Database size={24} /> Intelligence Pipeline</h2>
          <div className="agent-step active">
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>STT/Translating</span><StatusBadge status={sttStatus === 'processing' ? 'processing' : 'idle'} /></div>
            <div className="output-area">{sttStatus === 'processing' ? `Listening to ${activeRole}...` : "Idle"}</div>
          </div>
          <div className="agent-step active" style={{ flexGrow: 1, overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Report</span><StatusBadge status={clinicalAgent.status} /></div>
            <div className="output-area"><ClinicalReportDisplay data={clinicalAgent.data} /></div>
          </div>
        </section>
      </main>
    </div>
  );
};

const ClinicalReportDisplay: React.FC<{ data: any }> = ({ data }) => {
  if (!data) return <span style={{ opacity: 0.5 }}>No report generated yet.</span>;
  let json: any = null;
  try {
    json = typeof data === 'string' ? JSON.parse(data) : data;
  } catch {
    return <pre style={{ fontSize: '11px', whiteSpace: 'pre-wrap' }}>{data}</pre>;
  }

  const Section = ({ title, children, color = 'var(--accent)' }: { title: string, children: React.ReactNode, color?: string }) => (
    <div style={{ marginBottom: '1.25rem' }}>
      <h4 style={{ color, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '0.5rem', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '4px' }}>{title}</h4>
      {children}
    </div>
  );

  const profile = json.patient_profile || {};

  return (
    <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.9)' }}>
      <Section title="Patient Intake Details">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          <div><b style={{ opacity: 0.6, fontSize: '11px' }}>Complaint:</b> <div style={{ color: 'white' }}>{profile.chief_complaint || 'N/A'}</div></div>
          <div><b style={{ opacity: 0.6, fontSize: '11px' }}>Duration:</b> <div style={{ color: 'white' }}>{profile.duration || 'N/A'}</div></div>
          <div><b style={{ opacity: 0.6, fontSize: '11px' }}>Severity:</b> <div style={{ color: 'white' }}>{profile.severity || 'N/A'}</div></div>
          <div><b style={{ opacity: 0.6, fontSize: '11px' }}>Follow-up:</b> <div style={{ color: 'var(--secondary)' }}>{json.follow_up || 'As needed'}</div></div>
        </div>
      </Section>

      <Section title="Clinical History & Allergies" color="#FF6B6B">
        <div style={{ background: 'rgba(255,107,107,0.05)', padding: '10px', borderRadius: '8px' }}>
          <div style={{ marginBottom: '5px' }}><b>Conditions:</b> {profile.medical_history?.join(', ') || 'None reported'}</div>
          <div style={{ marginBottom: '5px' }}><b>Allergies:</b> <span style={{ color: '#FF6B6B', fontWeight: 'bold' }}>{profile.allergies?.join(', ') || 'No known allergies'}</span></div>
          <div><b>Current Meds:</b> {profile.current_meds?.join(', ') || 'None'}</div>
        </div>
      </Section>

      <Section title="Diagnosis" color="var(--primary)">
        <p style={{ fontSize: '1.1rem', fontWeight: 600, color: 'white', margin: 0 }}>{json.diagnosis || 'Clinical evaluation required'}</p>
      </Section>

      {json.prescription && json.prescription.length > 0 && (
        <Section title="Treatment Plan (Generic Medicines)">
          <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ opacity: 0.5, fontSize: '11px' }}>
                <th style={{ padding: '4px' }}>Medicine</th>
                <th style={{ padding: '4px' }}>Dose</th>
                <th style={{ padding: '4px' }}>Freq</th>
                <th style={{ padding: '4px' }}>Dur</th>
              </tr>
            </thead>
            <tbody>
              {json.prescription.map((p: any, i: number) => (
                <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <td style={{ padding: '6px 4px' }}><b>{p.medicine}</b></td>
                  <td style={{ padding: '6px 4px' }}>{p.dose}</td>
                  <td style={{ padding: '6px 4px', color: 'var(--secondary)' }}>{p.frequency}</td>
                  <td style={{ padding: '6px 4px' }}>{p.duration}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {json.advice && (
        <Section title="Doctor's Advice">
          <p style={{ fontStyle: 'italic', opacity: 0.8 }}>{json.advice}</p>
        </Section>
      )}
    </div>
  );
};

const StatusBadge: React.FC<{ status: AgentState['status'] }> = ({ status }) => {
  if (status === 'processing') return <div className="loader" style={{ width: '12px', height: '12px' }}></div>;
  if (status === 'completed') return <CheckCircle2 size={14} color="var(--accent)" />;
  if (status === 'error') return <AlertCircle size={14} color="var(--danger)" />;
  return <div className="dot"></div>;
};

export default App;
