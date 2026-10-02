// Saved shortcuts ("prompts"), stored in chrome.storage.local.
//
// Official: shortcuts_list returns saved prompts; shortcuts_execute runs one in
// a NEW SIDE-PANEL CHAT of the extension. This fork has no side panel and no
// chat model of its own, so execute returns the shortcut's prompt (with $ARGS
// substituted) for the calling agent to carry out on the given tab. `shortcuts_save`
// (not in the official tool set) is how shortcuts get created, since there is no
// settings UI to do it.

const KEY = "ocic_shortcuts_v1";

const text = (t) => ({ content: [{ type: "text", text: t }] });
const err = (t) => ({ content: [{ type: "text", text: `Error: ${t}` }], isError: true });

const slug = (s) => String(s).trim().replace(/^\//, "");

export function createShortcuts(storage) {
  const load = async () => {
    const got = await storage.get(KEY);
    return Array.isArray(got[KEY]) ? got[KEY] : [];
  };
  const save = (list) => storage.set({ [KEY]: list });

  return {
    async shortcuts_list() {
      const list = await load();
      if (list.length === 0) {
        return text(JSON.stringify({ message: "No shortcuts found. Create one with shortcuts_save.", shortcuts: [] }, null, 2));
      }
      const shortcuts = list.map((s) => ({
        id: s.id,
        ...(s.command && { command: s.command }),
        ...(s.description && { description: s.description }),
        isWorkflow: !!s.isWorkflow,
      }));
      return text(JSON.stringify({ message: `Found ${shortcuts.length} shortcut(s)`, shortcuts }, null, 2));
    },

    async shortcuts_execute(args) {
      const { shortcutId, command, arguments: extra } = args || {};
      if (!shortcutId && !command) return err("Either shortcutId or command is required. Use shortcuts_list to see available shortcuts.");
      const list = await load();
      const cmd = command ? slug(command) : null;
      const s = shortcutId ? list.find((x) => x.id === shortcutId) : list.find((x) => x.command === cmd);
      if (!s) {
        return err(`Shortcut not found. ${shortcutId ? `No shortcut with ID "${shortcutId}"` : `No shortcut with command "/${cmd}"`}. Use shortcuts_list to see available shortcuts.`);
      }
      s.lastUsed = Date.now();
      s.uses = (s.uses || 0) + 1;
      await save(list);
      const prompt = String(s.prompt).replaceAll("$ARGS", extra == null ? "" : String(extra));
      return text(
        `Shortcut "${s.command || s.id}" found. This extension has no side panel to run it in, so carry out ` +
          `the following instructions yourself on the current tab, using the browser tools:\n\n${prompt}`
      );
    },

    // Create, update (same command or id) or delete (prompt omitted).
    async shortcuts_save(args) {
      const { command, prompt, description, isWorkflow, id: givenId } = args || {};
      if (!command && !givenId) return err("shortcuts_save requires 'command' (e.g. 'summarize') or 'id'.");
      const list = await load();
      const cmd = command ? slug(command) : null;
      const i = list.findIndex((x) => (givenId && x.id === givenId) || (cmd && x.command === cmd));
      if (prompt === undefined || prompt === null || prompt === "") {
        if (i < 0) return err("No such shortcut to delete. To create one, pass 'prompt'.");
        const [gone] = list.splice(i, 1);
        await save(list);
        return text(`Deleted shortcut "${gone.command || gone.id}".`);
      }
      const rec = {
        id: i >= 0 ? list[i].id : givenId || `sc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        command: cmd || (i >= 0 ? list[i].command : undefined),
        prompt: String(prompt),
        description: description ?? (i >= 0 ? list[i].description : undefined),
        isWorkflow: !!isWorkflow,
      };
      if (i >= 0) list[i] = { ...list[i], ...rec };
      else list.push(rec);
      await save(list);
      return text(`${i >= 0 ? "Updated" : "Saved"} shortcut "${rec.command || rec.id}" (id ${rec.id}).`);
    },
  };
}
