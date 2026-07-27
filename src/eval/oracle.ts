/**
 * Independent safety oracles for the structural benchmark.
 *
 * The benchmark exists to detect the failure this project is built to prevent: a message that had
 * content going in and has none coming out. It cannot do that by asking the extractor, and the
 * previous version did exactly that:
 *
 *     const hadContent = visibleChars + hiddenChars > 0;
 *
 * That reads "did the input have content" off the output. When extraction dropped everything the
 * flag went false, the catastrophic counter did not increment, and the benchmark reported zero
 * losses while a reproducible total loss case existed.
 *
 * So the code here shares the *definition* of a body with the extractor, and shares none of its
 * *implementation*. It re-parses the message, walks the flat part list itself, and never calls the
 * selection logic it is meant to check. Re-parsing costs a second MIME pass per message, which is
 * the right trade for a release gate.
 */

import { canonicaliseText } from '../canonical/text';
import { stripTagsToText } from '../canonical/html';
import { normaliseForMatch } from '../match/normalize';
import { buildShingleIndex, containment, CONTAINMENT_THRESHOLD, isMatchable } from '../match/shingle';
import { type MimePart, type ParsedMessage } from '../mime/model';

/** Part ids that sit inside an embedded `message/rfc822`, which is content and not the outer body. */
export function embeddedPartIds(message: ParsedMessage): Set<string> {
    const containers = message.parts.filter(part => part.rfc822 || part.embeddedRoot);
    const inside = new Set<string>();
    if (!containers.length) {
        return inside;
    }
    for (const part of message.parts) {
        let cursor: MimePart | undefined = part;
        while (cursor?.parentId) {
            if (containers.some(container => container.partId === cursor?.parentId)) {
                inside.add(part.partId);
                break;
            }
            cursor = message.partsById.get(cursor.parentId);
        }
    }
    return inside;
}

/** A decoded body-bearing leaf, by the written MIME rules rather than by the selection heuristic. */
export function eligibleBodyParts(message: ParsedMessage): MimePart[] {
    const embedded = embeddedPartIds(message);
    return message.parts.filter(
        part =>
            (part.contentType === 'text/plain' || part.contentType === 'text/html') &&
            part.disposition !== 'attachment' &&
            Boolean(part.decoded) &&
            !embedded.has(part.partId)
    );
}

export interface InputInventory {
    /** Characters of plausibly visible body text across every eligible part. */
    visibleChars: number;
    /** Eligible non attachment body leaves, whether or not they hold visible text. */
    eligibleParts: number;
    /** True when at least one eligible part holds visible text. */
    hasVisibleText: boolean;
}

/**
 * Count plausible visible body text in a parsed message, before extraction runs.
 *
 * Deliberately over-inclusive: it counts every eligible part, including both members of a
 * `multipart/alternative`, because its only question is whether the message had anything visible to
 * show. It is not, and must not be used as, a demand that every part appear in the output.
 *
 * Script, style, comment and markup text is excluded, so an image-only newsletter or a body that is
 * nothing but a tracking pixel does not count as visible text that extraction then lost.
 */
export function inventoryVisibleInput(message: ParsedMessage): InputInventory {
    let visibleChars = 0;
    const parts = eligibleBodyParts(message);
    for (const part of parts) {
        visibleChars += visibleTextOf(part).length;
    }
    return { visibleChars, eligibleParts: parts.length, hasVisibleText: visibleChars > 0 };
}

/**
 * A piece of the message that the output has to represent somehow.
 *
 * Per-part coverage would be wrong. A normal `multipart/alternative` carries both a plain and an
 * HTML rendering, and HTML-primary output deliberately contains only HTML-derived segments;
 * demanding both part ids would report most valid mail as lossy. So the unit is a *group*, and any
 * one supported member satisfies it.
 */
export interface CoverageGroup {
    /** Stable identifier: the container part for an alternative, the leaf itself otherwise. */
    id: string;
    /** True when the group is one alternative rendering set rather than independent content. */
    alternative: boolean;
    /** Part ids, any one of which represents this group. */
    members: string[];
}

/**
 * Text a reader would actually have seen in one part.
 *
 * Quote prefixes are stripped rather than counted. A plain part whose entire body is `>` on three
 * lines contains no text at all, and counting the markers made the gate report a total content loss
 * on a message that had nothing to lose. Script, style, comment and markup text is excluded the
 * same way, so an image-only body does not look like text that extraction dropped.
 */
function visibleTextOf(part: MimePart): string {
    const raw = part.decoded?.text ?? '';
    if (!raw) {
        return '';
    }
    if (part.contentType === 'text/html') {
        return stripTagsToText(raw).trim();
    }
    return canonicaliseText(raw)
        .lines.filter(line => !line.blank)
        .map(line => line.content)
        .join('\n')
        .trim();
}

/**
 * Supported body leaf, by the same written rules the plan uses, deliberately reimplemented here.
 *
 * A part with no visible text is not required coverage. An image-only newsletter and a body that is
 * nothing but a tracking pixel both have a body part and nothing for the output to carry, and
 * demanding a segment for them would report "content lost" on messages where none existed.
 */
function isSupportedLeaf(part: MimePart): boolean {
    return (
        (part.contentType === 'text/plain' || part.contentType === 'text/html') &&
        part.disposition !== 'attachment' &&
        Boolean(part.decoded) &&
        visibleTextOf(part) !== ''
    );
}

function supportedLeavesUnder(message: ParsedMessage, part: MimePart, into: string[], depth = 0): void {
    if (depth > 32 || part.disposition === 'attachment' || part.rfc822 || part.embeddedRoot) {
        return;
    }
    if (isSupportedLeaf(part)) {
        into.push(part.partId);
        return;
    }
    for (const childId of part.childIds) {
        const child = message.partsById.get(childId);
        if (child) {
            supportedLeavesUnder(message, child, into, depth + 1);
        }
    }
}

function bareContentId(value: string | null | undefined): string {
    return (value ?? '').trim().replace(/^</, '').replace(/>$/, '').toLowerCase();
}

/**
 * Fold a `mixed` container's misencoded alternatives into single equivalence groups.
 *
 * Some clients use `multipart/mixed` where they mean `multipart/alternative`, `mixed(H,P)` most
 * often. The extractor merges such a pair into one section when their content matches, so only one
 * of the two part ids reaches the output, and a per-part rule would report the other as lost
 * content when nothing was lost.
 *
 * Decided by content rather than structure, exactly as the selection code decides it, and
 * implemented separately here on purpose. An oracle that called the selection code would agree with
 * it by construction and could never catch it being wrong. These two must be reviewed together
 * against `docs/adr-001-document-global-classification.md`; when they disagree, one of them is
 * wrong and the run says so.
 */
function mergeMisencodedAlternatives(message: ParsedMessage, groups: CoverageGroup[], from: number): void {
    for (let i = from; i + 1 < groups.length; i++) {
        const left = groups[i] as CoverageGroup;
        const right = groups[i + 1] as CoverageGroup;
        if (left.alternative || right.alternative || left.members.length !== 1 || right.members.length !== 1) {
            continue;
        }
        const a = message.partsById.get(left.members[0] as string);
        const b = message.partsById.get(right.members[0] as string);
        if (!a || !b) {
            continue;
        }
        const plain = a.contentType === 'text/plain' ? a : b.contentType === 'text/plain' ? b : null;
        const markup = a.contentType === 'text/html' ? a : b.contentType === 'text/html' ? b : null;
        if (!plain || !markup) {
            continue;
        }
        const left_ = buildShingleIndex(normaliseForMatch(visibleTextOf(plain)));
        const right_ = buildShingleIndex(normaliseForMatch(visibleTextOf(markup)));
        if (!isMatchable(left_) || !isMatchable(right_)) {
            continue;
        }
        if (containment(left_, right_).containment < CONTAINMENT_THRESHOLD && containment(right_, left_).containment < CONTAINMENT_THRESHOLD) {
            continue;
        }
        groups.splice(i, 2, { id: left.id, alternative: true, members: [...left.members, ...right.members] });
        i--;
    }
}

/**
 * Required coverage groups for a parsed message.
 *
 * Written from the decision table rather than by calling `planBody()`. Sharing the implementation
 * would make the oracle agree with the selection code by construction, which is exactly the
 * property a gate must not have. The two are reviewed against the same table and are expected to
 * agree; when they do not, one of them is wrong and the run says so.
 */
export function requiredCoverageGroups(message: ParsedMessage): CoverageGroup[] {
    const groups: CoverageGroup[] = [];

    const walk = (part: MimePart, depth: number): void => {
        if (depth > 32 || part.disposition === 'attachment') {
            return;
        }
        // Embedded messages are content for the caller to render, not the container's body.
        if (part.rfc822 || part.embeddedRoot) {
            return;
        }

        if (part.multipart === 'alternative') {
            const members: string[] = [];
            supportedLeavesUnder(message, part, members);
            if (members.length) {
                groups.push({ id: part.partId, alternative: true, members });
            }
            return;
        }

        const children = part.childIds.map(id => message.partsById.get(id)).filter(Boolean) as MimePart[];

        if (part.multipart === 'related') {
            // Only the root carries body. Everything else is an inline resource.
            const start = bareContentId(part.contentTypeParams.start);
            const root =
                (start ? children.find(child => bareContentId(child.headers.find(entry => entry.key === 'content-id')?.value) === start) : undefined) ??
                children[0];
            if (root) {
                walk(root, depth + 1);
            }
            return;
        }

        if (part.multipart) {
            // mixed and everything unrecognised: ordered independent content, each body-bearing
            // child is its own required group.
            const before = groups.length;
            for (const child of children) {
                walk(child, depth + 1);
            }
            mergeMisencodedAlternatives(message, groups, before);
            return;
        }

        if (isSupportedLeaf(part)) {
            groups.push({ id: part.partId, alternative: false, members: [part.partId] });
        }
    };

    const root = message.partsById.get(message.rootId) ?? message.parts[0];
    if (root) {
        walk(root, 0);
    }
    return groups;
}

export interface CoverageReport {
    required: number;
    covered: number;
    /** Group ids with no member anywhere in the output. Each one is content that vanished. */
    missing: string[];
    /** Alternative members deliberately not emitted. Informational, never a failure. */
    alternativesNotEmitted: string[];
    /** Groups present only in `hiddenSegments`. */
    hiddenOnly: string[];
}

/** Compare the required groups against the MIME parts the result actually names. */
export function coverageOf(groups: readonly CoverageGroup[], visibleParts: ReadonlySet<string>, hiddenParts: ReadonlySet<string>): CoverageReport {
    const missing: string[] = [];
    const alternativesNotEmitted: string[] = [];
    const hiddenOnly: string[] = [];
    let covered = 0;

    for (const group of groups) {
        const present = group.members.filter(member => visibleParts.has(member) || hiddenParts.has(member));
        if (!present.length) {
            missing.push(group.id);
            continue;
        }
        covered++;
        if (group.alternative) {
            alternativesNotEmitted.push(...group.members.filter(member => !present.includes(member)));
        }
        if (present.every(member => !visibleParts.has(member))) {
            hiddenOnly.push(group.id);
        }
    }

    return { required: groups.length, covered, missing, alternativesNotEmitted, hiddenOnly };
}
