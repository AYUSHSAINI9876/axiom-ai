export type Role = "user" | "assistant";

export interface Citation {
  text: string;
  score: number | null;
  file: string | null;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  citations?: Citation[];
  createdAt: number;
  isError?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export interface DocumentInfo {
  name: string;
  size_bytes: number;
  modified: string;
}
