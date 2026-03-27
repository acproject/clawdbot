import { z } from "zod";

const AgentChannelAccountSchema = z.object({
  host: z.string().min(1).optional(),
  port: z.number().int().positive().optional(),
  token: z.string().optional(),
  signatureSecret: z.string().optional(),
  enabled: z.boolean().optional(),
  allowFrom: z.array(z.string()).optional(),
  ignoreAuthors: z.array(z.string()).optional(),
  outboundAuthor: z.string().optional(),
});

const AgentChannelConfigBaseSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
});

const SimplifiedSchema = z.intersection(AgentChannelConfigBaseSchema, AgentChannelAccountSchema);

const MultiAccountSchema = z.intersection(
  AgentChannelConfigBaseSchema,
  z
    .object({
      accounts: z.record(z.string(), AgentChannelAccountSchema),
    })
    .refine((val) => Object.keys(val.accounts || {}).length > 0, {
      message: "accounts must contain at least one entry",
    }),
);

export const AgentChannelConfigSchema = z.union([SimplifiedSchema, MultiAccountSchema]);
