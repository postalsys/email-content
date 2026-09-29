import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { auditPatterns, type AuditBlock } from '../src/eval/pattern-audit';
import { segmentLookup } from '../src/eval/reference';
import { type Segment } from '../src/types';

function block(overrides: Partial<AuditBlock>): AuditBlock {
    return { reference: 'NEW_CONTENT', predicted: 'NEW_CONTENT', hidden: false, chars: 10, evidence: [], reasons: [], ...overrides };
}

const anchor = { id: 'reply:on_x_wrote_en', kind: 'reply-anchor' };
const signature = { id: 'signature:best_regards', kind: 'signature' };

describe('pattern audit', () => {
    it('scores a pattern against the labels its evidence kind implies', () => {
        const audit = auditPatterns([
            block({ reference: 'REPLY_HISTORY', evidence: [anchor] }),
            block({ reference: 'REPLY_HISTORY', evidence: [anchor, anchor] }),
            block({ reference: 'NEW_CONTENT', evidence: [anchor] })
        ]);
        const row = audit.evidence.find(item => item.key === anchor.id);
        assert.ok(row);
        // The duplicate hit inside one block still counts one block.
        assert.equal(row.blocks, 3);
        assert.equal(row.matching, 2);
        assert.equal(row.scored, 3);
        assert.equal(row.authored, 1);
    });

    it('counts authored blocks the extractor hid as lost, and ranks them first', () => {
        const audit = auditPatterns([
            block({ reference: 'REPLY_HISTORY', evidence: [signature] }),
            block({ reference: 'INLINE_QUOTE', predicted: 'REPLY_HISTORY', hidden: true, chars: 40, evidence: [anchor], reasons: ['preceded_by_reply_header'] })
        ]);
        assert.equal(audit.evidence[0]?.key, anchor.id);
        assert.equal(audit.evidence[0]?.authoredHidden, 1);
        assert.equal(audit.evidence[0]?.authoredHiddenChars, 40);
        const reason = audit.reasons.find(item => item.key === 'preceded_by_reply_header -> REPLY_HISTORY');
        assert.equal(reason?.matching, 0);
        assert.equal(reason?.authoredHidden, 1);
    });

    it('leaves quoted sign-offs out of a signature pattern precision', () => {
        const audit = auditPatterns([
            block({ reference: 'REPLY_HISTORY', evidence: [signature] }),
            block({ reference: 'SIGNATURE', evidence: [signature] }),
            block({ reference: 'NEW_CONTENT', evidence: [signature] })
        ]);
        const row = audit.evidence.find(item => item.key === signature.id);
        assert.equal(row?.scored, 2);
        assert.equal(row?.matching, 1);
    });

    it('reports hint evidence without a precision', () => {
        const audit = auditPatterns([block({ evidence: [{ id: 'html:outlook_mso_normal', kind: 'hint' }] })]);
        assert.equal(audit.evidence[0]?.expected, null);
    });
});

describe('segment lookup', () => {
    const segment = (part: string, blockIndex: number, type: Segment['type'], visibility: Segment['visibility']): Segment => ({
        type,
        text: '',
        confidence: 1,
        visibility,
        reasons: [],
        source: { kind: 'mime-part', mimePart: part, representation: 'text', blockIndex, start: 0, end: 0 }
    });

    it('fills forward within a part and keeps parts apart', () => {
        const { lookup, emitted } = segmentLookup(
            [segment('1', 0, 'NEW_CONTENT', 'show'), segment('2', 0, 'SIGNATURE', 'collapse')],
            [segment('1', 3, 'REPLY_HISTORY', 'hide')]
        );
        assert.deepEqual(lookup('1', 2), { label: 'NEW_CONTENT', hidden: false });
        assert.deepEqual(lookup('1', 7), { label: 'REPLY_HISTORY', hidden: true });
        assert.deepEqual(lookup('2', 5), { label: 'SIGNATURE', hidden: false });
        // An annotation without a recorded part falls back to the first part the output used.
        assert.deepEqual(lookup(null, 4), { label: 'REPLY_HISTORY', hidden: true });
        // A recorded part the output never used is not scored against some other part.
        assert.equal(emitted('3'), false);
        assert.equal(lookup('3', 0), null);
    });
});
