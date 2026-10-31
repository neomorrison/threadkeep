// Splits a JSON text stream into top-level array elements without holding the whole file as one string.
// A 600 MB conversations.json can be read this way; JSON.parse on the whole text could not.
// Feed it text chunks in order. It calls onElement(jsonText) for each element of a top-level array.
// If the document is a top-level object (or anything else), it collects the text and reports it from end().

export class JsonStreamSplitter {
  constructor(onElement) {
    this.onElement = onElement;
    this.mode = null;       // 'array' | 'whole'
    this.depth = 0;         // nesting depth inside the top-level array (0 = between elements)
    this.inStr = false;
    this.esc = false;
    this.parts = [];        // pieces of the element being read, or of the whole document
    this.count = 0;
  }

  feed(text) {
    if (!text) return;
    if (this.mode === null) {
      let i = 0;
      while (i < text.length && /[\s﻿]/.test(text[i])) i++;
      if (i === text.length) return;
      this.mode = text[i] === '[' ? 'array' : 'whole';
      if (this.mode === 'whole') { this.parts.push(text.slice(i)); return; }
      text = text.slice(i + 1);
    }
    if (this.mode === 'whole') { this.parts.push(text); return; }

    let segStart = this.depth > 0 ? 0 : -1; // where the current element's text starts inside this chunk
    const n = text.length;
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i);
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (c === 92) this.esc = true;      // backslash
        else if (c === 34) this.inStr = false;   // closing quote
        continue;
      }
      if (c === 34) { this.inStr = true; continue; } // opening quote
      if (c === 123 || c === 91) { // { [
        if (this.depth === 0) segStart = i;
        this.depth++;
      } else if (c === 125 || c === 93) { // } ]
        if (this.depth === 0) { this.done = true; return; } // closing ] of the top-level array
        this.depth--;
        if (this.depth === 0) {
          this.parts.push(text.slice(segStart, i + 1));
          segStart = -1;
          const el = this.parts.length === 1 ? this.parts[0] : this.parts.join('');
          this.parts = [];
          this.count++;
          this.onElement(el);
        }
      }
    }
    if (this.depth > 0 && segStart !== -1) this.parts.push(text.slice(segStart));
  }

  /** For a non-array document: the full text. For arrays: null. */
  end() {
    if (this.mode === 'whole') return this.parts.join('');
    return null;
  }
}
