#!/usr/bin/env node
/**
 * Smart Files — Content-aware file management for OpenClaw agents
 *
 * Modes:
 *   --search <query>          → Content-aware file search (not just names)
 *   --dedup                   → Find duplicate files by content
 *   --organize <dir>          → Auto-categorize files by content type
 *   --rename <file> <pattern> → Batch rename with context
 *   --info <file>             → File type detection and metadata
 *   --cleanup <dir>           → Automated cleanup (temp files, duplicates, etc.)
 *   --status                  → File system health overview
 *   --watch <dir> [interval]  → Auto-organize (dry-run by default, --force to mutate)
 *
 * ⚠️ Watch mode requires --force to actually move/delete files.
 *    Default is dry-run: shows what would change without touching anything.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Constants ─────────────────────────────────────────────────────────────

// Detect workspace
const WORKSPACE = (() => {
  if (process.env.SMART_FILES_WORKSPACE) return process.env.SMART_FILES_WORKSPACE;
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'MEMORY.md'))) return dir;
    dir = path.resolve(dir, '..');
  }
  return path.resolve(__dirname, '..', '..');
})();

// Max file size to scan (10 MB)
const MAX_SCAN_SIZE = 10 * 1024 * 1024;
const JOURNAL_FILE = path.join(WORKSPACE, 'memory', 'smart-files-journal.json');

// ─── Helpers ───────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJSON(filepath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch {
    return typeof fallback === 'function' ? fallback() : fallback;
  }
}

function saveJSON(filepath, data) {
  ensureDir(path.dirname(filepath));
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
}

function readSafe(filepath) {
  try {
    const stat = fs.statSync(filepath);
    if (stat.size > MAX_SCAN_SIZE) {
      console.log(`[smart-files] Skipping oversized file: ${filepath} (${stat.size} bytes)`);
      return null;
    }
    // Skip binary files
    const ext = path.extname(filepath).toLowerCase();
    const binaryExts = ['.exe', '.dll', '.so', '.o', '.bin', '.dat', '.db', '.sqlite', '.tar', '.gz', '.zip', '.rar', '.7z', '.iso', '.img', '.dmg', '.pkg', '.deb', '.rpm'];
    if (binaryExts.includes(ext) || stat.size === 0) return null;

    const content = fs.readFileSync(filepath, 'utf8');
    // Check for null bytes (binary indicator)
    if (content.includes('\0')) return null;
    return content;
  } catch { return null; }
}

function getToday() {
  return new Date().toISOString().split('T')[0];
}

function charToTokens(chars) {
  return Math.ceil(chars / 4);
}

function normalizeText(text) {
  return text.toLowerCase().replace(/[\s_\-]+/g, ' ').trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// ─── Path Validation ───────────────────────────────────────────────────────

function isPathWithinWorkspace(targetPath) {
  const resolved = path.resolve(targetPath);
  const wsResolved = path.resolve(WORKSPACE);
  return resolved.startsWith(wsResolved) || resolved === wsResolved;
}

function resolveDir(targetDir) {
  if (!targetDir) return WORKSPACE;
  const resolved = path.resolve(targetDir);

  // Only enforce workspace boundary when no explicit --dir is given
  // or when the path is clearly outside (for safety in agent contexts)
  if (!isPathWithinWorkspace(resolved)) {
    console.log(`[smart-files] ⚠️ Path is outside workspace: ${resolved}`);
    console.log(`[smart-files] ⚠️ Workspace root: ${WORKSPACE}`);
    console.log(`[smart-files] ⚠️ Proceeding with target directory — use with care.`);
  }
  return resolved;
}

// ─── Snippet Sanitization ─────────────────────────────────────────────────

// Redact obvious secrets from snippets to prevent accidental exposure
const SECRET_PATTERNS = [
  // OpenAI / API keys starting with sk-
  /\b(sk-[a-zA-Z0-9]{20,})\b/g,
  // GitHub tokens
  /\b(gh[pousr]_[a-zA-Z0-9]{36,})\b/g,
  // AWS access keys
  /\b(AKIA[0-9A-Z]{16})\b/g,
  // Generic bearer tokens
  /\b(Bearer\s+[a-zA-Z0-9\-_=+.]{20,})\b/gi,
  // PEM private keys
  /(-{5}BEGIN\s+(?:RSA|EC|OPENSSH|DSA)?\s*PRIVATE\s+KEY-{5}[\s\S]*?-{5}END\s+(?:RSA|EC|OPENSSH|DSA)?\s*PRIVATE\s+KEY-{5})/g,
  // Long hex strings that look like tokens (64+ chars of hex)
  /\b([0-9a-fA-F]{64,})\b/g,
  // Generic "key" or "token" assignments with long values
  /(["']?(?:api_?key|secret|token|password|passwd)["']?\s*[:=]\s*["'])([^"'\n]{8,})(["'])/gi,
  // .env-style KEY=VALUE with values > 16 chars
  /([A-Z_]{2,}=)([a-zA-Z0-9\-_=+.\/]{32,})/g,
];

function sanitizeSnippet(snippet) {
  let sanitized = snippet;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match, ...groups) => {
      // For regexps with capture groups, redact the sensitive part
      if (groups.length >= 2 && typeof groups[1] === 'string') {
        // Pattern like key="value" — redact value
        return `${groups[0]}[REDACTED]${groups[2] || ''}`;
      }
      // Simple match — redact the whole thing
      const len = match.length;
      return '[REDACTED-' + len + ']';
    });
  }
  return sanitized;
}

// ─── Collect Files ──────────────────────────────────────────────────────────

function collectFiles(dir, extensions = null, skipDirs = null) {
  const files = [];
  if (!fs.existsSync(dir)) return files;

  const defaults = ['.git', 'node_modules', '.npm', '.cache', '.config', '.local'];
  const skip = skipDirs || defaults;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skip.includes(entry.name)) {
        files.push(...collectFiles(fullPath, extensions, skip));
      }
    } else {
      if (extensions && extensions.length > 0) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!extensions.includes(ext)) continue;
      }
      files.push({ path: fullPath, name: entry.name, size: fs.statSync(fullPath).size });
    }
  }
  return files;
}

// ─── SEARCH MODE ───────────────────────────────────────────────────────────

function searchFiles(query, rootDir = null) {
  const searchRoot = resolveDir(rootDir);
  const files = collectFiles(searchRoot);
  const results = [];
  const queryLower = normalizeText(query);

  for (const file of files) {
    const content = readSafe(file.path);
    if (!content) continue;

    const contentNorm = normalizeText(content);

    if (contentNorm.includes(queryLower)) {
      const snippet = sanitizeSnippet(findSnippet(content, query, 100));
      results.push({
        path: file.path,
        name: file.name,
        size: file.size,
        score: 1.0,
        snippet
      });
      continue;
    }

    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
    let wordMatches = 0;
    for (const word of queryWords) {
      if (contentNorm.includes(word)) wordMatches++;
    }
    if (wordMatches > 0) {
      const score = wordMatches / queryWords.length;
      const snippet = sanitizeSnippet(findSnippet(content, query, 100));
      results.push({
        path: file.path,
        name: file.name,
        size: file.size,
        score: Math.min(score, 0.99),
        snippet
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

function findSnippet(content, query, context = 100) {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return content.substring(0, context);

  const start = Math.max(0, idx - context);
  const end = Math.min(content.length, idx + query.length + context);
  let snippet = content.substring(start, end);

  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}

// ─── DEDUP MODE ────────────────────────────────────────────────────────────

function findDuplicates(rootDir = null) {
  const searchRoot = resolveDir(rootDir);
  const files = collectFiles(searchRoot);
  const hashMap = new Map();
  const sizeMap = new Map();

  for (const file of files) {
    if (file.size === 0) continue;

    if (!sizeMap.has(file.size)) sizeMap.set(file.size, []);
    sizeMap.get(file.size).push(file);
  }

  for (const [size, szFiles] of sizeMap) {
    if (szFiles.length < 2) continue;

    for (const file of szFiles) {
      const content = readSafe(file.path);
      if (!content) continue;

      const hash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
      if (!hashMap.has(hash)) hashMap.set(hash, []);
      hashMap.get(hash).push({ ...file, content });
    }
  }

  const duplicates = [];
  for (const [hash, dupFiles] of hashMap) {
    if (dupFiles.length >= 2) {
      duplicates.push({ hash, files: dupFiles, size: dupFiles[0].size });
    }
  }

  return duplicates.sort((a, b) => b.files.length - a.files.length);
}

// ─── ORGANIZE MODE ─────────────────────────────────────────────────────────

function organizeFiles(rootDir = null) {
  const searchRoot = resolveDir(rootDir);
  const files = collectFiles(searchRoot);
  const categories = {
    code: { exts: ['.js', '.ts', '.py', '.html', '.css', '.json', '.yaml', '.yml', '.xml', '.sh', '.bash', '.zsh', '.rb', '.go', '.rs', '.c', '.cpp', '.h', '.java', '.kt', '.swift', '.php', '.sql', '.md', '.txt'], dir: 'code' },
    data: { exts: ['.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.sql'], dir: 'data' },
    docs: { exts: ['.pdf', '.doc', '.docx', '.rtf', '.odt', '.tex', '.epub'], dir: 'docs' },
    media: { exts: ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.bmp', '.mp4', '.avi', '.mov', '.mkv', '.mp3', '.wav', '.flac', '.ogg', '.m4a'], dir: 'media' },
    archives: { exts: ['.zip', '.tar', '.gz', '.rar', '.7z', '.bz2', '.xz'], dir: 'archives' },
    images: { exts: ['.ico', '.webp', '.avif', '.tiff', '.psd', '.ai', '.eps'], dir: 'images' },
    other: { exts: [], dir: 'other' }
  };

  const organized = {};
  let uncategorized = [];

  for (const file of files) {
    const ext = path.extname(file.name).toLowerCase();
    let category = null;

    for (const [name, cat] of Object.entries(categories)) {
      if (cat.exts.includes(ext)) {
        category = name;
        break;
      }
    }

    if (category) {
      if (!organized[category]) organized[category] = [];
      organized[category].push(file);
    } else {
      uncategorized.push(file);
    }
  }

  return { organized, uncategorized, total: files.length };
}

// ─── INFO MODE ─────────────────────────────────────────────────────────────

function fileInfo(filepath) {
  try {
    const stat = fs.statSync(filepath);
    const ext = path.extname(filepath).toLowerCase();
    const content = readSafe(filepath);

    let detectedType = 'unknown';
    if (content) {
      if (content.includes('#!/bin') || content.includes('#!/usr/bin')) detectedType = 'Shell script';
      else if (content.includes('<html') || content.includes('<!DOCTYPE')) detectedType = 'HTML';
      else if (content.includes('function') || content.includes('const ') || content.includes('let ') || content.includes('import ') || content.includes('export ')) detectedType = 'JavaScript/TypeScript';
      else if (content.includes('def ') || content.includes('class ') || content.includes('import ') || content.includes('from ')) detectedType = 'Python';
      else if (content.includes('SELECT ') || content.includes('INSERT ') || content.includes('CREATE ')) detectedType = 'SQL';
      else if (content.includes('{') && content.includes('}')) detectedType = 'JSON';
      else if (content.includes('# ') && !content.includes('function')) detectedType = 'Markdown';
      else if (content.includes('name:') || content.includes('version:') || content.includes('description:')) detectedType = 'YAML';
      else if (content.includes('[') && content.includes(']')) detectedType = 'TOML/INI';
      else if (content.length > 0) detectedType = 'Text';
    }

    return {
      path: filepath,
      name: path.basename(filepath),
      size: stat.size,
      sizeHuman: formatBytes(stat.size),
      ext,
      modified: stat.mtime.toISOString().split('T')[0],
      created: stat.birthtime ? stat.birthtime.toISOString().split('T')[0] : 'unknown',
      detectedType,
      lineCount: content ? content.split('\n').length : 0,
      wordCount: content ? content.split(/\s+/).length : 0
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ─── CLEANUP MODE ──────────────────────────────────────────────────────────

function cleanupFiles(rootDir = null) {
  const searchRoot = resolveDir(rootDir);
  const files = collectFiles(searchRoot);

  const tempFiles = [];
  const backupFiles = [];
  const largeFiles = [];
  const duplicates = findDuplicates(searchRoot);

  for (const file of files) {
    const name = file.name.toLowerCase();
    if (name.startsWith('.~') || name.endsWith('~') || name.startsWith('~') ||
        name.includes('.tmp') || name.includes('.temp') || name.includes('.swp') ||
        name.includes('.bak') || name.includes('.orig') || name.includes('.old')) {
      tempFiles.push(file);
    }
  }

  for (const file of files) {
    if (file.size > 1024 * 1024) {
      largeFiles.push(file);
    }
  }

  return { tempFiles, largeFiles, duplicates, totalScanned: files.length };
}

// ─── STATUS MODE ───────────────────────────────────────────────────────────

function showStatus(rootDir = null) {
  const searchRoot = resolveDir(rootDir);
  const files = collectFiles(searchRoot);

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  const byExt = {};
  for (const file of files) {
    const ext = path.extname(file.name).toLowerCase() || '(no extension)';
    if (!byExt[ext]) byExt[ext] = { count: 0, size: 0 };
    byExt[ext].count++;
    byExt[ext].size += file.size;
  }

  const largest = files.sort((a, b) => b.size - a.size).slice(0, 10);

  return {
    totalFiles: files.length,
    totalSize: formatBytes(totalSize),
    extensions: byExt,
    largestFiles: largest.map(f => ({ name: f.name, size: formatBytes(f.size), path: f.path }))
  };
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ─── RENAME MODE ───────────────────────────────────────────────────────────

function renameFiles(file, pattern, rootDir = null) {
  const searchRoot = rootDir || WORKSPACE;
  const targetFile = path.resolve(path.join(searchRoot, file));

  if (!fs.existsSync(targetFile)) {
    console.log(`[smart-files] File not found: ${file}`);
    return;
  }

  const parts = pattern.split(':');
  if (parts.length !== 2) {
    console.log('[smart-files] Usage: --rename <file> <old>:<new>');
    console.log('[smart-files] Example: --rename script.js app.js');
    return;
  }

  const [oldStr, newStr] = parts;
  const name = path.basename(file);
  const ext = path.extname(name);
  const base = name.substring(0, name.length - ext.length);

  const newName = base.replace(new RegExp(oldStr, 'gi'), newStr) + ext;
  const newNamePath = path.join(path.dirname(targetFile), newName);

  if (name === newName) {
    console.log(`[smart-files] Name unchanged: ${name}`);
    return;
  }

  console.log(`[smart-files] Would rename: ${name} → ${newName}`);
  console.log(`[smart-files] (Use --force to actually rename)`);

  return { from: name, to: newName, path: targetFile };
}

// ─── AUTO-ORGANIZATION RULES ───────────────────────────────────────────────

const DEFAULT_RULES = [
  { exts: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico'], category: 'Pictures' },
  { exts: ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt', '.epub'], category: 'Documents' },
  { exts: ['.mp4', '.mov', '.avi', '.mkv', '.webm'], category: 'Videos' },
  { exts: ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac'], category: 'Audio' },
  { exts: ['.js', '.ts', '.py', '.go', '.rs', '.c', '.cpp', '.java', '.rb', '.sh', '.html', '.css', '.json', '.yaml', '.yml', '.xml', '.md'], category: 'Code' },
];
const DEFAULT_CATEGORIES = ['Pictures', 'Documents', 'Videos', 'Audio', 'Code', 'Uncategorized'];

function loadRules(dir) {
  const rulesPath = path.join(dir, '.smart-files-rules.json');
  if (fs.existsSync(rulesPath)) {
    try { return JSON.parse(fs.readFileSync(rulesPath, 'utf8')); } catch { return null; }
  }
  return null;
}

function categorizeFile(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  return ext || 'unknown';
}

function findCategory(ext, rules) {
  for (const rule of rules) {
    if (rule.exts && rule.exts.includes(ext)) return rule.category;
  }
  return 'Uncategorized';
}

function cleanFilename(name) {
  let cleaned = name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .trim();
  if (cleaned.length > 120) cleaned = cleaned.substring(0, 120);
  return cleaned;
}

function normalizeDate(name) {
  const match = name.match(/(\d{4})[\-_.](\d{1,2})[\-_.](\d{1,2})/);
  if (match) {
    const [_, y, m, d] = match;
    const normalized = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    return name.replace(match[0], normalized);
  }
  return name;
}

function fileHash(filepath) {
  try {
    const stat = fs.statSync(filepath);
    if (stat.size > MAX_SCAN_SIZE) return null;
    const buf = fs.readFileSync(filepath);
    return crypto.createHash('sha256').update(buf).digest('hex').substring(0, 16);
  } catch { return null; }
}

function loadJournal() {
  return loadJSON(JOURNAL_FILE, { files: {}, lastScan: null });
}

function saveJournal(journal) {
  saveJSON(JOURNAL_FILE, journal);
}

// ─── WATCH MODE ────────────────────────────────────────────────────────────

/**
 * Watch a directory for file changes and auto-organize.
 *
 * ⚠️ CRITICAL: Requires opts.force === true to actually move/delete files.
 *    Without --force, runs in dry-run mode: shows what would change,
 *    but never modifies the filesystem.
 *
 * @param {string} dir - Directory to watch
 * @param {number} interval - Polling interval in seconds (default 30)
 * @param {object} opts - { dryRun?: boolean, force?: boolean, rules?: array }
 */
function watchDirectory(dir, interval = 30, opts = {}) {
  const { dryRun = true, force = false, rules = null } = opts;
  const watchDir = path.resolve(dir);
  const rulesFile = path.join(watchDir, '.smart-files-rules.json');

  // ⚠️ Safety gate: require --force for actual mutations
  const actuallyModify = force;
  const previewOnly = dryRun && !actuallyModify;

  if (previewOnly) {
    console.log('\n⚠️  DRY-RUN MODE — No files will be modified');
    console.log('   Use --force to actually move/organize files.\n');
  }

  // Load custom rules if available, otherwise use defaults
  let watchRules = rules;
  if (!watchRules) {
    watchRules = loadRules(watchDir) || DEFAULT_RULES;
  }

  if (!fs.existsSync(watchDir)) {
    console.log(`[smart-files] Directory not found: ${watchDir}`);
    return;
  }

  const rulesHint = (rulesFile || '').length > 0 && fs.existsSync(rulesFile)
    ? ` rules from .smart-files-rules.json`
    : ` (default rules)`;
  const modeLabel = actuallyModify ? ' [FORCE — files WILL be moved]' : ' [DRY-RUN — preview only]';
  const startMsg = `[smart-files] Watching: ${watchDir}${rulesHint}${modeLabel}`;
  console.log(startMsg);
  if (actuallyModify) {
    console.log('[smart-files] ⚠️ WARNING: --force enabled. Files will be renamed, moved, and reorganized.');
    console.log('[smart-files] ⚠️ This is DESTRUCTIVE. Original files will be unlinked after copy.');
    console.log('[smart-files] ⚠️ Use --dry-run first to preview what would change.');
  }
  console.log(`[smart-files] Polling every ${interval}s. Press Ctrl+C to stop\n`);

  // Initial scan of existing files for dedup baseline
  let baselineHashes = {};
  let baselineCount = 0;
  const allFiles = collectFiles(watchDir);
  for (const f of allFiles) {
    const h = fileHash(f.path);
    if (h) { baselineHashes[f.path] = h; baselineCount++; }
  }
  console.log(`[smart-files] Baseline: ${baselineCount} files indexed for dedup\n`);

  let actionCount = 0;

  function journalAction(action, file, details = {}) {
    const journal = loadJournal();
    if (!journal.entries) journal.entries = [];
    journal.entries.push({
      timestamp: new Date().toISOString(),
      action,
      file: path.relative(watchDir, file),
      category: details.category,
      dest: details.dest,
      reason: details.reason
    });
    if (journal.entries.length > 1000) journal.entries = journal.entries.slice(-1000);
    saveJournal(journal);
  }

  function processFile(filepath) {
    if (!fs.existsSync(filepath)) return;
    const stat = fs.statSync(filepath);
    if (stat.isDirectory()) return;
    const name = path.basename(filepath);
    if (name.startsWith('.')) return;
    if (name === '.smart-files-rules.json' || name === '.smart-files-journal.json') return;

    const ext = categorizeFile(filepath);
    const category = findCategory(ext, watchRules);
    const hash = fileHash(filepath);

    // Dedup check against baseline + already-processed files
    if (hash && baselineHashes[hash] && baselineHashes[hash] !== filepath) {
      const dupOf = path.relative(watchDir, baselineHashes[hash]);
      console.log(`  ⏭️  Skip (dup of ${dupOf}): ${name}`);
      journalAction('skip-dup', filepath, { reason: `duplicate of ${dupOf}` });
      return;
    }
    if (hash) baselineHashes[hash] = filepath;

    // Clean filename
    let cleanName = cleanFilename(name);
    cleanName = normalizeDate(cleanName);
    if (cleanName !== name) {
      const renamed = path.join(path.dirname(filepath), cleanName);
      if (actuallyModify && cleanName !== name && !fs.existsSync(renamed)) {
        fs.renameSync(filepath, renamed);
        console.log(`  ✏️  Renamed: ${name} → ${cleanName}`);
        journalAction('rename', filepath, { dest: cleanName });
      } else if (previewOnly) {
        console.log(`  ✏️  [DRY-RUN] Would rename: ${name} → ${cleanName}`);
        journalAction('dry-run-rename', filepath, { dest: cleanName });
      }
    }

    // Create category dir and move
    const destDir = path.join(watchDir, category);
    if (actuallyModify) ensureDir(destDir);

    const destPath = path.join(destDir, cleanName);

    // Handle name collision
    if (fs.existsSync(destPath)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const base = cleanName.replace(/\.[^.]+$/, '');
      const extPart = cleanName.includes('.') ? cleanName.substring(cleanName.lastIndexOf('.')) : '';
      const collisionName = `${base}-${ts}${extPart}`;
      cleanName = collisionName;
      const newDest = path.join(destDir, collisionName);
      if (actuallyModify) {
        fs.copyFileSync(filepath, newDest);
        fs.unlinkSync(filepath);
        console.log(`  📂 Moved (collision): ${name} → ${category}/${collisionName}`);
        journalAction('move-collision', filepath, { category, dest: path.join(category, collisionName) });
      } else {
        console.log(`  📂 [DRY-RUN] Would move: ${name} → ${category}/${collisionName} (collision)`);
      }
    } else {
      if (previewOnly) {
        console.log(`  📂 [DRY-RUN] Would move: ${name} → ${category}/${cleanName}`);
        journalAction('dry-run-move', filepath, { category, dest: path.join(category, cleanName) });
      } else {
        fs.copyFileSync(filepath, destPath);
        fs.unlinkSync(filepath);
        console.log(`  📂 Moved: ${name} → ${category}/${cleanName}`);
        journalAction('move', filepath, { category, dest: path.join(category, cleanName) });
      }
    }
    actionCount++;
  }

  function scan() {
    const files = collectFiles(watchDir);
    for (const f of files) {
      processFile(f.path);
    }
  }

  // Try fs.watch first, fall back to polling
  let watcher = null;
  try {
    watcher = fs.watch(watchDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const filepath = path.join(watchDir, filename);
      setTimeout(() => { processFile(filepath); }, 500);
    });
    console.log(`[smart-files] Using native fs.watch`);
  } catch {
    console.log(`[smart-files] fs.watch unavailable, using polling fallback`);
  }

  // Polling fallback timer
  const pollTimer = setInterval(() => {
    if (!watcher) scan();
  }, interval * 1000);

  // Initial scan
  scan();

  // Graceful shutdown
  const shutdown = () => {
    if (watcher) watcher.close();
    clearInterval(pollTimer);
    console.log(`\n[smart-files] Stopped. ${actionCount} actions ${previewOnly ? 'previewed' : 'performed'}.`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ─── CLI ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

let searchQuery = null, rootDir = null, force = false;
let mode = 'help';
let watchDir = null, watchInterval = 30, dryRun = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dir' && i + 1 < args.length) rootDir = args[i + 1];
  if (args[i] === '--force') force = true;
  if (args[i] === '--search' && i + 1 < args.length) { mode = 'search'; searchQuery = args[i + 1]; }
  if (args[i] === '--dedup') mode = 'dedup';
  if (args[i] === '--organize') mode = 'organize';
  if (args[i] === '--info') mode = 'info';
  if (args[i] === '--cleanup') mode = 'cleanup';
  if (args[i] === '--status') mode = 'status';
  if (args[i] === '--rename') mode = 'rename';
  if (args[i] === '--watch') {
    mode = 'watch';
    watchDir = args[i + 1];
    i++;
    if (args[i + 1] && !args[i + 1].startsWith('-')) {
      watchInterval = parseInt(args[i + 1]) || 30;
      i++;
    }
  }
  if (args[i] === '--dry-run') dryRun = true;
}

switch (mode) {
  case 'search': {
    if (!searchQuery) {
      console.log('Usage: smart-files.js --search <query> [--dir <path>]');
    } else {
      const results = searchFiles(searchQuery, rootDir);
      console.log(`[smart-files] Found ${results.length} matches for "${searchQuery}":\n`);
      for (const r of results.slice(0, 20)) {
        console.log(`  ${r.score > 0.8 ? '✅' : '🔍'} ${r.score.toFixed(2)} — ${r.path}`);
        if (r.snippet) console.log(`     "${r.snippet}"`);
      }
      if (results.length > 20) console.log(`  ... and ${results.length - 20} more`);
    }
    break;
  }
  case 'dedup': {
    const dups = findDuplicates(rootDir);
    console.log(`[smart-files] Found ${dups.length} groups of duplicate files:\n`);
    for (const d of dups.slice(0, 10)) {
      console.log(`  ${d.files.length} files (${formatBytes(d.size)}) — hash: ${d.hash}`);
      for (const f of d.files) console.log(`    → ${f.path}`);
    }
    if (dups.length > 10) console.log(`  ... and ${dups.length - 10} more`);
    break;
  }
  case 'organize': {
    const result = organizeFiles(rootDir);
    console.log(`[smart-files] Organized ${result.total} files:\n`);
    for (const [cat, files] of Object.entries(result.organized)) {
      console.log(`  ${cat}: ${files.length} files`);
    }
    if (result.uncategorized.length > 0) {
      console.log(`  other: ${result.uncategorized.length} files (uncategorized)`);
    }
    break;
  }
  case 'info': {
    const fileArg = args[args.indexOf('--info') + 1];
    if (!fileArg || fileArg.startsWith('-')) {
      console.log('Usage: smart-files.js --info <file>');
    } else {
      const info = fileInfo(fileArg);
      if (info.error) {
        console.log(`[smart-files] Error: ${info.error}`);
      } else {
        console.log(`[smart-files] File info: ${info.name}`);
        console.log(`  Size: ${info.sizeHuman}`);
        console.log(`  Type: ${info.detectedType}`);
        console.log(`  Lines: ${info.lineCount}`);
        console.log(`  Words: ${info.wordCount}`);
        console.log(`  Modified: ${info.modified}`);
        console.log(`  Path: ${info.path}`);
      }
    }
    break;
  }
  case 'cleanup': {
    const result = cleanupFiles(rootDir);
    console.log(`[smart-files] Cleanup analysis for ${result.totalScanned} files:\n`);
    console.log(`  Temp/backup files: ${result.tempFiles.length}`);
    for (const f of result.tempFiles.slice(0, 5)) console.log(`    → ${f.path}`);
    console.log(`  Large files (>1MB): ${result.largeFiles.length}`);
    for (const f of result.largeFiles.slice(0, 5)) console.log(`    → ${f.path} (${formatBytes(f.size)})`);
    console.log(`  Duplicate groups: ${result.duplicates.length}`);
    break;
  }
  case 'status': {
    const result = showStatus(rootDir);
    console.log(`[smart-files] Workspace status:\n`);
    console.log(`  Total files: ${result.totalFiles}`);
    console.log(`  Total size: ${result.totalSize}`);
    console.log(`  Extensions:`);
    for (const [ext, data] of Object.entries(result.extensions).sort((a, b) => b[1].size - a[1].size).slice(0, 10)) {
      console.log(`    ${ext}: ${data.count} files, ${formatBytes(data.size)}`);
    }
    console.log(`  Largest files:`);
    for (const f of result.largestFiles) {
      console.log(`    ${f.name} — ${f.size}`);
    }
    break;
  }
  case 'rename': {
    const renameFile = args[args.indexOf('--rename') + 1];
    const renamePattern = args[args.indexOf('--rename') + 2];
    if (!renameFile || !renamePattern) {
      console.log('Usage: smart-files.js --rename <file> <old>:<new>');
    } else {
      renameFiles(renameFile, renamePattern, rootDir);
    }
    break;
  }
  case 'watch': {
    if (!watchDir) {
      console.log('Usage: smart-files.js --watch <dir> [interval-seconds] [--dry-run|--force]');
      console.log('\n  ⚠️  Default: DRY-RUN — shows what would change without modifying files.');
      console.log('  --force    Actually move and organize files (DESTRUCTIVE).');
      console.log('  --dry-run  Preview mode (default).');
    } else {
      // Default to dry-run; only mutate with explicit --force
      const modeIsForce = force;
      const modeIsDryRun = dryRun || !modeIsForce;

      if (modeIsForce) {
        console.log('[smart-files] ⚠️  --force enabled. This will MOVE and DELETE files.');
        console.log('[smart-files] ⚠️  Press Ctrl+C within 5 seconds to cancel...');
        // Give user time to abort
        setTimeout(() => {
          watchDirectory(watchDir, watchInterval, { dryRun: false, force: true });
        }, 5000);
        return;
      }

      watchDirectory(watchDir, watchInterval, { dryRun: true, force: false });
    }
    break;
  }
  case 'help':
  default: {
    console.log('Smart Files — Content-aware file management for OpenClaw agents');
    console.log('\nUsage: smart-files.js [--search|--dedup|--organize|--info|--cleanup|--status|--rename|--watch]');
    console.log('\nCommands:');
    console.log('  --search <query>          → Content-aware file search');
    console.log('  --dedup                   → Find duplicate files by content');
    console.log('  --organize <dir>          → Auto-categorize files (read-only)');
    console.log('  --info <file>             → File metadata and type detection');
    console.log('  --cleanup <dir>           → Cleanup analysis (temp files, large files)');
    console.log('  --status                  → Workspace file overview');
    console.log('  --rename <file> <old>:<new> → Rename file (dry run)');
    console.log('  --watch <dir> [interval]  → ⚠️ Auto-organize (DRY-RUN by default)');
    console.log('  --dry-run                 → Preview mode for --watch (default)');
    console.log('  --force                   → Actually move/organize in --watch (DESTRUCTIVE)');
    console.log('  --dir <path>              → Override workspace root');
    console.log('\n⚠️  Privacy: --search may return file content snippets.');
    console.log('   Sensitive values are redacted, but exercise care scanning');
    console.log('   directories containing secrets or personal data.');
    break;
  }
}

// ─── EXPORTS (for self-tests) ──────────────────────────────────────────────
module.exports = {
  searchFiles,
  findDuplicates,
  organizeFiles,
  fileInfo,
  cleanupFiles,
  showStatus,
  renameFiles,
  watchDirectory,
  categorizeFile,
  findCategory,
  DEFAULT_RULES,
  formatBytes,
  charToTokens,
  similarity,
  readSafe,
  collectFiles,
  normalizeText,
  levenshtein,
  getToday,
  sanitizeSnippet,
  isPathWithinWorkspace,
  resolveDir,
  MAX_SCAN_SIZE
};
