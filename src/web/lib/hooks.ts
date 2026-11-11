import { useEffect, useState } from 'react';
import { api } from './api';
export function useResource<T>(path: string, revision = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const controller = new AbortController();
    api<T>(path, { signal: controller.signal })
      .then((value) => {
        setData(value);
        setError(undefined);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error);
      });
    return () => controller.abort();
  }, [path, revision]);
  return { data, error };
}
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
      return true;
    } catch (error) {
      setError(error);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}
