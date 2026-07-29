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

/**
 * Disclaimers live after the sender's own words, but not necessarily late in the document: in a
 * notification reply the footer sits between a short comment and a long quoted thread, which puts
 * it early by character position. The old 0.4 gate looked like it worked only because HTML
 * positions were measured against raw markup, where a large style block pushed every visible block
 * past the gate. Once positions became honest the gate cost half of measured recall while the
 * pattern tightening already carried the precision, so only the opening slice is excluded now.
 */
const MIN_POSITION = 0.1;

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
