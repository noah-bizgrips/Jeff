"use client";

import { useEffect } from "react";
import { registerServiceWorker } from "@/lib/jeff/push/client";

/**
 * Registers the push-only service worker once the workspace is open.
 * Subscribing happens from a user gesture in Settings (browsers require it).
 */
export function PushManager() {
  useEffect(() => {
    void registerServiceWorker();
  }, []);
  return null;
}
