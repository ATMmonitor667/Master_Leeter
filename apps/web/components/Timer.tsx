"use client";

import { useEffect, useState } from "react";

/**
 * Remaining time.
 *
 * Server-authoritative: the component counts down locally between STATE
 * messages purely so the display doesn't tick in jumps, and re-syncs whenever
 * the server speaks. A client-owned clock would drift, and worse, would keep
 * running through a disconnect the server had paused.
 *
 * No colour changes, no urgency animation, no gamification. Pressure in a real
 * interview comes from the interview.
 */
export function Timer({ remainingSeconds }: { remainingSeconds: number }) {
  const [local, setLocal] = useState(remainingSeconds);

  useEffect(() => {
    setLocal(remainingSeconds);
  }, [remainingSeconds]);

  useEffect(() => {
    const id = setInterval(() => setLocal((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, []);

  const minutes = Math.floor(local / 60);
  const seconds = local % 60;

  return (
    <div aria-label="Time remaining" className="timer">
      {minutes}:{String(seconds).padStart(2, "0")}
    </div>
  );
}
