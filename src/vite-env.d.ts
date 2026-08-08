/// <reference types="vite/client" />

declare module 'lamejs' {
  interface Mp3Encoder {
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    flush(): Int8Array;
  }
  const lamejs: {
    Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => Mp3Encoder;
  };
  export default lamejs;
}
