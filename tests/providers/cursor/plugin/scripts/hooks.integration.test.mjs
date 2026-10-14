// This test requires the Cursor CLI to be installed and logged in

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  before as beforeAll,
  describe,
  it,
} from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGENT_FEEDBACK_MESSAGE } from '../../../../../providers/cursor/plugin/scripts/feedback.mjs';

const PLUGIN_ROOT = fileURLToPath(
  new URL('../../../../../providers/cursor/plugin', import.meta.url),
);
const MODEL = 'composer-2.5-fast';
const SAMPLE_IMPORT = `--import=data:text/javascript,${encodeURIComponent(
  'Math.random = () => 0',
)}`;

function parseEventStream(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // The CLI can print startup notices before the JSON event stream.
    }
  }
  return events;
}

function valueContains(value, expected) {
  if (typeof value === 'string') {
    return value.includes(expected);
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueContains(item, expected));
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => valueContains(item, expected));
  }
  return false;
}

function getAllHookExecutionsFromLogs(startedAt) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'default';
  const logDir = join(tmpdir(), `cursor-agent-logs-${uid}`);
  if (!existsSync(logDir)) {
    return [];
  }

  const marker = '"eventName":"cli.hook.executed"';
  return readdirSync(logDir)
    .map((name) => join(logDir, name))
    .filter((path) => statSync(path).mtimeMs >= startedAt)
    .flatMap((path) => readFileSync(path, 'utf8').split(/\r?\n/))
    .filter((line) => line.includes(marker))
    .flatMap((line) => {
      try {
        const props = JSON.parse(line.slice(line.indexOf('{'))).props;
        return props?.hookStep ? [props] : [];
      } catch {
        return [];
      }
    });
}

function isStripeSubagentCall(event) {
  const call = event?.tool_call?.taskToolCall;
  return Boolean(call) && valueContains(call, 'stripe');
}

describe('Stripe feedback hooks', { timeout: 120_000 }, () => {
  let events;
  let hookExecutions;
  let sessionStderr;

  beforeAll(() => {
    const agentPath = spawnSync('which', ['agent'], { encoding: 'utf8' }).stdout.trim();
    assert.ok(agentPath, 'Cursor agent CLI is not installed');

    const status = spawnSync(agentPath, ['status'], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    const statusText = `${status.stdout ?? ''}\n${status.stderr ?? ''}`;
    assert.ok(
      status.status === 0 && !/not logged in/i.test(statusText),
      `Cursor agent CLI is not logged in.\n${statusText}`,
    );

    const startedAt = Date.now();

    const result = spawnSync(
      agentPath,
      [
        '--print',
        '--output-format',
        'stream-json',
        '--model',
        MODEL,
        '--plugin-dir',
        PLUGIN_ROOT,
        '--workspace',
        PLUGIN_ROOT,
        '--trust',
        '--approve-mcps',
        '--force',
        '--sandbox',
        'disabled',
        'Launch a subagent who uses the stripe-docs skill ' +
          'and calls one tool from the loaded Stripe MCP server to search Stripe documentation for Checkout. ' +
          'Do not edit files and do not run the stripe CLI yourself. ' +
          'After both calls finish, reply with only DONE.',
      ],
      {
        cwd: PLUGIN_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, SAMPLE_IMPORT]
            .filter(Boolean)
            .join(' '),
        },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 90_000,
      },
    );

    hookExecutions = getAllHookExecutionsFromLogs(startedAt);

    assert.ifError(result.error);
    assert.equal(
      result.status,
      0,
      `Cursor session failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );

    events = parseEventStream(result.stdout);
    sessionStderr = result.stderr ?? '';
  });

  it('loads the plugin and checks the Stripe CLI at sessionStart', () => {
    assert.ok(
      events.some(
        (event) => event.type === 'system' && event.subtype === 'init',
      ),
      'Cursor did not start a session',
    );
    assert.ok(
      hookExecutions.some(
        (execution) =>
          execution.hookStep === 'sessionStart' &&
          execution.status === 'success',
      ),
      `The sessionStart hook did not succeed.\n${JSON.stringify(hookExecutions)}`,
    );
  });

  it('reports when a Stripe skill is used', () => {
    assert.ok(
      events.some(
        (event) =>
          event.type === 'tool_call' &&
          valueContains(event.tool_call?.readToolCall?.args?.path, 'skills/stripe-docs/SKILL.md'),
      ),
      'Cursor did not read the Stripe skill',
    );
    assert.ok(
      hookExecutions.some(
        (execution) =>
          execution.hookStep === 'beforePromptSubmit' && execution.exitCode === 0,
      ),
      `The beforePromptSubmit hook did not report Stripe skill usage.\n${JSON.stringify(
        hookExecutions,
      )}`,
    );
  });

  it('emits sampled feedback after a subagent completes Stripe work', () => {
    assert.ok(
      events.some((event) => isStripeSubagentCall(event)),
      'Cursor did not finish a Stripe subagent',
    );
    assert.ok(
      events.some(
        (event) =>
          isStripeSubagentCall(event) &&
          valueContains(
            event.tool_call?.hookAdditionalContexts,
            AGENT_FEEDBACK_MESSAGE,
          ),
      ),
      'The postToolUse hook did not emit sampled feedback for the Stripe subagent.',
    );
    assert.ok(
      events.some(
        (event) => event.type === 'result' && event.subtype === 'success',
      ),
      'Cursor session did not complete',
    );
  });

  it('keeps unsupported usage reporting silent', () => {
    assert.ok(!sessionStderr.includes('report_usage'));
  });
});
