// Anthropic SDK client. One shared instance for the lifetime of the backend.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

export const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
