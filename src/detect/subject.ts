/**
 * Subject prefixes that mark a reply or a forward, shared by analyze() and the corpus scanner so
 * the two cannot drift apart again.
 *
 * Forward prefixes were measured on 266 real forwards from 16 clients (test/fixtures/clients):
 * every one used Fwd, Fw or Ed (Outlook's Estonian prefix), whatever the interface language, and
 * 250 of them also carried In-Reply-To or References, so headers cannot tell a forward from a
 * reply. The other entries are the prefixes Outlook and webmail clients write in other locales.
 * A reply to a forward reads "Re: Fwd:" and is caught by REPLY_SUBJECT first, which is also why
 * "VS" (a Finnish reply, a Norwegian forward) is listed only as a reply.
 */

export const REPLY_SUBJECT = /^\s*(re|aw|sv|vs|vast|antw|res|odp|ответ)\s*(\[\d+\])?\s*:/i;

export const FORWARD_SUBJECT = /^\s*(fwd?|wg|tr|rv|enc|doorst|pd|vl|ed|edasi|пересл[а-я]*|转发|轉寄|転送)\s*(\[\d+\])?\s*:/i;

/** A forward, and not a reply to one. */
export function isForwardSubject(subject: string): boolean {
    return !REPLY_SUBJECT.test(subject) && FORWARD_SUBJECT.test(subject);
}
