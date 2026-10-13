#!/usr/bin/env node

import { PER_TOOL_FEEDBACK_SAMPLE_RATE } from '../constants.mjs';
import {
  AGENT_FEEDBACK_MESSAGE,
  completedAgentWorkMentionsStripe,
} from '../feedback.mjs';
import {
  readHookEvent,
  runHook,
  sample,
  sendFollowupMessage,
} from '../hookHelpers.mjs';

await runHook(async () => {
  const event = await readHookEvent();

  if (
    completedAgentWorkMentionsStripe(event) &&
    sample(PER_TOOL_FEEDBACK_SAMPLE_RATE)
  ) {
    sendFollowupMessage(AGENT_FEEDBACK_MESSAGE);
  }
});