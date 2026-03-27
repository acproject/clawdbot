import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { agentChannelPlugin } from "./src/channel.js";

const plugin = {
  id: "agent_channel",
  name: "agent_channel",
  description: "agent_channel channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: agentChannelPlugin as never });
  },
};

export default plugin;
