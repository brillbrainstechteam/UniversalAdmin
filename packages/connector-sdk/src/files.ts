// read-excel-file ships ESM typings but a CommonJS build; load the CommonJS entry explicitly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const readXlsxFile = require('read-excel-file/node') as (input: Buffer) => Promise<unknown[][]>;

export const MAX_FILE_ROWS = 5000;

export class FileFormatError extends Error {}

export interface TabularFile {
  columns: string[];
  /** Data rows keyed by header; `rowNo` is the 1-based line/row in the source file. */
  rows: { rowNo: number; values: Record<string, string> }[];
}

/** RFC 4180 CSV: quoted fields, escaped quotes, embedded commas/newlines, CRLF/LF, UTF-8 BOM. */
export function parseCsv(text: string): { line: number; cells: string[] }[] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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
  if (inQuotes) throw new FileFormatError(`Unterminated quoted field starting on line ${rowLine}`);
  cells.push(field);
  if (cells.some((c) => c !== '')) rows.push({ line: rowLine, cells });
  return rows;
}

function toTable(rows: { line: number; cells: string[] }[]): TabularFile {
  const [header, ...data] = rows;
  if (!header) throw new FileFormatError('The file is empty');
  const columns = header.cells.map((c) => c.trim());
  if (columns.some((c) => c === '')) throw new FileFormatError('Every column needs a header name');
  const dup = columns.find((c, i) => columns.findIndex((x) => x.toLowerCase() === c.toLowerCase()) !== i);
  if (dup) throw new FileFormatError(`Column "${dup}" appears twice`);
  if (data.length === 0) throw new FileFormatError('The file has a header but no data rows');
  if (data.length > MAX_FILE_ROWS)
    throw new FileFormatError(`At most ${MAX_FILE_ROWS} rows per file (got ${data.length})`);
  return {
    columns,
    rows: data.map((r) => ({
      rowNo: r.line,
      values: Object.fromEntries(columns.map((c, i) => [c, (r.cells[i] ?? '').trim()])),
    })),
  };
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/** Excel cells → text without float artefacts: numbers keep up to 6 decimals, dates become ISO. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') {
    // Excel stores numbers as binary doubles; round to the 6 dp we accept, then trim trailing zeros.
    const fixed = value.toFixed(6).replace(/\.?0+$/, '');
    return fixed === '-0' ? '0' : fixed;
  }
  return String(value);
}

/**
 * Parses an uploaded CSV or XLSX (first worksheet). The format is decided by content (ZIP magic bytes), not by the
 * file name; anything else must be valid UTF-8 CSV.
 */
export async function parseTabular(fileName: string, bytes: Buffer): Promise<TabularFile> {
  const isZip = ZIP_MAGIC.every((b, i) => bytes[i] === b);
  if (isZip) {
    let sheet: unknown[][];
    try {
      sheet = await readXlsxFile(bytes);
    } catch {
      throw new FileFormatError(`${fileName} is not a readable .xlsx workbook`);
    }
    return toTable(
      sheet
        .map((cells, i) => ({ line: i + 1, cells: cells.map(cellText) }))
        .filter((r) => r.cells.some((c) => c !== '')),
    );
  }
  if (bytes.includes(0)) throw new FileFormatError(`${fileName} is neither CSV text nor an .xlsx workbook`);
  const text = bytes.toString('utf8');
  if (text.includes('�')) throw new FileFormatError(`${fileName} is not UTF-8 text; save it as "CSV UTF-8"`);
  return toTable(parseCsv(text));
}
