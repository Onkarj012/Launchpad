// Usage:
//   node tests/resume/verify.mjs                          verify every .tex under resumes/sources/
//                                                           (including one level of date subdirs)
//   node tests/resume/verify.mjs <source.tex> [output.pdf]  verify one source; if output.pdf is
//                                                           given, that exact delivered PDF is used
//                                                           for the page-count / page-fill / text-
//                                                           extraction checks (the source is still
//                                                           compiled separately to check the log).
//   node tests/resume/verify.mjs a.tex b.tex ...           verify multiple sources (no explicit PDFs)
//
// Extended checks (template conformance + page fill) compare against the canonical layout
// template at resumes/templates/Onkar_Template.tex. Slots delimited by
// `%== TAILOR-START: NAME ==` / `%== TAILOR-END: NAME ==` are free to differ; everything else,
// including the full preamble (\documentclass .. \begin{document}), must match byte-for-byte.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CLAIM_PATTERNS = [
  { label: '5-10 active', pattern: /5\s*[-–—]+\s*10 active/ },
  { label: 'GPT-4o', pattern: /GPT-4o/ },
  { label: 'indexed 5M vectors', pattern: /indexe[sd].*5M vectors/i },
  { label: 'Nov 2025', pattern: /Nov 2025/ },
];

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_DIR = join(PROJECT_ROOT, 'resumes', 'sources');
const OUTPUT_DIR = join(PROJECT_ROOT, 'resumes', 'output');
const TEMPLATE_PATH = join(PROJECT_ROOT, 'resumes', 'templates', 'Onkar_Template.tex');
const EVIDENCE_CATALOGUE_PATH = join(PROJECT_ROOT, 'resumes', 'evidence', 'approved-evidence.md');
const MIN_PAGE_FILL = 0.93;
const SLOT_MARKER = /%==\s*TAILOR-(START|END):\s*([A-Z0-9-]+)\s*==\s*\r?\n/g;

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
  };
}

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function sourceLineAt(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function claimReasons(source) {
  return CLAIM_PATTERNS.flatMap(({ label, pattern }) => {
    pattern.lastIndex = 0;
    const match = pattern.exec(source);
    return match ? [`claim pattern "${label}" at source line ${sourceLineAt(source, match.index)}`] : [];
  });
}

function slotContents(source) {
  const marker = '\\begin{document}';
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const { segments } = splitSlots(source.slice(start + marker.length));
  return segments.filter((segment) => segment.type === 'slot').map((segment) => segment.text).join('\n');
}

function proseReasons(source) {
  const prose = slotContents(source);
  const reasons = [];
  if (prose.includes('—')) reasons.push('Unicode em dash in tailored prose');
  if (prose.includes('---')) reasons.push('LaTeX triple hyphen in tailored prose');
  return reasons;
}

function evidenceCatalogue() {
  if (!existsSync(EVIDENCE_CATALOGUE_PATH)) return { ids: new Map(), reasons: [`evidence catalogue not found: ${EVIDENCE_CATALOGUE_PATH}`] };
  const text = readFileSync(EVIDENCE_CATALOGUE_PATH, 'utf8');
  const ids = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\|\s*`([^`]+)`\s*\|[^|]*\|\s*`([^`]+)`\s*\|/);
    if (match) ids.set(match[1], match[2]);
  }
  return { ids, reasons: ids.size ? [] : ['evidence catalogue has no locator rows'] };
}

function sidecarMetadata(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  const values = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([a-z-]+):\s*(.+?)\s*$/);
    if (pair) values.set(pair[1], pair[2]);
  }
  return values;
}

function tableRows(text, expectedHeader) {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() === expectedHeader);
  if (index < 0 || !/^\|\s*---/.test(lines[index + 1] || '')) return [];
  const rows = [];
  for (let i = index + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
    const cells = lines[i].split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function evidenceSidecarReasons(sourcePath, source) {
  // Legacy tailored sources predate the evidence contract. New sources copied from
  // the current template opt in via this frozen marker and must include both sidecars.
  if (!source.includes('% RESUME_EVIDENCE_V1')) return [];
  const stem = basename(sourcePath, extname(sourcePath));
  const directory = dirname(sourcePath);
  const expected = [
    { suffix: '.matrix.md', kind: 'resume-requirement-matrix' },
    { suffix: '.provenance.md', kind: 'resume-claim-provenance' },
  ];
  const { ids, reasons } = evidenceCatalogue();
  const failures = [...reasons];
  const master = existsSync(join(PROJECT_ROOT, 'resumes', 'master', 'Master_Resume_ATS.tex'))
    ? readFileSync(join(PROJECT_ROOT, 'resumes', 'master', 'Master_Resume_ATS.tex'), 'utf8')
    : '';
  const profileIds = new Set(['ai-product-full-stack', 'full-stack-backend', 'applied-ml-ai']);

  for (const { suffix, kind } of expected) {
    const path = join(directory, `${stem}${suffix}`);
    if (!existsSync(path)) {
      failures.push(`missing evidence sidecar ${basename(path)}`);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    const metadata = sidecarMetadata(text);
    if (!metadata) {
      failures.push(`${basename(path)} missing YAML metadata`);
      continue;
    }
    if (metadata.get('kind') !== kind) failures.push(`${basename(path)} has wrong kind metadata`);
    if (metadata.get('source') !== basename(sourcePath)) failures.push(`${basename(path)} source metadata must equal ${basename(sourcePath)}`);
    if (!profileIds.has(metadata.get('profile'))) failures.push(`${basename(path)} has an unknown profile`);
    if (metadata.get('approved-evidence') !== 'resumes/evidence/approved-evidence.md') failures.push(`${basename(path)} has wrong approved-evidence metadata`);

    if (kind === 'resume-requirement-matrix') {
      const rows = tableRows(text, '| Exact JD phrase | Required / preferred | Category | Approved evidence locator | Target section | Resume wording | Covered / missing |');
      if (!rows.length) failures.push(`${basename(path)} has no requirement rows`);
      for (const [phrase, , category, locator, , wording, state] of rows) {
        if (!phrase || !category || !wording || !state) failures.push(`${basename(path)} has an incomplete requirement row`);
        const missing = /^Missing\b/i.test(state || '');
        if (!missing && !/^Covered\b/i.test(state || '')) failures.push(`${basename(path)} row for ${JSON.stringify(phrase)} lacks Covered or Missing state`);
        if (missing && !/^(Unsupported|Not Verified)$/i.test(locator || '')) failures.push(`${basename(path)} missing row for ${JSON.stringify(phrase)} must use Unsupported or Not Verified`);
        if (!missing && !ids.has(locator)) failures.push(`${basename(path)} covered row for ${JSON.stringify(phrase)} has invalid locator ${JSON.stringify(locator)}`);
      }
    } else {
      const rows = tableRows(text, '| Claim ID | Tailored claim | Resume section | Approved evidence locator | Equivalence note |');
      const claimIds = new Set();
      if (!rows.length) failures.push(`${basename(path)} has no provenance rows`);
      for (const [claimId, claim, section, locator, note] of rows) {
        if (!claimId || !claim || !section || !locator || !note) failures.push(`${basename(path)} has an incomplete provenance row`);
        if (claimIds.has(claimId)) failures.push(`${basename(path)} repeats Claim ID ${JSON.stringify(claimId)}`);
        claimIds.add(claimId);
        if (!ids.has(locator)) failures.push(`${basename(path)} claim ${JSON.stringify(claimId)} has invalid locator ${JSON.stringify(locator)}`);
      }
    }
  }

  for (const [id, anchor] of ids) {
    if (!master.includes(anchor)) failures.push(`evidence catalogue locator ${id} anchor is absent from Master_Resume_ATS.tex`);
  }
  return failures;
}

function fontReasons(pdfPath) {
  const fonts = runCommand('pdffonts', [pdfPath]);
  if (fonts.error) return [`pdffonts: ${oneLine(fonts.error.message)}`];
  if (fonts.status !== 0) return [`pdffonts exit ${fonts.status ?? 'unknown'}`];
  const entries = fonts.stdout.split(/\r?\n/).filter((line) => /\s(?:yes|no)\s+(?:yes|no)\s+(?:yes|no)\s+\d+\s+\d+\s*$/.test(line));
  if (!entries.length) return ['pdffonts reported no embedded font entries'];
  return entries.filter((line) => !/\s+yes\s+(?:yes|no)\s+(?:yes|no)\s+\d+\s+\d+\s*$/.test(line)).map((line) => `font is not embedded: ${oneLine(line)}`);
}

function linkReasons(pdfPath) {
  const urls = runCommand('pdfinfo', ['-url', pdfPath]);
  if (urls.error) return [`pdfinfo -url: ${oneLine(urls.error.message)}`];
  if (urls.status !== 0) return [`pdfinfo -url exit ${urls.status ?? 'unknown'}`];
  const expected = ['mailto:onkarj012@gmail.com', 'https://github.com/Onkarj012', 'https://leo4.dev', 'https://linkedin.com/in/onkarj012'];
  return expected.filter((url) => !urls.stdout.includes(url)).map((url) => `PDF link missing ${url}`);
}

function overfullReasons(log) {
  return log.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith('Overfull \\hbox')) return [];
    const match = line.match(/Overfull \\hbox \(([\d.]+)pt too wide\)/);
    if (!match || Number(match[1]) <= 5) return [];
    const lines = line.match(/\bat lines? (\d+)(?:--(\d+))?/);
    const location = lines
      ? lines[2] ? `source lines ${lines[1]}-${lines[2]}` : `source line ${lines[1]}`
      : null;
    return [`overfull hbox ${match[1]}pt${location ? ` (${location})` : ''}`];
  });
}

function readingOrderReasons(text) {
  const reasons = [];
  const nameIndex = text.indexOf('Onkar Jadhav');
  if (nameIndex < 0) reasons.push('extracted text missing "Onkar Jadhav"');

  const projectIndex = nameIndex < 0 ? -1 : text.indexOf('Projects', nameIndex + 'Onkar Jadhav'.length);
  if (projectIndex < 0) reasons.push('extracted text missing "Projects" after the name');

  const sectionIndexes = ['Education', 'Experience']
    .map((section) => text.indexOf(section, nameIndex + 1))
    .filter((index) => index >= 0 && (projectIndex < 0 || index < projectIndex));
  if (!sectionIndexes.length) reasons.push('extracted text missing "Education" or "Experience" before "Projects"');

  const skillsIndex = projectIndex < 0 ? -1 : text.indexOf('Technical Skills', projectIndex + 'Projects'.length);
  if (skillsIndex < 0) reasons.push('extracted text missing "Technical Skills" after "Projects"');
  return reasons;
}

function extractPreamble(source) {
  const start = source.indexOf('\\documentclass');
  const marker = '\\begin{document}';
  const beginIndex = source.indexOf(marker);
  if (start < 0 || beginIndex < 0) return null;
  return source.slice(start, beginIndex + marker.length);
}

function firstDiffLine(a, b) {
  const linesA = a.split(/\r?\n/);
  const linesB = b.split(/\r?\n/);
  const max = Math.max(linesA.length, linesB.length);
  for (let i = 0; i < max; i += 1) {
    if (linesA[i] !== linesB[i]) {
      return `line ${i + 1}: expected ${JSON.stringify(linesB[i] ?? '<eof>')} got ${JSON.stringify(linesA[i] ?? '<eof>')}`;
    }
  }
  return null;
}

function preambleReasons(source, templateSource) {
  const candidate = extractPreamble(source);
  const template = extractPreamble(templateSource);
  if (!template) return ['template preamble could not be located (missing \\documentclass or \\begin{document})'];
  if (!candidate) return ['source preamble could not be located (missing \\documentclass or \\begin{document})'];
  if (candidate === template) return [];
  const diff = firstDiffLine(candidate, template);
  return [`preamble drift from resumes/templates/Onkar_Template.tex — ${diff ?? 'content differs'}`];
}

// Split a document body into an ordered list of segments: frozen text and named
// tailor slots. Each slot segment retains its own START/END marker lines (those are
// frozen boundary text) but its inner content is free to differ between documents.
function splitSlots(body) {
  const segments = [];
  let cursor = 0;
  let openName = null;
  let openStart = 0;
  const re = new RegExp(SLOT_MARKER);
  let match;
  const errors = [];
  while ((match = re.exec(body))) {
    const [full, kind, name] = match;
    if (kind === 'START') {
      if (openName) {
        errors.push(`nested TAILOR-START: ${name} inside ${openName}`);
        continue;
      }
      segments.push({ type: 'frozen', text: body.slice(cursor, match.index) });
      segments.push({ type: 'marker', text: full });
      openName = name;
      openStart = match.index + full.length;
    } else {
      if (!openName) {
        errors.push(`TAILOR-END: ${name} without matching TAILOR-START`);
        continue;
      }
      if (openName !== name) {
        errors.push(`TAILOR-END: ${name} does not match open slot ${openName}`);
      }
      segments.push({ type: 'slot', name: openName, text: body.slice(openStart, match.index) });
      segments.push({ type: 'marker', text: full });
      openName = null;
      cursor = match.index + full.length;
    }
  }
  if (openName) errors.push(`TAILOR-START: ${openName} never closed`);
  segments.push({ type: 'frozen', text: body.slice(cursor) });
  return { segments, errors };
}

function frozenZoneReasons(source, templateSource) {
  const marker = '\\begin{document}';
  const candBodyStart = source.indexOf(marker);
  const tmplBodyStart = templateSource.indexOf(marker);
  if (candBodyStart < 0 || tmplBodyStart < 0) return ['could not locate \\begin{document} to compare body content'];

  const candidateBody = source.slice(candBodyStart + marker.length);
  const templateBody = templateSource.slice(tmplBodyStart + marker.length);

  const candidateSplit = splitSlots(candidateBody);
  const templateSplit = splitSlots(templateBody);
  const reasons = [...candidateSplit.errors, ...templateSplit.errors];
  if (reasons.length) return reasons;

  const candidateSlotNames = candidateSplit.segments.filter((s) => s.type === 'slot').map((s) => s.name);
  const templateSlotNames = templateSplit.segments.filter((s) => s.type === 'slot').map((s) => s.name);
  const missing = templateSlotNames.filter((n) => !candidateSlotNames.includes(n));
  const extra = candidateSlotNames.filter((n) => !templateSlotNames.includes(n));
  if (missing.length) reasons.push(`missing tailor slot(s): ${missing.join(', ')}`);
  if (extra.length) reasons.push(`unexpected tailor slot(s) not in template: ${extra.join(', ')}`);
  if (reasons.length) return reasons;

  // Build a "masked" body per document: frozen + marker text kept verbatim, slot
  // interiors replaced with a canonical placeholder so frozen zones can be compared
  // byte-for-byte independent of tailored content.
  const mask = (split) =>
    split.segments.map((s) => (s.type === 'slot' ? `[[SLOT:${s.name}]]` : s.text)).join('');

  const candidateMasked = mask(candidateSplit);
  const templateMasked = mask(templateSplit);
  if (candidateMasked === templateMasked) return [];
  const diff = firstDiffLine(candidateMasked, templateMasked);
  return [`frozen-zone drift from resumes/templates/Onkar_Template.tex outside TAILOR slots — ${diff ?? 'content differs'}`];
}

function pageFillReasons(pdfPath) {
  const bbox = runCommand('pdftotext', ['-bbox', pdfPath, '-']);
  if (bbox.error) return [`pdftotext -bbox: ${oneLine(bbox.error.message)}`];
  if (bbox.status !== 0) return [`pdftotext -bbox exit ${bbox.status ?? 'unknown'}`];

  const pageMatch = bbox.stdout.match(/<page width="([\d.]+)" height="([\d.]+)">/);
  if (!pageMatch) return ['pdftotext -bbox did not report a page size'];
  const pageHeight = Number(pageMatch[2]);

  const yMaxValues = [...bbox.stdout.matchAll(/yMax="([\d.]+)"/g)].map((m) => Number(m[1]));
  if (!yMaxValues.length) return ['pdftotext -bbox reported no text content'];

  const lastContentY = Math.max(...yMaxValues);
  const fill = lastContentY / pageHeight;
  if (fill < MIN_PAGE_FILL) {
    return [`page fill ${(fill * 100).toFixed(1)}% (last content at ${lastContentY.toFixed(1)}pt of ${pageHeight.toFixed(1)}pt) is below the ${(MIN_PAGE_FILL * 100).toFixed(0)}% minimum`];
  }
  return [];
}

function resultLine(fileName, failures, warnings) {
  const status = failures.length ? 'FAIL' : warnings.length ? 'WARN' : 'PASS';
  const reasons = [...failures, ...warnings];
  return { status, line: `${status} ${fileName} — ${reasons.length ? reasons.join('; ') : 'all checks passed'}` };
}

function findOutputPdf(stem) {
  const flat = join(OUTPUT_DIR, `${stem}.pdf`);
  if (existsSync(flat)) return flat;
  if (!existsSync(OUTPUT_DIR)) return null;
  for (const entry of readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(OUTPUT_DIR, entry.name, `${stem}.pdf`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function verifyFile(inputPath, pdfPathArg) {
  const sourcePath = resolve(inputPath);
  const fileName = basename(sourcePath);
  const failures = [];
  const warnings = [];
  let tempDir;

  try {
    if (!existsSync(sourcePath)) {
      failures.push('source file not found');
      return resultLine(fileName, failures, warnings);
    }

    const source = readFileSync(sourcePath, 'utf8');
    failures.push(...claimReasons(source));
    failures.push(...proseReasons(source));
    failures.push(...evidenceSidecarReasons(sourcePath, source));

    if (existsSync(TEMPLATE_PATH)) {
      const templateSource = readFileSync(TEMPLATE_PATH, 'utf8');
      failures.push(...preambleReasons(source, templateSource));
      failures.push(...frozenZoneReasons(source, templateSource));
    } else {
      failures.push(`canonical template not found at ${TEMPLATE_PATH}`);
    }

    tempDir = mkdtempSync(join(tmpdir(), 'resume-verify-'));
    const stem = basename(sourcePath, extname(sourcePath));
    const compile = runCommand(
      'pdflatex',
      ['-interaction=nonstopmode', '-output-directory', tempDir, basename(sourcePath)],
      { cwd: dirname(sourcePath) },
    );
    const logPath = join(tempDir, `${stem}.log`);
    const log = existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
      : `${compile.stdout}\n${compile.stderr}`;

    if (compile.error) failures.push(`pdflatex: ${oneLine(compile.error.message)}`);
    if (compile.status !== 0) failures.push(`pdflatex exit ${compile.status ?? 'unknown'}`);
    failures.push(...log.split(/\r?\n/).filter((line) => line.startsWith('!')).map((line) => `pdflatex log: ${oneLine(line)}`));
    failures.push(...overfullReasons(log));

    const compiledPdfPath = join(tempDir, `${stem}.pdf`);
    if (!existsSync(compiledPdfPath)) {
      failures.push('pdflatex did not produce a PDF');
    }

    // The PDF used for artifact checks (page count, fill, extraction) is the exact
    // delivered file when the caller supplies one; otherwise it's the freshly
    // compiled temp PDF (compile-only invocations, e.g. the default source sweep).
    let pdfForChecks = null;
    if (pdfPathArg) {
      const resolvedPdf = resolve(pdfPathArg);
      if (!existsSync(resolvedPdf)) {
        failures.push(`output PDF not found: ${resolvedPdf}`);
      } else {
        pdfForChecks = resolvedPdf;
      }
    } else if (existsSync(compiledPdfPath)) {
      pdfForChecks = compiledPdfPath;
    }

    if (pdfForChecks) {
      const info = runCommand('pdfinfo', [pdfForChecks]);
      if (info.error) failures.push(`pdfinfo: ${oneLine(info.error.message)}`);
      if (info.status !== 0) failures.push(`pdfinfo exit ${info.status ?? 'unknown'}`);
      const pageMatch = info.stdout.match(/^Pages:\s+(\d+)$/m);
      if (!pageMatch) {
        failures.push('pdfinfo did not report a page count');
      } else if (Number(pageMatch[1]) !== 1) {
        failures.push(`page count ${pageMatch[1]} (expected 1)`);
      }

      const text = runCommand('pdftotext', ['-layout', pdfForChecks, '-']);
      if (text.error) failures.push(`pdftotext: ${oneLine(text.error.message)}`);
      if (text.status !== 0) failures.push(`pdftotext exit ${text.status ?? 'unknown'}`);
      if (text.status === 0) {
        failures.push(...readingOrderReasons(text.stdout));
        if (/[\uFFFD\u0000]/.test(text.stdout)) failures.push('extracted text contains replacement or NUL glyphs');
      }

      failures.push(...pageFillReasons(pdfForChecks));
      failures.push(...fontReasons(pdfForChecks));
      failures.push(...linkReasons(pdfForChecks));
    }

    const outputPath = pdfPathArg ? resolve(pdfPathArg) : findOutputPdf(stem);
    if (outputPath && existsSync(outputPath) && statSync(outputPath).mtimeMs < statSync(sourcePath).mtimeMs) {
      warnings.push('matching output PDF is older than the source');
    }
  } catch (error) {
    failures.push(`verifier error: ${oneLine(error.message)}`);
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }

  return resultLine(fileName, failures, warnings);
}

function defaultSources() {
  if (!existsSync(SOURCE_DIR)) return [];
  const results = [];
  for (const entry of readdirSync(SOURCE_DIR, { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name) === '.tex') {
      results.push(join(SOURCE_DIR, entry.name));
    } else if (entry.isDirectory() && entry.name !== 'build') {
      const subDir = join(SOURCE_DIR, entry.name);
      for (const fileName of readdirSync(subDir)) {
        if (extname(fileName) === '.tex') results.push(join(subDir, fileName));
      }
    }
  }
  return results.sort();
}

export function main(argv = process.argv.slice(2)) {
  // <source.tex> <output.pdf> — verify one source against its exact delivered PDF.
  const isSourceWithPdf = argv.length === 2 && extname(argv[1]).toLowerCase() === '.pdf';
  const results = isSourceWithPdf
    ? [verifyFile(argv[0], argv[1])]
    : (argv.length ? argv : defaultSources()).map((path) => verifyFile(path));
  results.forEach(({ line }) => console.log(line));

  const counts = results.reduce((summary, { status }) => {
    summary[status] += 1;
    return summary;
  }, { PASS: 0, WARN: 0, FAIL: 0 });
  console.log(`Summary: ${counts.PASS} PASS, ${counts.WARN} WARN, ${counts.FAIL} FAIL`);
  return counts.FAIL ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
