import React, { useState, useEffect } from 'react';
import CustomTitleBar from './components/CustomTitleBar';
import Dashboard from './components/Dashboard';
import SplashScreen from './components/SplashScreen';
import ActivationScreen from './components/ActivationScreen';
import { invoke } from '@tauri-apps/api/core';

function App() {
  const [isLoading, setIsLoading] = useState(true);
  const [isActivated, setIsActivated] = useState(false);

  useEffect(() => {
    // Check local activation state on mount
    invoke('is_activated')
      .then(active => {
        setIsActivated(active);
      })
      .catch(e => console.error("Activation check failed", e));
  }, []);

  if (isLoading) {
    return (
      <>
        <CustomTitleBar />
        <SplashScreen onComplete={() => setIsLoading(false)} />
      </>
    );
  }

  if (!isActivated) {
    return (
      <>
        <CustomTitleBar />
        <ActivationScreen 
          onActivated={() => setIsActivated(true)} 
        />
      </>
    );
  }

  return (
    <>
      <CustomTitleBar />
      <Dashboard />
    </>
  );
}

export default App;
