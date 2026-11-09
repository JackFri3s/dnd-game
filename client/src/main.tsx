import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { Home } from './pages/Home.tsx';
import { TableScreen } from './pages/TableScreen.tsx';
import { JoinScreen } from './pages/JoinScreen.tsx';

function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/table') return <TableScreen />;
  if (path === '/join') return <JoinScreen initialRole="player" />;
  if (path === '/dm') return <JoinScreen initialRole="dm" />;
  return <Home />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
