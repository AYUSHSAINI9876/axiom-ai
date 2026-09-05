"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { deleteDocument, fetchDocuments, uploadDocument } from "@/lib/api";
import { useToast } from "@/context/ToastProvider";
import type { DocumentInfo } from "@/lib/types";

interface Props {
  onUploaded?: () => void;
}

export default function UploadPanel({ onUploaded }: Props) {
  const { notify } = useToast();
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setDocuments(await fetchDocuments());
    } catch {
      // Document list is best-effort; keep whatever was last shown on failure.
    }
  }, []);

  useEffect(() => {
    // Fetching the document list on mount; there's no synchronous data to
    // derive this from (it lives on the ML service), so an effect is the
    // right tool here per React's own data-fetching guidance.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see comment above
    refresh();
  }, [refresh]);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setIsUploading(true);
    try {
      for (const file of Array.from(files)) {
        await uploadDocument(file);
      }
      await refresh();
      onUploaded?.();
      notify(
        files.length === 1 ? `Indexed ${files[0].name}` : `Indexed ${files.length} documents`,
        "success"
      );
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      notify(message, "error");
    } finally {
      setIsUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleDelete = async (name: string) => {
    setPendingDelete(name);
    try {
      await deleteDocument(name);
      await refresh();
      onUploaded?.();
      notify(`Removed ${name}`, "success");
    } catch (err) {
      notify((err as Error).message, "error");
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        className={`focus-ring cursor-pointer rounded-xl border border-dashed px-3 py-4 text-center transition-colors ${
          isDragging
            ? "border-amber bg-amber/10"
            : "border-border-strong hover:border-amber/60 hover:bg-amber/5"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.md,.txt"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        <svg
          className={`mx-auto mb-1.5 h-5 w-5 ${isDragging ? "text-amber" : "text-fg-subtle"}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M7 16a4 4 0 01-.88-7.9A5 5 0 1115.9 6H16a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
          />
        </svg>
        <p className="text-[12px] font-medium text-fg-muted">
          {isUploading ? "Indexing…" : "Drop files or click to upload"}
        </p>
        <p className="mt-0.5 text-[10px] text-fg-subtle">PDF · Markdown · text</p>
      </div>

      {error && <p className="text-[11px] text-rose">{error}</p>}

      <ul className="scrollbar-thin flex max-h-48 flex-col gap-1 overflow-y-auto">
        {documents.length === 0 && (
          <li className="px-1 text-[11px] text-fg-subtle">No documents indexed yet.</li>
        )}
        {documents.map((doc) => (
          <li
            key={doc.name}
            className="group/doc flex items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 transition-colors hover:border-border hover:bg-surface"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber/15 text-amber">
              <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-fg-muted" title={doc.name}>
              {doc.name}
            </span>
            <span className="shrink-0 text-[10px] text-fg-subtle">{formatBytes(doc.size_bytes)}</span>
            <button
              type="button"
              onClick={() => handleDelete(doc.name)}
              disabled={pendingDelete === doc.name}
              aria-label={`Remove ${doc.name}`}
              className="focus-ring shrink-0 rounded p-0.5 text-fg-subtle opacity-0 transition-all hover:text-rose focus-visible:opacity-100 group-hover/doc:opacity-100 disabled:opacity-50"
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
