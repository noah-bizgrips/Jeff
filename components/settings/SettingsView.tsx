"use client";

import { useState } from "react";
import { Icon } from "@/components/jeff/icons";
import { useJeff } from "@/components/jeff/store";
import { PushCard } from "./PushCard";
import type { OwnerSettings } from "@/lib/jeff/settings";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TIMEZONES = ["America/Denver", "America/Los_Angeles", "America/Phoenix", "America/Chicago", "America/New_York", "UTC", "Europe/London"];

export function SettingsView({ initial, vapidPublicKey = "" }: { initial: OwnerSettings; vapidPublicKey?: string }) {
  const jeff = useJeff();
  const [s, setS] = useState<OwnerSettings>(initial);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState<Partial<OwnerSettings>>({});

  function set<K extends keyof OwnerSettings>(key: K, value: OwnerSettings[K]) {
    setS((prev) => ({ ...prev, [key]: value }));
    setDirty((d) => ({ ...d, [key]: value }));
  }

  async function save() {
    if (!Object.keys(dirty).length) return jeff.toast("No changes.");
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(dirty) });
      const data = (await res.json().catch(() => null)) as { settings?: OwnerSettings; changed?: string[]; reason?: string; error?: string } | null;
      if (!res.ok || !data?.settings) return jeff.toast(`Could not save (${data?.reason ?? data?.error ?? res.status}).`);
      setS(data.settings);
      setDirty({});
      jeff.toast(`Saved ${data.changed?.length ?? 0} setting${data.changed?.length === 1 ? "" : "s"}.`);
    } finally {
      setSaving(false);
    }
  }

  const toggle = (k: keyof OwnerSettings, label: string, desc: string) => (
    <div className="policy-row" key={k}>
      <div>
        <strong>{label}</strong>
        <small>{desc}</small>
      </div>
      <button type="button" className="toggle" role="switch" aria-checked={Boolean(s[k])} aria-label={label} onClick={() => set(k, !s[k] as never)} />
    </div>
  );

  return (
    <section className="page-view" id="settingsView">
      <div className="preview-banner">
        <Icon name="sliders" />
        <span>
          These are preferences, not security controls. Authentication, MFA, access, approvals and secret handling live under <strong>Security &amp; access</strong> and cannot be changed here or by learned rules.
        </span>
      </div>
      <div className="security-grid">
        <section className="security-card">
          <h3>Briefings</h3>
          <p>When Jeff writes your daily brief and reviews.</p>
          <label className="field">
            Timezone
            <select value={s.timezone} onChange={(e) => set("timezone", e.target.value)}>
              {[...new Set([s.timezone, ...TIMEZONES])].map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </label>
          {toggle("daily_brief_enabled", "Daily brief", "A short morning summary of what deserves attention.")}
          <label className="field">
            Daily brief time
            <input type="time" value={s.daily_brief_time} onChange={(e) => set("daily_brief_time", e.target.value)} />
          </label>
          <label className="field">
            Attention items in the daily brief
            <input type="number" min={1} max={10} value={s.brief_max_items} onChange={(e) => set("brief_max_items", Math.max(1, Math.min(10, Number(e.target.value) || 3)))} />
          </label>
          {toggle("weekly_review_enabled", "Weekly operating review", "Goal progress, wins, misses, funnel and finance changes, what worked.")}
          <div className="form-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <label className="field">
              Day
              <select value={s.weekly_review_day} onChange={(e) => set("weekly_review_day", Number(e.target.value))}>
                {DAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Time
              <input type="time" value={s.weekly_review_time} onChange={(e) => set("weekly_review_time", e.target.value)} />
            </label>
          </div>
          {toggle("monthly_review_enabled", "Monthly owner review", "Revenue, MRR, cash, expenses, CAC, pipeline, churn — only with sufficient data.")}
          <label className="field">
            Monthly review time (1st of the month)
            <input type="time" value={s.monthly_review_time} onChange={(e) => set("monthly_review_time", e.target.value)} />
          </label>
        </section>

        <section className="security-card">
          <h3>Alerts &amp; quiet hours</h3>
          <p>Jeff stays quiet by default. Urgent alerts always surface; everything else respects these.</p>
          <label className="field">
            Minimum importance to notify
            <select value={s.alert_min_importance} onChange={(e) => set("alert_min_importance", e.target.value as OwnerSettings["alert_min_importance"])}>
              <option value="informational">Informational (everything)</option>
              <option value="briefing">Briefing-level and up</option>
              <option value="important">Important and up (default)</option>
              <option value="urgent">Urgent only</option>
            </select>
          </label>
          <div className="form-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <label className="field">
              Quiet hours start
              <input type="time" value={s.quiet_hours_start} onChange={(e) => set("quiet_hours_start", e.target.value)} />
            </label>
            <label className="field">
              Quiet hours end
              <input type="time" value={s.quiet_hours_end} onChange={(e) => set("quiet_hours_end", e.target.value)} />
            </label>
          </div>
          {toggle("goal_alerts", "Goal alerts", "Trajectory changes on active goals.")}
          {toggle("opportunity_alerts", "Opportunity alerts", "Automation and bottleneck opportunities.")}
          {toggle("business_notifications", "Business notifications", "Pipeline, clients, operations.")}
          {toggle("financial_notifications", "Financial notifications", "Failed payments, cash-flow and expense changes.")}
          {toggle("personal_notifications", "Personal notifications", "Personal-scope items.")}
        </section>

        <PushCard
          vapidPublicKey={vapidPublicKey}
          toggles={
            <>
              {toggle("push_alerts", "Push alerts", "Important alerts outside quiet hours; urgent alerts always.")}
              {toggle("push_briefings", "Push briefings", "A notification when your daily brief or weekly/monthly review is ready.")}
            </>
          }
        />

        <section className="security-card">
          <h3>Learning</h3>
          <p>How Jeff turns your feedback into memory and rules.</p>
          {toggle("learn_from_feedback", "Allow Jeff to learn from feedback", "Chat feedback and finding feedback become memories and rules.")}
          {toggle("auto_apply_safe_rules", "Automatically apply safe preference rules", "Tier 1 (reversible) rules apply immediately; you can undo them under Memory & rules.")}
          {toggle("ask_before_major_changes", "Ask before major behavior changes", "Tier 2 rules (KPI thresholds, muting a whole financial monitor) need your confirmation.")}
        </section>
      </div>
      <div className="security-lockbar">
        <div>
          <strong>{Object.keys(dirty).length ? `${Object.keys(dirty).length} unsaved change${Object.keys(dirty).length === 1 ? "" : "s"}` : "All settings saved."}</strong>
          <p>Changes are audited. Jeff can also change these for you in chat (&ldquo;move my brief to 8am&rdquo;).</p>
        </div>
        <button className="button primary" type="button" disabled={saving || !Object.keys(dirty).length} onClick={save}>
          {saving ? <span className="spinner" /> : <Icon name="check" />}
          Save settings
        </button>
      </div>
    </section>
  );
}
