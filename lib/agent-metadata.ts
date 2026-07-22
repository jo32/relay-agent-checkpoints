export const AGENT_METADATA_MODES = ["shared", "pseudonymous"] as const;
export type AgentMetadataMode = (typeof AGENT_METADATA_MODES)[number];

export type AgentMetadata = {
  agentName: string;
  agentDescription: string;
  agentMetadataMode: AgentMetadataMode;
};

export const MAX_AGENT_NAME_CHARACTERS = 80;
export const MAX_AGENT_DESCRIPTION_CHARACTERS = 280;
export const PSEUDONYMOUS_AGENT_DESCRIPTION =
  "A privacy-minded helper that summarized progress and prepared an encrypted workspace handoff.";

const FUN_ADJECTIVES = [
  "Bouncy",
  "Caffeinated",
  "Cosmic",
  "Dapper",
  "Disco",
  "Fuzzy",
  "Jolly",
  "Quantum",
  "Sneaky",
  "Wobbly",
] as const;
const FUN_NOUNS = [
  "Badger",
  "Capybara",
  "Ferret",
  "Goose",
  "Llama",
  "Marmot",
  "Octopus",
  "Otter",
  "Pangolin",
  "Turnip",
] as const;

export class AgentMetadataError extends Error {}

export function resolveAgentMetadata(
  checkpointId: string,
  input: {
    agentName?: unknown;
    agentDescription?: unknown;
    agentMetadataMode?: unknown;
  },
): AgentMetadata {
  const mode = cleanText(input.agentMetadataMode, 20) || "pseudonymous";
  if (!AGENT_METADATA_MODES.includes(mode as AgentMetadataMode)) {
    throw new AgentMetadataError(
      "Agent metadata mode must be shared or pseudonymous.",
    );
  }
  if (mode === "shared") {
    const agentName = cleanText(input.agentName, MAX_AGENT_NAME_CHARACTERS);
    const agentDescription = cleanText(
      input.agentDescription,
      MAX_AGENT_DESCRIPTION_CHARACTERS,
    );
    if (!agentName || !agentDescription) {
      throw new AgentMetadataError(
        "Shared agent metadata requires both a name and description.",
      );
    }
    return { agentName, agentDescription, agentMetadataMode: mode };
  }
  return {
    // A declined or unanswered sharing choice must never leak a supplied
    // identity accidentally. Always replace it with a Relay pseudonym.
    agentName: funnyAgentName(checkpointId),
    agentDescription: PSEUDONYMOUS_AGENT_DESCRIPTION,
    agentMetadataMode: "pseudonymous",
  };
}

export function funnyAgentName(checkpointId: string) {
  let first = 0;
  let second = 0;
  for (let index = 0; index < checkpointId.length; index += 1) {
    const code = checkpointId.charCodeAt(index);
    first = (first * 31 + code) >>> 0;
    second = (second * 37 + code + index) >>> 0;
  }
  return `${FUN_ADJECTIVES[first % FUN_ADJECTIVES.length]} ${
    FUN_NOUNS[second % FUN_NOUNS.length]
  }`;
}

export function agentMetadataHeaders(metadata: AgentMetadata) {
  return {
    "x-relay-agent-name": encodeURIComponent(metadata.agentName),
    "x-relay-agent-description": encodeURIComponent(metadata.agentDescription),
    "x-relay-agent-metadata-mode": metadata.agentMetadataMode,
  };
}

function cleanText(value: unknown, maxCharacters: number) {
  if (typeof value !== "string") return "";
  const normalized = value.normalize("NFC").trim().replace(/\s+/g, " ");
  if ([...normalized].length > maxCharacters) {
    throw new AgentMetadataError(
      `Agent metadata is limited to ${maxCharacters} characters.`,
    );
  }
  return normalized;
}
