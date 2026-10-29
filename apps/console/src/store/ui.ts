import { create } from 'zustand';

export type Theme = 'light' | 'dark' | 'system';
export type Density = 'comfortable' | 'compact';

/**
 * What Ask Govern is asked to explain. The payload is the record itself, as the page already holds it:
 *  - receipt: Receipt · approval: Approval · alert: Alert
 *  - rule: { rule, extra?, agentSlug?, rulebookVersion?, draft?, hits?, pending? } (rulebooks/RulesTab)
 *  - assessment: { assessment, systemName? } (assessments/AssessmentPage)
 *  - incident: { incident, refused?, relatedAlerts?, isCurrentStop? } (incidents/IncidentPage)
 *  - general: no payload; the general questions
 */
export interface AskContext {
  kind: 'receipt' | 'approval' | 'rule' | 'alert' | 'assessment' | 'incident' | 'general';
  title: string;
  payload?: unknown;
}

interface UiState {
  theme: Theme;
  density: Density;
  sidebarCollapsed: boolean;
  commandOpen: boolean;
  shortcutsOpen: boolean;
  singleKeyShortcuts: boolean;
  liveUpdates: boolean;
  ask?: AskContext;
  setTheme: (t: Theme) => void;
  setDensity: (d: Density) => void;
  toggleSidebar: () => void;
  setCommandOpen: (o: boolean) => void;
  setShortcutsOpen: (o: boolean) => void;
  setSingleKeyShortcuts: (o: boolean) => void;
  setLiveUpdates: (o: boolean) => void;
  openAsk: (c: AskContext) => void;
  closeAsk: () => void;
}

const KEY = 'eg:ui';
const saved = (() => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; }
})();

const persist = (s: Partial<UiState>) => {
  try {
    const { theme, density, sidebarCollapsed, singleKeyShortcuts, liveUpdates } = { ...useUi.getState(), ...s };
    localStorage.setItem(KEY, JSON.stringify({ theme, density, sidebarCollapsed, singleKeyShortcuts, liveUpdates }));
  } catch { /* fine */ }
};

export const useUi = create<UiState>((set) => ({
  theme: saved.theme ?? 'light',
  density: saved.density ?? 'comfortable',
  sidebarCollapsed: saved.sidebarCollapsed ?? false,
  singleKeyShortcuts: saved.singleKeyShortcuts ?? true,
  liveUpdates: saved.liveUpdates ?? true,
  commandOpen: false,
  shortcutsOpen: false,
  setTheme: (theme) => { set({ theme }); persist({ theme }); applyTheme(theme); },
  setDensity: (density) => { set({ density }); persist({ density }); },
  toggleSidebar: () => set((s) => { persist({ sidebarCollapsed: !s.sidebarCollapsed }); return { sidebarCollapsed: !s.sidebarCollapsed }; }),
  setCommandOpen: (commandOpen) => set({ commandOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setSingleKeyShortcuts: (singleKeyShortcuts) => { set({ singleKeyShortcuts }); persist({ singleKeyShortcuts }); },
  setLiveUpdates: (liveUpdates) => { set({ liveUpdates }); persist({ liveUpdates }); },
  openAsk: (ask) => set({ ask }),
  closeAsk: () => set({ ask: undefined }),
}));

export function applyTheme(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
