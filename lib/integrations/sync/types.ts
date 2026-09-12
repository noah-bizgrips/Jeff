/** Normalised record shape written to public.source_items. No provider bodies, ever. */
export interface SourceItemInput {
  provider: string;
  capability: string;
  resource_type: string;
  external_id: string;
  title: string;
  summary: string | null;
  author: string | null;
  source_url: string | null;
  source_timestamp: string | null;
  content_hash: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface CapabilitySyncResult {
  capability: string;
  seen: number;
  upserted: number;
  cursor?: string | null;
  error?: string;
}

export interface SyncSummary {
  connectionId: string;
  provider: string;
  results: CapabilitySyncResult[];
}
