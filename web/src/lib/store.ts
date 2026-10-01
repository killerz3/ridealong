// App state. The connection writes into it; components read from it.
import { create } from 'zustand';
import type { Activity, Boot, Download, StreamMode, TabInfo, WorkspaceInfo } from '@shared/protocol';
import { prefs } from './prefs';

export type WsState = 'connecting' | 'waking' | 'awake' | 'asleep' | 'error';
export type View = 'browser' | 'overview';

export interface PageInfo { url: string; title: string; canBack: boolean; canFwd: boolean }
export interface Stats { fps: number; kbps: number; rtt: number; quality: number | null; mode: StreamMode }

export interface State {
  boot: Boot | null;
  link: 'connecting' | 'open' | 'closed';
  workspaces: WorkspaceInfo[];
  ws: string | null;
  wsState: WsState;
  wsError: string | null;
  tabs: TabInfo[];
  tab: string | null;
  page: PageInfo;
  loading: boolean;
  hasFrame: boolean;
  frame: { w: number; h: number } | null; // CSS size of the remote page
  stats: Stats | null;
  pingRtt: number;
  mode: StreamMode;
  activity: Activity[];
  unseenActivity: number;
  downloads: Download[];
  unseenDownloads: number;
  thumbs: Record<string, string>;
  dialog: { type: string; message: string; value: string } | null;
  chooser: { multiple: boolean } | null;
  view: View;
  activityOpen: boolean;
  modal: null | 'palette' | 'connect' | 'settings' | 'newWorkspace' | 'shortcuts' | 'delete';
  connectAgent: string | null; // preset name for the connect dialog
}

export const blankPage: PageInfo = { url: '', title: '', canBack: false, canFwd: false };

export const useStore = create<State>(() => ({
  boot: null,
  link: 'connecting',
  workspaces: [],
  ws: null,
  wsState: 'connecting',
  wsError: null,
  tabs: [],
  tab: null,
  page: blankPage,
  loading: false,
  hasFrame: false,
  frame: null,
  stats: null,
  pingRtt: 0,
  mode: prefs.get<StreamMode>('mode', 'jpeg'),
  activity: [],
  unseenActivity: 0,
  downloads: [],
  unseenDownloads: 0,
  thumbs: {},
  dialog: null,
  chooser: null,
  view: 'browser',
  activityOpen: prefs.get('activityOpen', false),
  modal: null,
  connectAgent: null,
}));

export const set = useStore.setState;
export const get = useStore.getState;

export const currentWorkspace = (s: State) => s.workspaces.find(w => w.name === s.ws) || null;
export const currentTab = (s: State) => s.tabs.find(t => t.id === s.tab) || null;
export const openModal = (modal: State['modal'], extra: Partial<State> = {}) => set({ modal, ...extra });
export const closeModal = () => set({ modal: null });
