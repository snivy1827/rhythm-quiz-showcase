(function () {
  'use strict';

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function inline(text) {
    let s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s;
  }

  function render(markdown) {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let listType = null;
    let inCode = false;
    let codeLines = [];

    function closeList() {
      if (listType) out.push(`</${listType}>`);
      listType = null;
    }
    function closeCode() {
      if (!inCode) return;
      out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      inCode = false;
      codeLines = [];
    }

    for (const raw of lines) {
      if (/^```/.test(raw.trim())) {
        closeList();
        if (inCode) closeCode();
        else { inCode = true; codeLines = []; }
        continue;
      }
      if (inCode) { codeLines.push(raw); continue; }

      const line = raw.trimEnd();
      if (!line.trim()) { closeList(); out.push('<div class="md-spacer"></div>'); continue; }
      if (/^\s*---+\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }

      let m = line.match(/^\s*(#{1,4})\s+(.+)$/);
      if (m) { closeList(); const level=m[1].length; out.push(`<h${level}>${inline(m[2])}</h${level}>`); continue; }

      m = line.match(/^\s*>\s?(.*)$/);
      if (m) { closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }

      m = line.match(/^\s*[-*+]\s+(.+)$/);
      if (m) {
        if (listType !== 'ul') { closeList(); listType='ul'; out.push('<ul>'); }
        out.push(`<li>${inline(m[1])}</li>`); continue;
      }

      m = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (m) {
        if (listType !== 'ol') { closeList(); listType='ol'; out.push('<ol>'); }
        out.push(`<li>${inline(m[1])}</li>`); continue;
      }

      closeList();
      out.push(`<p>${inline(line.trim())}</p>`);
    }
    closeList(); closeCode();
    return out.join('\n');
  }

  window.MarkdownLite = { render, escapeHtml };
})();
