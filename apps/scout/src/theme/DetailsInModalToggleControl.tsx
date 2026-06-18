import clsx from "clsx";
import { FC } from "react";

import { useTranscriptDisplayOptions } from "@tsmono/inspect-components/transcript";

import { useUserSettings } from "../state/userSettings";

import styles from "./DetailsInModalToggleControl.module.css";

/**
 * Compact navbar toggle for the "open message details in a modal" transcript
 * setting. Reflects the effective value (user override or app default) and
 * writes an explicit override when clicked. Scout has no settings popover, so
 * this lives inline beside the theme toggle.
 */
export const DetailsInModalToggleControl: FC = () => {
  const { detailsInModal } = useTranscriptDisplayOptions();
  const setDetailsInModal = useUserSettings((s) => s.setDetailsInModal);
  const label = detailsInModal
    ? "Message details open in a modal (click to show inline)"
    : "Message details open inline (click to open in a modal)";
  return (
    <button
      type="button"
      className={clsx(styles.button)}
      aria-pressed={detailsInModal}
      title={label}
      aria-label={label}
      onClick={() => setDetailsInModal(!detailsInModal)}
    >
      <i
        className={clsx(
          detailsInModal ? "bi bi-window-fullscreen" : "bi bi-window",
          detailsInModal ? styles.active : undefined
        )}
      />
    </button>
  );
};
