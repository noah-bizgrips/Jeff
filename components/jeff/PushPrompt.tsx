"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "./icons";
import { currentSubscription, pushSupport } from "@/lib/jeff/push/client";

const DISMISS_KEY = "jeff.pushPrompt.dismissed";

/**
 * Small, dismissable nudge on Mission Control when push is possible on this
 * device but not enabled. Dismissal is remembered per browser (best effort).
 */
export function PushPrompt() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      dismissed = false;
    }
    if (dismissed || pushSupport() !== "ready") return;
    currentSubscription()
      .then((sub) => setShow(!sub))
      .catch(() => setShow(false));
  }, []);
  if (!show) return null;
  return (
    <div className="preview-banner" role="status">
      <Icon name="bell" />
      <span>
        <strong>Get alerts and briefings on this device.</strong> Enable push notifications in Settings — urgent alerts, your Daily Brief, and reviews.{" "}
        <Link href="/settings" className="text-button">
          Enable
        </Link>{" "}
        ·{" "}
        <button
          type="button"
          className="text-button"
          onClick={() => {
            try {
              localStorage.setItem(DISMISS_KEY, "1");
            } catch {
              /* storage unavailable */
            }
            setShow(false);
          }}
        >
          Not now
        </button>
      </span>
    </div>
  );
}
