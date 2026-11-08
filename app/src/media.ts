// Photos (compressed), audio notes, signatures and GPS. Everything is stored locally as Blobs in
// IndexedDB and kept until the server acknowledges each file's SHA-256.
import { db, type Attachment } from "./db";
import { nowIso, sha256Hex, uuid } from "./util";

export async function compressPhoto(file: Blob, maxSide = 1600, quality = 0.8): Promise<{ blob: Blob; width: number; height: number }> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), hgt = Math.round(bmp.height * scale);
  const c = document.createElement("canvas");
  c.width = w; c.height = hgt;
  c.getContext("2d")!.drawImage(bmp, 0, 0, w, hgt);
  bmp.close?.();
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", quality));
  return { blob, width: w, height: hgt };
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

export async function deleteLocalAttachment(id: string): Promise<void> {
  const d = await db();
  const a = await d.get("attachments", id);
  if (a && !a.uploaded) await d.delete("attachments", id);  // only drafts' unsent media can be removed by the user
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

export function pickRecorderMime(): string {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return options.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m)) ?? "";
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
    this.rec.start(1000);
    this.started = performance.now();
  }

  stop(): Promise<{ blob: Blob; duration_s: number }> {
    return new Promise((resolve) => {
      if (!this.rec) return resolve({ blob: new Blob(), duration_s: 0 });
      this.rec.onstop = () => {
        this.stream?.getTracks().forEach((t) => t.stop());
        const type = (this.rec!.mimeType || "audio/webm").split(";")[0];
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
