"use client";

import { useAuth } from "@/context/AuthProvider";
import type { Conversation } from "@/lib/types";
import UploadPanel from "./UploadPanel";
import Logo from "./Logo";

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onDocumentsChanged: () => void;
  isOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onDocumentsChanged,
  isOpen,
  onClose,
}: Props) {
  const { user, signOut } = useAuth();

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-border bg-bg-elevated transition-transform duration-200 md:static md:bg-transparent ${
          isOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <Logo size={32} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold leading-none tracking-tight">AXIOM AI</p>
            <p className="mt-0.5 text-[9px] font-medium uppercase tracking-[0.18em] text-fg-subtle">
              Scientific RAG
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring rounded-lg p-1 text-fg-subtle transition-colors hover:text-fg md:hidden"
            aria-label="Close menu"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <button
            type="button"
            onClick={onNew}
            className="gradient-brand focus-ring flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold text-white shadow-md transition-opacity hover:opacity-95"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m-7-7h14" />
            </svg>
            New chat
          </button>

          <nav className="scrollbar-thin flex min-h-20 flex-1 flex-col gap-0.5 overflow-y-auto" aria-label="Conversations">
            <h2 className="mb-1 px-1 text-[10px] font-medium uppercase tracking-widest text-fg-subtle">
              Conversations
            </h2>
            {conversations.length === 0 && (
              <p className="px-1 text-[11px] text-fg-subtle">No conversations yet.</p>
            )}
            {conversations.map((conversation) => {
              const isActive = conversation.id === activeId;
              return (
                <div
                  key={conversation.id}
                  className={`group flex items-center gap-1 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                    isActive
                      ? "bg-violet/15 text-violet"
                      : "text-fg-muted hover:bg-surface hover:text-fg"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(conversation.id)}
                    aria-current={isActive ? "page" : undefined}
                    className="focus-ring min-w-0 flex-1 truncate rounded text-left"
                  >
                    {conversation.title}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete conversation ${conversation.title}`}
                    onClick={() => onDelete(conversation.id)}
                    className="focus-ring shrink-0 rounded p-0.5 text-fg-subtle opacity-0 transition-all hover:text-rose focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </nav>

          <div className="border-t border-border pt-4">
            <h2 className="mb-2 px-1 text-[10px] font-medium uppercase tracking-widest text-fg-subtle">
              Your documents
            </h2>
            <UploadPanel onUploaded={onDocumentsChanged} />
          </div>
        </div>

        {/* ---- Account footer ---- */}
        <div className="flex items-center gap-2.5 border-t border-border px-4 py-3">
          <span
            className="gradient-brand flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
            aria-hidden="true"
          >
            {initialsOf(user?.name)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-medium text-fg">{user?.name ?? "Signed in"}</p>
            <p className="truncate text-[10px] text-fg-subtle">{user?.email}</p>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            className="focus-ring rounded-lg p-1.5 text-fg-subtle transition-colors hover:text-rose"
            aria-label="Sign out"
            title="Sign out"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
              />
            </svg>
          </button>
        </div>
      </aside>
    </>
  );
}

export function initialsOf(name: string | undefined): string {
  if (!name) return "";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
