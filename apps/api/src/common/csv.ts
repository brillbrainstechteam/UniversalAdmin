/**
 * Minimal RFC 4180 CSV parser: quoted fields, escaped quotes (""), embedded commas/newlines, CRLF or LF.
 * Returns rows with their 1-based starting line number. Throws on an unterminated quote.
 */
export function parseCsv(text: string): { line: number; cells: string[] }[] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip UTF-8 BOM
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') inQuotes = true;
    else if (ch === ',') {
      cells.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      cells.push(field);
      if (cells.some((c) => c !== '')) rows.push({ line: rowLine, cells });
      cells = [];
      field = '';
      line++;
      rowLine = line;
    } else field += ch;
  }
  if (inQuotes) throw new Error(`Unterminated quoted field starting on line ${rowLine}`);
  cells.push(field);
  if (cells.some((c) => c !== '')) rows.push({ line: rowLine, cells });
  return rows;
}
