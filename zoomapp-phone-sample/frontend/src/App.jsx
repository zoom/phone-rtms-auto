import React, { useState, useEffect } from 'react';
import zoomSdk from '@zoom/appssdk';
import './App.css';

function App() {
  const [phoneContext, setPhoneContext] = useState(null);
  const [aiCallSummaryId, setAiCallSummaryId] = useState('');
  const [aiSummary, setAiSummary] = useState(null);
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false);
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

  // Listen for AI call summary ID pushed from backend via SSE
  useEffect(() => {
    const eventSource = new EventSource('/api/events');

    eventSource.onmessage = (e) => {
      const { aiCallSummaryId } = JSON.parse(e.data);
      if (aiCallSummaryId) {
        setAiCallSummaryId(aiCallSummaryId);
      }
    };

    eventSource.onerror = (err) => {
      console.error('SSE connection error:', err);
    };

    return () => eventSource.close();
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

  const fetchAiCallSummary = async () => {
    if (!aiCallSummaryId) return;
    setAiSummaryLoading(true);
    setAiSummary(null);
    try {
      const response = await fetch(`/api/zoom/phone/user/me/ai_call_summary/${aiCallSummaryId}`, {
        credentials: 'include'
      });
      const data = await response.json();
      if (response.ok) {
        setAiSummary(data);
      } else {
        setError(data.error || 'Failed to fetch AI call summary');
      }
    } catch (err) {
      setError(`Error fetching AI call summary: ${err.message}`);
    } finally {
      setAiSummaryLoading(false);
    }
  };

  return (
    <div className="App">
      <div className="container">
        <div className="header">
          <h1>Zoom App for Phone</h1>
          <p className="subtitle">Your AI call summary assistant</p>
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
          <h3>AI Call Summary</h3>
          <div className="status-item" style={{ background: 'white' }}>
            <span className="status-label">Summary ID:</span>
            <input
              className="input"
              type="text"
              value={aiCallSummaryId}
              onChange={e => setAiCallSummaryId(e.target.value)}
              placeholder="AI Call Summary ID"
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
            <button
              className="btn"
              onClick={fetchAiCallSummary}
              disabled={aiSummaryLoading || !aiCallSummaryId}
            >
              {aiSummaryLoading ? 'Loading...' : 'Get AI Summary'}
            </button>
          </div>
          {aiSummary && (
            <div className="summary-box">
              {aiSummary.transcript_language && (
                <div className="status-item">
                  <span className="status-label">Transcript Language:</span>
                  <span className="status-value">{aiSummary.transcript_language}</span>
                </div>
              )}
              {aiSummary.call_summary && (
                <div className="status-item" style={{ flexDirection: 'column', gap: '6px' }}>
                  <span className="status-label">Call Summary:</span>
                  <span className="status-value">{aiSummary.call_summary}</span>
                </div>
              )}
              {aiSummary.detailed_summary && (
                <details className="detailed-summary">
                  <summary>Detailed Summary</summary>
                  <p className="status-value">{aiSummary.detailed_summary}</p>
                </details>
              )}
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
