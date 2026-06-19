import React, { useState } from 'react';
import CustomTitleBar from './components/CustomTitleBar';
import Dashboard from './components/Dashboard';
import SplashScreen from './components/SplashScreen';

function App() {
  const [isLoading, setIsLoading] = useState(true);

  if (isLoading) {
    return (
      <>
        <CustomTitleBar />
        <SplashScreen onComplete={() => setIsLoading(false)} />
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
