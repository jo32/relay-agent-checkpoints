export const CHECKPOINT_ARTIFACT_TYPES = ["agent", "skill"] as const;
export type CheckpointArtifactType =
  (typeof CHECKPOINT_ARTIFACT_TYPES)[number];

export const MAX_SKILL_NAME_CHARACTERS = 80;
export const MAX_SKILL_DESCRIPTION_CHARACTERS = 1000;

export type CheckpointArtifactMetadata = {
  artifactType: CheckpointArtifactType;
  skillName: string | null;
  skillDescription: string | null;
};

export class ArtifactMetadataError extends Error {}

export function resolveArtifactMetadata(input: {
  artifactType?: unknown;
  skillName?: unknown;
  skillDescription?: unknown;
}): CheckpointArtifactMetadata {
  const artifactType = cleanText(input.artifactType, 20) || "agent";
  if (!CHECKPOINT_ARTIFACT_TYPES.includes(artifactType as CheckpointArtifactType)) {
    throw new ArtifactMetadataError("Checkpoint artifact type must be agent or skill.");
  }
  if (artifactType === "agent") {
    if (input.skillName != null || input.skillDescription != null) {
      throw new ArtifactMetadataError(
        "Agent checkpoints cannot include skill metadata.",
      );
    }
    return {
      artifactType: "agent",
      skillName: null,
      skillDescription: null,
    };
  }

  const skillName = cleanText(input.skillName, MAX_SKILL_NAME_CHARACTERS);
  const skillDescription = cleanText(
    input.skillDescription,
    MAX_SKILL_DESCRIPTION_CHARACTERS,
  );
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(skillName)) {
    throw new ArtifactMetadataError(
      "Skill checkpoints require a lowercase SKILL.md name using letters, numbers, hyphens, or underscores.",
    );
  }
  if (!skillDescription) {
    throw new ArtifactMetadataError(
      "Skill checkpoints require the description declared by SKILL.md.",
    );
  }
  return {
    artifactType: "skill",
    skillName,
    skillDescription,
  };
}

export function artifactMetadataHeaders(
  value: CheckpointArtifactMetadata,
): Record<string, string> {
  return {
    "x-relay-artifact-type": value.artifactType,
    ...(value.artifactType === "skill"
      ? {
          "x-relay-skill-name": encodeURIComponent(value.skillName!),
          "x-relay-skill-description": encodeURIComponent(
            value.skillDescription!,
          ),
        }
      : {}),
  };
}

function cleanText(value: unknown, maxCharacters: number) {
  if (typeof value !== "string") return "";
  const normalized = value.normalize("NFC").trim().replace(/\s+/g, " ");
  if ([...normalized].length > maxCharacters) {
    throw new ArtifactMetadataError(
      `Artifact metadata is limited to ${maxCharacters} characters.`,
    );
  }
  return normalized;
}
