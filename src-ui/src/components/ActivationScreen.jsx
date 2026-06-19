import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export default function ActivationScreen({ onActivated }) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  const handleActivate = async () => {
    if (!code.trim()) {
      setError('Please enter an activation code.');
      return;
    }

    setLoading(true);
    setError('');
    
    try {
      const isValid = await invoke('verify_activation_code', {
        code: code.trim()
      });
      
      if (isValid) {
        onActivated();
      } else {
        setError('Invalid or disabled activation code.');
      }
    } catch (e) {
      console.error(e);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'var(--color-canvas)',
      color: 'var(--color-on-canvas)',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 99999, // Above everything
      padding: '24px'
    }}>
      <div className="section-border" style={{
        maxWidth: '480px',
        width: '100%',
        backgroundColor: 'var(--color-surface-elevated)',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}>
        <div style={{ textAlign: 'center', borderBottom: '1px solid var(--color-hairline)', paddingBottom: '16px' }}>
          <h2 style={{ fontFamily: '"FFFFORWA", "Black Ops One", Impact, sans-serif', margin: 0, color: 'var(--color-accent)' }}>AET v4.0.0</h2>
          <div className="text-mute" style={{ marginTop: '4px', letterSpacing: '1px' }}>SYSTEM ACTIVATION REQUIRED</div>
        </div>

        <div style={{ fontSize: '13px', lineHeight: '1.6' }}>
          Welcome to AKI File Activity Monitor. To continue, please enter a valid activation code provided by the administrator.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label style={{ fontWeight: 'bold', fontSize: '11px', color: 'var(--color-mute)' }}>ACTIVATION CODE</label>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. AET-PRO-2026-VIP"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleActivate();
            }}
            style={{
              backgroundColor: 'var(--color-canvas)',
              border: '1px solid var(--color-hairline-strong)',
              borderRadius: '4px',
              padding: '10px 12px',
              color: 'var(--color-on-canvas)',
              fontFamily: 'monospace',
              fontSize: '14px',
              outline: 'none',
              width: '100%'
            }}
            disabled={loading}
          />
        </div>

        {error && (
          <div className="text-danger" style={{ fontWeight: 'bold', fontSize: '12px', textAlign: 'center', padding: '8px', backgroundColor: 'rgba(255, 59, 48, 0.1)', border: '1px solid var(--color-danger)' }}>
            [!] {error}
          </div>
        )}

        <button
          onClick={handleActivate}
          className="btn-tui"
          style={{
            marginTop: '8px',
            padding: '10px',
            fontWeight: 'bold',
            backgroundColor: loading ? 'var(--color-surface-card)' : 'var(--color-accent)',
            color: 'var(--color-on-canvas)',
            border: 'none',
            opacity: loading ? 0.7 : 1,
            cursor: loading ? 'not-allowed' : 'pointer'
          }}
          disabled={loading}
        >
          {loading ? 'VERIFYING WITH SUPABASE...' : 'ACTIVATE SYSTEM'}
        </button>
        
        <div style={{ textAlign: 'center', fontSize: '11px', color: 'var(--color-hairline-strong)', marginTop: '8px' }}>
          Requires internet connection for initial verification.
        </div>
      </div>
    </div>
  );
}
