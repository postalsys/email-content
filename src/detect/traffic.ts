/**
 * Traffic classification: is this message part of a human conversation, or machine generated?
 *
 * This matters more than it looks. Measured on the working corpus, only about 13 percent of
 * messages are human authored, roughly 40 percent are GitHub notifications, and 56 percent carry
 * mailing list or bulk headers. Sampling and evaluation target the human slice, so a reliable
 * split keeps the annotation budget from being spent on templated machine formats.
 *
 * The rules are header based and deliberately ordered from most to least specific. They classify
 * traffic, never content: a notification message is still extracted normally.
 */

import { type HeaderEntry, type MessageHeaders } from '../mime/model';

export type TrafficClass = 'human' | 'mailing-list' | 'bulk' | 'notification' | 'ticketing' | 'auto-reply' | 'unknown';

export interface TrafficVerdict {
    traffic: TrafficClass;
    /** Ids of the rules that fired, in order. */
    signals: string[];
}

const NOREPLY = /(^|[.\-_])(no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon|postmaster|bounces?|automated)([.\-_@]|$)/i;

const VENDOR_HEADERS = [
    'x-github-recipient',
    'x-github-sender',
    'x-gitlab-project',
    'x-jira-fingerprint',
    'x-atlassian-mail-generated',
    'x-zendesk-from-account-id',
    'x-freshdesk-account',
    'x-intercom-message-id',
    'x-hubspot-message-id',
    'x-mailgun-sid',
    'x-ses-outgoing',
    'x-sg-eid',
    'x-campaign-id',
    'feedback-id',
    'x-mailchimp-id'
];

const TICKETING_HEADERS = new Set([
    'x-github-recipient',
    'x-github-sender',
    'x-gitlab-project',
    'x-jira-fingerprint',
    'x-atlassian-mail-generated',
    'x-zendesk-from-account-id',
    'x-freshdesk-account',
    'x-intercom-message-id'
]);

function hasHeader(entries: readonly HeaderEntry[], key: string): boolean {
    return entries.some(entry => entry.key === key);
}

/**
 * Classify message traffic.
 *
 * @param headers decoded well known headers
 * @param entries every header line of the outermost message
 */
export function classifyTraffic(headers: MessageHeaders, entries: readonly HeaderEntry[]): TrafficVerdict {
    const signals: string[] = [];

    const autoSubmitted = (headers.autoSubmitted || '').toLowerCase();
    if (autoSubmitted && autoSubmitted !== 'no') {
        signals.push(`auto-submitted:${autoSubmitted.split(/[\s;]/)[0]}`);
    }
    if (headers.listId) {
        signals.push('list-id');
    }
    if (headers.listUnsubscribe) {
        signals.push('list-unsubscribe');
    }
    const precedence = (headers.precedence || '').toLowerCase();
    if (precedence === 'bulk' || precedence === 'junk' || precedence === 'list') {
        signals.push(`precedence:${precedence}`);
    }
    const vendor = VENDOR_HEADERS.filter(key => hasHeader(entries, key));
    signals.push(...vendor);
    if (headers.from && NOREPLY.test(headers.from)) {
        signals.push('noreply-from');
    }

    // Most specific first. Ticketing and notification systems often also set list headers, and
    // knowing that a message is a GitHub notification is more useful than knowing it is a list.
    if (vendor.some(key => TICKETING_HEADERS.has(key))) {
        return { traffic: 'ticketing', signals };
    }
    if (autoSubmitted === 'auto-replied' || autoSubmitted === 'auto-generated') {
        return { traffic: 'auto-reply', signals };
    }
    if (headers.listId) {
        return { traffic: 'mailing-list', signals };
    }
    if (headers.listUnsubscribe || vendor.length > 0) {
        return { traffic: 'bulk', signals };
    }
    if (precedence === 'bulk' || precedence === 'junk') {
        return { traffic: 'bulk', signals };
    }
    if (headers.from && NOREPLY.test(headers.from)) {
        return { traffic: 'notification', signals };
    }
    if (!headers.from && !headers.messageId) {
        return { traffic: 'unknown', signals };
    }
    return { traffic: 'human', signals };
}
