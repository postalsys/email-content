/**
 * Forward marker detection.
 *
 * Forwarded content was included on purpose, so a forward anchor opens a region that is collapsed
 * and kept, never hidden. That difference in consequence is why forward markers are detected
 * separately from reply markers rather than being folded into one "quote anchor" concept.
 */

import { loadPatterns } from './patterns';
import { type Evidence } from '../segment/types';

export function detectForwardMarker(line: string): Evidence | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 300) {
        return null;
    }
    const patterns = loadPatterns();
    let best: Evidence | null = null;
    for (const pattern of patterns.forwardHeaders) {
        // The bare "From:" pattern is only useful as part of a header block, which
        // detectQuotedHeaderBlock handles. Treating it as a forward anchor on its own would fire on
        // ordinary prose.
        if (pattern.id === 'fyi_forward_header_block') {
            continue;
        }
        if (!pattern.regex.test(trimmed)) {
            continue;
        }
        if (!best || pattern.strength > best.strength) {
            best = { id: `forward:${pattern.id}`, kind: 'forward-anchor', strength: pattern.strength };
        }
    }
    return best;
}
