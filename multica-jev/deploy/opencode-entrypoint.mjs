// The OpenCode image copies this tiny loader into its direct plugin directory.
// Keeping the package itself elsewhere preserves the normal npm layout and
// lets the same source load as a Pi package.
import plugin from "/usr/local/share/opencode/plugins/multica-jev/adapters/opencode.mjs";

export default plugin;
