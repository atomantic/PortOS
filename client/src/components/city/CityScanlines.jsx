import { useRef, useEffect } from 'react';

// CSS-based CRT scanline + vignette overlay for cyberpunk atmosphere
export default function CityScanlines() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = 4;
    canvas.height = 4;

    // Draw a tiny 4x4 scanline pattern (repeating)
    ctx.clearRect(0, 0, 4, 4);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
    ctx.fillRect(0, 0, 4, 1);
    ctx.fillRect(0, 2, 4, 1);
  }, []);

  return (
    <>
      {/* Scanline pattern (generated from hidden canvas) */}
      <canvas ref={canvasRef} className="hidden" />
      {/* Scanline overlay */}
      <div
        className="absolute inset-0 pointer-events-none z-10"
        style={{
          backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.04) 0px, rgba(0,0,0,0.04) 1px, transparent 1px, transparent 3px)',
          backgroundSize: '100% 3px',
          mixBlendMode: 'multiply',
        }}
      />
      {/* Vignette effect */}
      <div
        className="absolute inset-0 pointer-events-none z-10"
        style={{
          background: 'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.4) 100%)',
        }}
      />
      {/* Subtle chromatic aberration glow at edges */}
      <div
        className="absolute inset-0 pointer-events-none z-10 opacity-[0.015]"
        style={{
          boxShadow: 'inset 0 0 100px 20px rgba(6, 182, 212, 0.3), inset 0 0 60px 10px rgba(139, 92, 246, 0.2)',
        }}
      />
    </>
  );
}
