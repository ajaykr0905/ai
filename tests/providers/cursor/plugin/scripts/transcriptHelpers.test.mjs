import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { lastAssistantMessageToolCalls } from '../../../../../providers/cursor/plugin/scripts/transcriptHelpers.mjs';

function writeTranscript(t, entries) {
  const directory = mkdtempSync(join(tmpdir(), 'stripe-cursor-transcript-'));
  const transcriptPath = join(directory, 'transcript.jsonl');
  writeFileSync(
    transcriptPath,
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return transcriptPath;
}

function userPrompt(text) {
  return {
    role: 'user',
    message: {
      content: [
        {
          type: 'text',
          text: `<timestamp>Tuesday, Oct 13, 2026, 11:44 AM (UTC-4)</timestamp>\n<user_query>\n${text}\n</user_query>`,
        },
      ],
    },
  };
}

function assistantContent(content) {
  return { role: 'assistant', message: { content } };
}

function toolUse(name, input) {
  return { type: 'tool_use', name, input };
}

const TURN_ENDED = { type: 'turn_ended', status: 'success' };

test('returns only the tool calls from the most recent assistant message', (t) => {
  const earlierCall = toolUse('Read', {
    path: '/skills/stripe-docs/SKILL.md',
  });
  const latestCalls = [
    toolUse('Read', {
      path: '/skills/stripe-best-practices/SKILL.md',
    }),
    toolUse('CallDynamicTool', {
      toolName: 'search_stripe_documentation',
      arguments: { query: 'Checkout' },
    }),
  ];
  const transcriptPath = writeTranscript(t, [
    userPrompt('Use the stripe-docs skill.'),
    assistantContent([
      { type: 'text', text: 'Reading the skill.\n\n[REDACTED]' },
      earlierCall,
    ]),
    TURN_ENDED,
    userPrompt('Now search the Stripe docs for Checkout.'),
    assistantContent([
      { type: 'text', text: 'Searching.\n\n[REDACTED]' },
      ...latestCalls,
    ]),
    TURN_ENDED,
  ]);

  assert.deepEqual(
    lastAssistantMessageToolCalls({ transcript_path: transcriptPath }),
    latestCalls,
  );
});
