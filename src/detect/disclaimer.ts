/**
 * Legal and organisational footer detection.
 *
 * A disclaimer is appended by a gateway or a policy engine rather than typed by the sender, so it
 * is collapsed by default. Detection requires both a phrase match and a trailing position: a
 * discussion that happens to mention confidentiality in the middle of a thread is ordinary content
 * and must stay visible.
 */

import { loadPatterns } from './patterns';
import { type Evidence } from '../segment/types';
import { type BlockFeatures } from '../segment/types';

/** Disclaimers live at the end. Anything earlier is discussion about a disclaimer. */
const MIN_POSITION = 0.4;

export function detectDisclaimer(text: string, features: BlockFeatures): Evidence[] {
    if (features.position < MIN_POSITION || features.isAllBlank) {
        return [];
    }
    const patterns = loadPatterns();
    const found: Evidence[] = [];
    for (const pattern of patterns.disclaimerPhrases) {
        if (pattern.regex.test(text)) {
            found.push({ id: `disclaimer:${pattern.id}`, kind: 'disclaimer', strength: pattern.strength });
        }
    }
    return found;
}
