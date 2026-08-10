/**
 * Controller entry point.
 *
 * The Jotai provider uses the runtime's own store because the transcript
 * projection pulls in runtime modules that read from it -- same arrangement as
 * packages/ios/src/transcript/main.tsx.
 */
import ReactDOM from 'react-dom/client';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '@nimbalyst/runtime/store';

import { App } from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('controller-root')!).render(
  <JotaiProvider store={store}>
    <App />
  </JotaiProvider>
);
