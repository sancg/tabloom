import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { audioUrl, cropBuffer, decodeAudio, encodeMp3, formatTime, removeSilentAudio, type TimeRange } from './audio';
import { emptyRecordingState, type RecordingState } from './messages';
import { loadRecording } from './recording-store';
import './styles.css';

type Screen = 'record' | 'editor' | 'settings';
type Settings = { bitrate: 128 | 192 | 256 | 320; silenceDb: number; minimumSilenceMs: number };
const defaultSettings: Settings = { bitrate: 320, silenceDb: -42, minimumSilenceMs: 450 };
const MIN_SELECTION_SECONDS = 0.05;

function WaveformTrim({ buffer, range, onRangeChange }: { buffer: AudioBuffer; range: TimeRange; onRangeChange: (range: TimeRange) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null);
  const duration = buffer.duration;
  const startPercent = range.start / duration * 100;
  const endPercent = range.end / duration * 100;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * devicePixelRatio; canvas.height = height * devicePixelRatio;
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    const samples = buffer.getChannelData(0);
    const stride = Math.max(1, Math.floor(samples.length / width));
    context.clearRect(0, 0, width, height);
    context.strokeStyle = '#7251df'; context.lineWidth = 1.2; context.beginPath();
    for (let x = 0; x < width; x += 1) {
      let peak = 0;
      for (let index = 0; index < stride; index += 1) peak = Math.max(peak, Math.abs(samples[x * stride + index] ?? 0));
      const amplitude = peak * height * 0.47;
      context.moveTo(x, height / 2 - amplitude); context.lineTo(x, height / 2 + amplitude);
    }
    context.stroke();
  }, [buffer]);

  function moveHandle(event: ReactPointerEvent<HTMLDivElement>, edge: 'start' | 'end') {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const seconds = Math.max(0, Math.min(duration, ((event.clientX - rect.left) / rect.width) * duration));
    onRangeChange(edge === 'start'
      ? { start: Math.min(seconds, range.end - MIN_SELECTION_SECONDS), end: range.end }
      : { start: range.start, end: Math.max(seconds, range.start + MIN_SELECTION_SECONDS) });
  }
  function beginDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const explicitEdge = target.dataset.edge as 'start' | 'end' | undefined;
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerPercent = (event.clientX - rect.left) / rect.width * 100;
    const edge = explicitEdge ?? (Math.abs(pointerPercent - startPercent) < Math.abs(pointerPercent - endPercent) ? 'start' : 'end');
    event.currentTarget.setPointerCapture(event.pointerId); setDragging(edge); moveHandle(event, edge);
  }
  return <div ref={rootRef} className={`waveform-trimmer ${dragging ? 'dragging' : ''}`} onPointerDown={beginDrag} onPointerMove={(event) => { if (dragging) moveHandle(event, dragging); }} onPointerUp={() => setDragging(null)} onPointerCancel={() => setDragging(null)}>
    <canvas ref={canvasRef} aria-label="Drag the waveform handles to choose the audio trim range" />
    <div className="trim-selection" style={{ left: `${startPercent}%`, width: `${endPercent - startPercent}%` }} />
    <div className="trim-handle start" data-edge="start" style={{ left: `${startPercent}%` }} aria-label={`Trim start at ${formatTime(range.start)}`} />
    <div className="trim-handle end" data-edge="end" style={{ left: `${endPercent}%` }} aria-label={`Trim end at ${formatTime(range.end)}`} />
  </div>;
}

async function popupCommand<T>(type: string): Promise<T> {
  const response = await chrome.runtime.sendMessage({ type }) as { ok: boolean; value?: T; error?: string };
  if (!response?.ok) throw new Error(response?.error ?? 'The recorder did not respond.');
  return response.value as T;
}

function App() {
  const [screen, setScreen] = useState<Screen>('record');
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [recording, setRecording] = useState<RecordingState>(emptyRecordingState);
  const [message, setMessage] = useState('Ready to capture audio from the current tab.');
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<AudioBuffer | null>(null);
  const [edited, setEdited] = useState<AudioBuffer | null>(null);
  const [range, setRange] = useState<TimeRange>({ start: 0, end: 0 });
  const [exporting, setExporting] = useState(false);
  const previewUrlRef = useRef<string | null>(null);
  const loadedRevisionRef = useRef(-1);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  async function refreshRecordingState() {
    try { setRecording(await popupCommand<RecordingState>('POPUP_GET_STATE')); }
    catch { /* The first popup load may race the service worker startup. */ }
  }
  useEffect(() => {
    chrome.storage.local.get('settings').then(({ settings: saved }) => { if (saved) setSettings({ ...defaultSettings, ...(saved as Partial<Settings>) }); });
    void refreshRecordingState();
    const interval = window.setInterval(() => { void refreshRecordingState(); }, 750);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => { void chrome.storage.local.set({ settings }); }, [settings]);
  useEffect(() => () => { if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current); }, []);
  useEffect(() => {
    if (!edited) return;
    const url = audioUrl(edited);
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = url; setPreviewUrl(url);
  }, [edited]);
  useEffect(() => {
    if (recording.status !== 'ready' || loadedRevisionRef.current === recording.revision) return;
    loadedRevisionRef.current = recording.revision;
    void (async () => {
      try {
        const blob = await loadRecording();
        if (!blob) throw new Error('The recording was not found in local extension storage.');
        const decoded = await decodeAudio(blob);
        setSource(decoded); setEdited(decoded); setRange({ start: 0, end: decoded.duration });
        setScreen('editor'); setMessage('Recording restored. Drag the waveform handles to set the trim range.');
      } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not restore the recording.'); }
    })();
  }, [recording.status, recording.revision]);

  async function controlRecorder(type: 'POPUP_START' | 'POPUP_PAUSE' | 'POPUP_RESUME' | 'POPUP_FINISH' | 'POPUP_CANCEL') {
    setError(null);
    try {
      if (type === 'POPUP_START') { setSource(null); setEdited(null); loadedRevisionRef.current = -1; }
      const state = await popupCommand<RecordingState>(type);
      setRecording(state); await refreshRecordingState();
      setMessage(type === 'POPUP_START' ? 'Starting active-tab audio capture…' : type === 'POPUP_CANCEL' ? 'Cancelling recording…' : 'Recorder updated.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Recorder action failed.'); }
  }
  function applyTrim() {
    if (!source) return;
    const result = cropBuffer(source, range); setEdited(result); setMessage(`Trimmed to ${formatTime(result.duration)}.`);
  }
  function removeSilence() {
    if (!edited) return;
    const result = removeSilentAudio(edited, settings.silenceDb, settings.minimumSilenceMs);
    setEdited(result); setMessage(`Removed long silent passages. New length: ${formatTime(result.duration)}.`);
  }
  function resetEdits() {
    if (!source) return;
    setEdited(source); setRange({ start: 0, end: source.duration }); setMessage('Edits and trim range reset to the original recording.');
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

  const isCapturing = ['starting', 'recording', 'paused', 'processing'].includes(recording.status);
  const duration = source?.duration ?? 0;
  return <main className="app">
    <header><div><p className="eyebrow">TAB AUDIO STUDIO</p><h1>{screen === 'record' ? 'Record audio' : screen === 'editor' ? 'Audio editor' : 'Settings'}</h1></div><span className={isCapturing ? 'status recording' : 'status'}>{recording.status === 'recording' ? '● REC' : recording.status === 'paused' ? 'Ⅱ PAUSED' : recording.status === 'processing' ? 'SAVING' : 'READY'}</span></header>
    <nav aria-label="Extension screens"><button className={screen === 'record' ? 'active' : ''} onClick={() => setScreen('record')}>Record</button><button className={screen === 'editor' ? 'active' : ''} onClick={() => setScreen('editor')} disabled={!source}>Editor</button><button className={screen === 'settings' ? 'active' : ''} onClick={() => setScreen('settings')}>Settings</button></nav>
    {error && <p className="error" role="alert">{error}</p>}
    {screen === 'record' && <section className="panel recorder-panel">
      {isCapturing ? <>{recording.status === 'processing' ? <div className="capture-card"><p>Finishing your recording</p><strong>…</strong><span>Saving it safely to this extension</span></div> : <><div className="capture-card"><p>Current tab is being captured</p><strong>{formatTime(recording.elapsedMs / 1000)}</strong><span>{recording.status === 'paused' ? 'Recording is paused' : 'Audio only · current tab'}</span></div><button className="pause-button" onClick={() => void controlRecorder(recording.status === 'paused' ? 'POPUP_RESUME' : 'POPUP_PAUSE')}>{recording.status === 'paused' ? '▶  Resume recording' : 'Ⅱ  Pause recording'}</button><div className="capture-actions"><button className="finish-button" onClick={() => void controlRecorder('POPUP_FINISH')}>✓ Finish recording</button><button className="cancel-button" onClick={() => void controlRecorder('POPUP_CANCEL')}>× Cancel</button></div></>}</> : <><div className="record-visual"><span>♫</span></div><h2>Capture current-tab audio</h2><p>Starts immediately after you click—no screen sharing and no tab picker. You can safely close this popup while recording.</p><button className="primary" onClick={() => void controlRecorder('POPUP_START')}>Start recording</button></>}
      <p className="hint">{message}</p>
    </section>}
    {screen === 'editor' && source && edited && <section className="panel editor"><audio controls src={previewUrl ?? undefined} /><div className="time-row"><span>{formatTime(edited.duration)}</span><span>Preview</span></div><fieldset className="trim-editor"><legend>Trim on the waveform</legend><WaveformTrim buffer={source} range={range} onRangeChange={setRange} /><div className="trim-times"><span>Start {formatTime(range.start)}</span><span>End {formatTime(range.end)}</span></div><div className="trim-actions"><button className="text-button" onClick={() => setRange({ start: 0, end: duration })}>Reset range</button><button className="secondary" onClick={applyTrim}>✂ Apply trim</button></div></fieldset><fieldset><legend>Silence cleanup</legend><p>Deletes quiet sections at least {settings.minimumSilenceMs} ms long (below {settings.silenceDb} dB).</p><button className="secondary" onClick={removeSilence}>Delete silent parts</button></fieldset><div className="editor-actions"><button className="text-button" onClick={resetEdits}>Reset edits</button><button className="primary" disabled={exporting} onClick={exportMp3}>{exporting ? 'Encoding MP3…' : `Export MP3 (${settings.bitrate} kbps)`}</button></div><p className="hint">{message}</p></section>}
    {screen === 'settings' && <section className="panel settings"><label>MP3 bitrate<select value={settings.bitrate} onChange={(event) => setSettings((current) => ({ ...current, bitrate: Number(event.target.value) as Settings['bitrate'] }))}><option value="128">128 kbps</option><option value="192">192 kbps</option><option value="256">256 kbps</option><option value="320">320 kbps (best quality)</option></select></label><label>Silence threshold <output>{settings.silenceDb} dB</output><input type="range" min="-60" max="-20" step="1" value={settings.silenceDb} onChange={(event) => setSettings((current) => ({ ...current, silenceDb: Number(event.target.value) }))} /></label><label>Minimum silent duration <output>{settings.minimumSilenceMs} ms</output><input type="range" min="150" max="1500" step="50" value={settings.minimumSilenceMs} onChange={(event) => setSettings((current) => ({ ...current, minimumSilenceMs: Number(event.target.value) }))} /></label><p className="hint">Settings are saved locally in the extension.</p></section>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
