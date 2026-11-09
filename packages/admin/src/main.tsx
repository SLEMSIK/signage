import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { App } from './App';
import './styles.css';

// Data router нужен для useBlocker (предупреждение о несохранённом плейлисте).
const router = createBrowserRouter([{ path: '*', element: <App /> }], { basename: '/admin' });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
