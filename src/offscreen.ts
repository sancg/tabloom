import { emptyRecordingState, type RecordingState } from './messages';
import { deleteRecording, saveRecording } from './recording-store';

let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let outputContext: AudioContext | null = null;
let chunks: Blob[] = [];
let discardOnStop = false;
let elapsedBeforePause = 0;
let startedAt: number | null = null;
let tick: number | null = null;
let state: RecordingState = emptyRecordingState;

function elapsedMs() {
  return elapsedBeforePause + (startedAt ? Date.now() - startedAt : 0);
}

function report(next: Omit<RecordingState, 'revision'>) {
  state = { ...next, revision: state.revision + 1 };
  void chrome.runtime.sendMessage({ type: 'OFFSCREEN_STATE', state });
}

function startTicking() {
  if (tick !== null) window.clearInterval(tick);
  tick = window.setInterval(() => report({ ...state, status: 'recording', elapsedMs: elapsedMs() }), 500);
}

function stopTicking() {
  if (tick !== null) window.clearInterval(tick);
  tick = null;
}

async function cleanUp() {
  stopTicking();
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  recorder = null;
  await outputContext?.close();
  outputContext = null;
  startedAt = null;
}

async function startRecording(streamId: string, tabId: number) {
  if (recorder?.state === 'recording' || recorder?.state === 'paused') throw new Error('A recording is already in progress.');
  try {
    await deleteRecording();
    const constraints = {
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    } as MediaStreamConstraints;
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (stream.getAudioTracks().length === 0) throw new Error('The selected tab did not provide an audio track.');
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 256000 } : undefined);
    chunks = []; discardOnStop = false; elapsedBeforePause = 0; startedAt = Date.now();
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    stream.getAudioTracks()[0]?.addEventListener('ended', () => stopRecording(false), { once: true });
    recorder.onstop = async () => {
      try {
        if (discardOnStop) {
          await deleteRecording();
          report({ status: 'idle', elapsedMs: 0 });
        } else {
          report({ status: 'processing', elapsedMs: elapsedMs(), tabId });
          const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' });
          await saveRecording(blob);
          report({ status: 'ready', elapsedMs: elapsedMs(), tabId });
        }
      } finally { await cleanUp(); }
    };
    outputContext = new AudioContext();
    outputContext.createMediaStreamSource(stream).connect(outputContext.destination);
    await outputContext.resume().catch(() => undefined);
    recorder.start(1000);
    report({ status: 'recording', elapsedMs: 0, tabId });
    startTicking();
  } catch (error) {
    await cleanUp();
    throw error;
  }
}

function pauseRecording() {
  if (recorder?.state !== 'recording') return;
  elapsedBeforePause = elapsedMs(); startedAt = null; recorder.pause(); stopTicking();
  report({ status: 'paused', elapsedMs: elapsedBeforePause, tabId: state.tabId });
}

function resumeRecording() {
  if (recorder?.state !== 'paused') return;
  startedAt = Date.now(); recorder.resume();
  report({ status: 'recording', elapsedMs: elapsedBeforePause, tabId: state.tabId }); startTicking();
}

function stopRecording(discard: boolean) {
  if (!recorder || recorder.state === 'inactive') return;
  discardOnStop = discard; elapsedBeforePause = elapsedMs(); startedAt = null; stopTicking();
  recorder.stop();
}

async function deleteSavedRecording() {
  if (recorder?.state === 'recording' || recorder?.state === 'paused') throw new Error('A recording is still in progress.');
  await deleteRecording();
  report({ status: 'idle', elapsedMs: 0 });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen') return undefined;
  const task = async () => {
    if (message.type === 'OFFSCREEN_START') await startRecording(message.streamId, message.tabId);
    if (message.type === 'OFFSCREEN_PAUSE') pauseRecording();
    if (message.type === 'OFFSCREEN_RESUME') resumeRecording();
    if (message.type === 'OFFSCREEN_FINISH') stopRecording(false);
    if (message.type === 'OFFSCREEN_CANCEL') stopRecording(true);
    if (message.type === 'OFFSCREEN_DELETE_SAVED') await deleteSavedRecording();
    return state;
  };
  void task().then((value) => sendResponse({ ok: true, value })).catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Recording action failed.' }));
  return true;
});
