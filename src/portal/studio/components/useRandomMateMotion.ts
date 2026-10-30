import { useEffect, useState } from "react";
import { MATE_PET_MOTIONS } from "../../../shared/matePet";

const BASE_MOTION_INTERVAL_MS = 3200;

/** Give each rendered Mate avatar its own starting action and animation pace. */
export function useRandomMateMotion() {
  const [timing] = useState(() => ({
    initialIndex: Math.floor(Math.random() * MATE_PET_MOTIONS.length),
    rate: 0.8 + Math.random() * 0.4
  }));
  const [motionIndex, setMotionIndex] = useState(timing.initialIndex);

  useEffect(() => {
    const intervalMs = Math.round(BASE_MOTION_INTERVAL_MS / timing.rate);
    const timer = window.setInterval(() => {
      setMotionIndex((current) => (current + 1) % MATE_PET_MOTIONS.length);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [timing.rate]);

  return motionIndex;
}
