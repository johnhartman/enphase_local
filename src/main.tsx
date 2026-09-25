import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { applyTheme, loadTheme } from './theme.js';
import './styles.css';

// Apply a saved theme before the first render so there is no flash.
applyTheme(loadTheme());

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
