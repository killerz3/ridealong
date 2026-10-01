// The viewer protocol: JSON messages both ways over one websocket, plus binary
// frames from the server. Shared by the server and the web UI.

export type WorkspaceState = 'asleep' | 'waking' | 'awake' | 'sleeping';
export type StreamMode = 'jpeg' | 'video';

export interface AgentInfo {
  name: string;
  connections: number;
  lastActive: number; // epoch ms of its last command
  tabs: number;
}

export interface WorkspaceInfo {
  name: string;
  state: WorkspaceState;
  error: string | null;
  idleMinutes: number;
  customIdle: boolean;
  agents: AgentInfo[];   // connected agents
  blocked: string[];     // agent names refused at connect
  viewers: number;
  sleepsIn: number | null; // seconds, when idle-sleep is pending
  memoryMB: number | null; // proportional memory of its Chrome + display
  tabs: number;
}

export interface TabInfo {
  id: string;
  title: string;
  url: string;
  owner: string | null; // agent name, or null for your own tabs
}

export type ActivityKind = 'connect' | 'disconnect' | 'open' | 'navigate' | 'close' | 'wake' | 'sleep' | 'download' | 'blocked';
export interface Activity {
  id: number;
  at: number;
  kind: ActivityKind;
  agent: string | null;
  url?: string;
  detail?: string;
}

export interface Download {
  id: string;
  name: string;
  url: string;
  state: 'inProgress' | 'completed' | 'canceled';
  received: number;
  total: number;
  at: number;
}

export interface Boot {
  authed: boolean;
  version: string;
  agentPort: number;
  idleMinutes: number;
  video: boolean; // ffmpeg with x11grab + libx264 on the server
}

export type ServerMsg =
  | { t: 'workspaces'; list: WorkspaceInfo[]; current: string | null }
  | { t: 'state'; workspace: string; state: 'waking' | 'awake' | 'asleep' | 'error'; error?: string | null }
  | { t: 'tabs'; current: string | null; tabs: TabInfo[] }
  | { t: 'view'; id: string | null }
  | { t: 'page'; url: string; title: string; canBack: boolean; canFwd: boolean }
  | { t: 'loading'; on: boolean }
  | { t: 'clip'; text: string }
  | { t: 'dialog'; type: string; message: string; value: string }
  | { t: 'dialog'; closed: true }
  | { t: 'filechooser'; multiple: boolean }
  | { t: 'mode'; mode: StreamMode; msg?: string }
  | { t: 'stats'; fps: number; kbps: number; rtt: number; quality: number | null; mode: StreamMode }
  | { t: 'pong'; ts: number }
  | { t: 'toast'; msg: string; kind?: 'error' | 'info' }
  | { t: 'activity'; workspace: string; items: Activity[]; reset?: boolean }
  | { t: 'thumb'; id: string; data: string }
  | { t: 'downloads'; workspace: string; items: Download[] }
  | { t: 'screenshot'; data: string; name: string };

export interface Stage { w: number; h: number; dpr: number; mobile: boolean }
export interface Mods { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean }

export type ClientMsg =
  | ({ t: 'hello'; workspace: string | null; mode: StreamMode; visible: boolean } & Stage)
  | { t: 'workspace'; name: string }
  | { t: 'wake' }
  | { t: 'sleep'; name: string }
  | { t: 'delete'; name: string }
  | { t: 'idle'; name: string; minutes: number | null }
  | { t: 'visible'; on: boolean }
  | ({ t: 'size' } & Stage)
  | { t: 'mode'; mode: StreamMode }
  | { t: 'ack'; seq: number }
  | { t: 'keyframe' }
  | { t: 'ping'; ts: number }
  | { t: 'view'; id: string }
  | { t: 'new'; url?: string }
  | { t: 'close'; id: string }
  | { t: 'nav'; url: string }
  | { t: 'back' } | { t: 'fwd' } | { t: 'reload' } | { t: 'stop' }
  | { t: 'dialog'; accept: boolean; text?: string }
  | ({ t: 'mouse'; type: string; x: number; y: number; button?: string; buttons?: number; clickCount?: number; dx?: number; dy?: number } & Mods)
  | ({ t: 'key'; type: 'keyDown' | 'keyUp'; key: string; code: string; keyCode: number } & Mods)
  | { t: 'text'; text: string }
  | { t: 'thumbs'; on: boolean }
  | { t: 'files'; ids: string[] }
  | { t: 'screenshot' }
  | { t: 'agent'; name: string; action: 'disconnect' | 'closeTabs' | 'block' | 'unblock' };

// binary frame: u8 type | 3 pad | u32 seq | f32 cssWidth | f32 cssHeight | payload
export const FRAME_JPEG = 1, FRAME_KEY = 2, FRAME_DELTA = 3;
export const HEADER_BYTES = 16;

export const WORKSPACE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const AGENT_NAME = /^[\w.-]{1,64}$/;
