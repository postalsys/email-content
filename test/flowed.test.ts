import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFlowed } from '../src/mime/flowed';

describe('format=flowed decoding', () => {
    it('joins soft wrapped unquoted lines and drops stuffing', () => {
        assert.equal(decodeFlowed('Hello this is \nflowed text.\n stuffed line'), 'Hello this is flowed text.\nstuffed line');
    });

    it('keeps a signature separator as a line of its own', () => {
        assert.equal(decodeFlowed('Thanks \nfor that.\n-- \nMarta'), 'Thanks for that.\n-- \nMarta');
    });

    it('joins quoted lines without copying the continuation quote marker', () => {
        // libmime produced "> quoted soft > continued" here.
        assert.equal(decodeFlowed('> quoted soft \n> continued\nnew'), '> quoted soft continued\nnew');
        assert.equal(decodeFlowed('>> deep soft \n>> more\n> shallow'), '>> deep soft more\n> shallow');
    });

    it('treats the space after a quote marker as stuffing, not a soft break', () => {
        // Roundcube writes an empty quoted line as "> ". Read as flowed, it swallowed the next
        // quoted line and doubled its marker: "> > Also, ...".
        assert.equal(decodeFlowed('> \n> Also, the delivery\n> the system.'), '>\n> Also, the delivery\n> the system.');
    });

    it('never joins across a change of quote depth', () => {
        assert.equal(decodeFlowed('a \n> b'), 'a \n> b');
        assert.equal(decodeFlowed('> a \nb'), '> a \nb');
    });

    it('removes the soft break space when delsp=yes', () => {
        assert.equal(decodeFlowed('split \nword', true), 'splitword');
    });

    it('accepts CRLF line endings', () => {
        assert.equal(decodeFlowed('one \r\ntwo\r\n> q \r\n> r'), 'one two\n> q r');
    });

    it('stays linear on a long soft wrapped body', () => {
        const body = 'word '.repeat(1).concat('\n').repeat(200000);
        const started = Date.now();
        decodeFlowed(body);
        assert.ok(Date.now() - started < 2000);
    });
});
