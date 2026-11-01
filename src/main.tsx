import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import ElkApi from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { setElkFactory } from './layout/elk-layout';

// Run ELK in a Web Worker so laying out a large circuit does not freeze the page.
// If the worker cannot start or load, layouts run on the main thread instead.
try {
  setElkFactory(
    (failed) =>
      new ElkApi({
        workerUrl: elkWorkerUrl,
        workerFactory: (url) => {
          const worker = new Worker(url!);
          worker.addEventListener('error', failed);
          return worker;
        },
      }),
  );
} catch {
  setElkFactory(undefined);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
