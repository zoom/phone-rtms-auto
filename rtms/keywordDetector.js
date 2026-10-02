const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'keywords.json');

const STOPWORDS = new Set((
  'about above after again against all also and any are because been before being below between both but can ' +
  'could did does doing down during each few for from further had has have having her here hers him his how ' +
  'into its itself just like more most need not off once only other our out over own same she should some ' +
  'such than that the their them then there these they this those through too under until very was were what ' +
  'when where which while who whom why will with would you your yours yeah okay thank thanks hello please ' +
  'right well know think want going gonna really actually something anything'
).split(' '));

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(text) {
  return text.toLowerCase().replace(/[’‘]/g, "'");
}

function compileRule(rule) {
  const patterns = rule.keywords.map((keyword) => ({
    keyword,
    regex: new RegExp(`(?<![\\w'])${escapeRegExp(normalize(keyword))}(?![\\w'])`)
  }));
  return { ...rule, patterns };
}

// Per-call detector. process() takes a transcript `content` object and returns
// events to push to the agent UI:
//   { type: 'prompt',   ruleId, keyword, prompt, text }
//   { type: 'keywords', keywords: [{ term, count }] }
function createKeywordDetector() {
  const config = loadConfig();
  const rules = config.rules.map(compileRule);
  const { topN = 8, minLength = 4, minCount = 2, emitIntervalMs = 2000 } = config.extraction || {};

  const lastFired = new Map(); // ruleId -> epoch ms
  const termCounts = new Map();
  let lastEmit = 0;
  let lastEmitKey = '';

  function matchRules(text, now) {
    const events = [];
    for (const rule of rules) {
      const hit = rule.patterns.find(({ regex }) => regex.test(text));
      if (!hit) continue;

      const cooldownMs = (rule.cooldownSeconds ?? 0) * 1000;
      if (now - (lastFired.get(rule.id) ?? -Infinity) < cooldownMs) continue;
      lastFired.set(rule.id, now);

      events.push({ type: 'prompt', ruleId: rule.id, keyword: hit.keyword, prompt: rule.prompt });
    }
    return events;
  }

  // Live keywords: most frequent non-stopword terms heard so far on this call.
  function extractKeywords(text, now) {
    for (const term of text.match(/[a-z][a-z'-]*/g) || []) {
      if (term.length < minLength || STOPWORDS.has(term)) continue;
      termCounts.set(term, (termCounts.get(term) || 0) + 1);
    }
    if (now - lastEmit < emitIntervalMs) return null;

    const keywords = [...termCounts.entries()]
      .filter(([, count]) => count >= minCount)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, topN)
      .map(([term, count]) => ({ term, count }));

    const key = JSON.stringify(keywords);
    if (!keywords.length || key === lastEmitKey) return null;
    lastEmit = now;
    lastEmitKey = key;
    return { type: 'keywords', keywords };
  }

  return {
    process(content) {
      const original = content?.data?.trim();
      if (!original) return [];

      const text = normalize(original);
      const now = Date.now();
      const events = matchRules(text, now).map((event) => ({ ...event, text: original }));
      const keywords = extractKeywords(text, now);
      if (keywords) events.push(keywords);
      return events;
    }
  };
}

module.exports = { createKeywordDetector };
