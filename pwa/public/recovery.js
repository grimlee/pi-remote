// Persist identifiers only. Credentials and conversation text never enter browser storage.
export class RecoveryMemory {
  constructor(storage) { this.storage = storage; }
  read(key) {
    try { return JSON.parse(this.storage.getItem(key)); } catch { return null; }
  }
  write(key, value) {
    try {
      if (value === null) this.storage.removeItem(key);
      else this.storage.setItem(key, JSON.stringify(value));
    } catch { /* Safari private/storage-disabled mode still works without persistence. */ }
  }
  selected(id) {
    if (id !== undefined) this.write("pi-remote-selected", id);
    return this.read("pi-remote-selected");
  }
  pending(sessionId, value) {
    const key = "pi-remote-pending:" + sessionId;
    if (value !== undefined) this.write(key, value);
    return this.read(key);
  }
}
export async function messageFingerprint(message) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
