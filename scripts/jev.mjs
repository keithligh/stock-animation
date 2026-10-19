#!/usr/bin/env node
// Ask typesafe/jev-router via OpenRouter.
//
//   node scripts/jev.mjs "question" path/to/file
//   node scripts/jev.mjs "question" < file
//
// Prints the answer, then the token usage. Requires OPENROUTER_API_KEY.

import { readFile } from 'node:fs/promises';

const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error('OPENROUTER_API_KEY is not set');
  process.exit(1);
}

const question = process.argv[2];
const file = process.argv[3];
if (!question) {
  console.error('Usage: node scripts/jev.mjs "<question>" [file]');
  process.exit(1);
}

let content = '';
if (file) {
  content = await readFile(file, 'utf8');
} else if (!process.stdin.isTTY) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  content = Buffer.concat(chunks).toString('utf8');
}

const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'typesafe/jev-router',
    messages: [
      {
        role: 'user',
        content: content ? `${question}\n\n---\n${content}` : question,
      },
    ],
  }),
});

const data = await response.json();
if (!response.ok) {
  console.error(JSON.stringify(data, null, 2));
  process.exit(1);
}

const answer = data.choices?.[0]?.message?.content ?? '';
console.log(typeof answer === 'string' ? answer : JSON.stringify(answer, null, 2));
console.log('\n--- usage ---');
console.log(JSON.stringify(data.usage ?? null, null, 2));
