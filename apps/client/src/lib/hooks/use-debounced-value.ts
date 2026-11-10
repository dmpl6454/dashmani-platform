import { useEffect, useState } from "react";

/**
 * The value, `delay` ms after it last changed. Used for search boxes whose text feeds an
 * API request: typing "bollywood" sends one request when the typing stops, not nine.
 * An empty value is passed through at once, so clearing a search shows the full list
 * without waiting.
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (value === "" || value === null || value === undefined) {
      setDebounced(value);
      return;
    }
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
