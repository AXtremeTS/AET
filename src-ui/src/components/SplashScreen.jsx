import React, { useEffect, useState } from 'react';

const SplashScreen = ({ onComplete }) => {
  const [isFading, setIsFading] = useState(false);

  useEffect(() => {
    // Start fading out after 2 seconds
    const fadeTimer = setTimeout(() => {
      setIsFading(true);
    }, 2000);

    // Call onComplete after the fade transition (0.5s) completes
    const completeTimer = setTimeout(() => {
      if (onComplete) onComplete();
    }, 2500);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(completeTimer);
    };
  }, [onComplete]);

  return (
    <div className={`splash-container ${isFading ? 'fade-out' : ''}`}>
      {/* Absolute Hairline Grids */}
      <div className="splash-grid-border"></div>
      <div className="splash-grid-hline top"></div>
      <div className="splash-grid-hline bottom"></div>
      <div className="splash-grid-vline left"></div>
      <div className="splash-grid-vline right"></div>

      {/* Main Branding */}
      <div className="splash-logo-text">
        <span className="aki-part">AKI</span> <span className="event-part">Event Tracker</span>
      </div>
      <p className="splash-subtitle">Kernel-level file activity tracking</p>
    </div>
  );
};

export default SplashScreen;
