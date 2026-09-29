'use strict';

/**
 * Editing helpers that run inside the page, shared by every driver.
 *
 * They mimic what a person does in the editor: type at the caret the client placed, or, for an
 * inline reply, split the quote after a paragraph and write the answer between the halves. They
 * never rewrite the quote itself, so the quoting structure stays the client's own.
 */

/** Plain text compose: a textarea. Runs in the page. */
function editPlain(el, { lines, inline }) {
    let value = el.value.replace(/\r\n/g, '\n');
    if (inline && inline.length) {
        const rows = value.split('\n');
        for (const item of inline) {
            let i = rows.findIndex(row => row.includes(item.after));
            if (i === -1) {
                throw new Error(`inline anchor ${item.after} not found`);
            }
            // The token may sit on the first line of a wrapped paragraph: answer after the whole paragraph.
            while (i + 1 < rows.length && /^>+ ?\S/.test(rows[i + 1])) {
                i++;
            }
            rows.splice(i + 1, 0, '', item.text, '');
        }
        value = rows.join('\n');
    } else if (lines && lines.length) {
        const caret = typeof el.selectionStart === 'number' ? el.selectionStart : 0;
        value = value.slice(0, caret) + lines.join('\n') + value.slice(caret);
    }
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * HTML compose, inline answers only: split the enclosing blockquote after the paragraph holding
 * each anchor token and put the answer between the halves. Runs in the editor's document.
 */
function editHtmlInline(root, inline) {
    const doc = root.ownerDocument || root;
    for (const item of inline) {
        const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node && !node.nodeValue.includes(item.after)) {
            node = walker.nextNode();
        }
        if (!node) {
            throw new Error(`inline anchor ${item.after} not found`);
        }
        let child = node.parentElement;
        let quote = child.closest('blockquote');
        if (!quote) {
            // Some clients quote with ">" characters even in HTML. Answer after the block that
            // holds the quoted line, which is what a person clicking after it would get.
            let block = child;
            while (block.parentElement && block.parentElement !== root && getComputedStyle(block).display === 'inline') {
                block = block.parentElement;
            }
            const answer = doc.createElement('p');
            answer.textContent = item.text;
            block.after(answer);
            continue;
        }
        // Outermost quote, so nested markup inside the quote stays intact.
        let outer = quote;
        while (outer.parentElement && outer.parentElement.closest('blockquote')) {
            outer = outer.parentElement.closest('blockquote');
        }
        quote = outer;
        while (child.parentElement !== quote) {
            child = child.parentElement;
        }
        const rest = quote.cloneNode(false);
        while (child.nextSibling) {
            rest.appendChild(child.nextSibling);
        }
        const answer = doc.createElement('p');
        answer.textContent = item.text;
        quote.after(answer);
        if (rest.childNodes.length) {
            answer.after(rest);
        }
    }
}

module.exports = { editPlain, editHtmlInline };
