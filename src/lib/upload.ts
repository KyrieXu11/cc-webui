export type UploadedFile = {
  name: string;
  path: string;
  size: number;
  mime: string;
  /** Base64 payload (no data-URL prefix) — only populated for images. */
  imageData?: string;
};

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

export async function uploadFiles(files: File[]): Promise<UploadedFile[]> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const res = await fetch("/api/upload", { method: "POST", body: fd });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  const { files: saved } = (await res.json()) as { files: UploadedFile[] };

  // For image files, compute base64 client-side so we can ship them inline
  // as Anthropic image content blocks on the next /api/chat call.
  for (let i = 0; i < saved.length; i++) {
    if (saved[i].mime?.startsWith("image/") && files[i]) {
      try {
        saved[i].imageData = await fileToBase64(files[i]);
      } catch {
        // ignore — fall back to path-only behavior
      }
    }
  }
  return saved;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
