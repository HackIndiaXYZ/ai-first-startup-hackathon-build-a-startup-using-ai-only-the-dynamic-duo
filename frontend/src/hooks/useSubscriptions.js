import { useState, useEffect, useCallback } from 'react';
import { getSubscriptions } from '../services/api';

export function useSubscriptions() {
  const [subscriptions, setSubscriptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchSubscriptions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getSubscriptions();
      setSubscriptions(data);
    } catch (err) {
      setError(err.message || 'Failed to load subscriptions.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchSubscriptions();
  }, [fetchSubscriptions]);

  return { subscriptions, loading, error, retry: fetchSubscriptions };
}
