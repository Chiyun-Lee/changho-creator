// The room scan is too big for localStorage, so it lives in IndexedDB.

const DB = 'changho'
const STORE = 'files'
const KEY = 'scan'

export interface StoredScan {
  blob: Blob
  name: string
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveScan(scan: StoredScan): Promise<void> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(scan, KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function loadScan(): Promise<StoredScan | null> {
  try {
    const db = await open()
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(KEY)
      req.onsuccess = () => {
        const v = req.result as StoredScan | Blob | undefined
        if (!v) resolve(null)
        else if (v instanceof Blob) resolve({ blob: v, name: 'scan.glb' }) // older format
        else resolve(v)
      }
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null
  }
}
