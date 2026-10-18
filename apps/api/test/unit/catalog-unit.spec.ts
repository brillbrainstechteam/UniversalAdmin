import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/common/csv';
import { safeFilename, sniffImageType } from '../../src/common/image-sniff';
import { assertTransition, checkVariantOptions } from '../../src/modules/catalog/catalog-rules';

describe('parseCsv (RFC 4180)', () => {
  it('handles quotes, escaped quotes, embedded commas/newlines, CRLF, BOM and blank lines', () => {
    const rows = parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","multi\nline"\r\n\r\n1,,3\n');
    expect(rows).toEqual([
      { line: 1, cells: ['a', 'b', 'c'] },
      { line: 2, cells: ['x, y', 'say "hi"', 'multi\nline'] },
      { line: 5, cells: ['1', '', '3'] },
    ]);
  });
  it('rejects an unterminated quote with its line', () => {
    expect(() => parseCsv('a\n"open')).toThrow(/line 2/);
  });
});

describe('image sniffing', () => {
  it('trusts bytes, not names or declared types', () => {
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(Buffer.from('<html>'))).toBeNull();
  });
  it('sanitises filenames', () => {
    expect(safeFilename('../../etc/pass"wd<script>.png')).toBe('pass_wd_script_.png');
    expect(safeFilename(undefined)).toBe('upload');
  });
});

describe('catalog rules', () => {
  const options = [{ name: 'Size', values: ['S', 'M'] }];
  it('variant options must match product axes and declared values (case-insensitive)', () => {
    expect(checkVariantOptions(options, { Size: 'm' }).key).toBe('size=m');
    expect(() => checkVariantOptions(options, {})).toThrow();
    expect(() => checkVariantOptions(options, { Size: 'XL' })).toThrow();
    expect(() => checkVariantOptions(options, { Size: 'S', Colour: 'Red' })).toThrow();
    expect(checkVariantOptions([], {}).key).toBe('');
  });
  it('product status transitions', () => {
    expect(() => assertTransition('draft', 'active')).not.toThrow();
    expect(() => assertTransition('archived', 'draft')).not.toThrow();
    expect(() => assertTransition('archived', 'active')).toThrow(/archived product cannot become active/);
  });
});
