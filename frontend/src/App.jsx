/**
 * MAIN APP COMPONENT (Router Shell)
 */

import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import socketService from './services/socket';
import './index.css';

export default function App() {
  useEffect(() => {
    // Initialize Socket.IO (persist for app lifetime)
    socketService.connect();
    // No disconnect on cleanup to avoid dev StrictMode double-unmount issues
  }, []);

  return (
    <div className="app-shell">
      <Outlet />
    </div>
  );
}
