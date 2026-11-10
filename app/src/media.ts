// Photos (compressed), audio notes, signatures and GPS. Everything is stored locally as Blobs in
// IndexedDB and kept until the server acknowledges each file's SHA-256.
import { apiUrl } from "./config";
import { db, type Attachment } from "./db";
import { decodeImage, drawScaled } from "./ocr_prep";
import { nowIso, sha256Hex, uuid } from "./util";

/** Photos are stored at up to 2048 px (was 1600): enough for OCR of ordinary print and for Hermes' vision model.
 *  Decoding goes through an <img> element so the iPhone's EXIF orientation is applied (no sideways photos). */
export async function compressPhoto(file: Blob, maxSide = 2048, quality = 0.85): Promise<{ blob: Blob; width: number; height: number }> {
  const im = await decodeImage(file);
  const c = drawScaled(im.src, im.width, im.height, Math.min(maxSide, Math.max(im.width, im.height)));
  im.close();
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", quality));
  const out = { blob, width: c.width, height: c.height };
  c.width = c.height = 0;
  return out;
}

/** Copy a Blob read from IndexedDB into a fresh in-memory Blob with the given type. iOS Safari can fail to load
 *  object URLs made directly from IndexedDB-backed Blobs (broken image, audio "error"), and re-storing such a Blob
 *  in a later transaction is not safe there either. Both are avoided by copying the bytes first. */
export async function memoryBlob(b: Blob, type?: string): Promise<{ blob: Blob; bytes: ArrayBuffer }> {
  const bytes = await b.arrayBuffer();
  return { blob: new Blob([bytes], { type: type || b.type || "application/octet-stream" }), bytes };
}

/** Update an attachment's metadata (OCR text, transcript) without re-storing an IndexedDB-backed Blob. */
export async function updateAttachment(id: string, patch: Partial<Omit<Attachment, "id" | "blob" | "sha256">>): Promise<Attachment | undefined> {
  const d = await db();
  const cur = await d.get("attachments", id);
  if (!cur) return undefined;
  const { blob } = await memoryBlob(cur.blob, cur.mime);
  const next = { ...cur, ...patch, meta: { ...cur.meta, ...(patch.meta ?? {}) }, blob };
  await d.put("attachments", next);
  return next;
}

export interface MediaSource { url: string; source: "device" | "hermes"; repaired: boolean }

/**
 * A URL that displays/plays a stored attachment. The bytes on the device are checked against the SHA-256 recorded
 * when the file was captured; if they are unreadable or damaged and Hermes has the file, Hermes' copy is used (and
 * verified against the same hash) and the device copy is repaired. Throws with a plain-language reason otherwise.
 */
export async function attachmentUrl(a: Attachment, fetchImpl: typeof fetch = fetch): Promise<MediaSource> {
  try {
    const { blob, bytes } = await memoryBlob(a.blob, a.mime);
    if (bytes.byteLength > 0 && (await sha256Hex(bytes)) === a.sha256) return { url: URL.createObjectURL(blob), source: "device", repaired: false };
  } catch { /* unreadable on this device: try Hermes */ }
  if (!a.uploaded) throw new Error("This file is damaged on this device and hasn't reached Hermes, so it can't be shown.");
  let res: Response;
  try { res = await fetchImpl(apiUrl(`attachments/${encodeURIComponent(a.id)}`), { credentials: "same-origin" }); }
  catch { throw new Error("This file can't be read on this device. Connect to the internet to load Hermes' copy."); }
  if (!res.ok) throw new Error(res.status === 401 ? "Sign in to Hermes to load this file." : `Hermes couldn't provide this file (HTTP ${res.status}).`);
  const bytes = await res.arrayBuffer();
  if ((await sha256Hex(bytes)) !== a.sha256) throw new Error("Hermes' copy doesn't match the file captured on this device.");
  const blob = new Blob([bytes], { type: a.mime });
  let repaired = false;
  try { await (await db()).put("attachments", { ...a, blob }); repaired = true; } catch { /* still show it */ }
  return { url: URL.createObjectURL(blob), source: "hermes", repaired };
}

/** Load a file from Hermes for a record that isn't on this device (needs internet); verified when a hash is known. */
export async function hermesMediaUrl(id: string, mime: string, sha256?: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(apiUrl(`attachments/${encodeURIComponent(id)}`), { credentials: "same-origin" });
  if (!res.ok) throw new Error(res.status === 401 ? "Sign in to Hermes to load this file." : `Hermes couldn't provide this file (HTTP ${res.status}).`);
  const bytes = await res.arrayBuffer();
  if (sha256 && (await sha256Hex(bytes)) !== sha256) throw new Error("The file from Hermes failed its integrity check.");
  return URL.createObjectURL(new Blob([bytes], { type: mime || res.headers.get("content-type") || "application/octet-stream" }));
}

export async function saveAttachment(recordId: string, fieldId: string, kind: Attachment["kind"], blob: Blob,
                                     meta: Attachment["meta"] = {}): Promise<Attachment> {
  const att: Attachment = {
    id: uuid("att"), record_id: recordId, field_id: fieldId, kind, mime: blob.type || "application/octet-stream", size: blob.size,
    sha256: await sha256Hex(blob), blob, created_at: nowIso(), uploaded: false, meta,
  };
  await (await db()).put("attachments", att);
  return att;
}

export async function getAttachment(id: string): Promise<Attachment | undefined> {
  return (await db()).get("attachments", id);
}

export interface GpsFix { lat: number; lon: number; accuracy: number; altitude?: number | null; timestamp: string; source: "device" | "manual" }

export function captureGps(timeoutMs = 20000): Promise<GpsFix> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("Location is not available on this device."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: +p.coords.latitude.toFixed(6), lon: +p.coords.longitude.toFixed(6), accuracy: Math.round(p.coords.accuracy),
        altitude: p.coords.altitude, timestamp: new Date(p.timestamp).toISOString(), source: "device" }),
      (e) => reject(new Error(e.code === 1 ? "Location permission was denied. You can enter coordinates manually."
        : e.code === 3 ? "Location timed out. Move outdoors and try again, or enter coordinates manually."
          : "Location unavailable. You can enter coordinates manually.")),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

/**
 * Recording format: one this browser can both record AND play back. Safari (iPhone) records audio/mp4 (AAC) by
 * default; recent versions also report WebM as recordable, but WebM playback in an <audio> element is not
 * dependable there, which showed up as an audio playback error on the Results screen. MP4/AAC plays on every
 * target and decodes for on-device transcription, so Apple devices use it; elsewhere WebM/Opus is kept.
 */
export function pickRecorderMime(env: { isTypeSupported?: (m: string) => boolean; canPlay?: (m: string) => string; apple?: boolean } = {}): string {
  const isTypeSupported = env.isTypeSupported ?? ((m: string) => typeof MediaRecorder !== "undefined" && !!MediaRecorder.isTypeSupported?.(m));
  const canPlay = env.canPlay ?? ((m: string) => (typeof document !== "undefined" ? document.createElement("audio").canPlayType(m) : "maybe"));
  const apple = env.apple ?? (typeof navigator !== "undefined" && /Apple/.test(navigator.vendor ?? ""));
  const options = apple ? ["audio/mp4", "audio/mp4;codecs=mp4a.40.2", "audio/webm;codecs=opus", "audio/webm"]
    : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return options.find((m) => isTypeSupported(m) && canPlay(m.split(";")[0]) !== "") ?? "";
}

export class VoiceRecorder {
  private rec?: MediaRecorder;
  private chunks: Blob[] = [];
  private started = 0;
  private stream?: MediaStream;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickRecorderMime();
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    // No timeslice: one complete file at stop. Sliced MP4 from Safari is fragmented and some players reject it;
    // the chunks only ever lived in memory, so slicing protected nothing.
    this.rec.start();
    this.started = performance.now();
  }

  stop(): Promise<{ blob: Blob; duration_s: number }> {
    return new Promise((resolve) => {
      if (!this.rec) return resolve({ blob: new Blob(), duration_s: 0 });
      this.rec.onstop = () => {
        this.stream?.getTracks().forEach((t) => t.stop());
        const type = (this.rec!.mimeType || pickRecorderMime() || "audio/mp4").split(";")[0];
        resolve({ blob: new Blob(this.chunks, { type }), duration_s: Math.round((performance.now() - this.started) / 100) / 10 });
      };
      this.rec.stop();
    });
  }
}

/** Minimal signature pad on a canvas (pointer events; works with touch and stylus). */
export function signaturePad(canvas: HTMLCanvasElement): { clear(): void; isEmpty(): boolean; toBlob(): Promise<Blob> } {
  const g = canvas.getContext("2d")!;
  let drawing = false, dirty = false;
  const pos = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)];
  };
  const reset = () => { g.fillStyle = "#fff"; g.fillRect(0, 0, canvas.width, canvas.height); g.lineWidth = 2.5; g.lineCap = "round"; g.strokeStyle = "#111"; dirty = false; };
  reset();
  canvas.addEventListener("pointerdown", (e) => { drawing = true; canvas.setPointerCapture(e.pointerId); const [x, y] = pos(e); g.beginPath(); g.moveTo(x, y); });
  canvas.addEventListener("pointermove", (e) => { if (!drawing) return; const [x, y] = pos(e); g.lineTo(x, y); g.stroke(); dirty = true; });
  canvas.addEventListener("pointerup", () => { drawing = false; });
  return {
    clear: reset,
    isEmpty: () => !dirty,
    toBlob: () => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/png")),
  };
}
