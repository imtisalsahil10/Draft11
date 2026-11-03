/**
 * MAIN ENTRY POINT
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './App.jsx';
import HomePage from './pages/HomePage.jsx';
import RoomPage from './pages/RoomPage.jsx';
import AuctionPage from './pages/AuctionPage.jsx';
import LeaguePage from './pages/LeaguePage.jsx';
import CataloguePage from './pages/CataloguePage.jsx';
import './index.css';

const developmentRoutes = import.meta.env.DEV
  ? [
      {
        path: '/identity-review',
        lazy: async () => {
          const module = await import('./pages/IdentityReviewPage.jsx');
          return { Component: module.default };
        }
      },
      ...(import.meta.env.VITE_CARD_LAB === '1'
        ? [{
            path: '/card-lab',
            lazy: async () => {
              const module = await import('./pages/CardLabPage.jsx');
              return { Component: module.default };
            }
          }]
        : [])
    ]
  : [];

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/catalogue', element: <CataloguePage /> },
      { path: '/league', element: <LeaguePage /> },
      { path: '/league/:leagueId', element: <LeaguePage /> },
      { path: '/room/:code', element: <RoomPage /> },
      { path: '/auction/:code', element: <AuctionPage /> },
      { path: '/squad/:code', element: <AuctionPage /> },
      ...developmentRoutes
    ]
  }
], {
  future: {
    v7_startTransition: true,
    v7_relativeSplatPath: true
  }
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
