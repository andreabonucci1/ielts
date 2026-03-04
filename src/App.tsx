import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Mic, Loader2, Play, Square, Activity, History } from 'lucide-react';

const SYSTEM_INSTRUCTION = `You are an expert IELTS examiner. Keep asking me questions and keep responses VERY short. Only correct MAJOR mistakes. CRITICAL RULE: When I say 'Give me my feedback', stop the roleplay, give me a quick verbal evaluation, and YOU MUST END your response with the exact phrase 'FINAL SCORE: X.X' (inserting my score).`;

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function base64ToArrayBuffer(base64: string) {
  const binary_string = window.atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
      bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes.buffer;
}

const workletCode = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 4096;
    this.buffer = new Int16Array(this.bufferSize);
    this.offset = 0;
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0];
      for (let i = 0; i < channelData.length; i++) {
        let s = Math.max(-1, Math.min(1, channelData[i]));
        this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        if (this.offset >= this.bufferSize) {
          const copy = new Int16Array(this.buffer);
          this.port.postMessage(copy.buffer, [copy.buffer]);
          this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

const workletBlob = new Blob([workletCode], { type: 'application/javascript' });
const workletUrl = URL.createObjectURL(workletBlob);

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scores, setScores] = useState<number[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('ielts_scores') || '[]');
    } catch {
      return [];
    }
  });

  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sessionRef = useRef<any>(null);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextPlayTimeRef = useRef<number>(0);
  const transcriptRef = useRef<string>("");
  
  const isEndingRef = useRef<boolean>(false);
  const serverTurnCompleteRef = useRef<boolean>(false);
  const isMicMutedRef = useRef<boolean>(false);

  useEffect(() => {
    localStorage.setItem('ielts_scores', JSON.stringify(scores));
  }, [scores]);

  const checkAndDisconnect = () => {
    if (isEndingRef.current && serverTurnCompleteRef.current && activeSourcesRef.current.length === 0) {
      forceStopPractice();
    }
  };

  const playAudio = (base64Audio: string) => {
    const audioCtx = audioContextRef.current;
    if (!audioCtx) return;

    const arrayBuffer = base64ToArrayBuffer(base64Audio);
    const int16Array = new Int16Array(arrayBuffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
    }
    
    const audioBuffer = audioCtx.createBuffer(1, float32Array.length, 24000);
    audioBuffer.getChannelData(0).set(float32Array);

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtx.destination);

    const currentTime = audioCtx.currentTime;
    const startTime = Math.max(nextPlayTimeRef.current, currentTime + 0.05);
    
    source.start(startTime);
    nextPlayTimeRef.current = startTime + audioBuffer.duration;

    activeSourcesRef.current.push(source);
    source.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
      checkAndDisconnect();
    };
  };

  const stopAudioPlayback = () => {
    activeSourcesRef.current.forEach(source => {
      try {
        source.stop();
      } catch (e) {}
    });
    activeSourcesRef.current = [];
    if (audioContextRef.current) {
      nextPlayTimeRef.current = audioContextRef.current.currentTime;
    }
  };

  const startPractice = async () => {
    try {
      setError(null);
      setIsConnecting(true);
      setIsEnding(false);
      isEndingRef.current = false;
      serverTurnCompleteRef.current = false;
      isMicMutedRef.current = false;
      transcriptRef.current = "";

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;

      await audioCtx.audioWorklet.addModule(workletUrl);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const source = audioCtx.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor');
      workletNodeRef.current = workletNode;

      const gainNode = audioCtx.createGain();
      gainNode.gain.value = 0;
      source.connect(workletNode);
      workletNode.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      const sessionPromise = ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: SYSTEM_INSTRUCTION,
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setIsConnecting(false);
            setIsRecording(true);
            
            workletNode.port.onmessage = (event) => {
              if (isMicMutedRef.current) return;
              const pcm16Buffer = event.data;
              const base64Data = arrayBufferToBase64(pcm16Buffer);
              sessionPromise.then((session: any) => {
                session.sendRealtimeInput({
                  media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
                });
              });
            };
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              playAudio(base64Audio);
            }
            
            if (message.serverContent?.interrupted) {
              stopAudioPlayback();
            }

            const outputText = message.serverContent?.outputTranscription?.text;
            if (outputText) {
              transcriptRef.current += outputText;
              const match = transcriptRef.current.match(/FINAL SCORE:\s*(\d+(?:\.\d+)?)/i);
              if (match) {
                const score = parseFloat(match[1]);
                if (!isNaN(score)) {
                  setScores(prev => [score, ...prev]);
                  transcriptRef.current = ""; // Reset to avoid duplicate parsing
                }
              }
            }

            if (message.serverContent?.turnComplete) {
              if (isEndingRef.current) {
                serverTurnCompleteRef.current = true;
                checkAndDisconnect();
              }
            }
          },
          onclose: () => {
            forceStopPractice();
          },
          onerror: (err: any) => {
            console.error("Live API Error:", err);
            setError("Connection error occurred.");
            forceStopPractice();
          }
        }
      });

      sessionRef.current = sessionPromise;

    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to start practice.");
      setIsConnecting(false);
      forceStopPractice();
    }
  };

  const stopPractice = () => {
    if (!sessionRef.current) return;
    
    if (isEnding) {
      // If already ending, force stop
      forceStopPractice();
      return;
    }

    setIsEnding(true);
    isEndingRef.current = true;
    isMicMutedRef.current = true;

    sessionRef.current.then((session: any) => {
      try {
        session.sendClientContent({
          turns: "The user has ended the session. Stop the roleplay, provide your final verbal evaluation now, and end your response with the exact phrase 'FINAL SCORE: X.X'.",
          turnComplete: true
        });
      } catch (e) {
        console.error("Failed to send end session message", e);
        forceStopPractice();
      }
    });
  };

  const forceStopPractice = () => {
    setIsRecording(false);
    setIsConnecting(false);
    setIsEnding(false);
    isEndingRef.current = false;
    serverTurnCompleteRef.current = false;
    isMicMutedRef.current = false;
    
    if (sessionRef.current) {
      sessionRef.current.then((session: any) => {
        try {
          session.close();
        } catch (e) {}
      });
      sessionRef.current = null;
    }

    if (workletNodeRef.current) {
      try { workletNodeRef.current.disconnect(); } catch (e) {}
      workletNodeRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      try { audioContextRef.current.close(); } catch (e) {}
      audioContextRef.current = null;
    }

    stopAudioPlayback();
  };

  useEffect(() => {
    return () => {
      forceStopPractice();
    };
  }, []);

  const latestScore = scores.length > 0 ? scores[0] : null;
  const averageScore = scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : null;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 flex flex-col items-center justify-center p-6 font-sans">
      <div className="max-w-md w-full flex flex-col gap-6">
        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 flex flex-col items-center shadow-2xl">
          <div className="w-24 h-24 bg-zinc-800 rounded-full flex items-center justify-center mb-8 relative">
            {isRecording && !isEnding && (
              <div className="absolute inset-0 rounded-full bg-emerald-500/20 animate-ping" />
            )}
            {isRecording ? (
              <Activity className={`w-10 h-10 ${isEnding ? 'text-amber-400' : 'text-emerald-400'}`} />
            ) : (
              <Mic className="w-10 h-10 text-zinc-400" />
            )}
          </div>

          <h1 className="text-2xl font-semibold mb-2 text-center tracking-tight">IELTS Examiner</h1>
          <p className="text-zinc-400 text-center mb-8 text-sm">
            Real-time voice conversation to practice your English speaking.
          </p>

          {error && (
            <div className="w-full bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl mb-6 text-sm text-center">
              {error}
            </div>
          )}

          {!isRecording ? (
            <button
              onClick={startPractice}
              disabled={isConnecting}
              className="w-full bg-emerald-500 hover:bg-emerald-600 text-white font-medium py-4 rounded-2xl transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-emerald-500/20"
            >
              {isConnecting ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <Play className="w-5 h-5" fill="currentColor" />
                  Start Practice
                </>
              )}
            </button>
          ) : (
            <button
              onClick={stopPractice}
              className={`w-full font-medium py-4 rounded-2xl transition-all flex items-center justify-center gap-2 ${
                isEnding 
                  ? 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-500' 
                  : 'bg-red-500/10 hover:bg-red-500/20 text-red-500'
              }`}
            >
              {isEnding ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Getting Feedback...
                </>
              ) : (
                <>
                  <Square className="w-5 h-5" fill="currentColor" />
                  Stop Practice
                </>
              )}
            </button>
          )}
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-xl">
          <div className="flex items-center gap-2 mb-6">
            <History className="w-5 h-5 text-zinc-400" />
            <h2 className="text-lg font-medium">Session History</h2>
          </div>
          
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="bg-zinc-950 rounded-2xl p-4 border border-zinc-800/50">
              <div className="text-zinc-500 text-xs font-medium uppercase tracking-wider mb-1">Latest Score</div>
              <div className="text-3xl font-light text-emerald-400">{latestScore !== null ? latestScore : '--'}</div>
            </div>
            <div className="bg-zinc-950 rounded-2xl p-4 border border-zinc-800/50">
              <div className="text-zinc-500 text-xs font-medium uppercase tracking-wider mb-1">Average</div>
              <div className="text-3xl font-light text-zinc-100">{averageScore !== null ? averageScore : '--'}</div>
            </div>
          </div>

          <div>
            <div className="text-zinc-500 text-xs font-medium uppercase tracking-wider mb-3">Past Scores</div>
            {scores.length > 0 ? (
              <div className="space-y-2 max-h-40 overflow-y-auto pr-2 custom-scrollbar">
                {scores.map((score, index) => (
                  <div key={index} className="flex justify-between items-center py-2 border-b border-zinc-800/50 last:border-0">
                    <span className="text-zinc-400 text-sm">Session {scores.length - index}</span>
                    <span className="font-medium text-zinc-200">{score.toFixed(1)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-zinc-500 text-sm text-center py-4">No sessions recorded yet.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
