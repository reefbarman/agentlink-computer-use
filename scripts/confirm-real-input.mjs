#!/usr/bin/env node

const explicitOptIn = process.env.COMPUTER_USE_ALLOW_REAL_INPUT === "1";
const countdownSeconds = 5;

if (explicitOptIn) {
  process.stderr.write(
    "WARNING: real mouse/keyboard input explicitly enabled; verify a disposable target is active.\n",
  );
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stderr.isTTY) {
  process.stderr.write(
    [
      "REFUSING TO POST REAL INPUT IN A NON-INTERACTIVE SESSION.",
      "This command can move the cursor, change focus, click, or type.",
      "Run interactively for a cancellation countdown, or set",
      "COMPUTER_USE_ALLOW_REAL_INPUT=1 only after verifying the disposable target and cleanup path.",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

process.stderr.write(
  [
    "",
    "⚠️  REAL INPUT WARNING",
    "This command can take control of the mouse/keyboard and change application focus.",
    "Verify that only the intended disposable test target is available.",
    "Press Ctrl-C now to cancel.",
    "",
  ].join("\n"),
);

for (let remaining = countdownSeconds; remaining > 0; remaining -= 1) {
  process.stderr.write(`Starting in ${remaining}…\r`);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
process.stderr.write("Starting real-input command now.        \n");
