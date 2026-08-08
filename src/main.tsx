import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { audioUrl, cropBuffer, decodeAudio, encodeMp3, formatTime, removeSilentAudio, type TimeRange } from './audio';
import './styles.css';

type Screen = 'record' | 'editor' | 'settings';
type CaptureState = 'idle' | 'recording' | 'paused';
type Settings = { bitrate: 128 | 192 | 256 | 320; silenceDb: number; minimumSilenceMs: number };
const defaultSettings: Settings = { bitrate: 320, silenceDb: -42, minimumSilenceMs: 450 };

function Waveform({ buffer }: { buffer: AudioBuffer | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !buffer) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
    context.scale(devicePixelRatio, devicePixelRatio);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const samples = buffer.getChannelData(0);
    const stride = Math.max(1, Math.floor(samples.length / width));
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#e7eeff'; context.fillRect(0, 0, width, height);
    context.strokeStyle = '#3367d6'; context.lineWidth = 1.5; context.beginPath();
    for (let x = 0; x < width; x += 1) {
      let peak = 0;
      for (let i = 0; i < stride; i += 1) peak = Math.max(peak, Math.abs(samples[x * stride + i] ?? 0));
      const amplitude = peak * height * 0.46;
      context.moveTo(x, height / 2 - amplitude); context.lineTo(x, height / 2 + amplitude);
    }
    context.stroke();
  }, [buffer]);
  return <canvas className="waveform" ref={canvasRef} aria-label="Audio waveform" />;
}

function captureCurrentTabAudio(): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
      const error = chrome.runtime.lastError?.message;
      if (error || !stream) reject(new Error(error ?? 'Chrome could not capture audio from this tab.'));
      else resolve(stream);
    });
  });
}

function App() {
  const [screen, setScreen] = useState<Screen>('record');
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [captureState, setCaptureState] = useState<CaptureState>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [message, setMessage] = useState('Ready to capture audio from the current tab.');
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<AudioBuffer | null>(null);
  const [edited, setEdited] = useState<AudioBuffer | null>(null);
  const [range, setRange] = useState<TimeRange>({ start: 0, end: 0 });
  const [exporting, setExporting] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const outputContextRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const timerStartedAtRef = useRef<number | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    chrome.storage.local.get('settings').then(({ settings: saved }) => {
      if (saved) setSettings({ ...defaultSettings, ...(saved as Partial<Settings>) });
    });
  }, []);
  useEffect(() => { void chrome.storage.local.set({ settings }); }, [settings]);
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    void outputContextRef.current?.close();
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);
  useEffect(() => {
    if (captureState !== 'recording') return undefined;
    timerStartedAtRef.current = Date.now() - elapsedMs;
    const interval = window.setInterval(() => setElapsedMs(Date.now() - (timerStartedAtRef.current ?? Date.now())), 250);
    return () => window.clearInterval(interval);
  }, [captureState]); // Only count the time where audio is actually recorded.
  useEffect(() => {
    if (!edited) return;
    const url = audioUrl(edited);
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = url; setPreviewUrl(url);
  }, [edited]);

  async function activeTabId() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
  }
  async function setBadge(type: 'RECORDING_STARTED' | 'RECORDING_STOPPED') {
    chrome.runtime.sendMessage({ type, tabId: await activeTabId() }).catch(() => undefined);
  }
  async function cleanUpCapture() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    await outputContextRef.current?.close();
    outputContextRef.current = null;
    recorderRef.current = null;
    setCaptureState('idle');
    await setBadge('RECORDING_STOPPED');
  }
  async function startRecording() {
    setError(null);
    if (typeof chrome === 'undefined' || !chrome.tabCapture) {
      setError('Direct active-tab audio capture is unavailable in this browser. It requires Chromium’s tabCapture API; Safari cannot provide this no-picker flow from a WebExtension.');
      return;
    }
    try {
      const stream = await captureCurrentTabAudio();
      streamRef.current = stream;
      if (stream.getAudioTracks().length === 0) throw new Error('The current tab did not expose an audio track.');
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 256000 } : undefined);
      chunksRef.current = []; discardRef.current = false; setElapsedMs(0);
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = async () => {
        const shouldDiscard = discardRef.current;
        try {
          if (!shouldDiscard) {
            const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
            const decoded = await decodeAudio(blob);
            setSource(decoded); setEdited(decoded); setRange({ start: 0, end: decoded.duration });
            setScreen('editor'); setMessage('Recording finished. Trim it or remove silent sections before exporting.');
          } else {
            setMessage('Recording cancelled. Nothing was saved.');
          }
        } catch (caught) {
          setError(caught instanceof Error ? `Could not decode this recording: ${caught.message}` : 'Could not decode this recording.');
        } finally { await cleanUpCapture(); }
      };
      const output = new AudioContext();
      output.createMediaStreamSource(stream).connect(output.destination);
      await output.resume(); // tabCapture otherwise suppresses normal tab playback.
      outputContextRef.current = output; recorderRef.current = recorder;
      recorder.start(1000); setCaptureState('recording'); setMessage('Current-tab audio is being captured. Keep this popup open.');
      await setBadge('RECORDING_STARTED');
    } catch (caught) {
      await cleanUpCapture();
      setError(caught instanceof Error ? caught.message : 'The recording could not be started.');
    }
  }
  function togglePause() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === 'recording') { recorder.pause(); setCaptureState('paused'); setMessage('Recording paused. The current tab continues playing normally.'); }
    else if (recorder.state === 'paused') { recorder.resume(); setCaptureState('recording'); setMessage('Recording resumed.'); }
  }
  function finishRecording() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }
  function cancelRecording() {
    discardRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }
  function applyTrim() {
    if (!source) return;
    const result = cropBuffer(source, range); setEdited(result); setMessage(`Trimmed to ${formatTime(result.duration)}.`);
  }
  function removeSilence() {
    if (!edited) return;
    const result = removeSilentAudio(edited, settings.silenceDb, settings.minimumSilenceMs);
    setEdited(result); setRange({ start: 0, end: result.duration }); setMessage(`Removed long silent passages. New length: ${formatTime(result.duration)}.`);
  }
  function resetEdits() {
    if (!source) return;
    setEdited(source); setRange({ start: 0, end: source.duration }); setMessage('Edits reset to the original recording.');
  }
  function exportMp3() {
    if (!edited) return;
    setExporting(true); setError(null);
    try {
      const mp3 = encodeMp3(edited, settings.bitrate);
      const href = URL.createObjectURL(mp3); const link = document.createElement('a');
      link.href = href; link.download = `tab-audio-${new Date().toISOString().replace(/[:.]/g, '-')}.mp3`; link.click();
      URL.revokeObjectURL(href); setMessage(`Downloaded MP3 at ${settings.bitrate} kbps.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'MP3 export failed.'); }
    finally { setExporting(false); }
  }

  const duration = source?.duration ?? 0;
  const isCapturing = captureState !== 'idle';
  return <main className="app">
    <header><div><p className="eyebrow">TAB AUDIO STUDIO</p><h1>{screen === 'record' ? 'Record audio' : screen === 'editor' ? 'Audio editor' : 'Settings'}</h1></div><span className={isCapturing ? 'status recording' : 'status'}>{captureState === 'recording' ? '● REC' : captureState === 'paused' ? 'Ⅱ PAUSED' : 'READY'}</span></header>
    <nav aria-label="Extension screens">
      <button className={screen === 'record' ? 'active' : ''} onClick={() => setScreen('record')}>Record</button>
      <button className={screen === 'editor' ? 'active' : ''} onClick={() => setScreen('editor')} disabled={!source}>Editor</button>
      <button className={screen === 'settings' ? 'active' : ''} onClick={() => setScreen('settings')}>Settings</button>
    </nav>
    {error && <p className="error" role="alert">{error}</p>}
    {screen === 'record' && <section className="panel recorder-panel">
      {isCapturing ? <><div className="capture-card"><p>Current tab is being captured</p><strong>{formatTime(elapsedMs / 1000)}</strong><span>{captureState === 'paused' ? 'Recording is paused' : 'Audio only · current tab'}</span></div><button className="pause-button" onClick={togglePause}>{captureState === 'paused' ? '▶  Resume recording' : 'Ⅱ  Pause recording'}</button><div className="capture-actions"><button className="finish-button" onClick={finishRecording}>✓ Finish recording</button><button className="cancel-button" onClick={cancelRecording}>× Cancel</button></div></> : <><div className="record-visual"><span>♫</span></div><h2>Capture current-tab audio</h2><p>Starts immediately after you click—no screen sharing and no tab picker. Only audio from the active tab is captured.</p><button className="primary" onClick={startRecording}>Start recording</button></>}
      <p className="hint">{message}</p>
    </section>}
    {screen === 'editor' && source && edited && <section className="panel editor">
      <Waveform buffer={edited} /><audio controls src={previewUrl ?? undefined} /><div className="time-row"><span>{formatTime(edited.duration)}</span><span>Preview</span></div>
      <fieldset><legend>Trim original recording</legend><label>Start <output>{formatTime(range.start)}</output><input type="range" min="0" max={duration} step="0.05" value={range.start} onChange={(e) => setRange((current) => ({ ...current, start: Math.min(Number(e.target.value), current.end - 0.05) }))} /></label><label>End <output>{formatTime(range.end)}</output><input type="range" min="0.05" max={duration} step="0.05" value={range.end} onChange={(e) => setRange((current) => ({ ...current, end: Math.max(Number(e.target.value), current.start + 0.05) }))} /></label><button className="secondary" onClick={applyTrim}>Apply trim</button></fieldset>
      <fieldset><legend>Silence cleanup</legend><p>Deletes quiet sections at least {settings.minimumSilenceMs} ms long (below {settings.silenceDb} dB).</p><button className="secondary" onClick={removeSilence}>Delete silent parts</button></fieldset>
      <div className="editor-actions"><button className="text-button" onClick={resetEdits}>Reset edits</button><button className="primary" disabled={exporting} onClick={exportMp3}>{exporting ? 'Encoding MP3…' : `Export MP3 (${settings.bitrate} kbps)`}</button></div><p className="hint">{message}</p>
    </section>}
    {screen === 'settings' && <section className="panel settings"><label>MP3 bitrate<select value={settings.bitrate} onChange={(e) => setSettings((current) => ({ ...current, bitrate: Number(e.target.value) as Settings['bitrate'] }))}><option value="128">128 kbps</option><option value="192">192 kbps</option><option value="256">256 kbps</option><option value="320">320 kbps (best quality)</option></select></label><label>Silence threshold <output>{settings.silenceDb} dB</output><input type="range" min="-60" max="-20" step="1" value={settings.silenceDb} onChange={(e) => setSettings((current) => ({ ...current, silenceDb: Number(e.target.value) }))} /></label><label>Minimum silent duration <output>{settings.minimumSilenceMs} ms</output><input type="range" min="150" max="1500" step="50" value={settings.minimumSilenceMs} onChange={(e) => setSettings((current) => ({ ...current, minimumSilenceMs: Number(e.target.value) }))} /></label><p className="hint">Settings are saved locally in the extension.</p></section>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
