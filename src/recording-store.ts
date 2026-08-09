const DB_NAME = 'tab-audio-studio';
const STORE_NAME = 'recordings';
const LATEST_RECORDING = 'latest';

interface StoredRecording {
  id: string;
  blob: Blob;
  createdAt: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the recording store.'));
  });
}

export async function saveRecording(blob: Blob) {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put({ id: LATEST_RECORDING, blob, createdAt: Date.now() } satisfies StoredRecording);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not save the recording.'));
  });
  database.close();
}

export async function loadRecording(): Promise<Blob | null> {
  const database = await openDatabase();
  const stored = await new Promise<StoredRecording | undefined>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(LATEST_RECORDING);
    request.onsuccess = () => resolve(request.result as StoredRecording | undefined);
    request.onerror = () => reject(request.error ?? new Error('Could not read the recording.'));
  });
  database.close();
  return stored?.blob ?? null;
}

export async function deleteRecording() {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(LATEST_RECORDING);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not delete the recording.'));
  });
  database.close();
}
