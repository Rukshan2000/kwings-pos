import { useEffect, useState } from "react";

// Shown for a beat on launch while the app boots. Held for a minimum time so
// it doesn't flash-and-vanish on a fast start, and fades out once the caller
// says it's ready.
export default function Splash({ ready }: { ready: boolean }) {
  const [minTimeElapsed, setMinTimeElapsed] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setMinTimeElapsed(true), 3000);
    return () => clearTimeout(id);
  }, []);

  const fadingOut = ready && minTimeElapsed;

  useEffect(() => {
    if (!fadingOut) return;
    const id = setTimeout(() => setHidden(true), 500);
    return () => clearTimeout(id);
  }, [fadingOut]);

  if (hidden) return null;

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-white transition-opacity duration-500 ${
        fadingOut ? "opacity-0 pointer-events-none" : "opacity-100"
      }`}
    >
      <div className="flex flex-col items-center gap-8">
        <div className="relative flex items-center justify-center">
          <span className="absolute h-72 w-72 rounded-full bg-brand-200/50 blur-3xl animate-splash-glow" />
          <span className="absolute h-56 w-56 rounded-full border-2 border-brand-300/40 animate-splash-ring" />
          <span
            className="absolute h-56 w-56 rounded-full border-2 border-brand-300/30 animate-splash-ring"
            style={{ animationDelay: "0.6s" }}
          />
          <img
            src="/pos-logo-black.png"
            alt=""
            className="relative h-64 w-64 object-contain animate-splash-pop"
          />
        </div>
        <div className="flex gap-2">
          <span className="h-2 w-2 rounded-full bg-brand-400 animate-splash-bounce" />
          <span
            className="h-2 w-2 rounded-full bg-brand-400 animate-splash-bounce"
            style={{ animationDelay: "150ms" }}
          />
          <span
            className="h-2 w-2 rounded-full bg-brand-400 animate-splash-bounce"
            style={{ animationDelay: "300ms" }}
          />
        </div>
      </div>
    </div>
  );
}
