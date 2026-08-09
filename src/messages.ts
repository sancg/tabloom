export type CaptureStatus = 'idle' | 'starting' | 'recording' | 'paused' | 'processing' | 'ready';

export interface RecordingState {
  status: CaptureStatus;
  elapsedMs: number;
  tabId?: number;
  revision: number;
}

export const emptyRecordingState: RecordingState = { status: 'idle', elapsedMs: 0, revision: 0 };
