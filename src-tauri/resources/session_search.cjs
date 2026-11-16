const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const query = (process.argv[1] || '').trim().toLowerCase();
const root = path.join(os.homedir(), '.pi', 'agent', 'sessions');
const MAX_RESULTS = 100;

function snippet(text) {
  const folded = text.toLowerCase();
  const byteIndex = folded.indexOf(query);
  if (byteIndex < 0) return null;
  const matchStart = Array.from(folded.slice(0, byteIndex)).length;
  const chars = Array.from(text);
  const start = Math.min(Math.max(0, matchStart - 48), chars.length);
  const end = Math.min(matchStart + Array.from(query).length + 88, chars.length);
  return (start > 0 ? '…' : '') + chars.slice(start, end).join('').replace(/\s/g, ' ').trim() +
    (end < chars.length ? '…' : '');
}

function messageMatch(message, state) {
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) return false;
  const texts = typeof message.content === 'string' ? [message.content] :
    Array.isArray(message.content) ? message.content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text) : [];
  let matched = false;
  for (const text of texts) {
    if (message.role === 'user' && !state.preview && text.trim()) {
      state.preview = Array.from(text.replace(/[\n\r]/g, ' ').trim()).slice(0, 120).join('');
    }
    const found = snippet(text);
    if (found === null) continue;
    matched = true;
    if (state.snippet === null) {
      state.snippet = found;
      state.role = message.role;
    }
  }
  return matched;
}

async function searchFile(file) {
  const input = fs.createReadStream(file);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let header;
  let title = null;
  const state = { role: null, snippet: null, matchCount: 0, preview: null };
  try {
    for await (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!header) {
        if (entry?.type !== 'session') return null;
        header = entry;
        continue;
      }
      if (entry?.type === 'session_info') {
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        title = name || null;
      } else if (entry?.type === 'message' && messageMatch(entry.message, state)) {
        state.matchCount += 1;
      }
    }
  } catch {
    return null;
  } finally {
    lines.close();
    input.destroy();
  }
  if (!header) return null;
  const titleMatches = title?.toLowerCase().includes(query) || false;
  const idMatches = typeof header.id === 'string' && header.id.toLowerCase().includes(query);
  if (!state.matchCount && !titleMatches && !idMatches) return null;
  let archived = false;
  try {
    const sidecar = path.join(path.dirname(file), path.basename(file, '.jsonl') + '.pix.json');
    archived = !!JSON.parse(fs.readFileSync(sidecar, 'utf8')).archived;
  } catch { /* Missing or invalid optional PiX metadata. */ }
  let mtimeMs = 0;
  try { mtimeMs = Math.max(0, Math.floor(fs.statSync(file).mtimeMs)); } catch { return null; }
  return {
    session: {
      file,
      id: typeof header.id === 'string' ? header.id : '',
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
      timestamp: typeof header.timestamp === 'string' ? header.timestamp : null,
      mtimeMs,
      title,
      archived,
      preview: state.preview,
    },
    role: state.role,
    snippet: state.snippet,
    matchCount: state.matchCount,
  };
}

async function scan() {
  if (!query) {
    console.log('PIX_SESSION_SEARCH_DONE');
    return;
  }
  const files = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file);
    }
  }
  const hits = [];
  for (const file of files) {
    const hit = await searchFile(file);
    if (hit) hits.push(hit);
  }
  hits.sort((a, b) => b.session.mtimeMs - a.session.mtimeMs || a.session.file.localeCompare(b.session.file));
  for (const hit of hits.slice(0, MAX_RESULTS)) {
    console.log('PIX_SESSION_SEARCH=' + JSON.stringify(hit));
  }
  console.log('PIX_SESSION_SEARCH_DONE');
}

scan().catch(() => console.log('PIX_SESSION_SEARCH_ERROR=远程会话搜索失败'));
