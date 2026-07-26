/**
 * Client fingerprinting.
 *
 * Knowing which client composed a message is evidence, not truth. It is used to prioritise
 * structural detectors and to stratify sampling, never to decide a label on its own. A message
 * whose client cannot be identified must still extract correctly, which is why "unknown" is a
 * first class outcome rather than a failure.
 *
 * Signals, in decreasing reliability: Message-ID domain (hard to spoof accidentally, set by the
 * submitting server), X-Mailer and User-Agent, MIME boundary shape, then HTML structure hints.
 */

import { type MessageHeaders } from '../mime/model';

export type ClientId =
    | 'gmail'
    | 'gmail-mobile'
    | 'outlook-web'
    | 'outlook-desktop'
    | 'outlook-mobile'
    | 'apple-mail'
    | 'apple-mail-mobile'
    | 'thunderbird'
    | 'proton'
    | 'yahoo'
    | 'zimbra'
    | 'roundcube'
    | 'superhuman'
    | 'hey'
    | 'front'
    | 'zendesk'
    | 'hubspot'
    | 'github'
    | 'atlassian'
    | 'mailchimp'
    | 'sendgrid'
    | 'amazon-ses'
    | 'nodemailer'
    | 'phpmailer'
    | 'mutt'
    | 'webmail-generic'
    | 'library-generic'
    | 'unknown';

export interface ClientFingerprint {
    client: ClientId;
    /** Which signal decided it. */
    source: 'message-id' | 'x-mailer' | 'user-agent' | 'boundary' | 'html' | 'header' | 'none';
    confidence: number;
}

interface Rule {
    client: ClientId;
    regex: RegExp;
    confidence: number;
}

/** Message-ID domain patterns. Set by the submitting infrastructure, so quite reliable. */
const MESSAGE_ID_RULES: Rule[] = [
    { client: 'gmail', regex: /@mail\.gmail\.com>?$/i, confidence: 0.95 },
    { client: 'outlook-web', regex: /@[a-z0-9.-]*prod\.outlook\.com>?$/i, confidence: 0.9 },
    { client: 'outlook-web', regex: /@[a-z0-9.-]*namprd[0-9]+\.prod\.outlook\.com>?$/i, confidence: 0.92 },
    { client: 'yahoo', regex: /@[a-z0-9.-]*(yahoo|ymail)\.com>?$/i, confidence: 0.8 },
    { client: 'proton', regex: /@(protonmail|proton\.me)/i, confidence: 0.9 },
    { client: 'github', regex: /@github\.com>?$/i, confidence: 0.95 },
    { client: 'atlassian', regex: /@(atlassian\.net|jira)/i, confidence: 0.85 },
    { client: 'zendesk', regex: /@[a-z0-9.-]*zendesk\.com>?$/i, confidence: 0.9 },
    { client: 'superhuman', regex: /@superhuman\.com>?$/i, confidence: 0.9 },
    { client: 'hey', regex: /@hey\.com>?$/i, confidence: 0.85 },
    { client: 'front', regex: /@(frontapp|front)\.com>?$/i, confidence: 0.85 },
    { client: 'mailchimp', regex: /@mail[0-9]*\.(mcsv|mailchimpapp)\.net>?$/i, confidence: 0.9 },
    { client: 'sendgrid', regex: /@(sendgrid|sendgrid\.net)/i, confidence: 0.85 },
    { client: 'amazon-ses', regex: /@(email\.amazonses\.com|[a-z0-9.-]*amazonses\.com)>?$/i, confidence: 0.9 }
];

/** X-Mailer and User-Agent values. Self declared, so slightly weaker. */
const AGENT_RULES: Rule[] = [
    { client: 'apple-mail', regex: /\bApple\s?Mail\b/i, confidence: 0.9 },
    { client: 'apple-mail-mobile', regex: /\biPhone Mail\b|\biPad Mail\b/i, confidence: 0.9 },
    { client: 'outlook-desktop', regex: /Microsoft (Outlook|Office Outlook)(?! Express)/i, confidence: 0.9 },
    { client: 'outlook-desktop', regex: /Microsoft Outlook Express/i, confidence: 0.9 },
    { client: 'outlook-mobile', regex: /Outlook for (iOS|Android)|ms-outlook-mobile/i, confidence: 0.9 },
    { client: 'thunderbird', regex: /Thunderbird|Icedove/i, confidence: 0.95 },
    { client: 'mutt', regex: /\bMutt\b|\bNeoMutt\b/i, confidence: 0.95 },
    { client: 'roundcube', regex: /Roundcube/i, confidence: 0.95 },
    { client: 'zimbra', regex: /Zimbra/i, confidence: 0.95 },
    { client: 'proton', regex: /ProtonMail|Proton Mail/i, confidence: 0.9 },
    { client: 'nodemailer', regex: /nodemailer/i, confidence: 0.95 },
    { client: 'phpmailer', regex: /PHPMailer|phpmailer/i, confidence: 0.95 },
    { client: 'webmail-generic', regex: /SquirrelMail|Horde|Webmail|MessagingEngine/i, confidence: 0.7 },
    { client: 'library-generic', regex: /JavaMail|Mailer|SwiftMailer|Sendmail|python|Zend_Mail|CakePHP/i, confidence: 0.6 }
];

/** MIME boundary shapes that some clients use consistently. */
const BOUNDARY_RULES: Rule[] = [
    { client: 'apple-mail', regex: /Apple-Mail[=-]/i, confidence: 0.85 },
    { client: 'library-generic', regex: /----=_Part_[0-9]+_[0-9]+/, confidence: 0.6 },
    { client: 'outlook-desktop', regex: /----_=_NextPart_/i, confidence: 0.7 }
];

/** HTML structure hints. Weakest signal, used only when nothing else matched. */
const HTML_RULES: Rule[] = [
    { client: 'gmail', regex: /class="?gmail_(quote|attr|signature)/i, confidence: 0.8 },
    { client: 'outlook-web', regex: /id="?(divRplyFwdMsg|appendonsend)/i, confidence: 0.8 },
    { client: 'outlook-web', regex: /class="?[^"]*elementToProof/i, confidence: 0.7 },
    { client: 'outlook-desktop', regex: /class="?MsoNormal|WordSection1/i, confidence: 0.6 },
    { client: 'thunderbird', regex: /moz-cite-prefix|moz-signature/i, confidence: 0.85 },
    { client: 'apple-mail', regex: /Apple-interchange-newline|AppleMailSignature/i, confidence: 0.75 },
    { client: 'proton', regex: /protonmail_quote/i, confidence: 0.85 },
    { client: 'yahoo', regex: /yahoo_quoted/i, confidence: 0.85 },
    { client: 'zimbra', regex: /id="?zwchr/i, confidence: 0.8 },
    { client: 'hubspot', regex: /hubspot/i, confidence: 0.6 },
    { client: 'zendesk', regex: /zendesk/i, confidence: 0.6 }
];

function match(rules: readonly Rule[], value: string | null | undefined): Rule | null {
    if (!value) {
        return null;
    }
    for (const rule of rules) {
        if (rule.regex.test(value)) {
            return rule;
        }
    }
    return null;
}

/**
 * Identify the composing client.
 *
 * @param headers decoded message headers
 * @param html first text/html part, or null. Only the head of the document is inspected.
 * @param boundary Content-Type boundary parameter of the root part, if any
 */
export function fingerprintClient(headers: MessageHeaders, html: string | null, boundary: string | null): ClientFingerprint {
    const byMessageId = match(MESSAGE_ID_RULES, headers.messageId);
    if (byMessageId) {
        // A mobile Outlook or Gmail message still carries the provider Message-ID, so refine with
        // the self declared agent when it disagrees on the same provider family.
        const agent = `${headers.xMailer || ''} ${headers.userAgent || ''}`;
        if (byMessageId.client === 'outlook-web' && /Outlook for (iOS|Android)/i.test(agent)) {
            return { client: 'outlook-mobile', source: 'user-agent', confidence: 0.9 };
        }
        if (byMessageId.client === 'gmail' && /Android|iPhone|iPad/i.test(agent)) {
            return { client: 'gmail-mobile', source: 'user-agent', confidence: 0.8 };
        }
        return { client: byMessageId.client, source: 'message-id', confidence: byMessageId.confidence };
    }

    const byMailer = match(AGENT_RULES, headers.xMailer);
    if (byMailer) {
        return { client: byMailer.client, source: 'x-mailer', confidence: byMailer.confidence };
    }

    const byAgent = match(AGENT_RULES, headers.userAgent);
    if (byAgent) {
        return { client: byAgent.client, source: 'user-agent', confidence: byAgent.confidence };
    }

    const byBoundary = match(BOUNDARY_RULES, boundary);
    if (byBoundary) {
        return { client: byBoundary.client, source: 'boundary', confidence: byBoundary.confidence };
    }

    // Only the head of the document is scanned. Client markers appear early, and a full scan of a
    // multi megabyte newsletter would dominate the cost of the whole pipeline.
    const byHtml = match(HTML_RULES, html ? html.slice(0, 65536) : null);
    if (byHtml) {
        return { client: byHtml.client, source: 'html', confidence: byHtml.confidence };
    }

    return { client: 'unknown', source: 'none', confidence: 0 };
}
