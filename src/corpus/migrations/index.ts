/**
 * Forward only schema migrations.
 *
 * Applied in order, tracked with SQLite's user_version pragma. Migrations never rewrite history:
 * to change a column, add a new migration. A corpus scan takes minutes and can be re-run, but
 * annotations cannot be regenerated, so the annotation tables must only ever be extended.
 */

export interface Migration {
    version: number;
    name: string;
    sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
    {
        version: 1,
        name: 'corpus-core',
        sql: `
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- One row per scan invocation, so that results can be attributed to a code version.
CREATE TABLE runs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    root                TEXT NOT NULL,
    started_at          INTEGER NOT NULL,
    finished_at         INTEGER,
    status              TEXT NOT NULL DEFAULT 'running',
    processing_version  TEXT NOT NULL,
    extractor_version   TEXT NOT NULL,
    options_json        TEXT NOT NULL DEFAULT '{}',
    files_seen          INTEGER NOT NULL DEFAULT 0,
    files_processed     INTEGER NOT NULL DEFAULT 0,
    files_failed        INTEGER NOT NULL DEFAULT 0,
    files_skipped       INTEGER NOT NULL DEFAULT 0
);

-- One row per .eml file. Path is relative to the run root so a corpus can be moved.
CREATE TABLE files (
    path                TEXT PRIMARY KEY,
    size                INTEGER NOT NULL,
    mtime               INTEGER NOT NULL,
    sha256              TEXT,
    status              TEXT NOT NULL,
    error_code          TEXT,
    error_detail        TEXT,
    duration_ms         INTEGER,
    scanned_at          INTEGER NOT NULL,
    run_id              INTEGER,
    processing_version  TEXT NOT NULL
);
CREATE INDEX files_sha256   ON files(sha256);
CREATE INDEX files_status   ON files(status);

-- Derived, privacy safe metadata. No subjects, no addresses, no body text.
CREATE TABLE messages (
    path                    TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE,
    message_id              TEXT,
    in_reply_to             TEXT,
    references_count        INTEGER NOT NULL DEFAULT 0,
    references_root         TEXT,
    date_ms                 INTEGER,
    from_domain             TEXT,
    from_hash               TEXT,
    subject_hash            TEXT,
    subject_prefix          TEXT,
    subject_length          INTEGER NOT NULL DEFAULT 0,
    structure               TEXT,
    body_kind               TEXT,
    charsets                TEXT,
    encodings               TEXT,
    part_count              INTEGER NOT NULL DEFAULT 0,
    attachment_count        INTEGER NOT NULL DEFAULT 0,
    has_rfc822              INTEGER NOT NULL DEFAULT 0,
    text_chars              INTEGER NOT NULL DEFAULT 0,
    html_chars              INTEGER NOT NULL DEFAULT 0,
    flowed                  INTEGER NOT NULL DEFAULT 0,
    client                  TEXT,
    client_source           TEXT,
    traffic                 TEXT,
    traffic_signals         TEXT,
    is_reply                INTEGER NOT NULL DEFAULT 0,
    is_forward              INTEGER NOT NULL DEFAULT 0,
    quote_depth_max         INTEGER NOT NULL DEFAULT 0,
    quoted_ratio            REAL NOT NULL DEFAULT 0,
    reply_style             TEXT,
    markers                 TEXT,
    html_hints              TEXT,
    blockquote_count        INTEGER NOT NULL DEFAULT 0,
    table_count             INTEGER NOT NULL DEFAULT 0,
    has_image               INTEGER NOT NULL DEFAULT 0,
    suspect_malformed_html  INTEGER NOT NULL DEFAULT 0,
    lang                    TEXT,
    lang_score              REAL NOT NULL DEFAULT 0,
    body_simhash            TEXT,
    warnings                TEXT,
    quote_marking_disagrees INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX messages_message_id ON messages(message_id);
CREATE INDEX messages_in_reply_to ON messages(in_reply_to);
CREATE INDEX messages_client      ON messages(client);
CREATE INDEX messages_traffic     ON messages(traffic);
CREATE INDEX messages_simhash     ON messages(body_simhash);
CREATE INDEX messages_subject     ON messages(subject_hash);
`
    },
    {
        version: 2,
        name: 'annotations',
        sql: `
-- One row per annotation pass over a set of messages, so that labels can always be attributed to
-- a labeller, a model and a prompt version.
CREATE TABLE annotation_runs (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    source             TEXT NOT NULL,          -- 'llm' | 'human' | 'weak' | 'distant'
    model              TEXT,                   -- model id for 'llm'
    prompt_version     TEXT,
    extractor_version  TEXT NOT NULL,
    started_at         INTEGER NOT NULL,
    finished_at        INTEGER,
    messages           INTEGER NOT NULL DEFAULT 0,
    blocks             INTEGER NOT NULL DEFAULT 0,
    failures           INTEGER NOT NULL DEFAULT 0,
    prompt_tokens      INTEGER NOT NULL DEFAULT 0,
    completion_tokens  INTEGER NOT NULL DEFAULT 0,
    notes              TEXT
);

-- Block level labels. Deliberately not unique on (path, block_index): the same block may be
-- labelled by several sources, and comparing them is the point.
CREATE TABLE annotations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          INTEGER NOT NULL REFERENCES annotation_runs(id) ON DELETE CASCADE,
    path            TEXT NOT NULL,
    representation  TEXT NOT NULL,
    block_index     INTEGER NOT NULL,
    mime_part       TEXT,
    block_start     INTEGER,
    block_end       INTEGER,
    char_count      INTEGER NOT NULL DEFAULT 0,
    source          TEXT NOT NULL,
    label           TEXT NOT NULL,
    confidence      REAL NOT NULL DEFAULT 0,
    -- What the deterministic baseline said about the same block, captured at annotation time so a
    -- later rule change cannot silently rewrite history.
    baseline_label  TEXT,
    baseline_conf   REAL,
    baseline_reasons TEXT,
    agrees          INTEGER NOT NULL DEFAULT 0,
    notes           TEXT
);
CREATE INDEX annotations_path   ON annotations(path);
CREATE INDEX annotations_run    ON annotations(run_id);
CREATE INDEX annotations_source ON annotations(source);
CREATE INDEX annotations_agree  ON annotations(agrees);
`
    }
];
