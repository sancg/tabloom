type RecorderMessage =
  | { type: 'RECORDING_STARTED'; tabId?: number }
  | { type: 'RECORDING_STOPPED'; tabId?: number };

async function setRecordingBadge(tabId: number | undefined, active: boolean) {
  const details = tabId === undefined ? {} : { tabId };
  await chrome.action.setBadgeBackgroundColor({ ...details, color: '#d92d20' });
  await chrome.action.setBadgeText({ ...details, text: active ? 'REC' : '' });
  await chrome.action.setTitle({ ...details, title: active ? 'Tab Audio Studio — Recording' : 'Tab Audio Studio' });
}

chrome.runtime.onMessage.addListener((message: RecorderMessage) => {
  if (message.type === 'RECORDING_STARTED') void setRecordingBadge(message.tabId, true);
  if (message.type === 'RECORDING_STOPPED') void setRecordingBadge(message.tabId, false);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: '' });
});
