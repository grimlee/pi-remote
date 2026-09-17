export type SessionAccess = "view" | "control";

export interface RemoteSession {
  instanceId: string;
  generation: number;
  sessionId: string | null;
  name: string | null;
  cwd: string | null;
  model: string | null;
  startedAt: string | null;
  participantCount: number;
  relayConnected: boolean;
  inputRequired: boolean;
  access: SessionAccess;
}

export interface SessionLink {
  instanceId: string;
  generation: number;
  access: SessionAccess;
  collabUrl: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }>;
}
