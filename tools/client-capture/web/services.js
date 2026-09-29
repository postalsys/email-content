'use strict';

/**
 * Web mail services to capture, each backed by a test account on the EmailEngine instance that is
 * used to plant seed messages. Open source webmails are left out: the Docker step covers them.
 * NetEase 163 is left out too: the test account only allows IMAP, not web login.
 */

module.exports = [
    { id: 'gmail', account: 'testbox', login: 'https://mail.google.com/mail/u/0/', match: 'mail.google.com' },
    { id: 'outlook-com', account: 'hotmail', login: 'https://outlook.live.com/mail/0/', match: 'outlook.live.com' },
    { id: 'outlook-m365', account: 'ms365', login: 'https://outlook.office.com/mail/', match: 'outlook.office.com' },
    { id: 'owa-exchange', account: 'exchange', login: 'https://pro2.mail.ovh.net/owa/', match: 'pro2.mail.ovh.net' },
    { id: 'yahoo', account: 'yahoo', login: 'https://mail.yahoo.com/', match: 'mail.yahoo.com' },
    { id: 'icloud', account: 'icloud', login: 'https://www.icloud.com/mail/', match: 'icloud.com/mail' },
    { id: 'fastmail', account: 'fastmail', login: 'https://app.fastmail.com/', match: 'app.fastmail.com' },
    { id: 'gmx', account: 'gmx', login: 'https://www.gmx.com/', match: 'gmx.com' },
    { id: 'proton', account: 'proton', login: 'https://mail.proton.me/', match: 'mail.proton.me' },
    { id: 'yandex', account: 'yandex', login: 'https://mail.yandex.com/', match: 'mail.yandex' },
    { id: 'zoho', account: 'zoho', login: 'https://mail.zoho.eu/', match: 'mail.zoho.eu' },
    { id: 'rambler', account: 'rambler', login: 'https://mail.rambler.ru/', match: 'mail.rambler.ru' },
    { id: 'lark', account: 'larkmail', login: 'https://zjp5160qifmv.jp.larksuite.com/mail', match: 'larksuite.com/mail' },
    // Alibaba accepts IMAP APPEND but silently drops the message, so it cannot be seeded this way.
    { id: 'alibaba', account: 'ali', login: 'https://mail.sg.aliyun.com/', match: 'mail.sg.aliyun.com' },
    { id: 'zimbra-ovh', account: 'zimbra', login: 'https://zimbra1.mail.ovh.net/', match: 'zimbra1.mail.ovh.net' }
];
