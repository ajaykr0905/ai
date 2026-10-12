import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  before as beforeAll,
  describe,
  it,
} from 'node:test';
import { fileURLToPath } from 'node:url';
import { PER_TOOL_FEEDBACK_MESSAGE } from '../../../../../providers/cursor/plugin/scripts/feedback.mjs';

const PLUGIN_ROOT = fileURLToPath(
  new URL('../../../../../providers/cursor/plugin', import.meta.url),
);
const STRIPE_SKILL_PATH = join(
  PLUGIN_ROOT,
  'skills/stripe-docs/SKILL.md',
);
const MODEL = 'composer-2.5-fast';

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

function scriptSource(source) {
  const lines = source.replace(/^\n/, '').split('\n');
  if (lines.at(-1)?.trim() === '') {
    lines.pop();
  }
  const indent = Math.min(
    ...lines
      .filter((line) => line.trim())
      .map((line) => line.match(/^ */)[0].length),
  );
  return `${lines.map((line) => line.slice(indent)).join('\n')}\n`;
}

// Wraps the stripe comand around a bash script that captures 
function writeStripeCommandWrapper(directory, usageLog) {
  const realStripe = spawnSync('which', ['stripe'], {
    encoding: 'utf8',
  }).stdout.trim();
  const delegate = realStripe
    ? `exec ${JSON.stringify(realStripe)} "$@"`
    : 'exit 127';
  const executablePath = join(directory, 'stripe');
  writeFileSync(
    executablePath,
    scriptSource(`
      #!/bin/sh
      printf '%s\\n' "$*" >> ${JSON.stringify(usageLog)}
      if [ "$1" = "agent" ]; then
        exit 0
      fi
      ${delegate}
    `),
  );
  chmodSync(executablePath, 0o755);
}

// 
function writeNodeWrapper(directory, hookLog) {
  const sampleImport = `--import=data:text/javascript,${encodeURIComponent(
    'Math.random = () => 0',
  )}`;
  const executablePath = join(directory, 'node');
  writeFileSync(
    executablePath,
    scriptSource(`
      #!${process.execPath}
      import { spawn } from 'node:child_process';
      import { appendFileSync } from 'node:fs';

      const args = process.argv.slice(2);
      const env = { ...process.env };
      if (args.some((arg) => arg.endsWith('postToolUse.mjs'))) {
        env.NODE_OPTIONS = ${JSON.stringify(sampleImport)};
      }

      const child = spawn(${JSON.stringify(process.execPath)}, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const input = [];
      const output = [];
      process.stdin.on('data', (chunk) => {
        input.push(chunk);
        child.stdin.write(chunk);
      });
      process.stdin.on('end', () => child.stdin.end());
      child.stdout.on('data', (chunk) => {
        output.push(chunk);
        process.stdout.write(chunk);
      });
      child.stderr.on('data', (chunk) => process.stderr.write(chunk));
      child.on('close', (code) => {
        appendFileSync(
          ${JSON.stringify(hookLog)},
          JSON.stringify({
            args,
            stdin: Buffer.concat(input).toString('utf8'),
            stdout: Buffer.concat(output).toString('utf8'),
          }) + '\\n',
        );
        process.exit(code ?? 1);
      });
    `),
  );
  chmodSync(executablePath, 0o755);
}

function readHookRecords(hookLog) {
  if (!existsSync(hookLog)) {
    return [];
  }
  return readFileSync(hookLog, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function additionalContext(record) {
  if (!record.stdout) {
    return undefined;
  }
  try {
    return JSON.parse(record.stdout).additional_context;
  } catch {
    return undefined;
  }
}

describe('Stripe feedback hooks', { timeout: 120_000 }, () => {
  let events;
  let hookRecords;
  let sessionStderr;
  let stripeCalls;

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

    const directory = mkdtempSync(join(tmpdir(), 'stripe-hooks-session-'));
    const usageLog = join(directory, 'usage.log');
    const hookLog = join(directory, 'hooks.jsonl');
    writeStripeCommandWrapper(directory, usageLog);
    writeNodeWrapper(directory, hookLog);
    const workspace = mkdtempSync(join(tmpdir(), 'stripe-hooks-workspace-'));

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
        workspace,
        '--trust',
        '--approve-mcps',
        '--force',
        '--sandbox',
        'disabled',
        'Read the file at ' +
          `${STRIPE_SKILL_PATH} before doing anything else. ` +
          'Then call one tool from the loaded Stripe MCP server to search Stripe documentation for Checkout. ' +
          'Do not edit files and do not run the stripe CLI yourself. ' +
          'After both calls finish, reply with only DONE.',
      ],
      {
        cwd: workspace,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}${delimiter}${process.env.PATH}`,
        },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 90_000,
      },
    );

    stripeCalls = existsSync(usageLog)
      ? readFileSync(usageLog, 'utf8')
      : '';
    hookRecords = readHookRecords(hookLog);
    rmSync(directory, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });

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
    assert.match(
      stripeCalls,
      /^--version$/m,
      `The sessionStart hook did not check the Stripe CLI.\n${stripeCalls}`,
    );
  });

  it('reports when a Stripe skill is used', () => {
    assert.ok(
      events.some(
        (event) =>
          event.type === 'tool_call' &&
          valueContains(event.tool_call, STRIPE_SKILL_PATH),
      ),
      'Cursor did not read the Stripe skill',
    );
    assert.match(
      stripeCalls,
      /^agent report_usage --type skill --name stripe-docs$/m,
      `The postToolUse hook did not report Stripe skill usage.\n${stripeCalls}`,
    );
  });

  it('emits sampled feedback after a Stripe MCP tool', () => {
    assert.ok(
      events.some(
        (event) =>
          event.type === 'tool_call' &&
          valueContains(event.tool_call, 'mcpToolCall') &&
          valueContains(event.tool_call, 'stripe'),
      ),
      'Cursor did not call a Stripe MCP tool',
    );
    assert.ok(
      hookRecords.some(
        (record) =>
          valueContains(record.stdin, 'MCP:') &&
          valueContains(record.stdin, 'stripe') &&
          additionalContext(record) === PER_TOOL_FEEDBACK_MESSAGE,
      ),
      `The postToolUse hook did not emit sampled Stripe feedback.\n${JSON.stringify(
        hookRecords,
      )}`,
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
    assert.ok(
      hookRecords.every((record) => !record.stdout.includes('report_usage')),
    );
  });
});
