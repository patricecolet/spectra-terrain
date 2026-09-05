import glyphSizes from './glyph-sizes.json';

// Track titles are spelled using individual glyph images cropped from the
// band's hand-drawn dotted alphabet sheet (b3typo.jpg) — no accents in that
// sheet, so titles are stored here without diacritics.
export const tracks = [
  { slug: 'if', title: 'If', file: '/album/tracks/02-if.mp3' },
  { slug: 'orange-pressee', title: 'Orange pressee', file: '/album/tracks/09-orange-pressee.mp3' },
];

export function trackBySlug(slug) {
  return tracks.find((t) => t.slug === slug);
}

// All glyph crops keep the alphabet sheet's real pixel proportions (recorded
// in glyph-sizes.json), so one scale factor applied uniformly reproduces the
// original size hierarchy: x-height letters end up visibly shorter than caps
// and ascenders/descenders, instead of every letter being stretched to the
// same box height.
const CAP_HEIGHT_REF = glyphSizes['H'].h;

// Builds a row of <img> glyphs (one per letter/digit) inside `container`,
// spelling `text`, scaled so a capital letter renders at `capHeightPx`.
export function renderGlyphTitle(container, text, capHeightPx = 18) {
  container.innerHTML = '';
  container.classList.add('glyph-row');
  const scale = capHeightPx / CAP_HEIGHT_REF;
  for (const ch of text) {
    if (ch === ' ') {
      const gap = document.createElement('span');
      gap.className = 'glyph-space';
      gap.style.width = `${capHeightPx * 0.35}px`;
      container.appendChild(gap);
      continue;
    }
    const key = /[a-z]/.test(ch) ? `lc_${ch}` : ch;
    const size = glyphSizes[key];
    if (!size) continue;
    const img = document.createElement('img');
    img.className = 'glyph';
    img.src = `/album/glyphs/${key}.png`;
    img.alt = ch;
    img.style.height = `${size.h * scale}px`;
    // Glyphs are tightly cropped to their own ink, so a descender's bottom
    // edge is the descender tip, not the baseline — align-items:flex-end
    // would otherwise pull every glyph's baseline to that tip. Pushing
    // descenders further down by their measured descent restores a shared
    // baseline, like real font metrics.
    if (size.descent) {
      img.style.marginBottom = `-${size.descent * scale}px`;
    }
    container.appendChild(img);
  }
}
