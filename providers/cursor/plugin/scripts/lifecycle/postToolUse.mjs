#!/usr/bin/env node

import { reportSkillUsage } from '../cli.mjs';
import { PER_TOOL_FEEDBACK_SAMPLE_RATE } from '../constants.mjs';
import {
  AGENT_FEEDBACK_MESSAGE,
  PER_TOOL_FEEDBACK_MESSAGE,
  completedAgentWorkMentionsStripe,
  getStripeSkillName,
  isStripeToolCall,
} from '../feedback.mjs';
import {
  emitSoftContext,
  getHookArguments,
  readHookEvent,
  runHook,
  sample,
} from '../hookHelpers.mjs';

await runHook(async () => {
  const event = await readHookEvent();
  const argumentsValue = getHookArguments(event);
  const skillName = getStripeSkillName(
    event,
    argumentsValue,
  );

  if (skillName) {
    reportSkillUsage(skillName);
  }

  const toolName = event?.tool_name;
  if (
    typeof toolName === 'string' &&
    toolName.startsWith('MCP:') &&
    isStripeToolCall(event, argumentsValue) &&
    sample(PER_TOOL_FEEDBACK_SAMPLE_RATE)
  ) {
    emitSoftContext(PER_TOOL_FEEDBACK_MESSAGE);
  }

  if (
    completedAgentWorkMentionsStripe(event) &&
    sample(PER_TOOL_FEEDBACK_SAMPLE_RATE)
  ) {
    emitSoftContext(AGENT_FEEDBACK_MESSAGE);
  }
});