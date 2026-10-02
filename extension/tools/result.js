// Handlers report failure explicitly: err(text) is a normal text result flagged
// isError. Nothing infers failure from the wording of a result.
export const err = (text) => ({ content: [{ type: "text", text }], isError: true });
