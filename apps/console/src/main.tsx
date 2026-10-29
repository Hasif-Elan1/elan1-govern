// live builds: the real backend is wired in before any screen module uses the store (src/api/live/boot.ts)
import { bootLive } from './api/live/boot';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { LIVE } from './api/mode';
import { PageFallback } from './shell/AppShell';
import { applyTheme, useUi } from './store/ui';
import './styles/index.css';

applyTheme(useUi.getState().theme);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (useUi.getState().theme === 'system') applyTheme('system');
});

const root = createRoot(document.getElementById('root')!);
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

if (LIVE) {
  // the session and the person's organisations are read from the server before the first screen renders
  root.render(<PageFallback />);
  void bootLive().then(() => root.render(app));
} else {
  root.render(app);
}
