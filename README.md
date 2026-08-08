# Tab Audio Studio

A React + TypeScript Manifest V3 extension that records the active Chrome/Chromium tab's audio, lets users trim and remove quiet sections, and downloads an MP3.

## Run it

1. Install dependencies with `npm install`.
2. Run `npm run build`; the loadable extension is created in `dist/`.
3. In Chrome, open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose `dist/`.
4. Pin the extension, open it on an audible tab, and choose **Start recording**. There is no sharing picker: audio only is captured from the tab that was active when the action was invoked.

## Design notes

- No runtime WebExtension polyfill is used. The project uses Chrome's native `chrome.*` global and `@types/chrome`. Safari and Firefox provide a native `browser.*` global, but Chrome does not; therefore there is no native `browser` replacement that works unchanged in all three browsers.
- Direct capture is intentionally implemented with `chrome.tabCapture.capture({ audio: true, video: false })`. Chrome requires the `tabCapture` permission and a user invocation, but does not show a source picker. The extension reconnects the capture stream to the audio destination so playback continues during recording.
- Safari WebExtensions do not expose this Chrome-specific `tabCapture` feature, so the exact no-picker, automatically-selected-tab requirement cannot be fulfilled in Safari with WebExtension APIs alone. The UI reports this limitation instead of falling back to screen sharing. A Safari version would require an approved native macOS companion using Apple capture APIs, which is a separate product architecture.
- The source recording is decoded with Web Audio, so trimming and silence deletion operate on PCM audio. Export uses LAME at a configurable bitrate up to 320 kbps, the MP3 maximum.
- Recordings stay in memory and are not uploaded or persisted. Keep the popup open while recording; closing it ends the extension page and may end the session.

## Verification checklist

1. Start a recording on an audible tab and confirm the toolbar badge says `REC`.
2. Pause and resume; the timer should exclude the paused interval.
3. Finish, verify the preview plays, and trim the range.
4. Use **Delete silent parts** on a recording with a known pause, then export and inspect the MP3 bitrate.
