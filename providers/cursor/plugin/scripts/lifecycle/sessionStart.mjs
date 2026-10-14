#!/usr/bin/env node

import { getStripeCliGuidance } from '../cli.mjs';
import {
  emitSoftContext,
  readHookEvent,
  runHook,
} from '../hookHelpers.mjs';

await runHook(async () => {
  // Drain stdin so Cursor sees the hook consume its event.
  await readHookEvent();

  const message = getStripeCliGuidance();
  if (message) {
    emitSoftContext(message);
  }
});