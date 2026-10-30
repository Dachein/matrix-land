import { useEffect, useState } from 'react';
import { uploadElapsedTime } from '../services/uploadProgress';

/** Derive elapsed time from a clock rather than counting ticks, including after backgrounding. */
export function useUploadTimer(uploading: boolean) {
  const [elapsed, setElapsed] = useState('00:00');
  useEffect(() => {
    setElapsed('00:00');
    if (!uploading) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed(uploadElapsedTime(startedAt, Date.now())), 1000);
    return () => clearInterval(timer);
  }, [uploading]);
  return elapsed;
}
