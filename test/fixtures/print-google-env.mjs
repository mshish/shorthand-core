#!/usr/bin/env node

// Reports which Google OAuth environment variables actually reached a child process.
//
// It exists because test/cli.test.ts's run() helper strips GOOGLE_OAUTH_CLIENT_ID and
// GOOGLE_OAUTH_CLIENT_SECRET from whatever env it is handed, and that strip is otherwise
// unobservable from the parent: spawn() takes the env and nothing gives it back. The two
// regression tests that guard the strip used to observe it indirectly, through a
// `google-login` command that failed fast without credentials; that command no longer
// exists, so the observation has to be direct.
process.stdout.write(JSON.stringify({
  GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID ?? null,
  GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? null,
}));
