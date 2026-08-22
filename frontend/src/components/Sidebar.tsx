"use client";

import type { Conversation } from "@/lib/types";
import UploadPanel from "./UploadPanel";

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
  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-30 md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={`fixed md:static inset-y-0 left-0 z-40 w-72 shrink-0 flex flex-col gap-4 border-r border-white/10 bg-[#0a0a0b] md:bg-transparent p-4 transition-transform duration-200 overflow-y-auto ${
          isOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <button
          type="button"
          onClick={onNew}
          className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 py-2.5 text-sm font-medium text-white transition-colors"
        >
          <span aria-hidden="true">+</span> New chat
        </button>

        <nav
          className="flex-1 overflow-y-auto scrollbar-hide flex flex-col gap-1 min-h-[80px]"
          aria-label="Conversations"
        >
          {conversations.length === 0 && (
            <p className="text-[11px] text-gray-500 px-2">No conversations yet.</p>
          )}
          {conversations.map((conversation) => (
            <div
              key={conversation.id}
              className={`group flex items-center gap-1 rounded-lg px-2.5 py-2 cursor-pointer text-sm transition-colors ${
                conversation.id === activeId
                  ? "bg-cyan-500/15 text-cyan-200"
                  : "text-gray-400 hover:bg-white/5 hover:text-gray-200"
              }`}
              onClick={() => onSelect(conversation.id)}
            >
              <span className="flex-1 truncate">{conversation.title}</span>
              <button
                type="button"
                aria-label={`Delete conversation ${conversation.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(conversation.id);
                }}
                className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 transition-opacity px-1"
              >
                ×
              </button>
            </div>
          ))}
        </nav>

        <div className="border-t border-white/10 pt-4">
          <h2 className="text-[11px] uppercase tracking-widest text-gray-500 mb-2">
            Documents
          </h2>
          <UploadPanel onUploaded={onDocumentsChanged} />
        </div>
      </aside>
    </>
  );
}
