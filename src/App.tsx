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
  const ENV_SARVAM_KEY = import.meta.env.VITE_SARVAM_API_KEY || '';
  const ENV_HF_KEY = import.meta.env.VITE_HF_API_KEY || '';

  // App States
  const [patientLanguage, setPatientLanguage] = useState('hi');
  const [isRecording, setIsRecording] = useState<'doctor' | 'patient' | null>(null);
  const [activeRole, setActiveRole] = useState<'doctor' | 'patient' | null>(null);
  const [chatHistory, setChatHistory] = useState<Array<{ role: 'doctor' | 'patient' | 'assistant', content: string }>>([]);

  // Agent States
  const [sttStatus, setSttStatus] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [clinicalAgent, setClinicalAgent] = useState<AgentState>({ status: 'idle', data: null });
  const [isProcessing, setIsProcessing] = useState(false);
  const [volume, setVolume] = useState(0);

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
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
        setVolume(sum / bufferLength);
        animationFrame.current = requestAnimationFrame(updateVolume);
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
      setVolume(0);
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
      const langMap: Record<string, string> = { 'hi': 'hi-IN', 'ta': 'ta-IN', 'te': 'te-IN', 'kn': 'kn-IN', 'ml': 'ml-IN', 'bn': 'bn-IN', 'gu': 'gu-IN', 'mr': 'mr-IN', 'pa': 'pa-IN' };
      if (langMap[patientLanguage]) formData.append('language_code', langMap[patientLanguage]);
    } else {
      formData.append('language_code', 'en-IN');
    }

    try {
      const res = await axios.post('https://api.sarvam.ai/speech-to-text', formData, {
        headers: { 'api-subscription-key': ENV_SARVAM_KEY, 'Content-Type': 'multipart/form-data' }
      });
      if (res.data?.transcript) {
        setChatHistory(prev => [...prev, { role: roleAtTime || 'doctor', content: res.data.transcript }]);
      }
    } catch (err) {
      alert("Transcription failed");
    } finally {
      setSttStatus('idle');
    }
  };

  const processIntelligencePipeline = async () => {
    if (!chatHistory.length || !ENV_GEMINI_KEY) return alert("No history or API key missing");
    setIsProcessing(true);
    setClinicalAgent({ status: 'processing', data: null });

    const conversationText = chatHistory.map(h => `${h.role.toUpperCase()}: ${h.content}`).join('\n');
    const medicalPrompt = `Extract clinical summary and prescription in JSON. Generic names only. Role: Clinical Assistant. Context:\n${conversationText}`;

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
              <div key={idx} style={{ alignSelf: chat.role === 'doctor' ? 'flex-start' : 'flex-end', background: chat.role === 'doctor' ? 'rgba(78, 205, 196, 0.1)' : 'rgba(255, 107, 107, 0.1)', padding: '10px', borderRadius: '12px', maxWidth: '80%', border: '1px solid rgba(255,255,255,0.1)' }}>
                <span style={{ fontSize: '10px', opacity: 0.5, display: 'block' }}>{chat.role.toUpperCase()}</span>
                {chat.content}
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
              <option value="hi">Hindi</option><option value="ta">Tamil</option><option value="te">Telugu</option><option value="kn">Kannada</option><option value="bn">Bengali</option>
            </select>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <button className="button" style={{ height: '80px', background: isRecording === 'doctor' ? '#ff4d4d' : 'var(--surface)' }} onClick={() => isRecording ? stopRecording() : startRecording('doctor')} disabled={sttStatus === 'processing' || (isRecording && isRecording !== 'doctor')}>
              <div style={{ textAlign: 'center' }}><Mic size={24} /><div style={{ fontSize: '10px' }}>Doctor (EN)</div></div>
            </button>
            <button className="button" style={{ height: '80px', background: isRecording === 'patient' ? 'var(--primary)' : 'var(--surface)' }} onClick={() => isRecording ? stopRecording() : startRecording('patient')} disabled={sttStatus === 'processing' || (isRecording && isRecording !== 'patient')}>
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
  try { json = typeof data === 'string' ? JSON.parse(data) : data; } catch { return <pre style={{ fontSize: '11px' }}>{data}</pre>; }
  return (
    <div style={{ fontSize: '13px' }}>
      {json.summary && <div style={{ marginBottom: '10px' }}><b>Summary:</b> {json.summary.join(', ')}</div>}
      {json.diagnosis && <div style={{ marginBottom: '10px' }}><b>Diagnosis:</b> {json.diagnosis}</div>}
      {json.prescription && <div><b>Rx:</b><table style={{ width: '100%', marginTop: '5px' }}><tbody>{json.prescription.map((p: any, i: number) => <tr key={i}><td>{p.medicine}</td><td>{p.dose}</td><td>{p.frequency}</td></tr>)}</tbody></table></div>}
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
