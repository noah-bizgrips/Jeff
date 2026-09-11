"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Icon } from "./icons";
import { useJeff } from "./store";
import { DocumentCard, EmptyState, FilterTabs } from "./shared";
import { retrieve, shortDate } from "@/lib/jeff/retrieve";

const COLLECTIONS: Record<string, string> = { projects: "Projects", people: "People & clients", ideas: "Ideas & inspiration" };

export function SearchView() {
  const jeff = useJeff();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<"relevance" | "recent">("relevance");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 40);
    return () => clearTimeout(t);
  }, []);
  const docs = jeff.docs();
  const results = useMemo(() => {
    let out = query.trim() ? retrieve(docs, query, filter, 1000) : docs.filter((d) => filter === "all" || d.source === filter);
    if (sort === "recent") out = [...out].sort((a, b) => b.updated.localeCompare(a.updated));
    return out;
  }, [docs, query, filter, sort]);
  return (
    <section className="page-view" id="searchView">
      <div className="search-input-wrap">
        <Icon name="search" />
        <input ref={inputRef} placeholder="Search people, projects, messages, ideas..." aria-label="Search your memories" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button
          className="icon-button"
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setQuery("");
            inputRef.current?.focus();
          }}
        >
          <Icon name="x" />
        </button>
      </div>
      <FilterTabs value={filter} onChange={setFilter} />
      <div className="results-heading">
        <span>
          {results.length} {results.length === 1 ? "memory" : "memories"}
          {query ? ` for "${query}"` : ""}
        </span>
        <select aria-label="Sort search results" value={sort} onChange={(e) => setSort(e.target.value as "relevance" | "recent")}>
          <option value="relevance">Most relevant</option>
          <option value="recent">Most recent</option>
        </select>
      </div>
      <div className="document-list">
        {results.length ? (
          results.map((d) => <DocumentCard key={d.id} d={d} />)
        ) : (
          <EmptyState
            icon="search"
            title="No dots to connect. Yet."
            action={
              <button
                className="button secondary"
                type="button"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                Clear search &amp; filters
              </button>
            }
          >
            Try another phrase or search across all sources.
          </EmptyState>
        )}
      </div>
    </section>
  );
}

export function MemoriesView() {
  const jeff = useJeff();
  const params = useSearchParams();
  const collection = params.get("collection");
  const [filter, setFilter] = useState(params.get("source") ?? "all");
  const docs = jeff.docs().filter((d) => (filter === "all" || d.source === filter) && (!collection || (d.tags ?? []).includes(collection)));
  return (
    <section className="page-view" id="memoriesView">
      {collection ? (
        <div className="preview-banner">
          <Icon name="layers" />
          <span>
            Collection: <strong>{COLLECTIONS[collection] ?? collection}</strong>
          </span>
        </div>
      ) : null}
      <FilterTabs value={filter} onChange={setFilter} />
      <div className="document-list">
        {docs.length ? docs.map((d) => <DocumentCard key={d.id} d={d} />) : <EmptyState title="Nothing here just yet.">Connect a source, choose another filter, or add a note.</EmptyState>}
      </div>
    </section>
  );
}

export function SavedView() {
  const jeff = useJeff();
  return (
    <section className="page-view" id="savedView">
      <div className="saved-list">
        {jeff.saved.length ? (
          jeff.saved.map((a) => (
            <article className="saved-card" key={a.id}>
              <h3>{a.question}</h3>
              <p style={{ whiteSpace: "pre-wrap" }}>{a.text}</p>
              <div className="saved-card-footer">
                <span>
                  {shortDate(a.savedAt)} &middot; {a.mode}
                </span>
                <button className="text-button" type="button" onClick={() => jeff.deleteSaved(a.id)}>
                  <Icon name="trash" />
                  Remove
                </button>
              </div>
            </article>
          ))
        ) : (
          <EmptyState
            icon="bookmark"
            title="Keep the good thoughts."
            action={
              <button className="button primary" type="button" onClick={() => jeff.setAgentOpen(true)}>
                Ask Jeff
              </button>
            }
          >
            Ask Jeff a question, then save an answer. It will be waiting right here.
          </EmptyState>
        )}
      </div>
    </section>
  );
}
