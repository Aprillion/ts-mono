import { useEffect } from "react";

/** Keeps `value` registered while mounted; re-registers when either changes. */
export function useRegistration<T>(
  register: ((value: T) => () => void) | null | undefined,
  value: T
): void {
  useEffect(() => register?.(value), [register, value]);
}
