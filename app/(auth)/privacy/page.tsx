import { AuthCard } from "@/components/auth/AuthForms";

export const dynamic = "force-static";

export default function PrivacyPage() {
  return (
    <AuthCard>
      <h1>Privacy policy</h1>
      <p>Gomez is a private, single-user application operated by BizGrips (Noah) for its owner&apos;s own business and personal accounts. Effective September 12, 2026.</p>
      <div className="detail-content" style={{ fontSize: 12, lineHeight: 1.7 }}>
        <p><strong>Who uses Gomez.</strong> One owner account. There is no public signup, no customers, and no third-party end users.</p>
        <p><strong>What data Gomez processes.</strong> Read-only metadata from services the owner explicitly connects (Google Workspace, HighLevel, Stripe, Plaid, and others): email subjects and snippets, calendar events, file names, CRM records, billing records, and bank account and transaction data. Full email bodies, bank credentials, account numbers, and routing numbers are never stored.</p>
        <p><strong>Plaid.</strong> Bank connections are made through Plaid Link. Bank credentials are entered with Plaid and never with Gomez. Gomez uses only Plaid&apos;s Transactions and Balance products; it never initiates transfers or payments. The Plaid access token is encrypted with AES-256-GCM before storage and is never exposed to the browser or logs. Plaid&apos;s own privacy policy applies to Plaid&apos;s processing: https://plaid.com/legal/#end-user-privacy-policy.</p>
        <p><strong>How data is used.</strong> To show the owner their own information, compute metrics, generate findings, alerts and briefings, and answer the owner&apos;s questions. Bounded excerpts may be sent to Anthropic&apos;s API to generate answers; provider credentials are never sent to any AI model.</p>
        <p><strong>Storage and security.</strong> Data is stored in a Supabase Postgres database (encrypted at rest) with row-level security, hosted on Vercel. All traffic uses HTTPS (TLS 1.2+). Access requires the owner&apos;s password and a time-based one-time code (MFA). Connection and access events are audit-logged.</p>
        <p><strong>Sharing.</strong> Gomez does not sell or share data. Sub-processors: Vercel (hosting), Supabase (database and authentication), Anthropic (AI responses), and the connected providers themselves.</p>
        <p><strong>Retention and deletion.</strong> Data is retained while a connection is active. Removing a connection in Gomez deletes the stored credential; synced records can be deleted on request by the owner. Plaid Items can also be revoked via Plaid.</p>
        <p><strong>Contact.</strong> noah@bizgrips.com</p>
      </div>
    </AuthCard>
  );
}
