import { organization } from "better-auth/plugins";

export const relayAuthPlugins = () => [
  organization({
    allowUserToCreateOrganization: true,
  }),
];

export const relayAccountPolicy = {
  accountLinking: {
    enabled: true,
    allowDifferentEmails: false,
    allowUnlinkingAll: false,
  },
} as const;
