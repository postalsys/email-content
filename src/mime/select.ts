/**
 * Which parts of a MIME tree hold the message body.
 *
 * This used to be four lines: walk the flat part list, keep the longest `text/plain` and the
 * longest `text/html`. That is wrong in a way that loses content silently. In
 * `multipart/mixed(P, P)` the two children are not two renderings of one thing, they are two
 * pieces of the message, and picking the longer one deleted the shorter. A three line authored
 * reply followed by a long gateway disclaimer came out as the disclaimer alone, with no warning.
 *
 * MIME structure carries the meaning that length does not:
 *
 * - `multipart/alternative` holds alternative renderings of the same content. At most one text and
 *   one HTML representation come out of one group.
 * - `multipart/mixed` holds ordered sibling content, all of which may belong to the visible message.
 *   Each body-bearing child is an independent section.
 * - `multipart/related` holds one root body plus inline resources. The root is named by the
 *   container's `start` parameter or is simply the first child.
 * - `message/rfc822` is embedded content, not the container's own body.
 * - An attachment disposition excludes a part. The *absence* of one does not make sibling parts
 *   alternatives, which is the assumption the old code made.
 *
 * Length survives only as a tie breaker inside one structurally equivalent group. Document order
 * decides everything else.
 */

import { type MimePart, type ParsedMessage } from './model';

/** Where a section sits in the message. The first body-bearing section is the primary one. */
export type SectionRole = 'primary' | 'appended';

/** One structurally independent piece of the body, in whichever representations it has. */
export interface PlannedSection {
    text: MimePart | null;
    html: MimePart | null;
    role: SectionRole;
}

/** Why an eligible looking text part is not in the plan. Machine readable, never free text. */
export type ExclusionReason =
    /** Another member of the same `multipart/alternative` group represents this content. */
    | 'alternative_not_preferred'
    /** An inline resource of a `multipart/related`, not its root. */
    | 'related_resource'
    /** Inside a `message/rfc822`. Embedded messages are content for the caller to render, not body. */
    | 'embedded_message'
    /** Carried an attachment disposition. */
    | 'attachment'
    /** Nesting deeper than the walk is willing to follow. */
    | 'max_depth_exceeded';

export interface ExcludedPart {
    partId: string;
    reason: ExclusionReason;
}

export interface BodyPlan {
    /** Body-bearing sections in document order. Empty when the message has no body. */
    sections: PlannedSection[];
    excluded: ExcludedPart[];
}

/**
 * Nesting depth the walk follows.
 *
 * Real mail nests a handful of levels. The parser already caps the part count; this caps the shape,
 * so a tree crafted to be deep rather than wide cannot drive the recursion into the stack.
 */
const MAX_DEPTH = 32;

function isEligibleLeaf(part: MimePart): boolean {
    return (part.contentType === 'text/plain' || part.contentType === 'text/html') && part.disposition !== 'attachment' && Boolean(part.decoded);
}

/** Every text leaf under a subtree, for recording what a whole branch excluded. */
function textLeavesUnder(message: ParsedMessage, part: MimePart, into: ExcludedPart[], reason: ExclusionReason, depth = 0): void {
    if (depth > MAX_DEPTH) {
        return;
    }
    if (isEligibleLeaf(part)) {
        into.push({ partId: part.partId, reason });
        return;
    }
    for (const childId of part.childIds) {
        const child = message.partsById.get(childId);
        if (child) {
            textLeavesUnder(message, child, into, reason, depth + 1);
        }
    }
}

/** Normalise a `Content-ID` or a `start` parameter to a bare token for comparison. */
function normaliseContentId(value: string | null | undefined): string {
    return (value ?? '').trim().replace(/^</, '').replace(/>$/, '').toLowerCase();
}

function contentIdOf(part: MimePart): string {
    return normaliseContentId(part.headers.find(entry => entry.key === 'content-id')?.value);
}

/** The root body of a `multipart/related`: named by `start`, else the first child. */
function relatedRoot(message: ParsedMessage, part: MimePart): MimePart | null {
    const children = part.childIds.map(id => message.partsById.get(id)).filter(Boolean) as MimePart[];
    if (!children.length) {
        return null;
    }
    const start = normaliseContentId(part.contentTypeParams.start);
    if (start) {
        const named = children.find(child => contentIdOf(child) === start);
        if (named) {
            return named;
        }
    }
    return children[0] as MimePart;
}

function sectionsOf(message: ParsedMessage, part: MimePart, excluded: ExcludedPart[], depth: number): PlannedSection[] {
    if (depth > MAX_DEPTH) {
        textLeavesUnder(message, part, excluded, 'max_depth_exceeded');
        return [];
    }

    if (part.disposition === 'attachment') {
        if (isEligibleLeaf(part) || part.contentType === 'text/plain' || part.contentType === 'text/html') {
            excluded.push({ partId: part.partId, reason: 'attachment' });
        }
        return [];
    }

    // An embedded message is content to classify or to render as an attachment, never the outer
    // message's own body. Descending into one lets a forwarded thread replace what the sender wrote.
    if (part.rfc822 || part.embeddedRoot) {
        textLeavesUnder(message, part, excluded, 'embedded_message');
        return [];
    }

    const children = part.childIds.map(id => message.partsById.get(id)).filter(Boolean) as MimePart[];

    if (part.multipart === 'alternative') {
        // The unit of choice is a *branch*, not a part.
        //
        // An alternative member can itself be multipart, and `alternative(P, mixed(H, app, H))` is
        // real mail: the HTML rendering is spread over two parts. Choosing "the last html part"
        // there keeps the second and deletes the first, which is the loss this module exists to
        // stop. So each branch is evaluated whole, the last branch offering each representation
        // wins, and the two winners are paired position by position.
        const branches = children.map(child => ({ child, sections: sectionsOf(message, child, excluded, depth + 1) }));
        const textBranch = [...branches].reverse().find(branch => branch.sections.some(section => section.text));
        const htmlBranch = [...branches].reverse().find(branch => branch.sections.some(section => section.html));

        for (const branch of branches) {
            if (branch !== textBranch && branch !== htmlBranch) {
                textLeavesUnder(message, branch.child, excluded, 'alternative_not_preferred');
            }
        }

        if (!textBranch || textBranch === htmlBranch) {
            return htmlBranch?.sections ?? [];
        }
        if (!htmlBranch) {
            return textBranch.sections;
        }

        // Two different branches, so one supplies the text rendering and the other the HTML one.
        // Pairing by position keeps a multi part branch intact instead of flattening it.
        const merged: PlannedSection[] = [];
        const length = Math.max(textBranch.sections.length, htmlBranch.sections.length);
        for (let i = 0; i < length; i++) {
            const fromText = textBranch.sections[i];
            const fromHtml = htmlBranch.sections[i];
            if (fromText?.html) {
                excluded.push({ partId: fromText.html.partId, reason: 'alternative_not_preferred' });
            }
            if (fromHtml?.text) {
                excluded.push({ partId: fromHtml.text.partId, reason: 'alternative_not_preferred' });
            }
            const text = fromText?.text ?? null;
            const html = fromHtml?.html ?? null;
            if (text || html) {
                merged.push({ text, html, role: 'primary' });
            }
        }
        return merged;
    }

    if (part.multipart === 'related') {
        const root = relatedRoot(message, part);
        const sections: PlannedSection[] = [];
        for (const child of children) {
            if (child === root) {
                sections.push(...sectionsOf(message, child, excluded, depth + 1));
            } else {
                textLeavesUnder(message, child, excluded, 'related_resource');
            }
        }
        return sections;
    }

    if (part.multipart) {
        // mixed, signed, report, digest and anything unrecognised. Ordered sibling content: keep
        // every body-bearing child, in document order. Treating an unknown subtype as mixed retains
        // more rather than less, which is the safe direction when a tree is malformed or novel.
        const sections: PlannedSection[] = [];
        for (const child of children) {
            sections.push(...sectionsOf(message, child, excluded, depth + 1));
        }
        return sections;
    }

    if (part.contentType === 'text/plain' && part.decoded) {
        return [{ text: part, html: null, role: 'primary' }];
    }
    if (part.contentType === 'text/html' && part.decoded) {
        return [{ text: null, html: part, role: 'primary' }];
    }
    return [];
}

/**
 * Build the ordered body plan for a parsed message.
 *
 * The first body-bearing section is `primary`; everything after it is `appended`. Appended sections
 * are ordinary content until a rule says otherwise: gateways append substantive text as often as
 * they append disclaimers, so position is evidence, not a label.
 */
export function planBody(message: ParsedMessage): BodyPlan {
    const root = message.partsById.get(message.rootId) ?? message.parts[0];
    if (!root) {
        return { sections: [], excluded: [] };
    }

    const excluded: ExcludedPart[] = [];
    const sections = sectionsOf(message, root, excluded, 0).filter(section => section.text || section.html);

    return {
        sections: sections.map((section, index) => ({ ...section, role: index === 0 ? 'primary' : 'appended' })),
        excluded
    };
}

/**
 * Exclusions a caller should be told about.
 *
 * An unused `multipart/alternative` member, an attachment and an embedded message are all excluded
 * by a written rule and are not losses. A text part dropped because it was not the related root, or
 * because the tree nested past the walk's limit, is content that exists and is not represented.
 */
export function reportableExclusions(plan: BodyPlan): ExcludedPart[] {
    return plan.excluded.filter(entry => entry.reason === 'related_resource' || entry.reason === 'max_depth_exceeded');
}
