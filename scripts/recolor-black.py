"""One-off migration helper: map every hard-coded color in app/globals.css to the
premium-black tokens by hue/lightness, and rewrite :root. Kept for provenance;
safe to delete after the redesign lands."""
import re, colorsys, sys

p = sys.argv[1] if len(sys.argv) > 1 else "app/globals.css"
src = open(p).read()

TOK = {
    "background": "#050505", "sidebar": "#070707", "surface-1": "#0A0A0C", "surface-2": "#0E0E11",
    "surface-3": "#111114", "surface-hover": "#151518", "input": "#0C0C0E", "border": "#1B1B1F",
    "border-strong": "#29292E", "text-faint": "#4C4C53", "text-muted": "#7A7A83",
    "text-secondary": "#A1A1AA", "text-primary": "#F5F5F7", "accent": "#4DA3FF",
    "accent-bright": "#78BEFF", "success": "#58D39D", "warning": "#E4B669", "danger": "#E57777",
}


def rgb(h):
    h = h.lstrip("#")
    if len(h) in (3, 4):
        h = "".join(c * 2 for c in h)
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    a = int(h[6:8], 16) / 255 if len(h) == 8 else None
    return r, g, b, a


def classify(h):
    r, g, b, a = rgb(h)
    H, L, S = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    H *= 360
    if S < 0.12 and (L < 0.02 or L > 0.97):
        return None
    if 95 <= H <= 175 and S > 0.25:
        tok = "success" if L > 0.3 else "success-bg"
    elif 25 <= H <= 60 and S > 0.25:
        tok = "warning" if L > 0.3 else "warning-bg"
    elif (H < 22 or H > 325) and S > 0.25:
        tok = "danger" if L > 0.3 else "danger-bg"
    elif S > 0.55 and 195 <= H <= 235 and 0.45 <= L <= 0.85:
        tok = "accent-bright" if L > 0.72 else "accent"
    else:
        if L < 0.055: tok = "background"
        elif L < 0.085: tok = "surface-1"
        elif L < 0.115: tok = "surface-2"
        elif L < 0.15: tok = "surface-3"
        elif L < 0.20: tok = "surface-hover"
        elif L < 0.25: tok = "border"
        elif L < 0.33: tok = "border-strong"
        elif L < 0.45: tok = "text-faint"
        elif L < 0.60: tok = "text-muted"
        elif L < 0.78: tok = "text-secondary"
        else: tok = "text-primary"
    return tok, a


def out(h):
    c = classify(h)
    if c is None:
        return h
    tok, a = c
    if tok.endswith("-bg"):
        r, g, b, _ = rgb(TOK[tok[:-3]])
        alpha = 0.14 if a is None else max(0.06, min(a, 0.35))
        return f"rgba({r},{g},{b},{alpha:.2f})"
    if a is not None:
        if tok in ("accent", "accent-bright"):
            return "var(--accent-glow)" if a < 0.25 else "var(--accent-glow-strong)"
        r, g, b, _ = rgb(TOK[tok])
        return f"rgba({r},{g},{b},{a:.2f})"
    return f"var(--{tok})"


count = {}


def repl(m):
    o = out(m.group(0))
    count[o] = count.get(o, 0) + 1
    return o


body = re.sub(r":root \{[^}]*\}", "/*ROOT*/", src, count=1)
body = re.sub(r":root \{[^}]*\}", "", body)
body = re.sub(r"#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b", repl, body)
ROOT = """/* Jeff design system — premium black "Intelligence OS". Black is the environment, white is the information,
   electric blue is intelligence/activity. Tokens are the single source of truth; legacy names are aliases. */
:root {
  color-scheme: dark;
  --background: #050505;
  --sidebar: #070707;
  --surface-1: #0a0a0c;
  --surface-2: #0e0e11;
  --surface-3: #111114;
  --surface-hover: #151518;
  --input: #0c0c0e;
  --text-primary: #f5f5f7;
  --text-secondary: #a1a1aa;
  --text-muted: #7a7a83; /* >= 4.5:1 on #050505 */
  --text-faint: #4c4c53;
  --border: #1b1b1f;
  --border-strong: #29292e;
  --accent: #4da3ff;
  --accent-bright: #78beff;
  --accent-glow: rgba(77, 163, 255, 0.12);
  --accent-glow-strong: rgba(77, 163, 255, 0.18);
  --success: #58d39d;
  --warning: #e4b669;
  --danger: #e57777;
  --radius-sm: 5px;
  --radius: 8px;
  --radius-lg: 12px;
  --ease: 180ms cubic-bezier(0.2, 0, 0, 1);
  /* legacy aliases */
  --bg: var(--background);
  --panel: var(--surface-1);
  --card: var(--surface-2);
  --muted: var(--text-muted);
  --text: var(--text-primary);
  --accent-dim: var(--accent-glow);
  --glow: var(--accent);
  --cyan: var(--accent-bright);
  --font: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}"""
body = body.replace("/*ROOT*/", ROOT, 1)
body = body.replace(
    "/* Jeff design system — ported from the original Mission Control prototype. Midnight/navy, electric blue. */\n", ""
)
open(p, "w").write(body)
for k, v in sorted(count.items(), key=lambda x: -x[1])[:25]:
    print(v, k)
