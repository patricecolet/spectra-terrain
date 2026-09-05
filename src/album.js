import glyphSizes from './glyph-sizes.json';

// Track titles are spelled using individual glyph images cropped from the
// band's hand-drawn dotted alphabet sheet (b3typo.jpg) — no accents in that
// sheet, so titles are stored here without diacritics.
export const tracks = [
  { slug: 'alpha', title: 'Alpha', file: '/album/tracks/01-alpha.mp3' },
  { slug: 'if', title: 'If', file: '/album/tracks/02-if.mp3' },
  { slug: 'jingle-cage', title: 'Jingle cage', file: '/album/tracks/03-jingle-cage.mp3' },
  { slug: 'selamane', title: 'Selamane', file: '/album/tracks/04-selamane.mp3' },
  { slug: 'jingle-cage-2', title: 'Jingle cage 2', file: '/album/tracks/05-jingle-cage-2.mp3' },
  { slug: 'tete', title: 'Tete', file: '/album/tracks/06-tete.mp3' },
  { slug: 'jingle-cage-3-vs-dom', title: 'Jingle cage 3 vs dom', file: '/album/tracks/07-jingle-cage-3-vs-dom.mp3' },
  { slug: 'cage', title: 'Cage', file: '/album/tracks/08-cage.mp3' },
  { slug: 'orange-pressee', title: 'Orange pressee', file: '/album/tracks/09-orange-pressee.mp3' },
];

// Shown in the top tracklist and playable by default when the page opens;
// the rest exist (deep links to their #slug still work) but stay tucked away
// behind the "morceaux affichés" checkboxes in the tuning panel until turned
// on there.
export const DEFAULT_VISIBLE_SLUGS = ['if', 'orange-pressee'];

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
