# Client capture

Produces labelled fixtures from real mail clients, so the extractor can be measured on the reply and
forward structure those clients actually generate, in every interface language they ship. Nothing
here touches private mail: every message is synthetic and every mailbox is a test account.

The output lives in `test/fixtures/clients/<client>/<locale>/<scenario>-<compose>.eml`, each with an
`.expected.json` beside it. `docs/client-coverage.md` summarises how the current build does on them.

## How the labels work

The harness writes every message itself, and every piece of text carries a made-up word that encodes
its role:

| prefix | role                              | expected label                                            |
| ------ | --------------------------------- | --------------------------------------------------------- |
| `nvq`  | typed in the reply or forward     | `NEW_CONTENT`                                             |
| `hvq`  | the message being replied to      | `REPLY_HISTORY`, or `INLINE_QUOTE` when answered in place |
| `gvq`  | an older message quoted inside it | `REPLY_HISTORY`                                           |
| `fvq`  | the forwarded message             | `FORWARDED_CONTENT`                                       |

After a client replies, finding those words in the extractor's segments says exactly what each span
should have been. No model and no human labelling is involved, and since clients do not care what
the words are, the quoting structure is entirely the client's own.

Scenarios: `reply` (typed above the quote), `reply-below` (below it), `reply-inline` (answers between
quoted paragraphs), `reply-nested` (the seed already quotes an older message), `forward`. Each runs in
plain text and HTML compose mode where the client has both.

## Self hosted clients (Docker)

Roundcube, SnappyMail and Cypht run in Docker, pointed at Ethereal's IMAP and SMTP. Ethereal never
delivers mail: whatever an account sends lands back in its own INBOX, where the harness reads it.

```bash
docker compose -f docker/compose.yml up -d
npm install
export ETHEREAL_API_KEY=...          # commercial Ethereal key, for account creation
node run.js --client roundcube --locales en_US --compose text,html
node run.js --client roundcube --locales all --scenarios reply,forward --workers 6
```

Accounts and credentials are kept in `.state/` (gitignored), one per client and worker, so client
settings survive reruns. `--debug` saves a screenshot for every failure there.

Client specific notes, each learned the hard way:

- **Roundcube** only picks up a language at login, and once any preference has been saved the
  stored preferences carry a language that wins over the `users.language` column. The driver writes
  both into the container's SQLite database, logs in again, checks the active locale, then saves
  compose preferences in that session and verifies the editor mode when compose opens, failing
  rather than typing into the wrong editor. Run it with `--workers 1`: parallel workers contend on
  that one SQLite file and language changes get lost.
- **SnappyMail** opens replies to HTML mail in the rich editor whatever the default, so plain text
  mode switches the compose window's own editor selector. Cmd+ArrowDown minimises its compose window,
  which is why caret placement uses the Selection API rather than key chords.
- **Cypht** needs `X-Forwarded-Host` (its origin check drops the published port), a sender profile
  before sending is enabled, SMTP on 587 (Ethereal has no 465), and the draft-save flag cleared before
  send, since with no drafts folder the save never completes. Its HTML forward does not send.

## Web services

Hosted webmails are driven in a real Google Chrome that a person logs into by hand, because login
pages refuse automation browsers. Seeds are uploaded to each service's INBOX through an EmailEngine
instance that holds the test accounts, sent from an mx-enabled Ethereal address, so the service's
real reply is delivered to Ethereal and read back over IMAP.

```bash
./web/open-chrome.sh                 # log in to each tab by hand, once
node web/status.js                   # which tabs are logged in
export EE_TOKEN=...                  # EmailEngine access token
node web/run.js --services gmail,yahoo --scenarios reply,reply-nested,forward
```

The web driver is generic: it finds the seed by its subject tag in any frame, presses reply or
forward by accessible name in many languages (piercing shadow DOM), types at the caret the service
chose, and sends with Cmd+Enter or the send button. Only the services listed in `web/services.js`
are covered; open source webmails are left to the Docker step.

## Reports

```bash
(cd ../.. && npm run build)
node rescore.js --verbose            # score every fixture against the current build
node report.js > ../../docs/client-coverage.md
```

`report.js` also lists, for every failing fixture, the boundary line the library did not act on: the
attribution line above the quote or the header above the forward. Those are the candidates for
`src/detect/patterns/*.json`.
