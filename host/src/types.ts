export type SessionAccess = "view" | "control";

export interface RemoteSession {
  instanceId: string;
  generation: number;
  sessionId: string;
  name: string | null;
  cwd: string;
  model: string | null;
  startedAt: string;
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
