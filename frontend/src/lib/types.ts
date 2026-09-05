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

export interface User {
  id: string;
  email: string;
  name: string;
  created_at: string;
}

/** The gateway's wire format for a new session. */
export interface Session {
  user: User;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/** The client-side shape: camelCase, with the expiry resolved to a timestamp. */
export interface StoredSession {
  user: User;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export type Theme = "light" | "dark" | "system";
