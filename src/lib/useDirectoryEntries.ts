import { useEffect, useRef, useState } from "react";
import { DirectoryReadError, listTree } from "./fs";
import { beginDirectoryRefresh, createDirectoryLoader, directoryNeedsRead, failDirectoryRefresh, type DirectorySnapshot } from "./directory-refresh";

const loadDirectory = createDirectoryLoader((path, signal) => listTree(path, { signal }));

export function useDirectoryEntries(path: string, revision: number, enabled = true) {
  const [snapshot, setSnapshot] = useState<DirectorySnapshot>({ path, revision: -1, entries: null, error: null });
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !directoryNeedsRead(latest.current, path, revision)) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    setSnapshot(previous => beginDirectoryRefresh(previous, path));
    loadDirectory(path, controller.signal)
      .then(entries => {
        if (!controller.signal.aborted) setSnapshot({ path, revision, entries, error: null });
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        setSnapshot(previous => failDirectoryRefresh(previous, path, error instanceof Error ? error.message : "读取失败", error instanceof DirectoryReadError ? error.status : undefined));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, revision, enabled]);

  return { entries: snapshot.path === path ? snapshot.entries : null, error: snapshot.path === path ? snapshot.error : null, loading };
}
