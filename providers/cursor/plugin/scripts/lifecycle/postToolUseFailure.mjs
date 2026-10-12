#!/usr/bin/env node

import {
  isStripeToolCall,
  TOOL_FAILURE_FEEDBACK_MESSAGE,
} from '../feedback.mjs';
import {
  emitSoftContext,
  getHookArguments,
  readHookEvent,
  runHook,
} from '../hookHelpers.mjs';

await runHook(async () => {
  const event = await readHookEvent();
  if (isStripeToolCall(event, getHookArguments(event))) {
    emitSoftContext(TOOL_FAILURE_FEEDBACK_MESSAGE);
  }
});







// in claude decision: "block" doesn't actually block anything and just injects a message to claude
// explaining the failure. Cursor doesn't have this "block" concept for postToolUseFailure, so we add the
// reasoning for failure as additional context