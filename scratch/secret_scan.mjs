import fs from 'fs';
import path from 'path';

const rootDir = 'e:/Pragati Telecom/pragati-telecom/Pragati Telecom analesis';

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    if (file === 'node_modules' || file === '.git' || file === 'scratch') return;
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(fullPath));
    } else {
      results.push(fullPath);
    }
  });
  return results;
}

const secretRegexes = [
  { name: 'Google API Key', regex: /AIza[0-9A-Za-z-_]{35}/g },
  { name: 'HuggingFace Token', regex: /hf_[a-zA-Z0-9]{34,}/g },
  { name: 'OpenAI Secret', regex: /sk-[a-zA-Z0-9]{20,}/g },
  { name: 'Generic Secret Assignment', regex: /(?:api[_-]?key|secret|token)\s*[:=]\s*['"][a-zA-Z0-9-_]{20,}['"]/gi }
];

const allFiles = walk(rootDir);
console.log(`Scanning ${allFiles.length} project files for real API key leaks...`);

let leakCount = 0;
allFiles.forEach(f => {
  const content = fs.readFileSync(f, 'utf8');
  const relPath = path.relative(rootDir, f).replace(/\\/g, '/');

  secretRegexes.forEach(sr => {
    const matches = content.match(sr.regex);
    if (matches) {
      matches.forEach(m => {
        // Skip placeholder tokens in .env.example or comments
        if (m.includes('YOUR_GEMINI_API_KEY_HERE') || m.includes('YOUR_SECRET_HERE')) return;
        console.error(`🚨 POTENTIAL SECRET FOUND in ${relPath}: Pattern "${sr.name}"`);
        leakCount++;
      });
    }
  });
});

if (leakCount === 0) {
  console.log('✅ ZERO REAL SECRETS DETECTED ACROSS ALL PROJECT FILES!');
} else {
  console.error(`❌ Found ${leakCount} potential secrets!`);
}
