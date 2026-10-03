// RFC-4180 CSV reading, shared by the holiday-list import, the data import and settlement reports.

/**
 * RFC-4180 CSV → [{line, fields}] (line = 1-based physical line where the record starts).
 * Strips a UTF-8 BOM, accepts CRLF/LF/CR, quoted fields with commas, "" escapes and embedded newlines.
 * Blank records are skipped.
 */
export function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const records = [];
  let field = '', fields = [], inQuotes = false, line = 1, startLine = 1;
  const endRecord = () => {
    fields.push(field);
    if (fields.some(f => f.trim() !== '')) records.push({ line: startLine, fields });
    field = ''; fields = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else if (c === '\r') {
        if (s[i + 1] !== '\n') { line++; field += '\n'; } // lone CR is a line break; CRLF adds its LF next
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; }
    else if (c === ',') { fields.push(field); field = ''; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      endRecord();
      line++;
      startLine = line;
    } else { field += c; }
  }
  if (inQuotes) records.push({ line: startLine, fields: [...fields, field], unterminated: true });
  else endRecord();
  return records;
}

/** Header key normaliser: lowercase letters and digits only ('Admission No.' → 'admissionno'). */
export const normHeader = h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * CSV with a header row → {headers, rows:[{line, values:{header: string}}], problems:[{line, reason}]}.
 * Values are trimmed. Duplicate or empty header names are made unique ('Phone', 'Phone (2)', 'Column 3').
 * An unterminated quoted field, or a row with more fields than headers, is reported in problems and kept as a row
 * with `problem` set (the importers quarantine it), never dropped.
 */
export function parseCsvObjects(text) {
  const records = parseCsv(text);
  if (!records.length) return { headers: [], rows: [], problems: [] };
  const [head, ...rest] = records;
  // a generated name ('Phone (2)') must never equal a literal header, or one column would overwrite another
  const raw = head.fields.map((f, i) => String(f).trim() || `Column ${i + 1}`);
  const used = new Set();
  const literal = new Set(raw);
  const headers = raw.map(h => {
    if (!used.has(h)) { used.add(h); return h; }
    let n = 2;
    while (used.has(`${h} (${n})`) || literal.has(`${h} (${n})`)) n++;
    const g = `${h} (${n})`;
    used.add(g);
    return g;
  });
  const rows = [], problems = [];
  if (head.unterminated) problems.push({ line: head.line, reason: 'unterminated quoted field in the header row' });
  for (const r of rest) {
    const values = {};
    headers.forEach((h, i) => { values[h] = String(r.fields[i] ?? '').trim(); });
    if (r.unterminated) {
      // kept as a row (so counts reconcile) but flagged: the importer quarantines it
      problems.push({ line: r.line, reason: 'unterminated quoted field' });
      rows.push({ line: r.line, values, problem: 'unterminated quoted field' });
      continue;
    }
    if (r.fields.length > headers.length && r.fields.slice(headers.length).some(f => f.trim() !== '')) {
      // e.g. an unquoted "1,000": the values no longer line up with the headers, so the row is quarantined
      const reason = `${r.fields.length} fields but ${headers.length} headers (an unquoted comma?)`;
      problems.push({ line: r.line, reason });
      rows.push({ line: r.line, values, problem: reason });
      continue;
    }
    rows.push({ line: r.line, values });
  }
  return { headers, rows, problems };
}
