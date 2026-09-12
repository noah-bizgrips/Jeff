import type { CSSProperties } from "react";

/** Inline icon set ported from the prototype (no external icon fonts/CDNs). */
const ICON_PATHS: Record<string, string> = {
  brain:
    '<path d="M12 5c-1-4-7-3-7 1-4 0-5 6-2 8-2 4 1 8 5 7 1 2 4 1 4-1V5Zm0 0c1-4 7-3 7 1 4 0 5 6 2 8 2 4-1 8-5 7-1 2-4 1-4-1V5Z"/><path d="M5 6c0 3 3 2 3 5m-5 3c3-2 5 0 5 3m4-7c-3-1-4 2-3 4m10-8c0 3-3 2-3 5m5 3c-3-2-5 0-5 3m-4-7c3-1 4 2 3 4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  network:
    '<circle cx="12" cy="11" r="3"/><circle cx="4" cy="4" r="2"/><circle cx="20" cy="4" r="2"/><circle cx="4" cy="20" r="2"/><circle cx="20" cy="20" r="2"/><path d="m6 6 4 3m4 0 4-3m-3 7 4 4m-9-4-4 4"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4V3Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  chevrons: '<path d="m9 9 3-3 3 3m-6 6 3 3 3-3"/>',
  chevronDown: '<path d="m7 10 5 5 5-5"/>',
  settings:
    '<path d="m10 3-1 3-3 1-3 3 2 2-1 3 3 2 2 4 3-1 3 1 2-4 3-2-1-3 2-2-3-3-3-1-1-3h-4Z"/><circle cx="12" cy="12" r="3"/>',
  grid: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/>',
  sliders: '<path d="M4 7h5m4 0h7M4 17h9m4 0h3"/><circle cx="11" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',
  link: '<path d="m10 14 4-4m-5 6-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 2 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 -1)"/>',
  plug: '<path d="m8 3 2 4m6-4-2 4M6 8h12v4a6 6 0 0 1-12 0V8Zm6 10v4"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m8 4 12 8-12 8V4Z"/>',
  arrowRight: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  arrowUpRight: '<path d="M6 18 18 6M6 6h12v12"/>',
  arrowUp: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/>',
  sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Zm7 0v4m-2-2h4M4 18v4m-2-2h4"/>',
  compose: '<path d="m16 3 5 5-11 11-6 1 1-6L16 3Zm-2 2 5 5M3 3h6M3 3v6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6m10-6v6M3 10h18m-14 4h3m4 0h3m-10 3h3"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',
  file: '<path d="M5 2h9l5 5v15H5V2Zm9 0v6h5M8 12h8m-8 4h6"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  refresh: '<path d="M20 7V2m0 5h-5M4 17v5m0-5h5M4 9a8 8 0 0 1 14-5l2 3M4 17l2 3a8 8 0 0 0 14-5"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/><path d="M12 3v3m0 12v3M3 12h3m12 0h3"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2Z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  inbox: '<path d="M3 13l2-8h14l2 8v6H3v-6Z"/><path d="M3 13h5l1.5 2h5L16 13h5"/>',
};

export type IconName = keyof typeof ICON_PATHS;

export function Icon({ name, className, style }: { name: string; className?: string; style?: CSSProperties }) {
  const path = ICON_PATHS[name] ?? ICON_PATHS.file!;
  return (
    <span className={className} aria-hidden="true" style={style} data-icon={name}>
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        dangerouslySetInnerHTML={{ __html: path }}
      />
    </span>
  );
}

const SOURCE_SVGS: Record<string, string> = {
  github: '<path d="M8 4 3 12l5 8m8-16 5 8-5 8M14 3l-4 18" stroke="#acd3ff" stroke-width="1.8" stroke-linecap="round"/>',
  n8n: '<path d="M5 12h6m0 0 5-6m-5 6 5 6" stroke="#67d4ef" stroke-width="1.8"/><g fill="#112440" stroke="#67d4ef" stroke-width="1.8"><circle cx="4" cy="12" r="2.5"/><circle cx="12" cy="12" r="2.5"/><circle cx="19" cy="5" r="2.5"/><circle cx="19" cy="19" r="2.5"/></g>',
  metaads: '<path d="M3 17 8 7l4 7 4-9 5 12" fill="none" stroke="#5b9dff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  facebook: '<path d="M14 4h4V1h-4c-4 0-6 2-6 6v3H5v4h3v9h4v-9h5l1-4h-6V7c0-2 1-3 2-3Z" fill="#79a9ff"/>',
  instagram:
    '<rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="#a788ff" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="#a788ff" stroke-width="2"/><circle cx="17.5" cy="6.5" r="1" fill="#a788ff"/>',
  stripe:
    '<path d="M6 8c0-2 2-4 6-4 2 0 4 .5 5.5 1.4L16 9c-1.3-.7-2.7-1.1-4-1.1-1.2 0-1.8.3-1.8.8 0 .6.9.8 2.7 1.3 3 .8 5.1 1.9 5.1 4.8 0 3.2-2.5 5.2-6.5 5.2-2.5 0-4.7-.6-6.5-1.7l1.5-3.7c1.6.9 3.3 1.4 5 1.4 1.3 0 2-.3 2-.9 0-.6-.9-.9-2.8-1.4C7.8 12.9 6 11.6 6 8Z" fill="#8aa4ff"/>',
  plaid: '<path d="M4 7 12 3l8 4-8 4-8-4Zm2 5h12M7 12v6m5-6v6m5-6v6M4 20h16" fill="none" stroke="#45c9ff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  gmail: '<path d="M3 6v13h4V10l5 4 5-4v9h4V6l-3-2-6 5-6-5Z" fill="#cf8b79"/><path d="m3 6 9 7 9-7v-2l-3-1-6 5-6-5-3 1Z" fill="#e1afa0"/>',
  slack:
    '<g stroke-width="4" stroke-linecap="round"><path d="M9 3v8M3 9h1" stroke="#88bfaa"/><path d="M21 9h-8M15 3v1" stroke="#93b9d3"/><path d="M15 21v-8M21 15h-1" stroke="#cbae7d"/><path d="M3 15h8M9 21v-1" stroke="#c293b7"/></g>',
  drive: '<path d="M9 3h6l7 12h-7Z" fill="#dcc381"/><path d="M9 3 2 15l3 5 7-12Z" fill="#9ebe95"/><path d="M2 15h20l-3 5H5Z" fill="#96b5d7"/>',
  notion: '<rect x="3" y="3" width="18" height="18" rx="2" fill="#dadbcd"/><path d="M7 17V7h2l7 10V7M6 7h4m4 0h3M6 17h3" fill="none" stroke="#272e23" stroke-width="1.3"/>',
  calendar:
    '<rect x="3" y="4" width="18" height="17" rx="2" fill="#99b9cd"/><path d="M3 8h18V5a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1Z" fill="#6c8eaa"/><path d="M7 2v4m10-4v4" stroke="#c3d3dd" stroke-width="2"/><text x="12" y="17" text-anchor="middle" font-size="9" font-weight="700" fill="#1e3541" font-family="sans-serif">31</text>',
  leadconnector: '<path d="M3 4h11v4H7v8h7v4H3Z" fill="#90b8d6"/><path d="m13 8 7 4-7 4" fill="none" stroke="#b6d3e6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
  google: '<circle cx="12" cy="12" r="8" fill="none" stroke="#75adff" stroke-width="2"/><path d="M12 8v8m-4-4h8" stroke="#75adff" stroke-width="2" stroke-linecap="round"/>',
  meta: '<path d="M3 17 8 7l4 7 4-9 5 12" fill="none" stroke="#5b9dff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  highlevel: '<path d="M3 4h11v4H7v8h7v4H3Z" fill="#90b8d6"/><path d="m13 8 7 4-7 4" fill="none" stroke="#b6d3e6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
  claude: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" fill="none" stroke="#80bdff" stroke-width="1.6" stroke-linejoin="round"/>',
};
const DEFAULT_SOURCE_SVG =
  '<path d="M5 3h10l4 4v14H5Z" fill="none" stroke="#80bdff" stroke-width="1.5"/><path d="M8 9h8m-8 4h8m-8 4h5" stroke="#80bdff" stroke-width="1.5"/>';

export function SourceIcon({ id, className = "" }: { id: string; className?: string }) {
  return (
    <span className={`source-icon ${className}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" dangerouslySetInnerHTML={{ __html: SOURCE_SVGS[id] ?? DEFAULT_SOURCE_SVG }} />
    </span>
  );
}
