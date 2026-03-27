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

export const AgentChannelConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    host: z.string().min(1).optional(),
    port: z.number().int().positive().optional(),
    token: z.string().optional(),
    signatureSecret: z.string().optional(),
    allowFrom: z.array(z.string()).optional(),
    ignoreAuthors: z.array(z.string()).optional(),
    outboundAuthor: z.string().optional(),
    accounts: z.record(z.string(), AgentChannelAccountSchema).optional(),
  })
  .refine((value) => !value.accounts || Object.keys(value.accounts).length > 0, {
    path: ["accounts"],
    message: "accounts must contain at least one entry",
  });
