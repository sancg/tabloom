import { emptyRecordingState, type RecordingState } from './messages';

const OFFSCREEN_PATH = 'offscreen.html';
const STATE_KEY = 'recordingState';
let creatingOffscreen: Promise<void> | null = null;

async function currentState(): Promise<RecordingState> {
  const { [STATE_KEY]: stored } = await chrome.storage.session.get(STATE_KEY);
  return (stored as RecordingState | undefined) ?? emptyRecordingState;
}

async function setBadge(state: RecordingState) {
  const details = state.tabId === undefined ? {} : { tabId: state.tabId };
  const text = state.status === 'recording' ? 'REC' : state.status === 'paused' ? 'Ⅱ' : state.status === 'processing' ? '…' : '';
  const title = state.status === 'recording' ? 'Tab Audio Studio — Recording' : state.status === 'paused' ? 'Tab Audio Studio — Paused' : 'Tab Audio Studio';
  await chrome.action.setBadgeBackgroundColor({ ...details, color: '#d92d20' });
  await chrome.action.setBadgeText({ ...details, text });
  await chrome.action.setTitle({ ...details, title });
}

async function storeState(state: RecordingState) {
  await chrome.storage.session.set({ [STATE_KEY]: state });
  await setBadge(state);
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] });
  if (contexts.length > 0) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Record and preserve audio from the user-selected active tab.'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function sendToOffscreen(message: Record<string, unknown>) {
  const response = await chrome.runtime.sendMessage({ ...message, target: 'offscreen' }) as { ok: boolean; error?: string };
  if (!response?.ok) throw new Error(response?.error ?? 'Recorder is unavailable.');
}

async function startRecording() {
  const previous = await currentState();
  if (['starting', 'recording', 'paused', 'processing'].includes(previous.status)) throw new Error('A recording is already in progress.');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error('No active tab is available to capture.');
  await storeState({ status: 'starting', elapsedMs: 0, tabId: tab.id, revision: previous.revision + 1 });
  try {
    await ensureOffscreenDocument();
    const streamId = await new Promise<string>((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
        const error = chrome.runtime.lastError?.message;
        if (error || !id) reject(new Error(error ?? 'Chrome did not return a tab audio stream.'));
        else resolve(id);
      });
    });
    await sendToOffscreen({ type: 'OFFSCREEN_START', streamId, tabId: tab.id });
  } catch (error) {
    await storeState({ status: 'idle', elapsedMs: 0, revision: previous.revision + 2 });
    throw error;
  }
}

async function commandRecorder(type: 'OFFSCREEN_PAUSE' | 'OFFSCREEN_RESUME' | 'OFFSCREEN_FINISH' | 'OFFSCREEN_CANCEL') {
  await ensureOffscreenDocument();
  await sendToOffscreen({ type });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'OFFSCREEN_STATE') {
    void storeState(message.state as RecordingState).finally(() => sendResponse({ ok: true }));
    return true;
  }
  const task = async () => {
    if (message.type === 'POPUP_GET_STATE') return currentState();
    if (message.type === 'POPUP_START') { await startRecording(); return currentState(); }
    if (message.type === 'POPUP_PAUSE') { await commandRecorder('OFFSCREEN_PAUSE'); return currentState(); }
    if (message.type === 'POPUP_RESUME') { await commandRecorder('OFFSCREEN_RESUME'); return currentState(); }
    if (message.type === 'POPUP_FINISH') { await commandRecorder('OFFSCREEN_FINISH'); return currentState(); }
    if (message.type === 'POPUP_CANCEL') { await commandRecorder('OFFSCREEN_CANCEL'); return currentState(); }
    return undefined;
  };
  if (!String(message.type ?? '').startsWith('POPUP_')) return undefined;
  void task().then((value) => sendResponse({ ok: true, value })).catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Recorder action failed.' }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => { void storeState(emptyRecordingState); });
