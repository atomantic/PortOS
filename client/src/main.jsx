import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import ErrorBoundary from './components/ErrorBoundary';
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
      <BrowserRouter>
        <App />
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: '#1e1e2e',
              color: '#fff',
              border: '1px solid #313244'
            }
          }}
        />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
