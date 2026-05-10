import { z } from "zod";

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
  BOT_USERNAME: z
    .string()
    .min(5, "BOT_USERNAME is required")
    .regex(/^[a-z][a-z0-9_]{4,}$/i, "BOT_USERNAME must look like a Telegram bot username"),
  DATA_FILE: z.string().min(1).default("./data/bot-data.json"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(input: NodeJS.ProcessEnv): Env {
  return envSchema.parse(input);
}
