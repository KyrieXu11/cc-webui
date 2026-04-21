export type UploadedFile = {
  name: string;
  path: string;
  size: number;
};

export async function uploadFiles(files: File[]): Promise<UploadedFile[]> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const res = await fetch("/api/upload", { method: "POST", body: fd });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  const { files: saved } = await res.json();
  return saved ?? [];
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
