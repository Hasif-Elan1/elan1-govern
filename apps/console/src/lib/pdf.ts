/**
 * A minimal PDF 1.4 writer for reports made in the browser: A4 pages, Helvetica (regular and bold) and Courier,
 * headings, wrapped paragraphs, label–value rows and simple fixed-width tables, with a footer on every page.
 * The output is plain ASCII (characters outside it are written as close ASCII equivalents), so the file's text
 * is also its bytes: a digest of the string is a digest of the file.
 */

export type PdfBlock =
  | { kind: 'title'; text: string }
  | { kind: 'h'; text: string }
  | { kind: 'p'; text: string; size?: number; muted?: boolean }
  | { kind: 'mono'; text: string }
  | { kind: 'kv'; rows: [string, string][] }
  | { kind: 'table'; cols: { title: string; width: number }[]; rows: string[][] }
  | { kind: 'rule' }
  | { kind: 'space'; h?: number };

export interface PdfDoc {
  title: string;
  /** printed in the footer of every page, before the page number */
  footer?: string;
  blocks: PdfBlock[];
  /** fixed creation date (ISO) so the same input gives the same file */
  createdAt?: string;
}

const W = 595.28;
const H = 841.89;
const M = 50;
const BODY_W = W - 2 * M;

/** ASCII only: the PDF's standard fonts here use a single-byte encoding. */
export function pdfAscii(s: string): string {
  return s
    .replace(/₹\s?/g, 'Rs ')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[·•]/g, '-')
    .replace(/→/g, '->')
    .replace(/←/g, '<-')
    .replace(/×/g, 'x')
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/ /g, ' ')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '');
}

const esc = (s: string) => pdfAscii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Approximate Helvetica advance per character, in thousandths of the font size. */
function widthOf(text: string, size: number, font: 'F1' | 'F2' | 'F3') {
  if (font === 'F3') return text.length * 0.6 * size;
  let w = 0;
  for (const ch of text) {
    if ('ijl.,;:!|\'`'.includes(ch)) w += 0.25;
    else if ('ftrI()[] '.includes(ch)) w += 0.32;
    else if ('mwMW@'.includes(ch)) w += 0.85;
    else if (ch >= 'A' && ch <= 'Z') w += 0.68;
    else if (ch >= '0' && ch <= '9') w += 0.556;
    else w += 0.52;
  }
  return w * size * (font === 'F2' ? 1.05 : 1);
}

function wrap(text: string, size: number, maxW: number, font: 'F1' | 'F2' | 'F3' = 'F1'): string[] {
  const out: string[] = [];
  for (const para of pdfAscii(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (widthOf(next, size, font) <= maxW) { line = next; continue; }
      if (line) out.push(line);
      // a single word longer than the line is cut
      let rest = w;
      while (widthOf(rest, size, font) > maxW && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && widthOf(rest.slice(0, cut), size, font) > maxW) cut--;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    out.push(line);
  }
  return out;
}

function clip(text: string, size: number, maxW: number, font: 'F1' | 'F2' | 'F3' = 'F1') {
  let t = pdfAscii(text);
  if (widthOf(t, size, font) <= maxW) return t;
  while (t.length > 1 && widthOf(`${t}...`, size, font) > maxW) t = t.slice(0, -1);
  return `${t}...`;
}

/** Build the PDF file as a string (ASCII). */
export function buildPdf(doc: PdfDoc): string {
  const pages: string[][] = [[]];
  let y = H - M;
  const cur = () => pages[pages.length - 1];
  const newPage = () => { pages.push([]); y = H - M; };
  const need = (h: number) => { if (y - h < M + 24) newPage(); };
  const text = (x: number, yy: number, s: string, size: number, font: 'F1' | 'F2' | 'F3' = 'F1', grey = false) => {
    cur().push(`BT ${grey ? '0.4 0.4 0.4 rg ' : '0 0 0 rg '}/${font} ${size} Tf ${x.toFixed(2)} ${yy.toFixed(2)} Td (${esc(s)}) Tj ET`);
  };
  const line = (x1: number, yy: number, x2: number, grey = 0.75, wdt = 0.6) => cur().push(`${grey} G ${wdt} w ${x1.toFixed(2)} ${yy.toFixed(2)} m ${x2.toFixed(2)} ${yy.toFixed(2)} l S`);

  for (const b of doc.blocks) {
    if (b.kind === 'title') {
      const ls = wrap(b.text, 20, BODY_W, 'F2');
      need(ls.length * 25 + 8);
      for (const l of ls) { text(M, y - 20, l, 20, 'F2'); y -= 25; }
      y -= 6;
    } else if (b.kind === 'h') {
      need(34);
      y -= 10;
      text(M, y - 12, b.text, 12.5, 'F2');
      y -= 16;
      line(M, y, M + BODY_W, 0.2, 0.8);
      y -= 8;
    } else if (b.kind === 'p') {
      const size = b.size ?? 10;
      const ls = wrap(b.text, size, BODY_W);
      for (const l of ls) { need(size + 4); text(M, y - size, l, size, 'F1', b.muted); y -= size + 3.5; }
      y -= 4;
    } else if (b.kind === 'mono') {
      const ls = wrap(b.text, 8.5, BODY_W, 'F3');
      for (const l of ls) { need(12); text(M, y - 8.5, l, 8.5, 'F3'); y -= 11; }
      y -= 4;
    } else if (b.kind === 'kv') {
      const lw = 150;
      for (const [k, v] of b.rows) {
        const ls = wrap(v, 9.5, BODY_W - lw);
        need(ls.length * 13 + 2);
        text(M, y - 9.5, clip(k, 9.5, lw - 8), 9.5, 'F2');
        for (const l of ls) { text(M + lw, y - 9.5, l, 9.5); y -= 13; }
      }
      y -= 4;
    } else if (b.kind === 'table') {
      const total = b.cols.reduce((s, c) => s + c.width, 0);
      const ws = b.cols.map((c) => (c.width / total) * BODY_W);
      const head = () => {
        need(18);
        let x = M;
        b.cols.forEach((c, i) => { text(x, y - 9, clip(c.title, 8.5, ws[i] - 6, 'F2'), 8.5, 'F2'); x += ws[i]; });
        y -= 13;
        line(M, y, M + BODY_W, 0.3);
        y -= 3;
      };
      head();
      for (const row of b.rows) {
        if (y - 13 < M + 24) { newPage(); head(); }
        let x = M;
        row.forEach((cell, i) => { if (i < ws.length) { text(x, y - 9, clip(cell, 8.5, ws[i] - 6), 8.5); x += ws[i]; } });
        y -= 12;
        line(M, y + 1, M + BODY_W, 0.88, 0.4);
      }
      y -= 6;
    } else if (b.kind === 'rule') {
      need(10);
      y -= 4;
      line(M, y, M + BODY_W, 0.6);
      y -= 6;
    } else {
      y -= b.h ?? 8;
    }
  }

  // footer on every page
  const total = pages.length;
  pages.forEach((ops, i) => {
    const f = `${doc.footer ? `${doc.footer} - ` : ''}page ${i + 1} of ${total}`;
    ops.push(`0.6 G 0.4 w ${M} ${M - 6} m ${M + BODY_W} ${M - 6} l S`);
    ops.push(`BT 0.4 0.4 0.4 rg /F1 7.5 Tf ${M} ${M - 18} Td (${esc(clip(f, 7.5, BODY_W))}) Tj ET`);
  });

  // objects: 1 catalog, 2 pages, 3-5 fonts, 6 info, then page + content pairs
  const objs: string[] = [];
  const kids: number[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  const created = (doc.createdAt ?? new Date().toISOString()).replace(/\D/g, '').slice(0, 14);
  objs[6] = `<< /Title (${esc(doc.title)}) /Producer (Elan1 Govern) /CreationDate (D:${created}Z) >>`;
  let next = 7;
  for (const ops of pages) {
    const stream = ops.join('\n');
    const pageId = next++;
    const contentId = next++;
    kids.push(pageId);
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentId} 0 R >>`;
    objs[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  objs[2] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

/** The PDF as a Blob, ready to download. */
export function pdfBlob(pdf: string): Blob {
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return new Blob([bytes], { type: 'application/pdf' });
}
