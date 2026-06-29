import clsx from "clsx";
import { CSSProperties, forwardRef } from "react";

import styles from "./Preformatted.module.css";

export interface PreformattedProps {
  text: string;
  style?: CSSProperties;
  className?: string | string[];
  /** Extra `data-*` attributes spread onto the `<pre>` (e.g. search identity). */
  dataAttributes?: Record<string, string | number>;
}

export const Preformatted = forwardRef<HTMLPreElement, PreformattedProps>(
  ({ text, style, className, dataAttributes }, ref) => {
    return (
      <pre
        ref={ref}
        className={clsx(styles.content, "text-size-smaller", className)}
        style={style}
        {...dataAttributes}
      >
        {text}
      </pre>
    );
  }
);

Preformatted.displayName = "Preformatted";
