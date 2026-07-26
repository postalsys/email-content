# Threat and privacy model

The corpus is 320,378 private email messages spanning 2003 to 2026: personal correspondence,
business mail, invoices, account notifications and password resets. Everything in this document
follows from that.

## Configured exception: LLM annotation

`email-content annotate` sends message block text to an OpenAI API endpoint. It is the only part of
the project that leaves the machine, it is opt in, it fails closed when no key is configured, and
`extract()` and the corpus scanner cannot reach it.

What this means in practice, stated plainly so it is not discovered later:

- Block text from private mail is transmitted to a third party and is subject to that provider's
  retention and training policies, not this project's.
- Subjects, addresses and headers are deliberately not sent. Block text, quote depth and a reply
  flag are.
- The API key lives in `.env`, which is gitignored, and is never logged.
- Labels produced this way are stored with `source = 'llm'` and their model and prompt version, and
  are never mixed with human labels.

If this is not acceptable for a given corpus, do not run that one command. Everything else in the
project continues to work offline.

## What the project promises

1. **Local only by default, with one opt in exception noted above.** No command contacts a network service. There is no telemetry, no
   crash reporting and no model API. The runtime dependency tree is three packages
   (`@zone-eu/mailsplit`, `libmime`, `node-html-parser`), none of which opens a socket.
2. **Source files are never modified.** The corpus is opened read only. Nothing is written back to
   the `.eml` folder, ever.
3. **No message content in logs.** Progress lines carry counts, rates and relative paths. Error
   records carry a file hash, an error code and a truncated exception message. Bodies, subjects and
   addresses never reach stdout, stderr or the database in readable form.
4. **The review app binds to 127.0.0.1** and serves a strict Content Security Policy that blocks
   scripts, remote images, fonts, frames and network requests, so a hostile message cannot exfiltrate
   the mailbox it is being rendered in.

## What is stored, and what it can still reveal

The corpus database holds derived metadata only. Raw messages stay on disk and are referenced by
relative path.

| field                                          | stored as                            | residual risk                                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| file path                                      | plain text                           | Filenames encode a timestamp. Reveals when mail arrived and how much.                                                                                                                        |
| sha256                                         | plain                                | Confirms whether a **known** message is present. Cannot reconstruct content.                                                                                                                 |
| `message_id`, `in_reply_to`, `references_root` | plain                                | Often contains a sending domain and sometimes a user identifier. Enables thread reconstruction, which is the point.                                                                          |
| `from_domain`                                  | plain                                | Reveals who the account corresponds with at organisation level. Kept deliberately: sampling stratification needs it.                                                                         |
| `from_hash`, `subject_hash`                    | HMAC-SHA256 with a per database salt | Groupable, not reversible, **but** an attacker holding the salt and a candidate list can confirm guesses. The salt lives in the same database, so treat the file as sensitive as the corpus. |
| `subject_length`, `text_chars`, `html_chars`   | plain                                | Weak side channel. Message length can fingerprint a known template.                                                                                                                          |
| `body_simhash`                                 | plain                                | 64 bits derived from token frequency. Cannot reconstruct text, but two databases can be joined to prove the same message appears in both.                                                    |
| `markers`, `html_hints`, `client`, `structure` | plain, closed vocabulary             | Detector ids only. No content.                                                                                                                                                               |
| `lang`                                         | plain                                | Reveals correspondence language mix.                                                                                                                                                         |

**The database is not anonymised and must not be treated as if it were.** It is a derived artefact
of private mail. Do not commit it, do not attach it to an issue, and do not copy it to shared
storage. `data/` is in `.gitignore` for this reason.

## Derived datasets

Annotations and exported training data are a sharper risk than the corpus database, because they
contain **verbatim block text**. That is unavoidable: a block classifier needs the block.

Consequences:

- `annotations/*.jsonl` is gitignored.
- A dataset export is as sensitive as the mailbox it came from. Sharing one shares the mail.
- Any model trained on this data can memorise fragments of it. A model trained here must not be
  published without a deliberate decision about that, made with knowledge of what is in the
  training set.

## Rendering hostile content

A message is attacker controlled input. The review app renders it, which is the highest risk
surface in the project.

| threat                                                                     | mitigation                                                                             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Script execution via HTML body                                             | Sanitise before rendering, plus a CSP with no `script-src` beyond the app's own origin |
| Tracking pixel or remote image confirming that mail was read and processed | CSP blocks remote images. `img-src 'self' data:` only                                  |
| Remote CSS or font phoning home                                            | CSP blocks both                                                                        |
| Data exfiltration via `fetch`, form action, or `<a ping>`                  | CSP `connect-src 'none'`, `form-action 'none'`                                         |
| Clickjacking or frame embedding                                            | `frame-ancestors 'none'`, `frame-src 'none'`                                           |
| Billion laughs or pathological markup hanging the parser                   | Per file timeout in the scanner, size caps, worker termination and replacement         |
| Zip bomb style nesting                                                     | `maxNestingDepth` and `maxParts` caps, reported as warnings                            |

## Denial of service on our own pipeline

The corpus is the adversary here, mostly accidentally.

- Per file timeout, default 30 seconds, enforced by terminating and replacing the worker thread.
- Files larger than 32 MiB are recorded as `oversize` and not parsed. The largest message in the
  corpus is 28 MB.
- Decoded text is capped at 1 MiB per part, with the truncation reported.
- Worker heaps are capped so that the pool cannot exhaust host memory.
- Every worker failure is recorded as a row. One bad message costs one row, never the run.

## Redacted fixtures

Test fixtures in `test/fixtures/` are written by hand and contain no real correspondence. Fixtures
derived from real messages must go through the redaction command, which rewrites addresses, display
names, domains and body words to deterministic pseudonyms while preserving structure, encodings,
boundaries and byte layout, so that the structural bug being reproduced survives but the content
does not.

Redaction is not a guarantee of anonymity. A structure can itself be identifying. Review a redacted
fixture by hand before it leaves the machine.

## Safe error reports

When a message triggers a bug, the shareable report is: file hash, size, MIME structure signature,
detector ids that fired, warning codes, extractor version, and the exception type and message. That
is enough to reproduce most structural problems without transmitting the message.

## Out of scope

- Encrypted or signed mail is parsed structurally. S/MIME and PGP payloads are not decrypted, and
  no key material is read.
- No attempt is made to detect or handle malware in attachments. Attachment bytes are counted and
  discarded, never written out or executed.
