"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDocuments, uploadDocument } from "@/lib/api";
import type { DocumentInfo } from "@/lib/types";

interface Props {
  onUploaded?: () => void;
}

export default function UploadPanel({ onUploaded }: Props) {
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const docs = await fetchDocuments();
      setDocuments(docs);
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
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsUploading(false);
      if (inputRef.current) inputRef.current.value = "";
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
        className={`cursor-pointer rounded-xl border border-dashed p-4 text-center text-xs transition-colors ${
          isDragging
            ? "border-cyan-400 bg-cyan-500/10"
            : "border-white/15 hover:border-white/30"
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
        <span className="text-gray-400">
          {isUploading
            ? "Uploading…"
            : "Drop a document or click to upload (PDF, Markdown, text)"}
        </span>
      </div>

      {error && <p className="text-[11px] text-red-400">{error}</p>}

      <ul className="flex flex-col gap-1 max-h-40 overflow-y-auto scrollbar-hide">
        {documents.length === 0 && (
          <li className="text-[11px] text-gray-500">No documents indexed yet.</li>
        )}
        {documents.map((doc) => (
          <li
            key={doc.name}
            className="flex items-center justify-between text-[11px] text-gray-400 bg-white/5 rounded-lg px-2.5 py-1.5"
          >
            <span className="truncate">{doc.name}</span>
            <span className="text-gray-600 shrink-0 ml-2">
              {formatBytes(doc.size_bytes)}
            </span>
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
