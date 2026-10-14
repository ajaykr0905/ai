#!/usr/bin/env node

import { reportSkillUsageByLastAssistantMessage } from '../cli.mjs';
import { PER_TOOL_FEEDBACK_SAMPLE_RATE } from '../constants.mjs';
import { lastAssistantMessageToolCalls } from '../transcriptHelpers.mjs';
import {
  readHookEvent,
  runHook,
  sample,
} from '../hookHelpers.mjs';

await runHook(async () => {
  const event = await readHookEvent();

  if (
    sample(PER_TOOL_FEEDBACK_SAMPLE_RATE)
  ) {
    const toolCalls = lastAssistantMessageToolCalls(event);
    reportSkillUsageByLastAssistantMessage(toolCalls);
  }
});