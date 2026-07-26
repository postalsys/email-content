/**
 * Normalisation for history matching.
 *
 * The same sentence, quoted by a mail client, is rarely byte identical to the original. It has been
 * re-wrapped, prefixed with ">", had its entities decoded or re-encoded, had non-breaking spaces
 * substituted, had smart quotes swapped for straight ones, and may have been transcoded through a
 * legacy charset and back.
 *
 * Matching therefore happens on a normalised projection: aggressive enough to survive all of that,
 * conservative enough that two genuinely different sentences do not collide. Note the asymmetry in
 * consequences here is the opposite of the rest of the pipeline: a false match causes content to be
 * hidden, so this normalisation deliberately stops short of stemming, case folding of proper nouns,
 * or anything else that would let distinct text collapse together.
 */

/** Punctuation and whitespace variants that clients substitute freely. */
const REPLACEMENTS: readonly [RegExp, string][] = [
    [/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' '], // exotic spaces
    [/[\u200b-\u200d\ufeff\u00ad]/g, ''], // zero width and soft hyphens
    [/[‘’‚‛′‵]/g, "'"], // single quotes
    [/[“”„‟″‶]/g, '"'], // double quotes
    [/[‐-―−]/g, '-'], // dashes
    [/[…]/g, '...'],
    [/[•·⁃]/g, '*'] // bullets
];

/**
 * Normalise text for comparison.
 *
 * Quote prefixes are stripped, whitespace is collapsed to single spaces, punctuation variants are
 * folded, and the result is lowercased. Line structure is deliberately discarded, because re-wrapping
 * is the single most common transformation a quoted message undergoes.
 */
export function normaliseForMatch(text: string): string {
    let out = text;
    try {
        out = out.normalize('NFC');
    } catch {
        // Unnormalisable input still compares usefully.
    }
    out = out.replace(/^[ \t]{0,3}(?:>[ \t]?)+/gm, '');
    for (const [pattern, replacement] of REPLACEMENTS) {
        out = out.replace(pattern, replacement);
    }
    return out.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Word tokens used for shingling and alignment. */
export function tokenise(normalised: string): string[] {
    return normalised.split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 0);
}

/**
 * Minimum tokens before a block is worth matching at all.
 *
 * Short blocks match by coincidence. "Thanks", "Yes", "Best regards" and "OK" appear in almost
 * every thread, so a match on them says nothing about whether this particular text was quoted. Nine
 * tokens is roughly a full sentence.
 */
export const MIN_MATCH_TOKENS = 9;
