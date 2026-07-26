# Performance benchmark

Machine: Apple Silicon, 18 cores, 24 GB RAM, Node 24.18, local SSD. Corpus:
320,378 `.eml` files, 15.9 GB.

Reproduce with:

```bash
node dist/cli/main.js corpus scan /path/to/eml-folder --concurrency 14
node dist/cli/main.js benchmark --sample 3000
```

## Corpus scan

Full scan, 14 worker threads:

| metric              |                 value |
| ------------------- | --------------------: |
| files               |               320,378 |
| parsed successfully |               320,377 |
| failures            |                     0 |
| skipped as oversize |   1 (a 33 MB message) |
| wall clock          | 10 minutes 51 seconds |
| throughput          |           492 files/s |
| peak RSS            |                2.5 GB |
| database size       |                190 MB |

Throughput varies with message size rather than count: the early corpus years are small plain text
messages and scan at over 1,300 files/s, while recent years are large multipart HTML and scan at
around 350 files/s.

Peak RSS is dominated by the worker heaps, which share the parent process. Each worker is capped at
192 MiB of old generation, so the pool is bounded by construction rather than by luck. The main
thread holds the candidate list, roughly 100 bytes per file, or about 32 MB for this corpus.

## Extraction

Single threaded, over 3,000 human authored replies drawn deterministically from the corpus:

| metric          |         value |
| --------------- | ------------: |
| throughput      | 63 messages/s |
| per message p50 |        2.9 ms |
| per message p90 |       16.0 ms |
| per message p99 |        310 ms |
| per message max |      1,948 ms |
| RSS growth      |        232 MB |

The distribution is heavily skewed. Half of all messages extract in under 3 ms, and the mean is
dragged up entirely by a small number of very large HTML messages: the p99 is over a hundred times
the median. Optimisation work should therefore target the tail, not the median, and the tail is DOM
parsing of large HTML rather than MIME parsing or classification.

At 63 messages/s single threaded, a full corpus extraction would take about 85 minutes. Across 14
workers, as the scanner already does, that is under ten minutes.

## Where the time goes

Measured before any optimisation, as the brief requires:

1. **HTML DOM parsing** dominates the tail. A 1 MB marketing message with deeply nested tables can
   take over a second on its own.
2. **MIME parsing** is cheap and linear. mailsplit streams and never buffers non text bodies.
3. **Classification** is negligible: it walks a block list a handful of times, and there are rarely
   more than a few hundred blocks.

No optimisation has been applied yet, deliberately. The numbers above are the baseline against
which any future change should be judged.

## Regression gate

`benchmark` exits non zero if any catastrophic check fires, so it can be used in CI:

```
empty extraction from non empty message  0 (0.00%)
all content hidden                       0 (0.00%)
only a footer left visible               0 (0.00%)
hidden without a structural anchor       0 (0.00%)
forwarded content hidden                 0 (0.00%)
```

These checks are structural and need no labels, so they run over any number of messages. They are a
floor, not a substitute for the labelled evaluation planned in Phase 4: they prove that content is
never silently lost, not that the right content was hidden.

## Content split

Over the same 3,000 human replies, 74.6 percent of extracted characters stay visible and 25.4
percent are hidden as reply history. Segment counts:

| label             | segments |
| ----------------- | -------: |
| NEW_CONTENT       |    4,326 |
| REPLY_HISTORY     |    2,422 |
| INLINE_QUOTE      |    1,305 |
| UNKNOWN           |       90 |
| FORWARDED_CONTENT |       63 |
| SIGNATURE         |       33 |

The large INLINE_QUOTE count is the conservative bias working as intended: a quote with no anchor
and an answer after it stays visible. Whether that is right in each case needs labels, which is
Phase 4. The low SIGNATURE count is a known gap: signature detection currently fires only on an
RFC 3676 delimiter, a client signature container, or a strong phrase, and many signatures have none
of those.
