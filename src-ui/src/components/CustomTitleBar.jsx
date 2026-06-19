import React from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export default function CustomTitleBar() {
  const appWindow = getCurrentWindow();

  const handleMinimize = () => appWindow.minimize();
  const handleMaximize = () => appWindow.toggleMaximize();
  const handleClose = () => appWindow.close();

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div style={{ fontWeight: '700', paddingLeft: '12px', pointerEvents: 'none' }}>
        [+] AET v3.0.0
      </div>
      
      <div style={{ display: 'flex', gap: '4px', paddingRight: '8px' }}>
        <button onClick={handleMinimize} className="titlebar-btn">
          [-]
        </button>
        <button onClick={handleMaximize} className="titlebar-btn">
          [+]
        </button>
        <button onClick={handleClose} className="titlebar-btn close">
          [x]
        </button>
      </div>
    </div>
  );
}
