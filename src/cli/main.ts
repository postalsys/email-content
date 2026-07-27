#!/usr/bin/env node
/**
 * email-content command line entry point.
 *
 * Commands are dispatched lazily so that, for example, `extract` does not pay for loading the
 * corpus database layer.
 */

import { ConfigurationError, EXTRACTOR_VERSION, PROCESSING_VERSION } from '../types';
import { CliOptionError, parseArgs } from './args';

const USAGE = `email-content <command> [options]

Commands:
  corpus scan <folder>        Scan a folder of .eml files into the corpus database
    --db <path>               Database path (default data/corpus.sqlite)
    --sample <n>              Deterministic sample of n files instead of the whole corpus
    --seed <string>           Sampling seed (default "default")
    --concurrency <n>         Worker threads (default: cores minus two)
    --no-resume               Re-process files already recorded
    --max-file-mb <n>         Skip files larger than this (default 32)
    --timeout <ms>            Per file timeout (default 30000)

  corpus stats                Print aggregate statistics
    --db <path>               Database path
    --json                    Emit JSON instead of Markdown
    --out <path>              Write the Markdown report to a file

  corpus threads              Summarise in-corpus thread parent resolution

  extract <message.eml>       Classify one message into segments
    --json                    Emit the full structured result
    --explain                 Show per block evidence, features and reasons
    --full                    Print complete segment text instead of a preview
    --history <path>          Corpus .sqlite or folder of .eml files, to resolve thread history

  benchmark                   Measure throughput and catastrophic error rates
    --dir <path>              Folder of .eml files to run instead of the corpus database
    --db <path>               Corpus database
    --sample <n>              Messages to run (default 2000)
    --traffic <class>         human, ticketing, mailing-list, bulk, all (default human)
    --replies false           Include non replies

  annotate                    Label blocks with an LLM instead of a human (sends content to OpenAI)
    --model <id>              Model id (default gpt-5.6-sol)
    --sample <n>              Messages to annotate (default 25)
    --concurrency <n>         Parallel requests (default 4)
    --traffic <class>         Traffic class to sample from (default human)
    --seed <string>           Deterministic selection seed
    --dry-run                 Count blocks and cost without calling the API
    --no-resume               Re-annotate messages already done by this model

  disagreements               Review blocks where annotator and baseline disagree (prints content)
    --direction <d>           expensive, cheap, footers, all (default expensive)
    --limit <n>               Rows to show (default 20)
    --run <id>                Restrict to one annotation run

  evaluate                    Score the extractor against an annotated reference set
    --model <id>              Reference annotations from this model (default gpt-5.6-sol)
    --history                 Resolve thread history from the corpus while evaluating
    --group-by <field>        client, lang or reply-style (default client)
    --json                    Emit the full report as JSON

  version                     Print version information

Privacy: no command prints message bodies, subjects or addresses.
`;

async function main(argv: readonly string[]): Promise<number> {
    const args = parseArgs(argv);
    const command = args.positional[0];

    switch (command) {
        case 'corpus': {
            const { corpusCommand } = await import('./corpus');
            return corpusCommand(args.positional[1], { ...args, positional: args.positional.slice(2) });
        }
        case 'extract': {
            const { extractCommand } = await import('./extract');
            return extractCommand({ ...args, positional: args.positional.slice(1) });
        }
        case 'benchmark': {
            const { benchmarkCommand } = await import('./benchmark');
            return benchmarkCommand({ ...args, positional: args.positional.slice(1) });
        }
        case 'annotate': {
            const { annotateCommand } = await import('./annotate');
            return annotateCommand({ ...args, positional: args.positional.slice(1) });
        }
        case 'disagreements': {
            const { disagreementsCommand } = await import('./disagreements');
            return disagreementsCommand({ ...args, positional: args.positional.slice(1) });
        }
        case 'evaluate': {
            const { evaluateCommand } = await import('./evaluate');
            return evaluateCommand({ ...args, positional: args.positional.slice(1) });
        }
        case 'version':
            process.stdout.write(`extractor ${EXTRACTOR_VERSION}, processing ${PROCESSING_VERSION}, node ${process.version}\n`);
            return 0;
        case 'help':
        case undefined:
            process.stdout.write(USAGE);
            return command === undefined ? 2 : 0;
        default:
            process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
            return 2;
    }
}

main(process.argv.slice(2)).then(
    code => {
        process.exitCode = code;
    },
    (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // Exit 2 marks "you asked for something impossible", separately from exit 1, which the
        // benchmark and evaluate commands use to report that the run itself found a problem.
        if (err instanceof CliOptionError || err instanceof ConfigurationError) {
            process.stderr.write(`invalid option: ${message}\n`);
            process.exitCode = 2;
            return;
        }
        process.stderr.write(`error: ${message}\n`);
        process.exitCode = 1;
    }
);
