import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import ElkApi from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { setElkFactory } from './layout/elk-layout';

// Run ELK in a Web Worker so laying out a large circuit does not freeze the page.
try {
  setElkFactory(() => new ElkApi({ workerUrl: elkWorkerUrl }));
} catch {
  // No workers available: the layout runs on the main thread instead.
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
