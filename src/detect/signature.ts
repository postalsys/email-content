/**
 * Signature detection.
 *
 * Signatures are collapsed, never hidden, so this only needs to be good enough to demote a trailing
 * block. Two rules carry almost all the weight:
 *
 *   - The RFC 3676 delimiter, a line containing exactly "-- " (trailing space) or "--". This is the
 *     one high confidence signal.
 *   - Position plus shape: a short block of short lines at the very end of a message, containing
 *     contact-like content.
 *
 * A signature that contains quote-looking text, a legal footer, or a pasted email address must not
 * be promoted into reply history, which is why signature evidence is emitted for the block rather
 * than for individual lines.
 */

import { loadPatterns } from './patterns';
import { type Evidence } from '../segment/types';
import { type BlockFeatures } from '../segment/types';

/** Signatures beyond this many lines are almost always something else. */
const MAX_SIGNATURE_LINES = 12;

/**
 * A signature sits after the sender's words, which in a reply with quoted history below can be
 * early by character position, not late. The classifier's walk back from the authored region is
 * what constrains location structurally; this gate only excludes the opening slice, where a
 * contact card is the message rather than a sign-off.
 */
const MIN_POSITION = 0.1;

export function detectSignatureDelimiter(line: string): Evidence | null {
    const patterns = loadPatterns();
    for (const pattern of patterns.signatureDelimiters) {
        if (pattern.regex.test(line)) {
            return { id: `signature:${pattern.id}`, kind: 'signature', strength: pattern.strength };
        }
    }
    return null;
}

/** Phrase level evidence, such as "Sent from my phone" or a closing greeting. */
export function detectSignaturePhrases(lines: readonly string[]): Evidence[] {
    const patterns = loadPatterns();
    const found = new Map<string, Evidence>();
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.length > 200) {
            continue;
        }
        for (const pattern of patterns.signaturePhrases) {
            if (pattern.regex.test(trimmed)) {
                const id = `signature:${pattern.id}`;
                const existing = found.get(id);
                if (!existing || existing.strength < pattern.strength) {
                    found.set(id, { id, kind: 'signature', strength: pattern.strength });
                }
            }
        }
    }
    return [...found.values()];
}

/**
 * Shape evidence for a whole block.
 *
 * Deliberately weak. It exists to nudge a genuine trailing signature over the collapse threshold
 * when combined with a phrase or a delimiter, not to classify on its own.
 */
export function detectSignatureShape(features: BlockFeatures): Evidence | null {
    if (features.isAllBlank || features.position < MIN_POSITION) {
        return null;
    }
    if (features.lineCount > MAX_SIGNATURE_LINES || features.wordCount > 80) {
        return null;
    }
    const contactish = features.hasEmailAddress || features.hasPhoneNumber || features.hasUrl;
    if (!contactish || features.shortLineRatio < 0.6) {
        return null;
    }
    // Trailing position and contact details, but no delimiter and no phrase. Enough to collapse
    // only in combination with something else.
    return { id: 'signature:shape', kind: 'signature', strength: 0.45 };
}
