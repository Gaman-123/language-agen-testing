import React, { useState, useRef } from 'react';
import {
  Stethoscope, Activity, Database, AlertCircle,
  CheckCircle2, Mic, Volume2, Edit2, PlusCircle, Lock
} from 'lucide-react';
import { motion } from 'framer-motion';
import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from 'axios';

interface AgentState { status: 'idle' | 'processing' | 'completed' | 'error'; data: any; error?: string; }
interface RxRow { medicine: string; dose: string; frequency: string; duration: string; }
interface EditableRx { diagnosis: string; advice: string; follow_up: string; prescription: RxRow[]; }

const App: React.FC = () => {
  const ENV_GEMINI_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';
  const ENV_SARVAM_KEY = import.meta.env.VITE_SARVAM_API_KEY || '';
  const ENV_HF_KEY = import.meta.env.VITE_HF_API_KEY || '';

  const [patientLanguage, setPatientLanguage] = useState('hi');
  const [isRecording, setIsRecording] = useState<'doctor' | 'patient' | null>(null);
  const [activeRole, setActiveRole] = useState<'doctor' | 'patient' | null>(null);
  const [chatHistory, setChatHistory] = useState<Array<{ role: 'doctor' | 'patient' | 'assistant', content: string, translated?: string }>>([]);
  const [sttStatus, setSttStatus] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [clinicalAgent, setClinicalAgent] = useState<AgentState>({ status: 'idle', data: null });
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

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
      const updateVolume = () => { if (!analyser.current) return; analyser.current.getByteFrequencyData(dataArray); };
      updateVolume();
      mediaRecorder.current = new MediaRecorder(stream);
      audioChunks.current = [];
      mediaRecorder.current.ondataavailable = (e) => e.data.size > 0 && audioChunks.current.push(e.data);
      mediaStream.current = stream;
      mediaRecorder.current.start();
      setIsRecording(role);
      setSttStatus('recording');
    } catch (err: any) { alert(`Microphone error: ${err.message}`); }
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
        } catch (e) { console.error(e); setSttStatus('idle'); }
      };
      mediaRecorder.current.stop();
      if (animationFrame.current) cancelAnimationFrame(animationFrame.current);
      if (audioContext.current) audioContext.current.close();
      if (mediaStream.current) { mediaStream.current.getTracks().forEach(t => t.stop()); mediaStream.current = null; }
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

    const sttLangMap: Record<string, string> = {
      'hi': 'hi-IN', 'ta': 'ta-IN', 'te': 'te-IN', 'kn': 'kn-IN',
      'tcy': 'kn-IN', 'ml': 'ml-IN', 'bn': 'bn-IN', 'gu': 'gu-IN', 'mr': 'mr-IN', 'pa': 'pa-IN'
    };
    const langNameMap: Record<string, string> = {
      'hi': 'Hindi', 'ta': 'Tamil', 'te': 'Telugu', 'kn': 'Kannada',
      'tcy': 'Tulu', 'ml': 'Malayalam', 'bn': 'Bengali', 'gu': 'Gujarati',
      'mr': 'Marathi', 'pa': 'Punjabi', 'en': 'English'
    };

    if (roleAtTime === 'patient') {
      if (sttLangMap[patientLanguage]) formData.append('language_code', sttLangMap[patientLanguage]);
    } else {
      formData.append('language_code', 'en-IN');
    }

    try {
      const sttRes = await axios.post('https://api.sarvam.ai/speech-to-text', formData, {
        headers: { 'api-subscription-key': ENV_SARVAM_KEY, 'Content-Type': 'multipart/form-data' }
      });

      if (sttRes.data?.transcript) {
        const transcript = sttRes.data.transcript;
        let translation = '';

        if (ENV_HF_KEY) {
          try {
            const sourceLangName = roleAtTime === 'doctor' ? 'English' : (langNameMap[patientLanguage] || patientLanguage);
            const targetLangName = roleAtTime === 'doctor' ? (langNameMap[patientLanguage] || patientLanguage) : 'English';
            const translatePrompt = `Translate the following ${sourceLangName} text to ${targetLangName}.
IMPORTANT RULES:
- Keep ALL medical terms exactly as-is in English: medicine names, drug names, dosages (mg, ml), frequencies (1-0-1, OD, BD, TDS), medical conditions, disease names, and medical abbreviations.
- Only translate the conversational/descriptive parts of the sentence.
- Reply with ONLY the translated text, no explanations, no quotes.

Text: ${transcript}`;
            const hfRes = await axios.post('https://router.huggingface.co/v1/chat/completions', {
              model: 'meta-llama/Llama-3.3-70B-Instruct',
              messages: [{ role: 'user', content: translatePrompt }],
              max_tokens: 400, temperature: 0.1
            }, { headers: { Authorization: `Bearer ${ENV_HF_KEY}`, 'Content-Type': 'application/json' } });
            translation = hfRes.data.choices?.[0]?.message?.content?.trim() || '';
          } catch (tErr: any) {
            console.error('HF Translation failed:', tErr?.response?.data || tErr.message);
          }
        }

        setChatHistory(prev => [...prev, { role: roleAtTime || 'doctor', content: transcript, translated: translation }]);

        if (translation) {
          callSarvamTTS(translation, roleAtTime === 'doctor' ? patientLanguage : 'en');
        }
      }
    } catch (err: any) {
      console.error('STT error:', err?.response?.data || err.message);
      alert('Transcription failed');
    } finally {
      setSttStatus('idle');
    }
  };

  const sarvamLangMap: Record<string, string> = {
    'tcy': 'kn-IN', 'hi': 'hi-IN', 'ta': 'ta-IN', 'te': 'te-IN',
    'kn': 'kn-IN', 'ml': 'ml-IN', 'bn': 'bn-IN', 'gu': 'gu-IN',
    'mr': 'mr-IN', 'pa': 'pa-IN', 'en': 'en-IN'
  };

  const callSarvamTTS = async (text: string, langCode: string) => {
    if (!text) return;
    setIsSpeaking(true);

    const sarvamTarget = sarvamLangMap[langCode] || 'en-IN';

    // ── Layer 1: Sarvam AI TTS for ALL Indian languages ──
    if (ENV_SARVAM_KEY) {
      try {
        // Build request with ALL required Sarvam fields
        const body: any = {
          inputs: [text.slice(0, 500)],
          target_language_code: sarvamTarget,
          model: 'bulbul:v2',
          pitch: 0,
          pace: 1.0,
          loudness: 1.5,
          speech_sample_rate: 16000,
          enable_preprocessing: false
        };
        // 'anushka' is a valid female speaker for bulbul:v2 across all languages
        body.speaker = 'anushka';

        const res = await axios.post(
          'https://api.sarvam.ai/text-to-speech',
          body,
          { headers: { 'api-subscription-key': ENV_SARVAM_KEY, 'Content-Type': 'application/json' } }
        );

        if (res.data?.audios?.[0]) {
          const audio = new Audio(`data:audio/wav;base64,${res.data.audios[0]}`);
          audio.onended = () => setIsSpeaking(false);
          audio.onerror = () => browserTTS(text, sarvamTarget);
          await audio.play();
          return;
        }
      } catch (err: any) {
        const errDetail = err?.response?.data ? JSON.stringify(err.response.data) : err.message;
        console.warn('Sarvam TTS failed:', errDetail, '→ browser fallback');
      }
    }

    // ── Layer 2: Browser SpeechSynthesis with smart voice selection ──
    browserTTS(text, sarvamTarget);
  };

  const browserTTS = (text: string, lang: string) => {
    if (!window.speechSynthesis) { setIsSpeaking(false); return; }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    const shortLang = lang.replace('-IN', '').toLowerCase();
    utter.lang = shortLang.length <= 3 ? `${shortLang}-IN` : lang;
    utter.rate = 0.95;
    utter.onstart = () => setIsSpeaking(true);
    utter.onend = () => setIsSpeaking(false);
    utter.onerror = () => setIsSpeaking(false);
    setIsSpeaking(true);
    window.speechSynthesis.speak(utter);
  };




  const processIntelligencePipeline = async () => {
    if (!chatHistory.length || !ENV_GEMINI_KEY) return alert("No history or API key missing");
    setIsProcessing(true);
    setClinicalAgent({ status: 'processing', data: null });

    const conversationText = chatHistory.map(h => `${h.role.toUpperCase()}: ${h.content}`).join('\n');
    const medicalPrompt = `
      You are a clinical documentation assistant in an Indian hospital.
      Analyze the consultation history and return ONLY a JSON object.

      JSON Structure:
      {
        "intake_completeness": {
          "is_complete": true/false,
          "missing_points": ["list any missing from: Chief Complaint, Duration, Severity, Associated Symptoms, Medical History, Allergies, Current Meds"],
          "suggested_questions": ["specific follow-up questions for the doctor"]
        },
        "patient_profile": {
          "chief_complaint": "string or null",
          "duration": "string or null",
          "severity": "string or null",
          "associated_symptoms": ["array or empty"],
          "medical_history": ["array or empty"],
          "allergies": ["array or empty"],
          "current_meds": ["array or empty"]
        },
        "diagnosis": "string",
        "prescription": [
          { "medicine": "generic name only", "dose": "e.g. 500mg", "frequency": "e.g. 1-0-1", "duration": "e.g. 5 days" }
        ],
        "advice": "string",
        "follow_up": "string"
      }

      Rules: Generic medicine names only. Frequency in X-X-X format. Return ONLY JSON.

      CONSULTATION:
      ${conversationText}
    `;

    const genAI = new GoogleGenerativeAI(ENV_GEMINI_KEY);
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const result = await model.generateContent(medicalPrompt);
      let text = (await result.response).text().replace(/```json|```/g, '').trim();
      // Extract the last (most complete) JSON object in the response
      const jsonMatch = text.match(/\{[\s\S]*\}/g);
      if (jsonMatch) text = jsonMatch[jsonMatch.length - 1];
      setClinicalAgent({ status: 'completed', data: text });
    } catch (err: any) {
      if (ENV_HF_KEY) {
        try {
          const hfRes = await axios.post("https://router.huggingface.co/v1/chat/completions", {
            model: "meta-llama/Llama-3.1-8B-Instruct",
            messages: [{ role: "user", content: medicalPrompt }], max_tokens: 1200
          }, { headers: { Authorization: `Bearer ${ENV_HF_KEY}` } });
          let hfText = hfRes.data.choices[0].message.content.replace(/```json|```/g, '').trim();
          const hfMatch = hfText.match(/\{[\s\S]*\}/g);
          if (hfMatch) hfText = hfMatch[hfMatch.length - 1];
          setClinicalAgent({ status: 'completed', data: hfText });
        } catch { setClinicalAgent({ status: 'error', data: null, error: err.message }); }
      } else {
        setClinicalAgent({ status: 'error', data: null, error: err.message });
      }
    } finally { setIsProcessing(false); }
  };

  const audioBufferToWavBlob = (buffer: AudioBuffer): Blob => {
    const numOfChan = buffer.numberOfChannels, length = buffer.length * numOfChan * 2 + 44;
    const arrayBuffer = new ArrayBuffer(length), view = new DataView(arrayBuffer), channels: Float32Array[] = [];
    let offset = 0;
    const setUint32 = (d: number) => { view.setUint32(offset, d, true); offset += 4; };
    const setUint16 = (d: number) => { view.setUint16(offset, d, true); offset += 2; };
    setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157); setUint32(0x20746d66); setUint32(16);
    setUint16(1); setUint16(numOfChan); setUint32(buffer.sampleRate); setUint32(buffer.sampleRate * 2 * numOfChan);
    setUint16(numOfChan * 2); setUint16(16); setUint32(0x61746164); setUint32(length - offset - 4);
    for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
    let channel = 0;
    while (offset < length) {
      for (let i = 0; i < numOfChan; i++) {
        let sample = Math.max(-1, Math.min(1, channels[i][channel]));
        sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
        view.setInt16(offset, sample, true); offset += 2;
      }
      channel++;
    }
    return new Blob([view], { type: "audio/wav" });
  };

  return (
    <div className="app-container">
      <header>
        <div className="logo"><Stethoscope size={32} /><span>Spot Medicine AI</span></div>
        <div className="status-indicator"><div className="dot online"></div><span>Systems Online</span></div>
      </header>
      <main className="main-grid">
        {/* LEFT: Consultation Panel */}
        <motion.section className="card" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <h2 className="card-title"><Activity size={24} className="gradient-text" />Live Consultation</h2>

          {/* Chat Log */}
          <div style={{ height: '340px', background: 'rgba(0,0,0,0.2)', borderRadius: '12px', padding: '1rem', overflowY: 'auto', marginBottom: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {chatHistory.length === 0 && (
              <div style={{ textAlign: 'center', opacity: 0.3, marginTop: '40%', fontSize: '13px' }}>Start recording to begin the consultation...</div>
            )}
            {chatHistory.map((chat, idx) => (
              <div key={idx} style={{
                alignSelf: chat.role === 'doctor' ? 'flex-start' : 'flex-end',
                background: chat.role === 'doctor' ? 'rgba(78,205,196,0.08)' : 'rgba(255,107,107,0.08)',
                padding: '12px 14px', borderRadius: '14px', maxWidth: '82%',
                border: `1px solid ${chat.role === 'doctor' ? 'rgba(78,205,196,0.25)' : 'rgba(255,107,107,0.25)'}`
              }}>
                <span style={{ fontSize: '9px', letterSpacing: '1.5px', textTransform: 'uppercase', opacity: 0.4, display: 'block', marginBottom: '5px' }}>
                  {chat.role === 'doctor' ? '🩺 Doctor (English)' : '🗣 Patient (Regional)'}
                </span>
                <div style={{ fontSize: '0.93rem', lineHeight: 1.5 }}>{chat.content}</div>
                {chat.translated && (
                  <div style={{ marginTop: '9px', paddingTop: '8px', borderTop: '1px dashed rgba(255,255,255,0.08)', display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                    <div style={{ flex: 1, fontSize: '0.82rem', color: 'rgba(255,255,255,0.45)', fontStyle: 'italic', lineHeight: 1.5 }}>
                      {chat.translated}
                    </div>
                    <button
                      onClick={() => callSarvamTTS(chat.translated!, chat.role === 'doctor' ? patientLanguage : 'en')}
                      title="Speak translation"
                      style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', color: 'var(--accent)', cursor: 'pointer', padding: '4px 6px', display: 'flex', alignItems: 'center', flexShrink: 0 }}
                    >
                      <Volume2 size={13} className={isSpeaking ? 'pulse' : ''} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Controls row */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <label style={{ fontSize: '12px', opacity: 0.6 }}>Patient Language</label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <select value={patientLanguage} onChange={e => setPatientLanguage(e.target.value)} style={{ fontSize: '12px' }}>
                <option value="hi">Hindi</option><option value="ta">Tamil</option><option value="te">Telugu</option>
                <option value="kn">Kannada</option><option value="tcy">Tulu</option><option value="bn">Bengali</option>
                <option value="ml">Malayalam</option><option value="gu">Gujarati</option>
              </select>
              <button className="button" onClick={() => setChatHistory([])} style={{ padding: '4px 12px', fontSize: '11px', height: 'auto' }}>Clear</button>
            </div>
          </div>

          {/* Generate Rx */}
          <button className="button" onClick={processIntelligencePipeline} style={{ width: '100%', background: 'linear-gradient(135deg,var(--primary),var(--accent))', marginBottom: '1rem', height: '44px', fontWeight: 700 }} disabled={isProcessing || !chatHistory.length}>
            {isProcessing ? "Analyzing..." : "✅  Check Completeness & Generate Rx"}
          </button>

          {/* Mic Buttons */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <button className="button" style={{ height: '76px', background: isRecording === 'doctor' ? '#ff4d4d' : 'var(--surface)', border: isRecording === 'doctor' ? '2px solid #ff4d4d' : '1px solid rgba(255,255,255,0.1)' }}
              onClick={() => isRecording ? stopRecording() : startRecording('doctor')}
              disabled={sttStatus === 'processing' || !!(isRecording && isRecording !== 'doctor')}>
              <div style={{ textAlign: 'center' }}>
                <Mic size={24} className={isRecording === 'doctor' ? 'pulse' : ''} />
                <div style={{ fontSize: '10px', marginTop: '4px' }}>{isRecording === 'doctor' ? '⏹ Stop' : '🎤 Doctor (EN)'}</div>
              </div>
            </button>
            <button className="button" style={{ height: '76px', background: isRecording === 'patient' ? 'var(--primary)' : 'var(--surface)', border: isRecording === 'patient' ? '2px solid var(--primary)' : '1px solid rgba(255,255,255,0.1)' }}
              onClick={() => isRecording ? stopRecording() : startRecording('patient')}
              disabled={sttStatus === 'processing' || !!(isRecording && isRecording !== 'patient')}>
              <div style={{ textAlign: 'center' }}>
                <Mic size={24} className={isRecording === 'patient' ? 'pulse' : ''} />
                <div style={{ fontSize: '10px', marginTop: '4px' }}>{isRecording === 'patient' ? '⏹ Stop' : `🎤 Patient (${patientLanguage.toUpperCase()})`}</div>
              </div>
            </button>
          </div>
        </motion.section>

        {/* RIGHT: Report + Editable Prescription */}
        <section className="card" style={{ overflowY: 'auto' }}>
          <h2 className="card-title"><Database size={24} /> Clinical Report</h2>
          <div className="agent-step active" style={{ marginBottom: '0.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Status</span>
              <StatusBadge status={clinicalAgent.status} />
            </div>
            <div className="output-area" style={{ fontSize: '12px' }}>
              {sttStatus === 'processing' ? `Transcribing ${activeRole}...` : clinicalAgent.status === 'idle' ? 'Idle — run a consultation first.' : ''}
            </div>
          </div>
          <ClinicalReportDisplay data={clinicalAgent.data} onSpeakSuggestion={(q) => callSarvamTTS(q, patientLanguage)} patientLanguage={patientLanguage} hfKey={ENV_HF_KEY} onSpeakInPatientLang={(text) => callSarvamTTS(text, patientLanguage)} />
        </section>
      </main>
    </div>
  );
};

/* ── Editable Clinical Report Display ── */
const ClinicalReportDisplay: React.FC<{
  data: any;
  onSpeakSuggestion: (q: string) => void;
  patientLanguage: string;
  hfKey: string;
  onSpeakInPatientLang: (text: string) => void;
}> = ({ data, onSpeakSuggestion, patientLanguage, hfKey, onSpeakInPatientLang }) => {
  const [finalized, setFinalized] = useState(false);
  const [rx, setRx] = useState<EditableRx | null>(null);
  const [json, setJson] = useState<any>(null);

  React.useEffect(() => {
    if (!data) { setRx(null); setJson(null); setFinalized(false); return; }
    try {
      // Handle both string and object data; extract last JSON block to skip any `{}` prefix
      let raw = typeof data === 'string' ? data : JSON.stringify(data);
      const matches = raw.match(/\{[\s\S]*\}/g);
      const jsonStr = matches ? matches[matches.length - 1] : raw;
      const parsed = JSON.parse(jsonStr);
      setJson(parsed);
      setRx({
        diagnosis: parsed.diagnosis || '',
        advice: parsed.advice || '',
        follow_up: parsed.follow_up || '',
        prescription: (parsed.prescription || []).map((p: any) => ({
          medicine: p.medicine || '', dose: p.dose || '', frequency: p.frequency || '', duration: p.duration || ''
        }))
      });
      setFinalized(false);
    } catch (e) {
      console.error('JSON parse error:', e);
      setJson(null); setRx(null);
    }
  }, [data]);

  if (!data) return <span style={{ opacity: 0.4, fontSize: '13px' }}>No report generated yet.</span>;
  if (!json || !rx) return <pre style={{ fontSize: '11px', whiteSpace: 'pre-wrap', opacity: 0.7 }}>{String(data)}</pre>;

  const profile = json.patient_profile || {};
  const intake = json.intake_completeness || { is_complete: true };

  const fieldStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '6px', color: 'white', padding: '5px 8px', fontSize: '13px', width: '100%', outline: 'none', marginTop: '3px'
  };

  const updateRow = (i: number, f: keyof RxRow, v: string) => {
    setRx(prev => { if (!prev) return prev; const rows = [...prev.prescription]; rows[i] = { ...rows[i], [f]: v }; return { ...prev, prescription: rows }; });
  };

  return (
    <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.9)' }}>

      {/* ─ Intake Completeness Warning ─ */}
      {!intake.is_complete && (
        <div style={{ background: 'rgba(255,183,77,0.08)', border: '1px solid #FFB74D', padding: '12px', borderRadius: '12px', marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#FFB74D', marginBottom: '6px' }}>
            <AlertCircle size={16} />
            <b style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px' }}>Incomplete Intake</b>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '10px' }}>
            {intake.missing_points?.map((p: string, i: number) => (
              <span key={i} style={{ fontSize: '10px', background: 'rgba(255,183,77,0.15)', padding: '2px 8px', borderRadius: '4px', color: '#FFB74D' }}>{p}</span>
            ))}
          </div>
          <b style={{ fontSize: '11px', opacity: 0.6 }}>Suggested Questions for Doctor:</b>
          <ul style={{ margin: '6px 0 0', paddingLeft: '1.1rem', color: '#FFB74D', fontSize: '12px' }}>
            {intake.suggested_questions?.map((q: string, i: number) => (
              <li key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
                {q}
                <button onClick={() => onSpeakSuggestion(q)} title="Read question" style={{ background: 'none', border: 'none', color: '#FFB74D', cursor: 'pointer', padding: 0 }}>
                  <Volume2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ─ Patient Summary (read-only) ─ */}
      <div style={{ marginBottom: '1.25rem' }}>
        <h4 style={{ color: 'var(--accent)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '8px', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '4px' }}>Patient Summary</h4>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '12px' }}>
          {[['Complaint', profile.chief_complaint], ['Duration', profile.duration], ['Severity', profile.severity], ['Symptoms', profile.associated_symptoms?.join(', ')]].map(([k, v]) => (
            <div key={k as string}><span style={{ opacity: 0.5 }}>{k as string}:</span> <span>{(v as string) || '—'}</span></div>
          ))}
        </div>
        {(profile.allergies?.length > 0) && (
          <div style={{ marginTop: '6px', padding: '6px 10px', background: 'rgba(255,107,107,0.08)', borderRadius: '8px', border: '1px solid rgba(255,107,107,0.2)' }}>
            ⚠️ <b style={{ color: '#FF6B6B' }}>Allergies:</b> {profile.allergies.join(', ')}
          </div>
        )}
        {(profile.medical_history?.length > 0) && <div style={{ marginTop: '4px', fontSize: '12px' }}><span style={{ opacity: 0.5 }}>History:</span> {profile.medical_history.join(', ')}</div>}
        {(profile.current_meds?.length > 0) && <div style={{ marginTop: '4px', fontSize: '12px' }}><span style={{ opacity: 0.5 }}>Current Meds:</span> {profile.current_meds.join(', ')}</div>}
      </div>

      {/* ─ Doctor Edit Mode ─ */}
      {finalized ? (
        <div style={{ background: 'rgba(78,205,196,0.06)', border: '1px solid rgba(78,205,196,0.3)', borderRadius: '12px', padding: '14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <span style={{ color: 'var(--accent)', fontSize: '12px', fontWeight: 700 }}><Lock size={12} style={{ marginRight: 5 }} />Finalized Prescription</span>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                onClick={async () => {
                  // Build English prescription text (keep medicine names in English)
                  const rxEnglish = `Your diagnosis is ${rx.diagnosis}. ${rx.prescription.map(p => `Take ${p.medicine} ${p.dose} ${p.frequency} for ${p.duration}`).join('. ')}. ${rx.advice ? 'Advice: ' + rx.advice + '.' : ''} ${rx.follow_up ? 'Please follow up ' + rx.follow_up + '.' : ''}`;

                  // Translate to patient's language via HF (keeping medicine names in English)
                  let spokenText = rxEnglish;
                  if (hfKey) {
                    const langNameMap: Record<string, string> = {
                      'hi': 'Hindi', 'ta': 'Tamil', 'te': 'Telugu', 'kn': 'Kannada',
                      'tcy': 'Tulu', 'bn': 'Bengali', 'ml': 'Malayalam', 'gu': 'Gujarati',
                      'mr': 'Marathi', 'pa': 'Punjabi', 'en': 'English'
                    };
                    const targetLang = langNameMap[patientLanguage] || patientLanguage;
                    if (targetLang !== 'English') {
                      try {
                        const prompt = `Translate the following English prescription instructions to ${targetLang} for the patient to understand.
IMPORTANT: Keep ALL medicine names, dosages (mg, ml), and frequency codes (OD, BD, TDS, 1-0-1) in English exactly as written.
Only translate the surrounding instructions and advice.
Reply with ONLY the translated text.

Text: ${rxEnglish}`;
                        const res = await axios.post('https://router.huggingface.co/v1/chat/completions', {
                          model: 'meta-llama/Llama-3.1-8B-Instruct',
                          messages: [{ role: 'user', content: prompt }],
                          max_tokens: 400, temperature: 0.1
                        }, { headers: { Authorization: `Bearer ${hfKey}`, 'Content-Type': 'application/json' } });
                        spokenText = res.data.choices?.[0]?.message?.content?.trim() || rxEnglish;
                      } catch (e) { console.warn('Rx translation failed, speaking in English'); }
                    }
                  }
                  onSpeakInPatientLang(spokenText);
                }}
                title="Read prescription to patient in their language"
                style={{ background: 'rgba(78,205,196,0.1)', border: '1px solid rgba(78,205,196,0.3)', borderRadius: '6px', color: 'var(--accent)', cursor: 'pointer', padding: '3px 8px', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}
              >
                <Volume2 size={13} /> Read to Patient
              </button>
              <button onClick={() => setFinalized(false)} style={{ fontSize: '11px', background: 'none', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '6px', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', padding: '2px 10px' }}>Edit</button>
            </div>
          </div>
          <div style={{ marginBottom: '8px' }}><b style={{ opacity: 0.5, fontSize: '10px', display: 'block' }}>DIAGNOSIS</b>{rx.diagnosis || '—'}</div>
          <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', marginBottom: '8px' }}>
            <thead><tr style={{ opacity: 0.4, fontSize: '10px' }}><th style={{ padding: '3px' }}>Medicine</th><th style={{ padding: '3px' }}>Dose</th><th style={{ padding: '3px' }}>Freq</th><th style={{ padding: '3px' }}>Duration</th></tr></thead>
            <tbody>{rx.prescription.map((p, i) => (
              <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                <td style={{ padding: '5px 3px' }}><b>{p.medicine}</b></td>
                <td style={{ padding: '5px 3px' }}>{p.dose}</td>
                <td style={{ padding: '5px 3px', color: 'var(--secondary)' }}>{p.frequency}</td>
                <td style={{ padding: '5px 3px' }}>{p.duration}</td>
              </tr>
            ))}</tbody>
          </table>
          {rx.advice && <div style={{ fontSize: '12px', fontStyle: 'italic', opacity: 0.7, marginBottom: '4px' }}>💊 {rx.advice}</div>}
          {rx.follow_up && <div style={{ fontSize: '12px', color: 'var(--secondary)' }}>📅 Follow-up: {rx.follow_up}</div>}
        </div>
      ) : (
        /* Edit Mode */
        <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px', opacity: 0.5 }}>
            <Edit2 size={13} /><span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px' }}>Doctor Edit Mode</span>
          </div>

          <label style={{ fontSize: '11px', opacity: 0.5 }}>Diagnosis</label>
          <input style={fieldStyle} value={rx.diagnosis} onChange={e => setRx(p => p ? { ...p, diagnosis: e.target.value } : p)} placeholder="Enter diagnosis..." />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '12px', marginBottom: '6px' }}>
            <label style={{ fontSize: '11px', opacity: 0.5 }}>Prescription (Generic)</label>
            <button onClick={() => setRx(p => p ? { ...p, prescription: [...p.prescription, { medicine: '', dose: '', frequency: '', duration: '' }] } : p)}
              style={{ fontSize: '11px', background: 'rgba(78,205,196,0.1)', border: '1px solid rgba(78,205,196,0.3)', borderRadius: '6px', color: 'var(--accent)', cursor: 'pointer', padding: '2px 10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <PlusCircle size={12} /> Add
            </button>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr style={{ opacity: 0.4, fontSize: '10px' }}><th style={{ padding: '3px' }}>Medicine</th><th style={{ padding: '3px' }}>Dose</th><th style={{ padding: '3px' }}>Freq</th><th style={{ padding: '3px' }}>Days</th><th></th></tr></thead>
            <tbody>
              {rx.prescription.map((p, i) => (
                <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <td style={{ padding: '3px' }}><input style={{ ...fieldStyle, marginTop: 0 }} value={p.medicine} onChange={e => updateRow(i, 'medicine', e.target.value)} placeholder="paracetamol" /></td>
                  <td style={{ padding: '3px' }}><input style={{ ...fieldStyle, marginTop: 0 }} value={p.dose} onChange={e => updateRow(i, 'dose', e.target.value)} placeholder="500mg" /></td>
                  <td style={{ padding: '3px' }}><input style={{ ...fieldStyle, marginTop: 0 }} value={p.frequency} onChange={e => updateRow(i, 'frequency', e.target.value)} placeholder="1-0-1" /></td>
                  <td style={{ padding: '3px' }}><input style={{ ...fieldStyle, marginTop: 0 }} value={p.duration} onChange={e => updateRow(i, 'duration', e.target.value)} placeholder="5 days" /></td>
                  <td style={{ padding: '3px' }}><button onClick={() => setRx(prev => prev ? { ...prev, prescription: prev.prescription.filter((_, idx) => idx !== i) } : prev)} style={{ background: 'none', border: 'none', color: '#FF6B6B', cursor: 'pointer', fontSize: '16px' }}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '10px', marginBottom: '14px' }}>
            <div>
              <label style={{ fontSize: '11px', opacity: 0.5 }}>Advice</label>
              <input style={fieldStyle} value={rx.advice} onChange={e => setRx(p => p ? { ...p, advice: e.target.value } : p)} placeholder="Rest, hydrate..." />
            </div>
            <div>
              <label style={{ fontSize: '11px', opacity: 0.5 }}>Follow-up</label>
              <input style={fieldStyle} value={rx.follow_up} onChange={e => setRx(p => p ? { ...p, follow_up: e.target.value } : p)} placeholder="After 5 days" />
            </div>
          </div>

          <button onClick={() => setFinalized(true)}
            style={{ width: '100%', padding: '11px', background: 'linear-gradient(135deg,var(--primary),var(--accent))', border: 'none', borderRadius: '10px', color: 'white', fontWeight: 700, fontSize: '13px', cursor: 'pointer', letterSpacing: '0.5px' }}>
            <Lock size={14} style={{ marginRight: 6 }} />Finalize Prescription
          </button>
        </div>
      )
      }
    </div >
  );
};

const StatusBadge: React.FC<{ status: AgentState['status'] }> = ({ status }) => {
  if (status === 'processing') return <div className="loader" style={{ width: '12px', height: '12px' }}></div>;
  if (status === 'completed') return <CheckCircle2 size={14} color="var(--accent)" />;
  if (status === 'error') return <AlertCircle size={14} color="var(--danger)" />;
  return <div className="dot"></div>;
};

export default App;
