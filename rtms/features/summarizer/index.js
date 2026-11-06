const { STOPWORDS } = require('../../lib/stopwords');

const SUMMARY_INTERVAL_MS = 30 * 1000; // how often a new summary line is added
const MAX_TOPICS = 3; // topic words shown per summary line
const MAX_QUOTE_CHARS = 90; // the key sentence is cut to about this length
const RECENT_WINDOW = 6; // lines compared for duplicate detection
const MIN_SENTENCE_WORDS = 4; // shorter sentences ("Okay.") are never picked as the key sentence
const MIN_TERM_LENGTH = 4; // shorter words are ignored when finding topics

function terms(sentence) {
  return (sentence.toLowerCase().match(/[a-z][a-z'-]*/g) || [])
    .filter((term) => term.length >= MIN_TERM_LENGTH && !STOPWORDS.has(term));
}

function wordCount(sentence) {
  return (sentence.match(/[a-z][a-z'-]*/gi) || []).length;
}

function shorten(sentence) {
  if (sentence.length <= MAX_QUOTE_CHARS) return sentence;
  return `${sentence.slice(0, MAX_QUOTE_CHARS).replace(/\s+\S*$/, '')}…`;
}

// Per-call summarizer. process() takes a transcript `content` object and collects
// its sentences. start() runs a timer that, every SUMMARY_INTERVAL_MS, digests only
// what was said since the last tick into one bullet (topics + the key point) and adds
// it to a running list, then passes the event to the callback:
//   { type: 'summary', summary }   e.g. "• billing, charge, refund — “I was charged twice…”"
// Call stop() when the call ends.
function createSummarizer() {
  const recent = [];
  const entries = [];
  let windowSentences = [];
  let timer = null;

  // One line for the window: its most repeated terms, and its most representative sentence.
  function summarizeWindow(sentences) {
    const termCounts = new Map();
    for (const sentence of sentences) {
      for (const term of terms(sentence)) termCounts.set(term, (termCounts.get(term) || 0) + 1);
    }

    const topics = [...termCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_TOPICS)
      .map(([term]) => term);

    const key = sentences
      .filter((text) => wordCount(text) >= MIN_SENTENCE_WORDS)
      .map((text, index) => {
        const unique = [...new Set(terms(text))];
        const score = unique.reduce((sum, term) => sum + termCounts.get(term), 0) / Math.sqrt(unique.length || 1);
        return { text, index, score };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index)[0];

    if (!topics.length && !key) return '';
    const quote = key ? `“${shorten(key.text)}”` : '';
    return [topics.join(', '), quote].filter(Boolean).join(' — ');
  }

  function tick(onSummary) {
    const sentences = windowSentences;
    windowSentences = [];
    const digest = summarizeWindow(sentences);
    if (!digest) return;

    entries.push(`• ${digest}`);
    onSummary({ type: 'summary', summary: entries.join('\n') });
  }

  return {
    process(content) {
      const text = content?.data?.trim();
      // "…" marks an interim result that a final line will replace.
      if (!text || text.endsWith('…')) return;

      // Zoom delivers each utterance once per channel; skip repeats of recent lines.
      const key = text.toLowerCase().replace(/[^a-z0-9' ]/g, '').trim();
      if (!key || recent.includes(key)) return;
      recent.push(key);
      if (recent.length > RECENT_WINDOW) recent.shift();

      windowSentences.push(...text.split(/(?<=[.!?])\s+/).filter(Boolean));
    },
    start(onSummary) {
      if (timer) return;
      timer = setInterval(() => tick(onSummary), SUMMARY_INTERVAL_MS);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    }
  };
}

module.exports = { createSummarizer };
