import * as lame from '@breezystack/lamejs';

export interface TimeRange {
  start: number;
  end: number;
}

export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00';
  const rounded = Math.max(0, Math.floor(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}

export async function decodeAudio(blob: Blob): Promise<AudioBuffer> {
  const context = new AudioContext();
  try {
    return await context.decodeAudioData(await blob.arrayBuffer());
  } finally {
    await context.close();
  }
}

export function cropBuffer(source: AudioBuffer, range: TimeRange): AudioBuffer {
  const sampleRate = source.sampleRate;
  const start = Math.floor(Math.max(0, range.start) * sampleRate);
  const end = Math.min(source.length, Math.ceil(Math.max(range.start, range.end) * sampleRate));
  const result = new AudioBuffer({ numberOfChannels: source.numberOfChannels, length: Math.max(1, end - start), sampleRate });
  for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
    result.copyToChannel(source.getChannelData(channel).slice(start, end), channel);
  }
  return result;
}

export function removeSilentAudio(source: AudioBuffer, thresholdDb: number, minSilenceMs: number): AudioBuffer {
  const frameSize = Math.max(1, Math.floor(source.sampleRate * 0.02));
  const threshold = 10 ** (thresholdDb / 20);
  const minFrames = Math.ceil(minSilenceMs / 20);
  const mono = source.getChannelData(0);
  const silent = new Array<boolean>(Math.ceil(mono.length / frameSize));
  for (let frame = 0; frame < silent.length; frame += 1) {
    const start = frame * frameSize;
    const end = Math.min(mono.length, start + frameSize);
    let energy = 0;
    for (let i = start; i < end; i += 1) energy += mono[i] * mono[i];
    silent[frame] = Math.sqrt(energy / Math.max(1, end - start)) < threshold;
  }

  const keep: TimeRange[] = [];
  let runStart = 0;
  while (runStart < silent.length) {
    if (!silent[runStart]) { runStart += 1; continue; }
    let runEnd = runStart;
    while (runEnd < silent.length && silent[runEnd]) runEnd += 1;
    if (runEnd - runStart < minFrames) keep.push({ start: runStart * frameSize, end: runEnd * frameSize });
    runStart = runEnd;
  }
  if (keep.length === 0 && silent.every(Boolean)) return source;

  const silentToRemove = new Set<number>();
  let quietStart = 0;
  while (quietStart < silent.length) {
    if (!silent[quietStart]) { quietStart += 1; continue; }
    let quietEnd = quietStart;
    while (quietEnd < silent.length && silent[quietEnd]) quietEnd += 1;
    if (quietEnd - quietStart >= minFrames) {
      for (let frame = quietStart; frame < quietEnd; frame += 1) silentToRemove.add(frame);
    }
    quietStart = quietEnd;
  }
  const keptSamples: number[] = [];
  for (let frame = 0; frame < silent.length; frame += 1) {
    if (!silentToRemove.has(frame)) {
      const start = frame * frameSize;
      for (let i = start; i < Math.min(mono.length, start + frameSize); i += 1) keptSamples.push(i);
    }
  }
  const output = new AudioBuffer({ numberOfChannels: source.numberOfChannels, length: Math.max(1, keptSamples.length), sampleRate: source.sampleRate });
  for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
    const input = source.getChannelData(channel);
    const data = new Float32Array(Math.max(1, keptSamples.length));
    keptSamples.forEach((index, i) => { data[i] = input[index]; });
    output.copyToChannel(data, channel);
  }
  return output;
}

function toInt16(input: Float32Array, start: number, length: number) {
  const output = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[start + i] ?? 0));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

export function encodeMp3(buffer: AudioBuffer, bitrate = 320): Blob {
  const channels = buffer.numberOfChannels > 1 ? 2 : 1;
  const encoder = new lame.Mp3Encoder(channels, buffer.sampleRate, bitrate);
  const left = buffer.getChannelData(0);
  const right = channels === 2 ? buffer.getChannelData(1) : undefined;
  const chunks: Uint8Array[] = [];
  const blockSize = 1152;
  for (let start = 0; start < buffer.length; start += blockSize) {
    const size = Math.min(blockSize, buffer.length - start);
    const bytes = encoder.encodeBuffer(toInt16(left, start, size), right ? toInt16(right, start, size) : undefined);
    if (bytes.length) chunks.push(new Uint8Array(bytes));
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(new Uint8Array(tail));
  // Copy each typed array: TypeScript permits SharedArrayBuffer-backed views,
  // while Blob parts must be regular transferable ArrayBuffers.
  return new Blob(chunks.map((chunk) => Uint8Array.from(chunk).buffer), { type: 'audio/mpeg' });
}

export function audioUrl(buffer: AudioBuffer): string {
  const channels = buffer.numberOfChannels;
  const frameCount = buffer.length;
  const wav = new ArrayBuffer(44 + frameCount * channels * 2);
  const view = new DataView(wav);
  const write = (offset: number, value: string) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, 36 + frameCount * channels * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, frameCount * channels * 2, true);
  const data = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i));
  let offset = 44;
  for (let i = 0; i < frameCount; i += 1) for (let c = 0; c < channels; c += 1) { view.setInt16(offset, Math.max(-1, Math.min(1, data[c][i])) * 0x7fff, true); offset += 2; }
  return URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
}
