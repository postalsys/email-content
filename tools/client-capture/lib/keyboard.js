'use strict';

/**
 * Type into a client's compose editor the way a person would: click in, jump to the top or the
 * end, and type. Works for textareas and contenteditable editors alike. Inline answers use the
 * shared DOM helpers instead, since placing a caret mid-quote by keystrokes is client specific.
 */

const { editPlain, editHtmlInline } = require('./edit');

async function typeLines(page, editor, lines, placement) {
    const isTextarea = await editor.evaluate(el => el.tagName === 'TEXTAREA');
    await editor.click();
    // Place the caret with the Selection API rather than key chords: clients bind chords like
    // Cmd+ArrowDown to their own actions (SnappyMail minimises the compose window on it).
    await editor.evaluate((el, atEnd) => {
        el.focus();
        if (el.tagName === 'TEXTAREA') {
            const pos = atEnd ? el.value.length : 0;
            el.setSelectionRange(pos, pos);
            return;
        }
        const range = el.ownerDocument.createRange();
        if (atEnd) {
            // The end of the document is inside the last quoted block. A person presses Enter to
            // leave the quote first; an empty block after it is where that puts the caret.
            const block = el.ownerDocument.createElement('div');
            block.appendChild(el.ownerDocument.createElement('br'));
            el.appendChild(block);
            range.setStart(block, 0);
        } else {
            range.selectNodeContents(el);
        }
        range.collapse(true);
        const selection = el.ownerDocument.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    }, placement === 'below');
    if (placement === 'below' && isTextarea) {
        await page.keyboard.press('Enter');
    }
    for (const [i, line] of lines.entries()) {
        await page.keyboard.type(line);
        if (i < lines.length - 1 || placement !== 'below') {
            await page.keyboard.press('Enter');
        }
    }
    if (placement !== 'below') {
        await page.keyboard.press('Enter');
    }
}

/** Write a scenario into an editor element: a textarea or a contenteditable root. */
async function writeScenario(page, editor, scenario, placement) {
    const isTextarea = await editor.evaluate(el => el.tagName === 'TEXTAREA');
    if (scenario.inline && scenario.inline.length) {
        if (isTextarea) {
            await editor.evaluate(editPlain, { lines: [], inline: scenario.inline });
        } else {
            await editor.evaluate(
                (el, [src, inline]) => {
                    // eslint-disable-next-line no-new-func
                    new Function(`return ${src}`)()(el, inline);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                },
                [editHtmlInline.toString(), scenario.inline]
            );
        }
        return;
    }
    await typeLines(page, editor, scenario.typed.lines, placement);
}

module.exports = { typeLines, writeScenario };
