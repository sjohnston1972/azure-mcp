// Capture the React Flow canvas as a PNG data URL.
//
// Using html-to-image because it's tiny (no deps) and React Flow's
// own download-image example uses the same library — so the rendered
// SVG/HTML structure is known to convert cleanly.
//
// Why the font handling is so paranoid:
// html-to-image renders the DOM via SVG <foreignObject>. That
// off-screen rendering context only has access to fonts whose woff2
// data is INLINED into the SVG. Material Symbols (Google Fonts) is
// loaded from a CDN at runtime, so the foreignObject can't see the
// font files and falls back to the system font — which renders the
// ligature TEXT ('lan', 'shield', 'memory', …) instead of the icon
// glyph.
//
// We get fonts inlined by two paths, in order:
//   1. getFontEmbedCSS() — html-to-image walks document.styleSheets
//      and resolves URL() refs in @font-face rules. Requires the
//      stylesheet to be CORS-readable; the index.html link tags
//      have crossorigin="anonymous" for that reason.
//   2. Manual Google Fonts fetch — directly fetch the URLs in the
//      <link rel="stylesheet"> tags, parse @font-face rules out of
//      the response, fetch each woff2 and base64-inline it. This
//      runs even when (1) succeeds and the results concatenate, so
//      we still get fonts even when the browser blocks cssRules
//      access.

import { toPng, getFontEmbedCSS } from "html-to-image";

const CANVAS_SELECTOR = ".react-flow";

/** Convert an ArrayBuffer to base64 in chunks. Naive btoa(String.fromCharCode(...))
 *  blows the stack on large fonts; chunking sidesteps it. */
function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    bin += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(bin);
}

/** Fetch a Google Fonts CSS URL, inline every woff/woff2 referenced
 *  via url(...) as a data: URI, and return the resulting CSS string.
 *  Errors are swallowed — partial CSS is still better than nothing. */
async function fetchAndInlineGoogleFontsCss(href: string): Promise<string> {
  let css = "";
  try {
    const r = await fetch(href, { credentials: "omit" });
    if (!r.ok) return "";
    css = await r.text();
  } catch {
    return "";
  }

  // Find every url(...) in the CSS. Google Fonts ships rules like
  //   src: url(https://fonts.gstatic.com/s/...woff2) format('woff2');
  // and typically several blocks for unicode subsets. Dedupe so we
  // don't fetch the same woff2 twice.
  const matches = [...css.matchAll(/url\((https?:[^)]+)\)/g)];
  const urls = [...new Set(matches.map((m) => m[1]!))];

  for (const u of urls) {
    try {
      const fontRes = await fetch(u, { credentials: "omit" });
      if (!fontRes.ok) continue;
      const buf = await fontRes.arrayBuffer();
      const ext = (u.match(/\.(woff2|woff|ttf|otf)/i)?.[1] ?? "woff2").toLowerCase();
      const mime =
        ext === "woff2"
          ? "font/woff2"
          : ext === "woff"
            ? "font/woff"
            : ext === "ttf"
              ? "font/ttf"
              : "font/otf";
      const dataUrl = `data:${mime};base64,${bufferToBase64(buf)}`;
      // Replace every occurrence of this exact URL.
      const escaped = u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      css = css.replace(new RegExp(escaped, "g"), dataUrl);
    } catch {
      // skip this URL, keep going
    }
  }
  return css;
}

/** Walk the document for cross-origin Google Fonts stylesheets and
 *  produce a fully-inlined CSS blob suitable for html-to-image's
 *  fontEmbedCSS option. */
async function inlineGoogleFontsCSS(): Promise<string> {
  const links = [
    ...document.querySelectorAll<HTMLLinkElement>(
      'link[rel="stylesheet"][href*="fonts.googleapis.com"]'
    ),
  ];
  const blocks = await Promise.all(
    links.map((l) => fetchAndInlineGoogleFontsCss(l.href))
  );
  return blocks.filter(Boolean).join("\n");
}

/** Find the visible React Flow canvas in the DOM and serialise it
 *  to a PNG data URL. Returns null if no canvas is present (no
 *  active topology, or the canvas isn't mounted). */
export async function captureCanvasPng(): Promise<string | null> {
  const el = document.querySelector(CANVAS_SELECTOR) as HTMLElement | null;
  if (!el) return null;

  // Background colour: pull the page's surface tint so the PNG
  // doesn't come out transparent on dark mode. Falls back to white.
  const surface =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--md-sys-color-surface")
      .trim() || "#ffffff";

  // Resolve fonts via both paths and concatenate. Both are
  // best-effort — failures fall back to the next layer.
  const [embedded, googleFonts] = await Promise.all([
    getFontEmbedCSS(el).catch(() => ""),
    inlineGoogleFontsCSS(),
  ]);
  const fontEmbedCSS = [embedded, googleFonts].filter(Boolean).join("\n");

  return toPng(el, {
    cacheBust: true,
    pixelRatio: 2, // crisper for retina + GitHub's image viewer scaling
    backgroundColor: surface,
    fontEmbedCSS: fontEmbedCSS || undefined,
  });
}
