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

function resultLine(fileName, failures, warnings) {
  const status = failures.length ? 'FAIL' : warnings.length ? 'WARN' : 'PASS';
  const reasons = [...failures, ...warnings];
  return { status, line: `${status} ${fileName} — ${reasons.length ? reasons.join('; ') : 'all checks passed'}` };
}

export function verifyFile(inputPath) {
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

    const pdfPath = join(tempDir, `${stem}.pdf`);
    if (!existsSync(pdfPath)) {
      failures.push('pdflatex did not produce a PDF');
    } else {
      const info = runCommand('pdfinfo', [pdfPath]);
      if (info.error) failures.push(`pdfinfo: ${oneLine(info.error.message)}`);
      if (info.status !== 0) failures.push(`pdfinfo exit ${info.status ?? 'unknown'}`);
      const pageMatch = info.stdout.match(/^Pages:\s+(\d+)$/m);
      if (!pageMatch) {
        failures.push('pdfinfo did not report a page count');
      } else if (Number(pageMatch[1]) !== 1) {
        failures.push(`page count ${pageMatch[1]} (expected 1)`);
      }

      const text = runCommand('pdftotext', ['-layout', pdfPath, '-']);
      if (text.error) failures.push(`pdftotext: ${oneLine(text.error.message)}`);
      if (text.status !== 0) failures.push(`pdftotext exit ${text.status ?? 'unknown'}`);
      if (text.status === 0) failures.push(...readingOrderReasons(text.stdout));
    }

    const outputPath = join(OUTPUT_DIR, `${stem}.pdf`);
    if (existsSync(outputPath) && statSync(outputPath).mtimeMs < statSync(sourcePath).mtimeMs) {
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
  return readdirSync(SOURCE_DIR)
    .filter((fileName) => extname(fileName) === '.tex')
    .sort()
    .map((fileName) => join(SOURCE_DIR, fileName));
}

export function main(argv = process.argv.slice(2)) {
  const paths = argv.length ? argv : defaultSources();
  const results = paths.map(verifyFile);
  results.forEach(({ line }) => console.log(line));

  const counts = results.reduce((summary, { status }) => {
    summary[status] += 1;
    return summary;
  }, { PASS: 0, WARN: 0, FAIL: 0 });
  console.log(`Summary: ${counts.PASS} PASS, ${counts.WARN} WARN, ${counts.FAIL} FAIL`);
  return counts.FAIL ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
