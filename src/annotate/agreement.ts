/**
 * Agreement between annotators.
 *
 * `evaluate` scores the extractor against a reference. This scores an annotator against other
 * annotators, which is the question a new annotator has to answer before its labels are worth
 * anything: two strong models agree on 97.6 percent of blocks and a weak one on 80.5
 * (docs/annotation.md), so a candidate's agreement with the strong models says which of those it
 * resembles.
 *
 * Pure over rows, so it is testable without a database.
 */

import { type Label } from '../types';
import { applyCostRule, AUTHORED_LABELS, type LabelProbabilities } from './probabilities';

export interface AnnotatedBlock {
    path: string;
    representation: string;
    blockIndex: number;
    mimePart: string | null;
    blockStart: number | null;
    blockEnd: number | null;
    charCount: number;
    label: Label;
    probabilities: LabelProbabilities | null;
    lang: string | null;
}

export interface PairCount {
    reference: Label;
    candidate: Label;
    blocks: number;
}

export interface ReferenceAgreement {
    name: string;
    /** Blocks labelled by both the candidate and this reference. */
    shared: number;
    agreed: number;
    sharedChars: number;
    agreedChars: number;
    /** The candidate would hide what this reference calls authored: the expensive direction. */
    expensive: { blocks: number; chars: number };
    /** The candidate leaves visible what this reference calls history: the cheap direction. */
    cheap: { blocks: number; chars: number };
    /** Most frequent disagreements, largest first. */
    pairs: PairCount[];
    perLabel: { label: Label; support: number; agreed: number }[];
    perLang: { lang: string; shared: number; agreed: number }[];
}

export interface AgreementReport {
    candidateBlocks: number;
    /** Candidate blocks no reference has a label for, usually because segmentation changed. */
    unmatched: number;
    /** Cost ratio re-applied to the candidate's stored distributions, or null for stored labels. */
    costRatio: number | null;
    /** Candidate blocks whose label was recomputed from a stored distribution. */
    rescored: number;
    references: ReferenceAgreement[];
    /**
     * Blocks every reference calls authored and the candidate would hide. The gate number: an
     * annotator that hides what all strong models agree was written by the sender cannot be used
     * to size content loss, whatever its overall agreement.
     */
    consensusExpensive: { blocks: number; chars: number; shared: number };
}

/**
 * Identity of a block. Offsets as well as the index, because annotation runs made under different
 * extractor versions can segment the same message differently, and pairing block 7 with a
 * different block 7 would count a segmentation change as a disagreement.
 */
export function blockKey(block: Pick<AnnotatedBlock, 'path' | 'representation' | 'blockIndex' | 'mimePart' | 'blockStart' | 'blockEnd'>): string {
    return [block.path, block.representation, block.mimePart ?? '', block.blockIndex, block.blockStart ?? '', block.blockEnd ?? ''].join('\u0000');
}

function byKey(blocks: readonly AnnotatedBlock[]): Map<string, AnnotatedBlock> {
    // Later entries win, so callers pass rows in run order and get the latest label per block.
    return new Map(blocks.map(block => [blockKey(block), block]));
}

interface Tally {
    total: number;
    agreed: number;
}

function tally<K>(map: Map<K, Tally>, key: K, agreed: boolean): void {
    const entry = map.get(key) ?? { total: 0, agreed: 0 };
    entry.total++;
    entry.agreed += agreed ? 1 : 0;
    map.set(key, entry);
}

/** The candidate's effective label per block, after any cost rule re-application. */
interface Judged {
    label: Label;
    charCount: number;
}

function compareOne(name: string, candidate: Map<string, Judged>, reference: Map<string, AnnotatedBlock>): ReferenceAgreement {
    const result: ReferenceAgreement = {
        name,
        shared: 0,
        agreed: 0,
        sharedChars: 0,
        agreedChars: 0,
        expensive: { blocks: 0, chars: 0 },
        cheap: { blocks: 0, chars: 0 },
        pairs: [],
        perLabel: [],
        perLang: []
    };
    const pairs = new Map<string, PairCount>();
    const byLabel = new Map<Label, Tally>();
    const byLang = new Map<string, Tally>();

    for (const [key, { label, charCount }] of candidate) {
        const ref = reference.get(key);
        if (!ref) {
            continue;
        }
        const agreed = label === ref.label;
        result.shared++;
        result.sharedChars += charCount;
        tally(byLabel, ref.label, agreed);
        tally(byLang, ref.lang ?? 'unknown', agreed);
        if (agreed) {
            result.agreed++;
            result.agreedChars += charCount;
            continue;
        }
        const pairKey = `${ref.label}|${label}`;
        const pair = pairs.get(pairKey) ?? { reference: ref.label, candidate: label, blocks: 0 };
        pair.blocks++;
        pairs.set(pairKey, pair);
        if (label === 'REPLY_HISTORY' && AUTHORED_LABELS.has(ref.label)) {
            result.expensive.blocks++;
            result.expensive.chars += charCount;
        } else if (ref.label === 'REPLY_HISTORY' && AUTHORED_LABELS.has(label)) {
            result.cheap.blocks++;
            result.cheap.chars += charCount;
        }
    }

    result.pairs = [...pairs.values()].sort((a, b) => b.blocks - a.blocks || `${a.reference}${a.candidate}`.localeCompare(`${b.reference}${b.candidate}`));
    result.perLabel = [...byLabel].map(([label, { total, agreed }]) => ({ label, support: total, agreed })).sort((a, b) => b.support - a.support);
    result.perLang = [...byLang].map(([lang, { total, agreed }]) => ({ lang, shared: total, agreed })).sort((a, b) => b.shared - a.shared);
    return result;
}

/**
 * Compare a candidate annotator against one or more references.
 *
 * @param candidate the candidate's labels, in run order
 * @param references each reference's labels, in run order
 * @param costRatio when set, re-derive the candidate's label from its stored distribution with
 *   this ratio instead of using the stored label; blocks without a distribution keep their label
 */
export function compareAnnotators(
    candidate: readonly AnnotatedBlock[],
    references: readonly { name: string; blocks: readonly AnnotatedBlock[] }[],
    costRatio: number | null = null
): AgreementReport {
    const judged = new Map<string, Judged>();
    let rescored = 0;
    for (const [key, block] of byKey(candidate)) {
        const rescore = costRatio !== null && block.probabilities !== null;
        rescored += rescore ? 1 : 0;
        judged.set(key, { label: rescore ? applyCostRule(block.probabilities as LabelProbabilities, costRatio) : block.label, charCount: block.charCount });
    }

    const referenceMaps = references.map(reference => ({ name: reference.name, blocks: byKey(reference.blocks) }));

    let unmatched = 0;
    const consensusExpensive = { blocks: 0, chars: 0, shared: 0 };
    for (const [key, { label, charCount }] of judged) {
        const refs = referenceMaps.map(reference => reference.blocks.get(key));
        if (!refs.some(Boolean)) {
            unmatched++;
        }
        if (!referenceMaps.length || !refs.every(Boolean)) {
            continue;
        }
        consensusExpensive.shared++;
        if (label === 'REPLY_HISTORY' && refs.every(ref => AUTHORED_LABELS.has((ref as AnnotatedBlock).label))) {
            consensusExpensive.blocks++;
            consensusExpensive.chars += charCount;
        }
    }

    return {
        candidateBlocks: judged.size,
        unmatched,
        costRatio,
        rescored,
        references: referenceMaps.map(reference => compareOne(reference.name, judged, reference.blocks)),
        consensusExpensive
    };
}
