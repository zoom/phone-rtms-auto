import React, { useState, useEffect } from 'react';
import zoomSdk from '@zoom/appssdk';
import './App.css';

const PROMPT_LIFETIME_MS = 10000;
let nextPromptId = 0;

function App() {
  const [phoneContext, setPhoneContext] = useState(null);
  const [prompts, setPrompts] = useState([]);
  const [liveKeywords, setLiveKeywords] = useState([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  // Check for OAuth redirect with auth status
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const authStatus = urlParams.get('auth');

    if (authStatus === 'success') {
      setMessage('Authentication successful!');
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (authStatus === 'error') {
      setError('Authentication failed. Please try again.');
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  // Listen for keyword/prompt events pushed from backend via SSE
  useEffect(() => {
    const eventSource = new EventSource('/api/events');
    const timers = new Set();

    eventSource.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.type === 'prompt') {
        const id = nextPromptId++;
        setPrompts(prev => [{ ...event, id, receivedAt: new Date() }, ...prev]);

        // Each prompt disappears on its own after PROMPT_LIFETIME_MS.
        const timer = setTimeout(() => {
          timers.delete(timer);
          setPrompts(prev => prev.filter(p => p.id !== id));
        }, PROMPT_LIFETIME_MS);
        timers.add(timer);
      } else if (event.type === 'keywords') {
        setLiveKeywords(event.keywords);
      }
    };

    eventSource.onerror = (err) => {
      console.error('SSE connection error:', err);
    };

    return () => {
      eventSource.close();
      timers.forEach(clearTimeout);
    };
  }, []);

  // Initialize Zoom SDK
  useEffect(() => {
    async function initializeZoomSdk() {
      try {
        await zoomSdk.config({
          version: '0.16.37',
          capabilities: ['getRunningContext', 'getPhoneContext']
        });

        console.log('Zoom SDK initialized successfully');

        const { context: runningContext } = await zoomSdk.getRunningContext();
        console.log('Running context:', runningContext);

        if (runningContext === 'inPhone') {
          const context = await zoomSdk.getPhoneContext();
          console.log('getPhoneContext response:', JSON.stringify(context, null, 2));
          setPhoneContext(context);
        }

      } catch (error) {
        console.warn('Zoom SDK initialization failed (app will use webhook-based tracking):', error);
        // Don't show error to user - app works without SDK via webhooks
      }
    }

    initializeZoomSdk();
  }, []);

  return (
    <div className="App">
      <div className="container">
        <div className="header">
          <h1>Zoom App for Phone</h1>
          <p className="subtitle">Live keyword detection and prompts</p>
        </div>

        {error && (
          <div className="error-box">
            <strong>Error:</strong> {error}
          </div>
        )}

        {message && (
          <div className="success-box">
            <strong>Success:</strong> {message}
          </div>
        )}

        {phoneContext && (
          <div className="section">
            <h3>Phone Context</h3>
            <div className="status-item">
              <span className="status-label">Call Id:</span>
              <span className="status-value">{phoneContext.callId ?? 'Not available'}</span>
            </div>
            <div className="status-item">
              <span className="status-label">Call Status:</span>
              <span className="status-value">{phoneContext.callStatus ?? 'Not available'}</span>
            </div>
            {phoneContext.callObject && (
              <>
            
                 <div className="status-item">
                  <span className="status-label">Ringing Start Time:</span>
                  <span className="status-value">{phoneContext.callObject.ringingStartTime ?? 'Not available'}</span>
                </div>
                <div className="status-item">
                  <span className="status-label">Answer Start Time:</span>
                  <span className="status-value">{phoneContext.callObject.answerStartTime ?? 'Not available'}</span>
                </div>
            
              </>
            )}
          </div>
        )}

        

        <div className="section">
          <h3>Keyword Detection</h3>
          {liveKeywords.length === 0 ? (
            <p className="status-value">Listening for keywords...</p>
          ) : (
            <div className="keyword-list">
              {liveKeywords.map(({ term, count }) => (
                <span key={term} className="keyword-chip">{term} <small>×{count}</small></span>
              ))}
            </div>
          )}

          <h4 className="prompt-heading">Live Prompts</h4>
          {prompts.length === 0 ? (
            <p className="status-value">No active prompts. New ones appear here as keywords are heard.</p>
          ) : (
            <div className="prompt-feed">
              {prompts.map((p) => (
                <div key={p.id} className="prompt-card">
                  <div className="prompt-meta">
                    Heard "{p.keyword}" at {p.receivedAt.toLocaleTimeString()}
                  </div>
                  <div>{p.prompt}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="footer">
        </div>
      </div>
    </div>
  );
}

export default App;
