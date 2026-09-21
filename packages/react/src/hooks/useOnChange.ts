import { useEffect, useRef } from "react";

import { useLatestRef } from "./useLatestRef";

/**
 * Calls `onChange(value)` after each commit in which `value` changed identity,
 * not on mount: for continuing work that waits on an external value (a store
 * or context) to move. Always calls the latest `onChange`.
 */
export function useOnChange<T>(value: T, onChange: (value: T) => void): void {
  const onChangeRef = useLatestRef(onChange);
  const previous = useRef(value);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    onChangeRef.current(value);
  }, [value, onChangeRef]);
}
