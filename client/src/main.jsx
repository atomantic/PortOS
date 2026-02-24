import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import ErrorBoundary from './components/ErrorBoundary';
import { ThemeProvider } from './components/ThemeContext';
import App from './App';
import './index.css';

// Handle unhandled promise rejections
window.addEventListener('unhandledrejection', (event) => {
  console.error(`❌ Unhandled Promise Rejection: ${event.reason}`);
  event.preventDefault();
});

// Handle global errors
window.addEventListener('error', (event) => {
  console.error(`💥 Global Error: ${event.message}`);
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <BrowserRouter>
          <App />
          <Toaster
            position="bottom-right"
            toastOptions={{
              style: {
                background: 'rgb(var(--port-card))',
                color: 'rgb(var(--port-text))',
                border: '1px solid rgb(var(--port-border))'
              }
            }}
          />
        </BrowserRouter>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
