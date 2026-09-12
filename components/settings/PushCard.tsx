"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/jeff/icons";
import { useJeff } from "@/components/jeff/store";
import { currentSubscription, deviceLabel, isIOS, isStandalone, pushSupport, subscribeToPush, unsubscribeFromPush, type PushSupport } from "@/lib/jeff/push/client";

interface Status {
  configured: boolean;
  devices: number;
  thisDevice: boolean;
  list: { label: string | null; since: string; lastUsed: string | null }[];
}

async function fetchStatus(): Promise<Status | null> {
  const sub = await currentSubscription().catch(() => null);
  const q = sub ? `?endpoint=${encodeURIComponent(sub.endpoint)}` : "";
  const res = await fetch(`/api/push/status${q}`, { cache: "no-store" }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json()) as Status;
}

/** "Notifications on this device" card for the Settings page. */
export function PushCard({ vapidPublicKey, toggles }: { vapidPublicKey: string; toggles: React.ReactNode }) {
  const jeff = useJeff();
  const [support, setSupport] = useState<PushSupport | "loading">("loading");
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const s = await fetchStatus();
    if (s) setStatus(s);
  }

  useEffect(() => {
    // Browser-only APIs: detect support and load server-side status after mount.
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) setSupport(pushSupport());
    });
    fetchStatus().then((s) => {
      if (!cancelled && s) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function enable() {
    setBusy(true);
    try {
      const r = await subscribeToPush(vapidPublicKey, deviceLabel());
      if (!r.ok) {
        const reason = r.reason === "denied" ? "Notifications are blocked for Jeff in this browser. Allow them in the browser/site settings and try again." : `Could not enable push (${r.reason}).`;
        return jeff.toast(reason);
      }
      jeff.toast("Push notifications enabled on this device.");
      setSupport(pushSupport());
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      await unsubscribeFromPush();
      jeff.toast("Push disabled on this device.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      const sub = await currentSubscription().catch(() => null);
      const res = await fetch("/api/push/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub ? { endpoint: sub.endpoint } : {}) });
      const d = (await res.json().catch(() => null)) as { delivered?: number; attempted?: number; error?: string } | null;
      if (!res.ok) return jeff.toast(`Test failed (${d?.error ?? res.status}).`);
      jeff.toast(d?.delivered ? "Test notification sent." : "No device accepted the test notification.");
    } finally {
      setBusy(false);
    }
  }

  const serverReady = status?.configured ?? false;
  const subscribed = status?.thisDevice ?? false;

  return (
    <section className="security-card">
      <h3>Notifications on this device</h3>
      <p>Push alerts and briefings to the Jeff app on this device. Nothing leaves Jeff unless you enable it here.</p>
      {!serverReady && status ? (
        <div className="callout">
          Push is not configured on the server yet. Add <code>NEXT_PUBLIC_VAPID_PUBLIC_KEY</code> and <code>VAPID_PRIVATE_KEY</code> in Vercel.
        </div>
      ) : null}
      {support === "needs-install" ? (
        <div className="callout">
          On iPhone/iPad, push works only from the installed app: open jeff.bizgrips.com in Safari → Share → <strong>Add to Home Screen</strong>, then open Jeff from the home screen and enable notifications here.
        </div>
      ) : null}
      {support === "unsupported" && !isIOS() ? <div className="callout">This browser does not support Web Push. Use Chrome, Edge, Firefox, or Safari 16.4+.</div> : null}
      {support === "denied" ? <div className="callout">Notifications are blocked for Jeff in this browser. Allow them in the site settings, then enable again.</div> : null}
      <div className="policy-row">
        <div>
          <strong>This device</strong>
          <small>
            {support === "loading" ? "Checking…" : subscribed ? `Subscribed (${deviceLabel()})` : support === "ready" ? "Not subscribed" : isStandalone() ? "Unavailable" : "Install the app first"}
            {status ? ` · ${status.devices} device${status.devices === 1 ? "" : "s"} total` : ""}
          </small>
        </div>
        <span className={`pill ${subscribed ? "ok" : "neutral"}`}>{subscribed ? "On" : "Off"}</span>
      </div>
      <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
        {!subscribed ? (
          <button className="button primary" type="button" disabled={busy || support !== "ready" || !serverReady} onClick={enable}>
            {busy ? <span className="spinner" /> : <Icon name="bell" />}
            Enable push notifications
          </button>
        ) : (
          <>
            <button className="button secondary" type="button" disabled={busy} onClick={test}>
              <Icon name="sparkles" />
              Send test notification
            </button>
            <button className="button secondary" type="button" disabled={busy} onClick={disable}>
              <Icon name="x" />
              Disable on this device
            </button>
          </>
        )}
      </div>
      {toggles}
    </section>
  );
}
