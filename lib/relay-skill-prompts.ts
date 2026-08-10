export function relaySkillsInstallPrompt(
  origin: string,
  completion: "stop" | "continue" = "stop",
) {
  const skillBundleUrl = `${origin}/skills/relay-checkpoint-skills.zip`;
  const skillChecksumUrl = `${skillBundleUrl}.sha256`;
  const finalStep = completion === "stop"
    ? "Stop after installation. Do not sign in, connect an account, create a checkpoint, upload, download, decrypt, or restore anything yet."
    : "Finish installing and reading both Relay skills before continuing. Do not sign in, connect an account, create a checkpoint, upload, download, decrypt, or restore anything during this prerequisite step. Then continue with the checkpoint installation below.";

  return `Install or update Relay's checkpoint skills in this project. No Relay sign-in is needed for installation or updates.

Relay URL: ${origin}

1. Download ${skillBundleUrl} and ${skillChecksumUrl} yourself. Do not ask me to download either file.
2. Verify the ZIP against the published SHA-256 checksum before opening it.
3. Inspect the archive. It must contain only these two skill folders under .agents/skills/:
   - agent-workspace-checkpoint
   - restore-agent-workspace
4. Install or update only those folders in this project. Preserve unrelated skills, and ask before replacing locally modified Relay skill files.
5. Read both SKILL.md files.
6. ${finalStep}`;
}

export function restoreSkillPrerequisitePrompt(origin: string) {
  return `Before installing this checkpoint, install or update the complete Relay skill bundle below so both $agent-workspace-checkpoint and $restore-agent-workspace skill directories are installed and current.

${relaySkillsInstallPrompt(origin, "continue")}`;
}
